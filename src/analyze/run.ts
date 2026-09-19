// diff the traces, work out the protocol, write out/<flow>.spec.json
//   npm run analyze -- films

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { BootstrapStep, Exchange, Field, Spec, Trace } from "../types.js";
import { extract, pickTarget } from "./fields.js";
import { classify } from "./classify.js";
import { resolve as resolveVolatile } from "./resolve.js";
import { infer } from "./schema.js";
import { emit } from "../events.js";

const flowName = process.argv[2];
if (!flowName) {
  console.error("usage: npm run analyze -- <flow name>");
  process.exit(1);
}

const dir = join("traces", flowName);
const files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();

if (files.length < 2) {
  console.error(`need at least 2 traces in ${dir}, found ${files.length}`);
  process.exit(1);
}

const traces: Trace[] = await Promise.all(
  files.map(async (f) => JSON.parse(await readFile(join(dir, f), "utf8"))),
);

// align the target request across runs
const targets: Exchange[] = [];
for (const trace of traces) {
  const target = pickTarget(trace.exchanges, trace.input, trace.targetHint, trace.origin);
  if (!target) {
    console.error(
      `no candidate request found in ${trace.runId}.\n` +
        `  The flow may not have fired an XHR. Run capture with --headed to watch it,\n` +
        `  or set flow.pick() to name the request explicitly.`,
    );
    process.exit(1);
  }
  targets.push(target);
}

// if runs disagree about which endpoint mattered, the flow isn't deterministic
// and everything downstream would be built on sand
const paths = new Set(targets.map((t) => `${t.method} ${t.path}`));
if (paths.size > 1) {
  console.error(`runs disagree on the target request:\n  ${[...paths].join("\n  ")}`);
  process.exit(1);
}

const fields: Field[] = classify(
  targets.map(extract),
  traces.map((t) => t.input),
);

for (const field of fields) {
  if (field.kind === "volatile" && !field.source) {
    field.source = resolveVolatile(field, traces, targets);
  }
}

const responseSchema = infer(targets.map((t) => t.responseBody));

// every derived field implies a request we must make first. collapse them by
// endpoint — one GET usually provides the cookie *and* the CSRF token
const bootstrap: BootstrapStep[] = [];
for (const field of fields) {
  const source = field.source;
  if (source?.kind !== "derived") continue;

  const url = traces[0]!.origin + source.fromPath;
  const step = bootstrap.find((b) => b.url === url && b.method === source.fromMethod);
  if (step) step.provides.push(field.name);
  else bootstrap.push({ method: source.fromMethod, url, provides: [field.name] });
}

const target = targets[0]!;
const spec: Spec = {
  flow: flowName,
  origin: traces[0]!.origin,
  target: { method: target.method, urlTemplate: stripQuery(target.url) },
  fields,
  bootstrap,
  responseSchema,
  unresolved: fields.filter((f) => f.source?.kind === "unresolved"),
  meta: {
    runs: traces.length,
    generatedAt: new Date().toISOString(),
    browserMs: median(targets.map((t) => t.t)),
  },
};

await mkdir("out", { recursive: true });
await writeFile(join("out", `${flowName}.spec.json`), JSON.stringify(spec, null, 2));

report(spec, traces);

function stripQuery(url: string) {
  const u = new URL(url);
  return u.origin + u.pathname;
}

// --- report ---

function report(spec: Spec, traces: Trace[]) {
  const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
  const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
  const amber = (s: string) => `\x1b[33m${s}\x1b[0m`;
  const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
  const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

  console.log(`\n  ${bold(spec.target.method + " " + spec.target.urlTemplate)}`);
  console.log(
    dim(`  ${spec.meta.runs} runs · ${traces.map((t) => Object.values(t.input).join("/")).join("  ")}\n`),
  );

  const width = Math.max(
    ...spec.fields.map((f) => f.name.length + f.location.length + 1),
  );

  for (const field of spec.fields) {
    // pad on the plain text; ANSI escapes have zero display width but count
    // toward String.padEnd, which would shear the columns
    const plain = `${field.location} ${field.name}`;
    const pad = " ".repeat(Math.max(0, width - plain.length));
    const label = `${dim(field.location)} ${field.name}${pad}`;
    const values = field.samples.map((s) => truncate(s)).join(dim(" | "));

    if (field.kind === "static") {
      console.log(`  ${dim("·")} ${label} ${dim(truncate(field.samples[0] ?? ""))}`);
    } else if (field.kind === "param") {
      console.log(
        `  ${cyan("→")} ${label} ${cyan(values)}  ${dim("← input." + field.boundTo)}`,
      );
    } else {
      const src = field.source;
      const note =
        src?.kind === "timestamp"
          ? dim(`← Date.now()`)
          : src?.kind === "derived"
            ? dim(`← ${src.fromMethod} ${src.fromPath} (${src.via.in})`)
            : red(`← unresolved`);
      const mark = src?.kind === "unresolved" ? red("?") : amber("~");
      console.log(`  ${mark} ${label} ${amber(values)}  ${note}`);
    }
  }

  const counts = {
    static: spec.fields.filter((f) => f.kind === "static").length,
    param: spec.fields.filter((f) => f.kind === "param").length,
    volatile: spec.fields.filter((f) => f.kind === "volatile").length,
  };

  console.log(
    `\n  ${counts.static} static · ${cyan(String(counts.param) + " param")} · ` +
      `${amber(String(counts.volatile) + " volatile")}` +
      (spec.unresolved.length ? ` · ${red(String(spec.unresolved.length) + " unresolved")}` : ""),
  );

  if (spec.bootstrap.length) {
    console.log(dim(`\n  bootstrap:`));
    for (const step of spec.bootstrap) {
      console.log(dim(`    ${step.method} ${step.url}  → ${step.provides.join(", ")}`));
    }
  }

  if (spec.unresolved.length) {
    console.log(
      red(`\n  ${spec.unresolved.length} field(s) could not be reproduced:`),
    );
    for (const f of spec.unresolved) {
      const note = f.source?.kind === "unresolved" ? f.source.note : "";
      console.log(red(`    ${f.location} ${f.name}  ${dim(note)}`));
    }
    console.log(
      dim(
        `\n  These are usually signed client-side. The generated client will send the\n` +
          `  captured value, which will work until it expires.`,
      ),
    );
  }

  emit({ type: "spec", flow: spec.flow });
  console.log(`\n  wrote out/${spec.flow}.spec.json\n`);
}

function truncate(s: string, n = 24) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// median, not max — max would pick the slowest browser run and quietly
// inflate the speedup we report
function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}
