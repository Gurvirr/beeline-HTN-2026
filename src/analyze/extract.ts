// the fallback, for when there is no api to find.
//
// some pages render their data on the server. there is no json on the wire, so
// there is nothing to diff — the html *is* the response. rather than giving up
// we work out how to pull the data out of it, and generate a client that
// fetches the page and extracts. slower to break than a browser, more brittle
// than a real endpoint, and we say so.

import { parse } from "node-html-parser";
import { emit } from "../events.js";

export interface Extraction {
  // css selector for the repeating thing (a row, a card, a list item)
  item: string;
  // field name -> selector relative to the item. "." means the item itself
  fields: Record<string, string>;
  // how many the selector matched when we checked
  found: number;
  why: string;
}

const BASE = () => process.env.LLM_BASE_URL ?? "https://api.openai.com/v1";
const KEY = () => process.env.LLM_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
const MODEL = () => process.env.LLM_MODEL ?? "gpt-4o-mini";

const SYSTEM = `You are shown the structure of a web page. The user wants data off it.

Reply with ONLY json:
{"item":"<css selector for the repeating element>","fields":{"<name>":"<selector relative to item, or '.' for the element's own text>"},"why":"<short clause>"}

You are given the repeating structures on a page: a selector, how many of
each there are, sample text, and the children of the first one.

Rules:
- "item" must be one of the listed selectors.
- Every field selector must be COPIED VERBATIM from a "child" line of the item
  you chose. Never add classes to it. "p@1" means the second <p> inside the row;
  the number is what locates it, so classes are both unnecessary and usually
  invalid (w-[95%], gap-1.5 are not legal css).
- Use "." to take the item's own text.
- 2 to 6 fields. Name them in snake_case after what the sample text looks like.

Example. Given:
  li.card   (20 of them)
    text: Dune1965Frank Herbert
    child h3@0 = "Dune"
    child span@0 = "1965"
    child span@1 = "Frank Herbert"
Answer:
  {"item":"li.card","fields":{"title":"h3@0","year":"span@0","author":"span@1"},"why":"book cards"}`;

// sending raw html doesn't scale. a big page is hundreds of kilobytes and the
// part that matters could be anywhere in it, so slicing blindly misses.
//
// instead, work out what actually repeats. every element gets a signature —
// its tag plus its classes — and anything appearing several times with real
// text in it is a candidate for "the row".
export function shape(html: string, top = 14): string {
  const root = parse(html);
  const groups = new Map<string, { n: number; text: string; kids: Set<string> }>();

  for (const el of root.querySelectorAll("*")) {
    const classes = (el.getAttribute("class") ?? "")
      .split(/\s+/)
      .filter((c) => c && c.length < 30)
      .slice(0, 3);
    if (!classes.length) continue;

    const sig = `${el.tagName.toLowerCase()}.${classes.join(".")}`;
    const text = el.text.trim().replace(/\s+/g, " ");
    if (!text) continue;

    const g = groups.get(sig) ?? { n: 0, text: "", kids: new Set<string>() };
    g.n++;

    // record the children of the first one we see, so the model can pick
    // field selectors without being shown the markup
    if (!g.text) {
      g.text = text.slice(0, 150);
      // label each child the way we want it selected — by tag and position,
      // not by class. show the model a class here and it will hand one back,
      // and on a utility-class site that class is never a valid selector
      const seen = new Map<string, number>();
      for (const kid of el.querySelectorAll("*").slice(0, 24)) {
        const tag = kid.tagName.toLowerCase();
        const n = seen.get(tag) ?? 0;
        seen.set(tag, n + 1);

        const kidText = kid.text.trim().replace(/\s+/g, " ").slice(0, 40);

        // a wrapper's text is two values glued together, and offering one is
        // how you get "TOML1.3M" as a field. but an element whose children are
        // all textless — a number next to its svg icon — is still one value,
        // so the test is whether anything below it carries text of its own
        const speaks = kid.querySelectorAll("*").some((d) => d.text.trim());
        if (kidText && !speaks) g.kids.add(`${tag}@${n} = "${kidText}"`);
      }
    }
    groups.set(sig, g);
  }

  // repeats a few times, and short enough to be one row rather than the
  // wrapper around all of them
  return [...groups.entries()]
    .filter(([, g]) => g.n >= 3 && g.text.length < 400)
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, top)
    .map(([sig, g]) =>
      [
        `${sig}   (${g.n} of them)`,
        `  text: ${g.text}`,
        ...[...g.kids].slice(0, 8).map((k) => `  child ${k}`),
      ].join("\n"),
    )
    .join("\n\n");
}

