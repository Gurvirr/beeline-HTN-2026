import type { Exchange, Field, Trace, VolatileSource } from "../types.js";
import { flatten } from "./fields.js";

/**
 * Volatile resolution: for a value that changes on its own, work out how to
 * reproduce it without a browser.
 *
 * The method is simple and it is the reason this works at all: a token the
 * client sends must have reached the client somehow, so it is sitting in an
 * *earlier response* in the same trace. Find it there and you have your
 * bootstrap step.
 *
 * We require the same source to be found in every run. One match is a
 * coincidence — a short value can appear anywhere in a large HTML document.
 */
export function resolve(
  field: Field,
  traces: Trace[],
  targets: Exchange[],
): VolatileSource {
  const clock = asTimestamp(field.samples);
  if (clock) return clock;

  const found = field.samples.map((value, i) => {
    const trace = traces[i];
    const target = targets[i];
    if (!trace || !target || !value) return undefined;
    return locate(value, trace.exchanges, target.t);
  });

  if (found.some((f) => f === undefined)) {
    return {
      kind: "unresolved",
      note: `no source found in ${found.filter((f) => !f).length} of ${found.length} runs`,
    };
  }

  // All runs found a source — but is it the *same* source?
  const first = found[0]!;
  const consistent = found.every(
    (f) => f!.fromPath === first.fromPath && sameVia(f!.via, first.via),
  );

  if (!consistent) {
    return {
      kind: "unresolved",
      note: "value found in different places in different runs",
    };
  }

  return { kind: "derived", ...first };
}

type Located = Omit<Extract<VolatileSource, { kind: "derived" }>, "kind">;

/** Search every response that completed before the target request fired. */
function locate(
  value: string,
  exchanges: Exchange[],
  before: number,
): Located | undefined {
  // Very short values match by accident constantly. Anything under 8
  // characters is more likely noise than a token.
  if (value.length < 8) return undefined;

  const earlier = exchanges
    .filter((x) => x.t < before)
    .sort((a, b) => b.t - a.t); // most recent first — closest source wins

  for (const x of earlier) {
    const setCookie = x.responseHeaders["set-cookie"];
    if (setCookie?.includes(value)) {
      const name = /(?:^|\n)\s*([^=;\s]+)=/.exec(
        setCookie.slice(Math.max(0, setCookie.indexOf(value) - 200)),
      )?.[1];
      if (name) {
        return base(x, { in: "set-cookie", cookieName: name });
      }
    }

    for (const [header, headerValue] of Object.entries(x.responseHeaders)) {
      if (header === "set-cookie") continue;
      if (headerValue === value) return base(x, { in: "header", header });
    }

    if (x.responseBody && typeof x.responseBody === "object") {
      const hit = flatten(x.responseBody).find(([, v]) => v === value);
      if (hit) return base(x, { in: "json", pointer: hit[0] });
    }

    if (typeof x.responseBody === "string") {
      const pattern = patternFor(x.responseBody, value);
      if (pattern) return base(x, { in: "html", pattern });
    }
  }

  return undefined;
}

function base(x: Exchange, via: Located["via"]): Located {
  return { fromExchangeId: x.id, fromMethod: x.method, fromPath: x.path, via };
}

/**
 * Build an extraction regex from the text immediately before the value.
 *
 * Anchoring on preceding context is what makes this survive the value
 * changing between runs — we capture `content="..."` rather than the token.
 */
function patternFor(document: string, value: string): string | undefined {
  const at = document.indexOf(value);
  if (at === -1) return undefined;

  // Reject values that appear more than once; we can't tell which is the source.
  if (document.indexOf(value, at + value.length) !== -1) return undefined;

  const lead = document.slice(Math.max(0, at - 60), at);

  // Trim to the last structural boundary so the anchor is meaningful markup
  // rather than an arbitrary 60-character window.
  const anchor = /[^<>\n]{0,60}$/.exec(lead)?.[0] ?? lead;
  if (anchor.trim().length < 4) return undefined;

  return `${escapeRe(anchor)}([^"'<\\s]+)`;
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sameVia(a: Located["via"], b: Located["via"]): boolean {
  if (a.in !== b.in) return false;
  if (a.in === "set-cookie" && b.in === "set-cookie")
    return a.cookieName === b.cookieName;
  if (a.in === "header" && b.in === "header") return a.header === b.header;
  if (a.in === "json" && b.in === "json") return a.pointer === b.pointer;
  if (a.in === "html" && b.in === "html") return a.pattern === b.pattern;
  return false;
}

/**
 * Is this a clock? Unix seconds or millis, all samples recent and increasing.
 * Cheap to check and it removes a whole class of "unresolved" fields that
 * would otherwise look scary in the report.
 */
function asTimestamp(samples: string[]): VolatileSource | undefined {
  if (!samples.every((s) => /^\d{10}$|^\d{13}$/.test(s))) return undefined;

  const nums = samples.map(Number);
  const unit = samples[0]!.length === 13 ? "ms" : "s";
  const now = unit === "ms" ? Date.now() : Math.floor(Date.now() / 1000);
  const window = unit === "ms" ? 86_400_000 : 86_400;

  if (!nums.every((n) => Math.abs(now - n) < window)) return undefined;

  return { kind: "timestamp", unit };
}
