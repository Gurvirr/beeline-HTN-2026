// drive a flow a few times with different inputs, save the traces
//   npm run capture -- flows/films.ts [--headed] [--cloud]

import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Recorder } from "./recorder.js";
import { launch, contextFor } from "./browser.js";
import type { Flow, Trace } from "../types.js";

const args = process.argv.slice(2);
const flowPath = args.find((a) => !a.startsWith("--"));
const headed = args.includes("--headed");
const cloud = args.includes("--cloud");

if (!flowPath) {
  console.error("usage: npm run capture -- <flow file> [--headed] [--cloud]");
  process.exit(1);
}

const flow: Flow = (await import(pathToFileURL(resolve(flowPath)).href)).default;

if (flow.inputs.length < 3) {
  console.warn(`! ${flow.name} only has ${flow.inputs.length} inputs — 3+ is safer`);
}

const outDir = join("traces", flow.name);
await mkdir(outDir, { recursive: true });

const channel = args.includes("--edge") ? "msedge" : "chrome";

console.log(`\n  ${flow.name} — ${flow.inputs.length} runs${cloud ? " on browserbase" : ""}\n`);

const sessionUrls: string[] = [];

for (const [i, input] of flow.inputs.entries()) {
  // one browser per run, not one context per run. the session cookie has to
  // differ between runs or the analyzer reads it as static and we lose the
  // bootstrap chain
  const launched = await launch({ cloud, headed, channel });
  if (launched.sessionUrl) sessionUrls.push(launched.sessionUrl);

  const context = await contextFor(launched);
  const page = await context.newPage();

  const recorder = new Recorder(page);
  recorder.start();

  await page.goto(flow.entry, { waitUntil: "domcontentloaded" });

  let failed: string | null = null;
  try {
    await flow.run(page, input);
  } catch (err) {
    failed = err instanceof Error ? err.message : String(err);
  }

  const elapsed = recorder.elapsed();
  const exchanges = await recorder.stop();

  const trace: Trace = {
    runId: `run-${i + 1}`,
    flow: flow.name,
    input,
    origin: new URL(flow.entry).origin,
    startedAt: new Date().toISOString(),
    exchanges,
    targetHint: flow.pick?.(exchanges, input),
    cookies: (await context.cookies()).map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
    })),
  };

  await writeFile(
    join(outDir, `run-${i + 1}.json`),
    JSON.stringify(trace, null, 2),
  );

  const label = Object.entries(input)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");

  if (failed) {
    console.log(`  run ${i + 1}  ${label}  — flow threw: ${failed}`);
    console.log(`            trace kept anyway (${exchanges.length} exchanges)`);
  } else {
    console.log(
      `  run ${i + 1}  ${label}  ${exchanges.length} exchanges  ${elapsed}ms`,
    );
  }

  await launched.close();
}

console.log(`\n  wrote ${flow.inputs.length} traces to ${outDir}`);

if (sessionUrls.length) {
  console.log(`\n  replays:`);
  for (const url of sessionUrls) console.log(`    ${url}`);
}
console.log();
