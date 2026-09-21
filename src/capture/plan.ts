// turn a sentence into something capture can run.
//
//   "get oscar films by year from scrapethissite.com/pages/ajax-javascript"
//     -> { entry, vary: "year", values: ["2010","2012","2015"], how: "url" }
//
// two ways a site takes input:
//
//   url    the thing you're asking for is in the address (?year=2015). three
//          navigations and we're done — fast, and nothing can misclick.
//   task   you have to actually do something on the page. slower, needs
//          stagehand, and it can fail in ways a url never does.
//
// we try url first because it's the one that behaves.

export interface Plan {
  entry: string;
  how: "url" | "task";
  // the query param to vary, when how === "url"
  vary?: string;
  // the sentence for stagehand, when how === "task"
  task?: string;
  values: string[];
  why: string;
}

// one code path, three possible providers. openai, baseten and backboard all
// speak the same request shape, so which one we're on is just env.
//
//   LLM_BASE_URL=https://inference.baseten.co/v1      (baseten)
//   LLM_BASE_URL=https://api.openai.com/v1            (openai)
//   LLM_API_KEY=...
//   LLM_MODEL=...
const BASE = () => process.env.LLM_BASE_URL ?? "https://api.openai.com/v1";
const KEY = () => process.env.LLM_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
const MODEL = () => process.env.LLM_MODEL ?? "gpt-4o-mini";

export async function plan(prompt: string): Promise<Plan> {
  const url = firstUrl(prompt);
  if (!url) throw new Error("no url in that — include the page you want an api for");

  const llm = KEY() ? await askModel(prompt, url).catch(() => null) : null;
  return llm ?? guess(prompt, url);
}

// no key, or the model fell over: work it out from the url itself. covers the
// common case where the page already has the parameter in its query string
function guess(prompt: string, url: string): Plan {
  const parsed = new URL(url);
  const words = prompt.toLowerCase().split(/[^a-z0-9]+/);

  // plumbing, not something anyone asks for
  const PLUMBING = /^(ajax|format|callback|json|api|_|v|version|lang|locale|utm_)/i;

  const params = [...parsed.searchParams.keys()].filter((k) => !PLUMBING.test(k));

  if (params.length) {
    // if they said "by year" and there's a ?year=, that's the one. otherwise
    // take the first real parameter
    const vary = params.find((k) => words.includes(k.toLowerCase())) ?? params[0]!;
    const seed = parsed.searchParams.get(vary) ?? "";
    return {
      entry: url,
      how: "url",
      vary,
      values: nearby(seed),
      why: `the page already takes ?${vary}= — varying that`,
    };
  }

  return {
    entry: url,
    how: "task",
    task: prompt,
    values: ["a", "b", "c"],
    why: "no query parameter to vary, so the page has to be driven",
  };
}

// three values around whatever the url was seeded with, so the diff has
// something to compare
function nearby(seed: string): string[] {
  const n = Number(seed);
  if (seed && !Number.isNaN(n)) return [String(n - 2), String(n - 1), seed];
  if (seed) return [seed, seed + "a", seed + "b"];
  return ["1", "2", "3"];
}

const SYSTEM = `You turn a request into a capture plan for a tool that learns a website's private API.

The tool loads a page three times with different inputs and diffs the network traffic.

Reply with ONLY json:
{"how":"url"|"task","vary":"<query param>","task":"<instruction>","values":["a","b","c"],"why":"<one short clause>"}

Prefer "url" when the url ALREADY HAS a query parameter for the thing being varied — it is faster and far more reliable.
Never invent a query parameter. If the url has no query string, answer "task".
values must be three real, plausible inputs for that site.`;

async function askModel(prompt: string, url: string): Promise<Plan | null> {
  const res = await fetch(`${BASE()}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${KEY()}`,
    },
    body: JSON.stringify({
      model: MODEL(),
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: `${prompt}

url: ${url}` },
      ],
    }),
  });
  if (!res.ok) return null;

  const body = (await res.json()) as any;
  const raw = body.choices?.[0]?.message?.content;
  if (!raw) return null;

  // models like to wrap json in a fence even when told not to
  const json = JSON.parse(String(raw).replace(/^[^{]*/, "").replace(/[^}]*$/, ""));
  const values: string[] = Array.isArray(json.values) ? json.values.slice(0, 3).map(String) : [];
  if (values.length < 3) return null;

  const entry =
    json.how === "url" && json.vary ? withParam(url, json.vary, values[0]!) : url;

  return {
    entry,
    how: json.how === "task" ? "task" : "url",
    vary: json.vary,
    task: json.task ?? prompt,
    values,
    why: String(json.why ?? "").slice(0, 120),
  };
}

export function withParam(url: string, key: string, value: string): string {
  const u = new URL(url);
  u.searchParams.set(key, value);
  return u.toString();
}

function firstUrl(text: string): string | null {
  // a bare domain can have any number of labels. matching only two turned
  // hn.algolia.com/?q=hackathon into hn.algolia — the tld and the whole query
  // string were dropped before the planner ever saw them, so it reported a
  // url with no query parameter to vary and fell back to driving the page.
  const m =
    text.match(/https?:\/\/[^\s"'<>]+/) ??
    text.match(/\b[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}(?:\/[^\s"'<>]*)?/i);
  if (!m) return null;
  const raw = m[0].replace(/[.,)]+$/, "");
  try {
    return new URL(/^https?:/.test(raw) ? raw : `https://${raw}`).toString();
  } catch {
    return null;
  }
}
