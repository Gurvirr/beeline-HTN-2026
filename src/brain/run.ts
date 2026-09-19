// talk to the brain.
//   beeline remember steam     teach it an api
//   beeline health             what it remembers and how they're doing
//   beeline check steam        make it go look right now
//
// BEELINE_BRAIN points at the worker; defaults to the local dev one.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const BRAIN = process.env.BEELINE_BRAIN ?? "http://localhost:8788";
const [action, name] = process.argv.slice(2);

const C = { dim: "\x1b[2m", green: "\x1b[32m", amber: "\x1b[33m", red: "\x1b[31m", r: "\x1b[0m" };

try {
  if (action === "remember") await remember();
  else if (action === "health") await health();
  else if (action === "check") await check();
  else {
    console.error("usage: beeline remember|health|check [flow]");
    process.exit(1);
  }
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`\n  ${C.red}${msg}${C.r}`);
  console.error(`  ${C.dim}is the brain running? npx wrangler dev in workers/brain${C.r}\n`);
  process.exit(1);
}

async function remember() {
  if (!name) throw new Error("which flow?");
  const spec = await readFile(join("out", `${name}.spec.json`), "utf8");

  const res = await fetch(`${BRAIN}/apis`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: spec,
  });

  const body = (await res.json()) as { registered?: string; target?: string };
  console.log(`\n  remembered ${C.green}${body.registered}${C.r}`);
  console.log(`  ${C.dim}${body.target}${C.r}\n`);
}

async function health() {
  const res = await fetch(`${BRAIN}/apis`);
  const { apis } = (await res.json()) as { apis: any[] };

  if (!apis.length) {
    console.log(`\n  ${C.dim}nothing learned yet — beeline remember <flow>${C.r}\n`);
    return;
  }

  console.log();
  for (const a of apis) {
    const colour =
      a.status === "healthy" ? C.green : a.status === "drifted" ? C.amber : C.red;
    console.log(
      `  ${colour}●${C.r} ${a.name.padEnd(16)} ${C.dim}${a.status.padEnd(9)}${C.r}` +
        (a.note ? ` ${C.amber}${a.note}${C.r}` : ""),
    );
    console.log(`    ${C.dim}${a.target}${C.r}`);
  }
  console.log();
}

async function check() {
  if (!name) throw new Error("which flow?");
  const res = await fetch(`${BRAIN}/check/${name}`, { method: "POST" });
  const r = (await res.json()) as any;

  console.log();
  if (r.ok) {
    console.log(`  ${C.green}healthy${C.r}  ${r.api} · ${r.ms}ms`);
  } else {
    console.log(`  ${C.amber}${r.status}${C.r}  ${r.api}`);
    for (const d of r.drift ?? []) console.log(`    ${C.amber}${d}${C.r}`);
  }
  console.log();
}
