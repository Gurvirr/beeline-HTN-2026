// diff the traces, work out the protocol, write out/<flow>.spec.json
//   npm run analyze -- films

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { BootstrapStep, Exchange, Field, Spec, Trace } from "../types.js";
import { extract, pickTarget } from "./fields.js";
import { classify } from "./classify.js";
import { resolve as resolveVolatile } from "./resolve.js";
import { infer } from "./schema.js";
import { planExtraction, extract as runExtraction } from "./extract.js";
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
let noApi = false;
for (const trace of traces) {
  const target = pickTarget(trace.exchanges, trace.input, trace.targetHint, trace.origin);
  if (!target) {
    noApi = true;
    break;
  }
  targets.push(target);
}

// nothing on the wire. the page renders its data on the server, so the html is
// the response — fall back to pulling the data out of it
if (noApi) {
  await htmlFallback(traces, flowName);
} else {
  await fromApi(flowName);
}

// the api path, in a function only so the html path above can skip it.
// it used to be top-level with a process.exit(0) before it, which exits
// while the model call's keep-alive socket is still closing — on windows
// that trips a libuv assertion and the whole run looks like it failed.
async function fromApi(flowName: string) {

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
}

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

// --- nothing on the wire ---
//
// the page renders its data on the server, so there's no endpoint to recover.
// the html *is* the response — work out how to pull the data out of it.
async function htmlFallback(traces: Trace[], name: string) {
  const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
  const amber = (s: string) => `\x1b[33m${s}\x1b[0m`;

  // which html response is "the page"? a run often loads the entry url first
  // and then navigates again with the argument on it, and the filtered page is
  // the SMALLER of the two — so size is the wrong test. prefer the one whose
  // url carries an input value, then the one we landed on last.
  const pageOf = (t: Trace) => {
    const html = t.exchanges.filter(
      (x) => typeof x.responseBody === "string" && /<html/i.test(x.responseBody),
    );
    const values = Object.values(t.input).filter(Boolean);
    const carries = html.filter((x) =>
      values.some((v) => x.url.includes(v) || x.url.includes(encodeURIComponent(v))),
    );
    if (carries.length) return carries.sort((a, b) => (b.t ?? 0) - (a.t ?? 0))[0];
    return html.sort(
      (a, b) => String(b.responseBody).length - String(a.responseBody).length,
    )[0];
  };

  const page = pageOf(traces[0]!);

  if (!page) {
    console.error("\n  no endpoint, and no html to fall back on either.\n");
    process.exit(1);
  }

  console.log(`\n  ${amber("no endpoint on the wire")} — this page renders on the server`);
  console.log(`  ${dim("reading it to work out how to pull the data out")}`);

  const goal = Object.entries(traces[0]!.input)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  const plan = await planExtraction(String(page.responseBody), goal || name);

  if (!plan) {
    console.error(`  couldn't find a repeating structure to extract.`);
    process.exitCode = 1;
    return;
  }

  const rows = runExtraction(String(page.responseBody), plan);
  console.log(`  ${plan.item} matched ${plan.found} — ${dim(plan.why)}`);
  console.log(`  fields: ${Object.keys(plan.fields).join(", ")}\n`);

  const spec: Spec = {
    flow: name,
    origin: traces[0]!.origin,
    mode: "html",
    extraction: plan,
    target: { method: "GET", urlTemplate: stripQuery(page.url) },
    fields: pageParams(traces, pageOf),
    bootstrap: [],
    responseSchema: infer([rows]),
    unresolved: [],
    meta: {
      runs: traces.length,
      generatedAt: new Date().toISOString(),
      browserMs: median(traces.map((t) => t.exchanges.at(-1)?.t ?? 0)),
    },
  };

  const bound = spec.fields.filter((f) => f.kind === "param");
  if (bound.length) {
    console.log(
      `  ${dim("the page takes")} ${bound.map((f) => f.name).join(", ")} ${dim("— passing them through")}`,
    );
  }

  await mkdir("out", { recursive: true });
  await writeFile(join("out", `${name}.spec.json`), JSON.stringify(spec, null, 2));
  emit({ type: "spec", flow: name });
  console.log(`  wrote out/${name}.spec.json\n`);
}

// a server-rendered page can still take arguments — zed.dev/extensions?filter=
// narrows the list before it renders it. so if a query param on the page url
// moved with one of our inputs, it's an argument of the api, not decoration.
function pageParams(traces: Trace[], pageOf: (t: Trace) => Exchange | undefined): Field[] {
  const urls = traces.map((t) => {
    const pg = pageOf(t);
    return pg ? new URL(pg.url) : null;
  });
  if (urls.some((u) => !u)) return [];

  const keys = new Set<string>();
  for (const u of urls) for (const k of u!.searchParams.keys()) keys.add(k);

  const fields: Field[] = [];
  for (const key of keys) {
    const values = urls.map((u) => u!.searchParams.get(key) ?? "");
    // same in every run: part of the address, not an argument
    if (values.every((v) => v === values[0])) continue;

    for (const input of Object.keys(traces[0]!.input)) {
      const expected = traces.map((t) => t.input[input] ?? "");
      if (expected.every((e) => e === expected[0])) continue;
      if (values.every((v, i) => v === expected[i])) {
        fields.push({
          location: "query",
          name: key,
          kind: "param",
          samples: values,
          boundTo: input,
        });
        break;
      }
    }
  }
  return fields;
}
