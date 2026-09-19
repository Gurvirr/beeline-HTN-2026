// one command, all four stages. this is what runs on stage
//   npm run learn -- flows/films.ts [--headed] [--from-cache]

import { spawn } from "node:child_process";
import { basename } from "node:path";

const argv = process.argv.slice(2);
const flowPath = argv.find((a) => !a.startsWith("--"));
const headed = argv.includes("--headed");
const fromCache = argv.includes("--from-cache");

if (!flowPath) {
  console.error("usage: npm run learn -- <flow file> [--headed] [--from-cache]");
  process.exit(1);
}

const flowName = basename(flowPath).replace(/\.ts$/, "");

const B = "\x1b[1m";
const G = "\x1b[90m";
const R = "\x1b[0m";

function run(script: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["tsx", script, ...args], {
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${script} exited ${code}`)),
    );
  });
}

function stage(n: number, total: number, label: string) {
  console.log(`\n${G}  ── ${n}/${total} ${R}${B}${label}${R}`);
}

const started = Date.now();

try {
  if (fromCache) {
    console.log(`\n${G}  using cached traces — skipping capture${R}`);
  } else {
    stage(1, 4, "capture");
    await run("src/capture/run.ts", [flowPath, ...(headed ? ["--headed"] : [])]);
  }

  stage(2, 4, "analyze");
  await run("src/analyze/run.ts", [flowName]);

  // the diff view is the point of the demo, so it gets its own beat rather
  // than scrolling past inside the analyze output
  await run("src/diff/run.ts", [flowName]);

  stage(3, 4, "synthesize");
  await run("src/synth/run.ts", [flowName]);

  stage(4, 4, "verify");
  await run("src/verify/run.ts", [flowName]);

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n${G}  learned ${flowName} in ${elapsed}s${R}`);
  console.log(`${G}  client → ${R}out/${flowName}.client.ts\n`);
} catch (err) {
  console.error(
    `\n\x1b[31m  failed: ${err instanceof Error ? err.message : err}\x1b[0m\n`,
  );
  process.exit(1);
}
