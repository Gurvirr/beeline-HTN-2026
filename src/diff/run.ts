// the diff view. shows what we concluded about every field and why
//   npm run diff -- films

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readdir } from "node:fs/promises";
import type { Spec, Field, Trace, VolatileSource } from "../types.js";

const flowName = process.argv.slice(2).find((a) => !a.startsWith("--"));
if (!flowName) {
  console.error("usage: npm run diff -- <flow>");
  process.exit(1);
}

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  amber: "\x1b[33m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  grey: "\x1b[90m",
};

const spec: Spec = JSON.parse(
  await readFile(join("out", `${flowName}.spec.json`), "utf8"),
);

// input labels for the column headers — "year=2010" and so on
const traceDir = join("traces", flowName);
const traceFiles = (await readdir(traceDir))
  .filter((f) => f.startsWith("run-"))
  .sort();

const inputs: string[] = [];
for (const f of traceFiles) {
  const trace: Trace = JSON.parse(await readFile(join(traceDir, f), "utf8"));
  inputs.push(
    Object.entries(trace.input)
      .map(([k, v]) => `${k}=${v}`)
      .join(" "),
  );
}

// --- layout ---

const VALUE_W = 16;
const NAME_W = Math.max(14, ...spec.fields.map((f) => f.name.length)) + 2;
const LOC_W = 8;

// pad to a visible width, then colour. ANSI codes must not count toward width
function cell(text: string, width: number, colour = ""): string {
  const clipped =
    text.length > width - 1 ? text.slice(0, width - 2) + "…" : text;
  return colour + clipped.padEnd(width) + (colour ? C.reset : "");
}

function kindColour(kind: Field["kind"]): string {
  if (kind === "param") return C.cyan + C.bold;
  if (kind === "volatile") return C.amber;
  return C.grey;
}

// human-readable account of where a volatile value came from
function describeSource(source: VolatileSource | undefined): string {
  if (!source) return "no source recorded";
  if (source.kind === "timestamp") {
    return `clock — emit Date.now()${source.unit === "s" ? " / 1000" : ""}`;
  }
  if (source.kind === "unresolved") return `unresolved — ${source.note}`;

  const where =
    source.via.in === "set-cookie"
      ? `set-cookie: ${source.via.cookieName}`
      : source.via.in === "header"
        ? `header: ${source.via.header}`
        : source.via.in === "json"
          ? `json: ${source.via.pointer}`
          : `html: ${source.via.pattern}`;

  return `from ${source.fromMethod} ${source.fromPath} · ${where}`;
}

// --- render ---

const line = "─".repeat(LOC_W + NAME_W + VALUE_W * inputs.length + 14);

console.log();
console.log(`  ${C.bold}beeline${C.reset} ${C.grey}·${C.reset} ${spec.flow}`);
console.log(
  `  ${C.grey}${spec.target.method}${C.reset} ${spec.target.urlTemplate}`,
);
console.log();

// column headers: the inputs each run was driven with
process.stdout.write("  " + " ".repeat(LOC_W + NAME_W));
for (const input of inputs) {
  process.stdout.write(cell(input, VALUE_W, C.grey));
}
console.log();
console.log(`  ${C.grey}${line}${C.reset}`);

// params first — they're the point. then volatile, then the static bulk
const order = { param: 0, volatile: 1, static: 2 } as const;
const fields = [...spec.fields].sort((a, b) => order[a.kind] - order[b.kind]);

for (const field of fields) {
  const colour = kindColour(field.kind);

  process.stdout.write("  ");
  process.stdout.write(cell(field.location, LOC_W, C.grey));
  process.stdout.write(cell(field.name, NAME_W, colour));

  for (let i = 0; i < inputs.length; i++) {
    process.stdout.write(cell(field.samples[i] ?? "—", VALUE_W, colour));
  }

  if (field.kind === "param") {
    process.stdout.write(`${C.cyan}${C.bold}← PARAM${C.reset}`);
    if (field.boundTo) {
      process.stdout.write(`${C.cyan} (${field.boundTo})${C.reset}`);
    }
  } else if (field.kind === "volatile") {
    process.stdout.write(`${C.amber}← VOLATILE${C.reset}`);
  }
  console.log();

  // volatile fields get a second line showing where the value was born
  if (field.kind === "volatile") {
    const indent = " ".repeat(2 + LOC_W + NAME_W);
    console.log(
      `${indent}${C.amber}└─ ${describeSource(field.source)}${C.reset}`,
    );
  }
}

console.log(`  ${C.grey}${line}${C.reset}`);
console.log();

// --- summary ---

const count = (kind: Field["kind"]) =>
  spec.fields.filter((f) => f.kind === kind).length;

const parts = [
  `${C.cyan}${C.bold}${count("param")} parameter${count("param") === 1 ? "" : "s"}${C.reset}`,
  `${C.grey}${count("static")} static${C.reset}`,
  `${C.amber}${count("volatile")} volatile${C.reset}`,
];

if (spec.unresolved.length) {
  parts.push(`${C.red}${spec.unresolved.length} unresolved${C.reset}`);
}

console.log("  " + parts.join(`${C.grey} · ${C.reset}`));

if (spec.bootstrap.length) {
  console.log();
  console.log(`  ${C.grey}bootstrap${C.reset}`);
  for (const step of spec.bootstrap) {
    console.log(
      `    ${C.amber}${step.method}${C.reset} ${step.url} ${C.grey}→ ${step.provides.join(", ")}${C.reset}`,
    );
  }
}

if (spec.unresolved.length) {
  console.log();
  console.log(
    `  ${C.red}These fields could not be reproduced without a browser:${C.reset}`,
  );
  for (const field of spec.unresolved) {
    console.log(`    ${C.red}${field.location} ${field.name}${C.reset}`);
  }
}

console.log();
