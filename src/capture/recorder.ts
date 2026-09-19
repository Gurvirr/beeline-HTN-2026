import type { Exchange } from "../types.js";

// records every request/response off a playwright page.
// everything, not just xhr — csrf tokens and session cookies live in documents
export class Recorder {
  private exchanges: Exchange[] = [];
  private pending = new Set<Promise<void>>();
  private started = Date.now();
  private seq = 0;

  constructor(private page: any) {}

  start() {
    this.started = Date.now();
    this.page.on("response", (response: any) => {
      // collect concurrently; stop() waits for all of these to settle
      const job = this.record(response).catch(() => {});
      this.pending.add(job);
      job.finally(() => this.pending.delete(job));
    });
  }

  private async record(response: any) {
    const request = response.request();
    const url: string = request.url();

    // data: and blob: URLs carry no protocol information
    if (!/^https?:/i.test(url)) return;

    const parsed = new URL(url);
    const timing = request.timing?.() ?? { responseEnd: 0, startTime: 0 };
    const requestHeaders = await safe<Record<string, string>>(
      () => request.allHeaders(),
      {},
    );

    this.exchanges.push({
      id: `x${(this.seq++).toString().padStart(4, "0")}`,
      t: Date.now() - this.started,
      method: request.method(),
      url,
      path: parsed.pathname,
      query: Object.fromEntries(parsed.searchParams),
      requestHeaders,
      requestBody: parseBody(
        request.postData?.() ?? null,
        requestHeaders["content-type"] ?? "",
      ),
      status: response.status(),
      responseHeaders: await safe(() => response.allHeaders(), {}),
      responseBody: await readBody(response),
      resourceType: request.resourceType?.() ?? "other",
      durationMs: Math.max(0, Math.round(timing.responseEnd - timing.startTime)),
    });
  }

  // wait for in-flight recordings, then return everything in wire order
  async stop(): Promise<Exchange[]> {
    await Promise.allSettled([...this.pending]);
    return [...this.exchanges].sort((a, b) => a.t - b.t);
  }

  elapsed() {
    return Date.now() - this.started;
  }
}

// response bodies come back as text when they're text-ish, parsed when JSON,
// and null otherwise. we keep HTML because tokens hide in it
async function readBody(response: any): Promise<unknown> {
  const type = (await safe(() => response.headerValue("content-type"), null)) ?? "";

  if (!/json|text|javascript|html|xml/i.test(type)) return null;

  const text = await safe(() => response.text(), null);
  if (text === null) return null;

  // don't let one enormous bundle dominate a trace file
  if (text.length > 2_000_000) return text.slice(0, 2_000_000);

  return /json/i.test(type) ? tryJson(text) : text;
}

// request bodies become objects wherever possible, because the analyzer
// classifies *fields* — a form post kept as one string would collapse
// csrf_token, username and password into a single indivisible blob
function parseBody(raw: string | null, contentType: string): unknown {
  if (raw === null) return null;

  if (/x-www-form-urlencoded/i.test(contentType)) {
    return Object.fromEntries(new URLSearchParams(raw));
  }

  return tryJson(raw);
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// playwright throws on bodies it can't reach (redirects, aborted requests)
async function safe<T>(fn: () => T | Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}
