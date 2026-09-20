// the fallback, for when there is no api to find.
//
// some pages render their data on the server. there is no json on the wire, so
// there is nothing to diff — the html *is* the response. rather than giving up
// we work out how to pull the data out of it, and generate a client that
// fetches the page and extracts. slower to break than a browser, more brittle
// than a real endpoint, and we say so.

import { parse } from "node-html-parser";

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

Rules:
- "item" must match MANY elements — the row/card/entry that repeats.
- Prefer stable selectors: tag names, semantic classes, data- attributes. Avoid generated hashes.
- field selectors are relative to item. Use "." to take the item's own text.
- 2 to 6 fields. Name them in snake_case.`;

// html is far too big to send whole, and most of it is noise. strip what can't
// contain data and keep the shape.
export function skeleton(html: string, budget = 14000): string {
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<svg[\s\S]*?<\/svg>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s+/g, " ");

  if (cleaned.length <= budget) return cleaned;

  // the middle of a page is usually where the list lives; the head and footer
  // are chrome
  const start = Math.floor(cleaned.length * 0.15);
  return cleaned.slice(start, start + budget);
}

export async function planExtraction(
  html: string,
  goal: string,
): Promise<Extraction | null> {
  if (!KEY()) return null;

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
        { role: "user", content: `goal: ${goal}\n\npage:\n${skeleton(html)}` },
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

  return plan;
}

// models sometimes prefix a tag selector with a dot — ".span.text" matches an
// element classed "span", which is never what they meant
function repair(fields: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = String(v).replace(/(^|[\s>])\.([a-z]+[.#])/gi, "$1$2");
  }
  return out;
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
  const root = parse(html);
  return root.querySelectorAll(e.item).map((node) => {
    const row: Record<string, string> = {};
    for (const [name, sel] of Object.entries(e.fields)) {
      const target = sel === "." ? node : node.querySelector(sel);
      row[name] = target?.text.trim().replace(/\s+/g, " ") ?? "";
    }
    return row;
  });
}
