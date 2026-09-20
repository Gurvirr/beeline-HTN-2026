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

const KEY = () => process.env.GEMINI_API_KEY ?? process.env.OPENAI_API_KEY ?? "";

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
  const params = [...parsed.searchParams.keys()];

  if (params.length) {
    const vary = params[0]!;
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

Prefer "url" whenever the thing being varied can live in the query string — it is faster and far more reliable. Use "task" only when the page genuinely requires interaction.
values must be three real, plausible inputs for that site.`;

async function askModel(prompt: string, url: string): Promise<Plan | null> {
  const body = `${prompt}\n\nurl: ${url}`;
  const raw = process.env.GEMINI_API_KEY
    ? await gemini(body)
    : await openai(body);
  if (!raw) return null;

  const json = JSON.parse(raw.replace(/^```json\s*|\s*```$/g, ""));
  const values: string[] = Array.isArray(json.values) ? json.values.slice(0, 3) : [];
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

async function gemini(body: string): Promise<string | null> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: [{ parts: [{ text: body }] }],
        generationConfig: { responseMimeType: "application/json" },
      }),
    },
  );
  if (!res.ok) return null;
  const j = (await res.json()) as any;
  return j.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
}

async function openai(body: string): Promise<string | null> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: body },
      ],
    }),
  });
  if (!res.ok) return null;
  const j = (await res.json()) as any;
  return j.choices?.[0]?.message?.content ?? null;
}

export function withParam(url: string, key: string, value: string): string {
  const u = new URL(url);
  u.searchParams.set(key, value);
  return u.toString();
}

function firstUrl(text: string): string | null {
  const m = text.match(/https?:\/\/[^\s"'<>]+/) ?? text.match(/\b[\w-]+\.[a-z]{2,}(?:\/[^\s"'<>]*)?/i);
  if (!m) return null;
  const raw = m[0].replace(/[.,)]+$/, "");
  try {
    return new URL(/^https?:/.test(raw) ? raw : `https://${raw}`).toString();
  } catch {
    return null;
  }
}
