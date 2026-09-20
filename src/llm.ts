// two models, two jobs.
//
// most of what beeline needs from a model is judgement: read a page's
// structure and work out which element is the row, turn a sentence into a
// capture plan. that goes to the stronger model.
//
// one job is the opposite shape — brainstorm a list of plausible query
// parameter names, where being wrong costs nothing because every suggestion
// is then tested against the live endpoint and thrown away if it doesn't
// measurably change the answer. that wants fast and cheap, not careful.
//
// so: openai reasons, baseten proposes, and the prober decides.

export interface Provider {
  name: string;
  base: string;
  key: string;
  model: string;
}

// the careful one
export function primary(): Provider {
  return {
    name: "openai",
    base: process.env.LLM_BASE_URL ?? "https://api.openai.com/v1",
    key: process.env.LLM_API_KEY ?? process.env.OPENAI_API_KEY ?? "",
    model: process.env.LLM_MODEL ?? "gpt-4o-mini",
  };
}

// the quick one. falls back to the careful one so nothing depends on baseten
// being configured — without a key this is simply the same provider twice.
export function fast(): Provider {
  const key = process.env.BASETEN_API_KEY ?? "";
  if (!key) return primary();
  return {
    name: "baseten",
    base: process.env.BASETEN_BASE_URL ?? "https://inference.baseten.co/v1",
    key,
    model: process.env.BASETEN_MODEL ?? "zai-org/GLM-5.3-Flash",
  };
}

export interface AskOptions {
  maxTokens?: number;
  timeoutMs?: number;
}

// one request shape for both. openai renamed the token limit; everyone else
// still takes the old name.
export async function ask(
  p: Provider,
  system: string,
  user: string,
  opts: AskOptions = {},
): Promise<string | null> {
  if (!p.key) return null;

  const limit = opts.maxTokens ?? 600;
  const ctl = AbortSignal.timeout(opts.timeoutMs ?? 30_000);

  const res = await fetch(`${p.base}/chat/completions`, {
    method: "POST",
    signal: ctl,
    headers: { "content-type": "application/json", authorization: `Bearer ${p.key}` },
    body: JSON.stringify({
      model: p.model,
      ...(p.base.includes("openai.com")
        ? { max_completion_tokens: limit }
        : { max_tokens: limit }),
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  }).catch(() => null);

  if (!res?.ok) return null;

  const body = (await res.json().catch(() => null)) as any;
  const msg = body?.choices?.[0]?.message;
  // some reasoning models leave content null and put the answer in
  // reasoning_content instead
  const raw = msg?.content ?? msg?.reasoning_content;
  return typeof raw === "string" && raw.trim() ? raw : null;
}
