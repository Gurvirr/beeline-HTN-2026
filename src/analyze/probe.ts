// what the site never told us.
//
// capture can only learn arguments the page actually sends. zed's extension
// search runs in the browser over a list it already has, so typing sends
// nothing — and the endpoint's text search is invisible to us even though it
// works. everything we recovered by watching stops exactly there.
//
// so once we have the endpoint, ask it directly. try a parameter, compare the
// answer to the one we already have, and keep it only if it provably changed
// something. a name that gets ignored returns the same rows and gets dropped,
// which is the difference between finding a parameter and guessing one.

import type { Field, Spec } from "../types.js";
import { ask, fast } from "../llm.js";

// the names everyone uses. ordered so the likely ones go first, since we stop
// after we have found enough.
const TEXT = ["filter", "search", "q", "query", "keyword", "term", "name"];
const LIMIT = ["limit", "per_page", "page_size", "count"];

const SUGGEST = `You are given a private API endpoint that a tool recovered by watching a website use it.

Name additional query parameters the endpoint plausibly accepts. Think about what this
particular API is for: a catalogue takes sorting and paging, a search takes a text query,
a feed takes a date cursor.

Reply with ONLY a JSON array of lowercase parameter names. No prose, no explanation.
At most 12. Do not repeat parameters that are already known.`;

// ask a model for candidates. it costs nothing to be wrong here - everything
// it says is tested against the live endpoint below, and anything that
// doesn't measurably change the answer is dropped. this is the cheap half of
// the job, so it goes to the fast provider.
async function suggest(spec: Spec, known: Set<string>, sample: unknown): Promise<string[]> {
  const p = fast();
  if (!p.key) return [];

  const row = JSON.stringify(sample ?? {}).slice(0, 700);
  const raw = await ask(
    p,
    SUGGEST,
    [
      `endpoint: ${spec.target.method} ${spec.target.urlTemplate}`,
      `known query params: ${[...known].join(", ") || "none"}`,
      `one row of the response: ${row}`,
    ].join("\n"),
    { maxTokens: 220, timeoutMs: 20_000 },
  ).catch(() => null);
  if (!raw) return [];

  try {
    const start = raw.indexOf("[");
    const end = raw.lastIndexOf("]");
    if (start < 0 || end < start) return [];
    const list = JSON.parse(raw.slice(start, end + 1));
    if (!Array.isArray(list)) return [];
    return list
      .filter((x) => typeof x === "string")
      .map((x) => x.trim().toLowerCase())
      // a parameter name is a short identifier; anything else is the model
      // answering a different question
      .filter((x) => /^[a-z][a-z0-9_]{1,24}$/.test(x))
      .filter((x) => !known.has(x));
  } catch {
    return [];
  }
}

export interface Probed {
  field: Field;
  before: number;
  after: number;
}

// pull the rows out of a response. most apis wrap them — {data: [...]} — and
// the rest just hand back an array.
export function rows(body: unknown): unknown[] | null {
  if (Array.isArray(body)) return body;
  if (body && typeof body === "object") {
    const arrays = Object.values(body as Record<string, unknown>).filter(Array.isArray);
    if (arrays.length === 1) return arrays[0] as unknown[];
    // more than one: the longest is the payload, the others are facets
    if (arrays.length > 1) {
      return (arrays as unknown[][]).sort((a, b) => b.length - a.length)[0]!;
    }
  }
  return null;
}

// a word to search for. it has to come from a name or a title: text search
// on these endpoints almost always covers the identifier and not the prose,
// so a word lifted from a description comes back with nothing and makes a
// working parameter look broken.
const NAMEISH = ["name", "title", "slug", "id"];

function needle(items: unknown[]): string | null {
  const counts = new Map<string, number>();
  const order: string[] = [];

  for (const item of items.slice(0, 400)) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;

    for (const key of NAMEISH) {
      const v = o[key];
      if (typeof v !== "string") continue;
      for (const w of new Set(v.split(/[^A-Za-z]+/))) {
        if (w.length < 6 || w.length > 20) continue;
        counts.set(w, (counts.get(w) ?? 0) + 1);
        order.push(w);
      }
    }
  }

  // one that names a single row, so a search for it should return about one
  for (const w of order) if (counts.get(w) === 1) return w;
  return null;
}

