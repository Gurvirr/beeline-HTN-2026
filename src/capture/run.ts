// drive a flow a few times with different inputs, save the traces
//   npm run capture -- flows/films.ts [--headed]

import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Recorder } from "./recorder.js";
import type { Flow, Trace } from "../types.js";

const args = process.argv.slice(2);
const flowPath = args.find((a) => !a.startsWith("--"));
const headed = args.includes("--headed");

if (!flowPath) {
  console.error("usage: npm run capture -- <flow file> [--headed]");
  process.exit(1);
}

const flow: Flow = (await import(pathToFileURL(resolve(flowPath)).href)).default;

if (flow.inputs.length < 3) {
  console.warn(
    `! ${flow.name} has ${flow.inputs.length} input sets. ` +
      `Three or more makes parameter inference reliable — with two, a field that ` +
      `changed by coincidence is indistinguishable from a real parameter.`,
  );
}

const outDir = join("traces", flow.name);
await mkdir(outDir, { recursive: true });

// system chrome for dev, browserbase for the demo. recorder just needs a page.
// channel:"chrome" skips playwright's bundled download
const channel = args.includes("--edge") ? "msedge" : "chrome";
const browser = await chromium.launch({ headless: !headed, channel });

console.log(`\n  ${flow.name} — ${flow.inputs.length} runs\n`);

for (const [i, input] of flow.inputs.entries()) {
  // fresh context per run: we want session material to differ between runs so
  // the analyzer can tell a session token apart from a constant header
  const context = await browser.newContext();
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

  await context.close();
}

await browser.close();

console.log(`\n  wrote ${flow.inputs.length} traces to ${outDir}\n`);
