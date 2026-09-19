#!/usr/bin/env node
// the cli. thin shim — resolves a flow name to its file and hands off to tsx.

import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [cmd, ...rest] = process.argv.slice(2);

const C = { dim: "\x1b[2m", bold: "\x1b[1m", cyan: "\x1b[36m", r: "\x1b[0m" };

const COMMANDS = {
  learn: "src/learn.ts",
  capture: "src/capture/run.ts",
  analyze: "src/analyze/run.ts",
  diff: "src/diff/run.ts",
  synth: "src/synth/run.ts",
  verify: "src/verify/run.ts",
  ui: "src/ui/server.ts",
  deploy: "src/deploy/run.ts",
};

if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
  usage();
  process.exit(cmd ? 0 : 1);
}

if (cmd === "flows" || cmd === "ls") {
  for (const f of flows()) console.log(`  ${f}`);
  process.exit(0);
}

// brain commands all route to one script with the action as the first arg
const BRAIN_CMDS = ["remember", "health", "check"];
if (BRAIN_CMDS.includes(cmd)) {
  run("src/brain/run.ts", [cmd, ...rest]);
} else {
  const script = COMMANDS[cmd];
  if (!script) {
    console.error(`unknown command: ${cmd}`);
    usage();
    process.exit(1);
  }
  main(script);
}

function main(script) {

// learn and capture want a path; everything else wants the bare name
const args = rest.map((a) => {
  if (a.startsWith("-")) return a;
  if (cmd !== "learn" && cmd !== "capture") return a;
  return existsSync(a) ? a : join(root, "flows", `${a}.ts`);
});

// check the flow exists before spinning up a browser to find out
const named = rest.find((a) => !a.startsWith("-") && !a.includes("="));
if (named && cmd !== "ui" && !flows().includes(named) && !existsSync(named)) {
  console.error(`\n  no flow called "${named}"\n`);
  console.error(`  available:`);
  for (const f of flows()) console.error(`    ${f}`);
  console.error();
  process.exit(1);
}

  run(script, args);
}

function run(rel, argv) {
  const child = spawn(
    "npx",
    ["tsx", "--env-file-if-exists=.env", join(root, rel), ...argv],
    { stdio: "inherit", cwd: root, shell: process.platform === "win32" },
  );
  child.on("exit", (code) => process.exit(code ?? 0));
}

function flows() {
  const dir = join(root, "flows");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => f.replace(/\.ts$/, ""));
}

function usage() {
  console.log(`
  ${C.bold}beeline${C.r} ${C.dim}— use a site once, get an sdk that does it without a browser${C.r}

  ${C.cyan}beeline learn <flow>${C.r}     capture, analyze, synthesize, verify
  ${C.cyan}beeline deploy <flow>${C.r}    put the client behind a public url
  ${C.cyan}beeline ui${C.r}               open the dashboard

  ${C.dim}the brain — remembers apis and keeps checking them${C.r}
  ${C.cyan}beeline remember <flow>${C.r}  teach it an api
  ${C.cyan}beeline health${C.r}           what it knows, and what has drifted
  ${C.cyan}beeline check <flow>${C.r}     go look right now

  ${C.dim}beeline capture <flow>   record the flow only
  beeline analyze <flow>   diff the recordings into a spec
  beeline diff <flow>      show what changed across runs
  beeline synth <flow>     spec -> client.ts
  beeline verify <flow>    run the client and time it
  beeline flows            list available flows${C.r}

  ${C.dim}flags${C.r}
    --cloud        run on browserbase instead of local chrome
    --headed       show the browser (local only)
    --from-cache   skip capture, reuse the last recordings

  ${C.dim}examples${C.r}
    beeline learn steam --cloud
    beeline verify steam term=celeste
`);
}