function idOf(x: unknown): string {
  if (x && typeof x === "object") {
    const o = x as Record<string, unknown>;
    for (const k of ["id", "slug", "name", "title"]) {
      if (typeof o[k] === "string") return o[k] as string;
    }
  }
  return JSON.stringify(x).slice(0, 80);
}

// the url the spec already calls, with everything it learned on it
function baseUrl(spec: Spec): URL {
  const url = new URL(spec.target.urlTemplate);
  for (const f of spec.fields) {
    if (f.location !== "query") continue;
    // leave the site's own arguments at their captured values so we are
    // comparing like with like
    if (f.samples[0]) url.searchParams.set(f.name, f.samples[0]);
  }
  return url;
}

async function get(url: URL, headers: Record<string, string>) {
  const res = await fetch(url, { headers });
  if (!res.ok) return null;
  try {
    return rows(await res.json());
  } catch {
    return null;
  }
}

export async function probe(spec: Spec, log?: (s: string) => void): Promise<Probed[]> {
  // only worth doing for a GET that answers with a list. a login has nothing
  // to narrow.
  if (spec.target.method !== "GET") return [];

  const headers: Record<string, string> = {};
  for (const f of spec.fields) {
    if (f.location === "header" && f.samples[0]) headers[f.name] = f.samples[0];
  }

  const base = baseUrl(spec);
  const before = await get(base, headers);
  if (!before || before.length < 5) return [];

  const known = new Set(spec.fields.filter((f) => f.location === "query").map((f) => f.name));
  const found: Probed[] = [];

  // the hardcoded names first, so behaviour without a model is unchanged and
  // the common case is still found on the first try. anything the model adds
  // is tried after, and only ever in addition.
  const proposed = await suggest(spec, known, before[0]).catch(() => []);
  if (proposed.length) log?.(`suggested: ${proposed.join(", ")}`);

  const textNames = [...new Set([...TEXT, ...proposed])].slice(0, 16);
  const limitNames = [...new Set([...LIMIT, ...proposed])].slice(0, 10);

  const word = needle(before);
  if (word) {
    for (const name of textNames) {
      if (found.length) break;
      // a parameter the site already sends is not a discovery
      if (known.has(name)) continue;
      const url = new URL(base);
      url.searchParams.set(name, word);
      const after = await get(url, headers);
      if (!after) continue;

      // it has to narrow, keep something, and keep the row we aimed at.
      // anything else is the endpoint ignoring us or falling over.
      const narrowed = after.length > 0 && after.length < before.length;
      if (!narrowed) continue;
      const ids = new Set(before.map(idOf));
      if (!after.every((r) => ids.has(idOf(r)))) continue;

      log?.(`${name}="${word}" → ${after.length} of ${before.length}`);
      found.push({
        field: {
          location: "query",
          name,
          kind: "param",
          samples: [word],
          boundTo: name,
          optional: true,
          note: `free-text search — ${word} matched ${after.length} of ${before.length}` + (TEXT.includes(name) ? "" : " (model-suggested, then verified)"),
        },
        before: before.length,
        after: after.length,
      });
    }
  }

  for (const name of limitNames) {
    if (known.has(name)) continue;
    const url = new URL(base);
    url.searchParams.set(name, "3");
    const after = await get(url, headers);
    // exactly three back means it was understood, not coincidence
    if (after?.length !== 3 || before.length === 3) continue;

    log?.(`${name}=3 → ${after.length} of ${before.length}`);
    found.push({
      field: {
        location: "query",
        name,
        kind: "param",
        samples: ["3"],
        boundTo: name,
        optional: true,
        note: "how many rows to return",
      },
      before: before.length,
      after: after.length,
    });
    break;
  }

  return found;
}
