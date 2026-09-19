// run the generated client on a fresh input and check it still matches
// doubles as drift detection
//   npm run verify -- films year=2018

import { readFile } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import type { Spec, VerifyResult } from "../types.js";
import { diff } from "../analyze/schema.js";

const [flowName, ...rest] = process.argv.slice(2);
if (!flowName) {
  console.error("usage: npm run verify -- <flow name> [key=value ...]");
  process.exit(1);
}

const spec: Spec = JSON.parse(
  await readFile(join("out", `${flowName}.spec.json`), "utf8"),
);

// inputs from argv, falling back to the first captured run so the command
// works with no arguments at all
const params: Record<string, string> = {};
for (const field of spec.fields) {
  if (field.kind === "param" && field.boundTo) {
    params[field.boundTo] = field.samples[0] ?? "";
  }
}
for (const pair of rest) {
  const eq = pair.indexOf("=");
  if (eq > 0) params[pair.slice(0, eq)] = pair.slice(eq + 1);
}

const clientPath = resolvePath(join("out", `${flowName}.client.ts`));
const mod = await import(pathToFileURL(clientPath).href);

const ClientClass = Object.values(mod).find(
  (v): v is new () => any => typeof v === "function" && /Client$/.test(v.name),
);

if (!ClientClass) {
  console.error(`no client class exported from ${clientPath}`);
  process.exit(1);
}

const client = new ClientClass();

const started = performance.now();
let body: unknown;
let status = 0;
let error: string | null = null;

try {
  if (typeof client.connect === "function") await client.connect();
  body = await client.call(params);
  status = 200;
} catch (err) {
  error = err instanceof Error ? err.message : String(err);
  status = Number(/\b(\d{3})\b/.exec(error)?.[1] ?? 0);
}

const httpMs = Math.round(performance.now() - started);
// a side-effect endpoint (login, redirect) has no body to match against
// there, a successful status *is* the result, and it was already checked by
// the client throwing on !res.ok
const sideEffectOnly = spec.responseSchema.type === "null";

const drift = error
  ? [error]
  : sideEffectOnly
    ? []
    : diff(spec.responseSchema, body);

const result: VerifyResult = {
  ok: !error && drift.length === 0,
  status,
  drift,
  httpMs,
  browserMs: spec.meta.browserMs,
  speedup: Math.round((spec.meta.browserMs / Math.max(httpMs, 1)) * 10) / 10,
};

report(result, params, body);

// set the code rather than calling process.exit(), which tears down libuv
// while fetch's keep-alive socket is still open and trips an assertion
process.exitCode = result.ok ? 0 : 1;

function report(r: VerifyResult, params: Record<string, string>, body: unknown) {
  const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
  const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
  const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
  const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

  const args = Object.entries(params).map(([k, v]) => `${k}=${v}`).join(" ");
  console.log(`\n  ${flowName}(${args})`);

  if (r.ok) {
    const detail = sideEffectOnly
      ? "session established"
      : Array.isArray(body)
        ? `${body.length} items · schema matches`
        : "schema matches";
    console.log(`  ${green("PASS")}  ${r.status} · ${detail}`);
  } else {
    console.log(`  ${red("FAIL")}  ${r.status}`);
    for (const note of r.drift) console.log(`        ${red(note)}`);
  }

  console.log();
  console.log(`  ${bold(`${r.httpMs}ms`)} over HTTP`);
  console.log(`  ${dim(`${r.browserMs}ms via the browser`)}`);
  console.log(`  ${bold(green(`${r.speedup}x faster`))}\n`);
}
