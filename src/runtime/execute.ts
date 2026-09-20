// run a spec directly, without generating code first.
//
// synth compiles a spec into a .ts file you can read and ship. this does the
// same thing at runtime, from a spec stored in memory — which is what lets the
// worker call any api it has ever learned instead of only the one bundled
// into it.

import type { Field, Spec } from "../types.js";
import { extract } from "../analyze/extract.js";

export interface RunResult {
  status: number;
  body: unknown;
  ms: number;
}

export async function execute(
  spec: Spec,
  params: Record<string, string>,
): Promise<RunResult> {
  const started = Date.now();

  // no endpoint was ever found for this one — the data is in the page. fetch it
  // and run the same extraction the generated client would.
  if (spec.mode === "html" && spec.extraction) {
    const pageUrl = new URL(spec.target.urlTemplate);
    // the page may narrow itself before rendering — ?filter=, ?q=, ?page=
    for (const f of spec.fields) {
      if (f.location === "query" && f.kind === "param") {
        const v = params[f.boundTo ?? ""] ?? "";
        if (v) pageUrl.searchParams.set(f.name, v);
      }
    }
    const res = await fetch(pageUrl);
    const rows = extract(await res.text(), spec.extraction);
    return { status: res.status, body: rows, ms: Date.now() - started };
  }

  const session: Record<string, string> = {};
  const cookies: Record<string, string> = {};

  // bootstrap first: everything the site handed out before it would answer
  for (const step of spec.bootstrap) {
    const res = await fetch(step.url, { method: step.method });
    const text = await res.text();
    const setCookie = res.headers.get("set-cookie") ?? "";

    for (const field of spec.fields) {
      const src = field.source;
      if (src?.kind !== "derived") continue;
      if (!step.provides.includes(field.name)) continue;

      switch (src.via.in) {
        case "set-cookie": {
          const m = new RegExp(`${escapeRe(src.via.cookieName)}=([^;]+)`).exec(setCookie);
          if (m?.[1]) cookies[src.via.cookieName] = m[1];
          break;
        }
        case "header": {
          session[field.name] = res.headers.get(src.via.header) ?? "";
          break;
        }
        case "html": {
          const m = new RegExp(src.via.pattern).exec(text);
          if (m?.[1]) session[field.name] = m[1];
          break;
        }
        case "json": {
          try {
            session[field.name] = String(pointer(JSON.parse(text), src.via.pointer) ?? "");
          } catch {
            session[field.name] = "";
          }
          break;
        }
      }
    }
  }

  const value = (f: Field): string => {
    if (f.kind === "param") return params[f.boundTo ?? ""] ?? "";
    if (f.kind === "static") return f.samples[0] ?? "";
    const src = f.source;
    if (src?.kind === "timestamp") {
      return src.unit === "ms"
        ? String(Date.now())
        : String(Math.floor(Date.now() / 1000));
    }
    if (src?.kind === "derived") {
      return session[f.name] ?? cookies[f.name] ?? "";
    }
    // unresolved — replay what we captured and let drift detection catch it
    return f.samples[0] ?? "";
  };

  const url = new URL(spec.target.urlTemplate);
  const headers: Record<string, string> = {};
  const body: Record<string, string> = {};

  for (const f of spec.fields) {
    // a probed parameter the caller didn't supply: leave it off entirely.
    // sending ?filter= is not the same as not filtering.
    if (f.optional && !params[f.boundTo ?? ""]) continue;
    if (f.location === "query") url.searchParams.set(f.name, value(f));
    if (f.location === "header") headers[f.name] = value(f);
    if (f.location === "body") body[f.name] = value(f);
    if (f.location === "cookie" && !cookies[f.name]) cookies[f.name] = value(f);
  }

  if (Object.keys(cookies).length) {
    headers["cookie"] = Object.entries(cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }

  const hasBody = Object.keys(body).length > 0;
  const form = /x-www-form-urlencoded/i.test(headers["content-type"] ?? "");

  const res = await fetch(url, {
    method: spec.target.method,
    headers,
    body: hasBody
      ? form
        ? new URLSearchParams(body).toString()
        : JSON.stringify(body)
      : undefined,
  });

  const raw = await res.text();
  let parsed: unknown = raw;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // not json — the schema check will say so
  }

  return { status: res.status, body: parsed, ms: Date.now() - started };
}

function pointer(obj: unknown, path: string): unknown {
  return path.split(".").reduce<any>((acc, part) => {
    const m = /^([^[]*)((?:\[\d+\])*)$/.exec(part);
    let cur = m?.[1] ? acc?.[m[1]] : acc;
    for (const i of (m?.[2] ?? "").matchAll(/\[(\d+)\]/g)) cur = cur?.[Number(i[1])];
    return cur;
  }, obj);
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