export async function planExtraction(
  html: string,
  goal: string,
): Promise<Extraction | null> {
  if (!KEY()) return null;
  emit({
    type: "think",
    who: MODEL(),
    doing: "no endpoint to recover — reading the page structure instead",
  });

  const res = await fetch(`${BASE()}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY()}` },
    body: JSON.stringify({
      model: MODEL(),
      // openai renamed this; baseten and the rest still take max_tokens
      ...(BASE().includes("openai.com")
        ? { max_completion_tokens: 600 }
        : { max_tokens: 600 }),
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: `goal: ${goal}\n\npage:\n${shape(html)}` },
      ],
    }),
  }).catch(() => null);

  if (!res?.ok) return null;

  const body = (await res.json()) as any;
  const raw = body.choices?.[0]?.message?.content;
  if (!raw) return null;

  let json: any;
  try {
    json = JSON.parse(String(raw).replace(/^[^{]*/, "").replace(/[^}]*$/, ""));
  } catch {
    return null;
  }
  if (!json.item || !json.fields) return null;

  // does it actually match anything? a selector that finds nothing is worse
  // than admitting we couldn't do it
  const found = check(html, json.item);
  if (found < 2) return null;

  const plan: Extraction = {
    item: String(json.item),
    fields: repair(json.fields),
    found,
    why: String(json.why ?? "").slice(0, 120),
  };

  // and do the field selectors pull anything out? a plan that matches rows but
  // extracts empty strings is worse than no plan — it looks like it worked
  const sample = extract(html, plan)[0] ?? {};
  const filled = Object.values(sample).filter((v) => v !== "").length;
  if (filled === 0) return null;

  // drop the ones that came back empty rather than shipping dead fields
  plan.fields = Object.fromEntries(
    Object.entries(plan.fields).filter(([k]) => sample[k] !== ""),
  );

  emit({
    type: "think",
    who: MODEL(),
    doing: `picked ${plan.item} — ${found} of them on the page`,
    detail: Object.keys(plan.fields).join(" "),
  });
  const dropped = Object.keys(json.fields).length - Object.keys(plan.fields).length;
  if (dropped > 0) {
    emit({
      type: "think",
      who: "checked",
      doing: `${dropped} of its selectors extracted nothing — dropped`,
    });
  }

  return plan;
}

// models sometimes prefix a tag selector with a dot — ".span.text" matches an
// element classed "span", which is never what they meant
function repair(fields: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  const used = new Set<string>();

  for (const [k, v] of Object.entries(fields)) {
    let sel = String(v).replace(/(^|[\s>])\.([a-z]+[.#])/gi, "$1$2");

    // asked for "p@1", told not to add classes, still handed back
    // "p.w-[95%].truncate@1". the number already locates it, so the classes are
    // decoration — and on a tailwind site they're not valid css either
    sel = sel.replace(/^([a-z]+)[.#][^@]*@(\d+)$/i, "$1@$2");

    // two names for the same element is just the same column twice
    if (used.has(sel)) continue;
    used.add(sel);
    out[k] = sel;
  }
  return out;
}

// "p@2" means the third <p> anywhere inside the row. css can't say that when
// the tags live under different parents, which on a utility-class site they
// almost always do.
function pickBy(node: any, selector: string) {
  const at = /^(.+)@(\d+)$/.exec(selector);
  if (!at) return node.querySelector(selector);
  return node.querySelectorAll(at[1]!.trim())[Number(at[2])] ?? null;
}

export function check(html: string, selector: string): number {
  try {
    return parse(html).querySelectorAll(selector).length;
  } catch {
    return 0;
  }
}

// run an extraction for real — used by verify and by the brain
export function extract(html: string, e: Extraction): Record<string, string>[] {
  let items;
  try {
    items = parse(html).querySelectorAll(e.item);
  } catch {
    return [];
  }

  return items.map((node) => {
    const row: Record<string, string> = {};
    for (const [name, sel] of Object.entries(e.fields)) {
      // tailwind classes like w-[95%] aren't valid css selectors unescaped,
      // and the parser throws rather than returning nothing
      let target;
      try {
        target = sel === "." ? node : pickBy(node, sel);
      } catch {
        target = null;
      }
      row[name] = target?.text.trim().replace(/\s+/g, " ") ?? "";
    }
    return row;
  });
}
