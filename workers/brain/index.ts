// beeline's brain.
//
// it remembers every api beeline has learned, serves them, and — on a cron —
// goes and checks whether the sites behind them still behave the way they did
// when it learned them. when one drifts it records what changed and marks it.
//
//   POST /apis          register a spec
//   GET  /apis          what it remembers
//   GET  /apis/:name    one api, with its check history
//   GET  /call/:name    actually call it
//   POST /check/:name   check it right now
//   POST /heal/:name    relearn the shape if that is all that changed
//   DEL  /apis/:name    forget one
//   GET  /              status

import { execute } from "../../src/runtime/execute.js";
import { diff, infer } from "../../src/analyze/schema.js";
import type { Spec } from "../../src/types.js";

interface Env {
  DB: D1Database;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const [, head, tail] = url.pathname.split("/");

    try {
      if (!head) {
        // curl wants json, a judge on a projector wants something to look at
        const wantsHtml = (request.headers.get("accept") ?? "").includes("text/html");
        return wantsHtml ? await page(env, url) : await status(env, url);
      }
      if (head === "apis" && request.method === "POST") return await register(request, env);
      if (head === "apis" && !tail) return await listApis(env);
      if (head === "apis" && tail && request.method === "DELETE")
        return await forget(env, tail);
      if (head === "apis" && tail) return await showApi(env, tail);
      if (head === "call" && tail) return await call(env, tail, url);
      if (head === "check" && tail) return await checkOne(env, tail);
      if (head === "heal" && tail) return await healOne(env, tail);
    } catch (err) {
      return json({ error: String(err instanceof Error ? err.message : err) }, 500);
    }

    return json({ error: "not found" }, 404);
  },

  // the heartbeat. nobody asked — it just goes and looks
  async scheduled(_event: ScheduledController, env: Env) {
    const { results } = await env.DB.prepare("select name from apis").all<{ name: string }>();
    for (const row of results ?? []) {
      const outcome = await runCheck(env, row.name).catch(() => null);
      // the site moved but we can still reach it — relearn the shape ourselves
      if (outcome && outcome.status === "drifted") {
        await heal(env, row.name).catch(() => {});
      }
    }
  },
};

async function status(env: Env, url: URL) {
  const total = await env.DB.prepare("select count(*) as n from apis").first<{ n: number }>();
  const drifted = await env.DB
    .prepare("select count(*) as n from apis where status != 'healthy'")
    .first<{ n: number }>();

  return json({
    what: "beeline brain — remembers every api beeline has learned and keeps checking them",
    remembers: total?.n ?? 0,
    needsAttention: drifted?.n ?? 0,
    routes: {
      list: `${url.origin}/apis`,
      call: `${url.origin}/call/<name>?<params>`,
      check: `${url.origin}/check/<name>`,
    },
  });
}

async function register(request: Request, env: Env) {
  const spec = (await request.json()) as Spec;

  await env.DB.prepare(
    `insert into apis (name, origin, target, spec, learned_at, status)
     values (?, ?, ?, ?, ?, 'unknown')
     on conflict(name) do update set
       spec = excluded.spec,
       target = excluded.target,
       learned_at = excluded.learned_at,
       status = 'unknown'`,
  )
    .bind(
      spec.flow,
      spec.origin,
      spec.target.urlTemplate,
      JSON.stringify(spec),
      spec.meta.generatedAt,
    )
    .run();

  return json({ registered: spec.flow, target: spec.target.urlTemplate });
}

async function listApis(env: Env) {
  const { results } = await env.DB.prepare(
    `select name, origin, target, learned_at, status, checked_at, note
     from apis order by name`,
  ).all();
  return json({ apis: results ?? [] });
}

async function showApi(env: Env, name: string) {
  const api = await env.DB.prepare("select * from apis where name = ?").bind(name).first();
  if (!api) return json({ error: `never learned "${name}"` }, 404);

  const { results } = await env.DB
    .prepare("select ts, ok, status, ms, drift from checks where api = ? order by ts desc limit 20")
    .bind(name)
    .all();

  const { spec: _raw, ...rest } = api as Record<string, unknown>;
  return json({ ...rest, history: results ?? [] });
}

// so a demo can be run twice without leftovers
async function forget(env: Env, name: string) {
  await env.DB.batch([
    env.DB.prepare("delete from checks where api = ?").bind(name),
    env.DB.prepare("delete from apis where name = ?").bind(name),
  ]);
  return json({ forgot: name });
}

async function call(env: Env, name: string, url: URL) {
  const spec = await loadSpec(env, name);
  if (!spec) return json({ error: `never learned "${name}"` }, 404);

  const params = Object.fromEntries(url.searchParams);
  const result = await execute(spec, params);
  return json({ ms: result.ms, status: result.status, data: result.body });
}

async function checkOne(env: Env, name: string) {
  const outcome = await runCheck(env, name);
  if (!outcome) return json({ error: `never learned "${name}"` }, 404);
  return json(outcome);
}

// call the api and compare what came back to what we learned. this is the
// whole point: the site can change without telling anyone, and the only way
// to know is to keep asking
async function runCheck(env: Env, name: string) {
  const spec = await loadSpec(env, name);
  if (!spec) return null;

  // replay the inputs it was learned with
  const params: Record<string, string> = {};
  for (const f of spec.fields) {
    if (f.kind === "param" && f.boundTo) params[f.boundTo] = f.samples[0] ?? "";
  }

  let ok = false;
  let drift: string[] = [];
  let httpStatus = 0;
  let ms = 0;

  try {
    const result = await execute(spec, params);
    httpStatus = result.status;
    ms = result.ms;
    drift =
      result.status >= 400
        ? [`http ${result.status}`]
        : spec.responseSchema.type === "null"
          ? []
          : diff(spec.responseSchema, result.body);
    ok = drift.length === 0;
  } catch (err) {
    drift = [err instanceof Error ? err.message : String(err)];
  }

  const now = new Date().toISOString();
  const state = ok ? "healthy" : httpStatus >= 400 || !httpStatus ? "broken" : "drifted";

  await env.DB.batch([
    env.DB
      .prepare("insert into checks (api, ts, ok, status, ms, drift) values (?, ?, ?, ?, ?, ?)")
      .bind(name, now, ok ? 1 : 0, httpStatus, ms, drift.join("; ") || null),
    env.DB
      .prepare("update apis set status = ?, checked_at = ?, note = ? where name = ?")
      .bind(state, now, drift.join("; ") || null, name),
  ]);

  return { api: name, ok, status: state, httpStatus, ms, drift };
}

async function healOne(env: Env, name: string) {
  const outcome = await heal(env, name);
  if (!outcome) return json({ error: `never learned "${name}"` }, 404);
  return json(outcome);
}

// self-repair, for the case we can actually repair.
//
// if the request still works and only the response shape moved, nothing about
// *how to ask* is wrong — the schema we learned is just out of date. re-infer
// it from what the site returns now and carry on.
//
// if the request itself broke (auth changed, endpoint moved) there is nothing
// to infer from and it needs a real re-capture, which needs a browser.
async function heal(env: Env, name: string) {
  const spec = await loadSpec(env, name);
  if (!spec) return null;

  const params: Record<string, string> = {};
  for (const f of spec.fields) {
    if (f.kind === "param" && f.boundTo) params[f.boundTo] = f.samples[0] ?? "";
  }

  const result = await execute(spec, params);

  if (result.status >= 400) {
    return {
      api: name,
      healed: false,
      reason: `the request itself is failing (http ${result.status}) — needs a re-capture, not a reshape`,
    };
  }

  const before = spec.responseSchema;
  const after = infer([result.body]);
  const changes = diff(before, result.body);

  if (changes.length === 0) {
    return { api: name, healed: false, reason: "nothing to fix — shape still matches" };
  }

  spec.responseSchema = after;
  const now = new Date().toISOString();

  await env.DB.batch([
    env.DB
      .prepare("update apis set spec = ?, status = 'healthy', checked_at = ?, note = ? where name = ?")
      .bind(JSON.stringify(spec), now, `healed: ${changes.join("; ")}`, name),
    env.DB
      .prepare("insert into checks (api, ts, ok, status, ms, drift) values (?, ?, 1, ?, ?, ?)")
      .bind(name, now, result.status, result.ms, `healed: ${changes.join("; ")}`),
  ]);

  return { api: name, healed: true, changes, note: "schema relearned from the live response" };
}

async function loadSpec(env: Env, name: string): Promise<Spec | null> {
  const row = await env.DB.prepare("select spec from apis where name = ?")
    .bind(name)
    .first<{ spec: string }>();
  return row ? (JSON.parse(row.spec) as Spec) : null;
}

// the status page. same data as GET / with curl, laid out for humans
async function page(env: Env, url: URL) {
  const { results } = await env.DB.prepare(
    `select name, origin, target, learned_at, status, checked_at, note, spec
     from apis order by name`,
  ).all<Record<string, string>>();

  const apis = results ?? [];
  const healthy = apis.filter((a) => a.status === "healthy").length;
  const attention = apis.filter((a) => a.status !== "healthy" && a.status !== "unknown").length;

  const rows = apis.length
    ? apis
        .map((a) => {
          const params = paramsOf(a.spec as string | undefined);
          return `
      <div class="api ${a.status}">
        <div class="dot"></div>
        <div class="body">
          <div class="name">${esc(a.name)}</div>
          <a class="target" href="${esc(a.target)}">${esc(a.target)}</a>
          ${a.note ? `<div class="note">${esc(a.note)}</div>` : ""}
          <div class="try">${esc(url.origin)}/call/${esc(a.name)}${params}</div>
        </div>
        <div class="meta">
          <div class="state">${esc(a.status)}</div>
          <div class="when">${a.checked_at ? ago(a.checked_at) : "never checked"}</div>
        </div>
      </div>`;
        })
        .join("")
    : `<div class="empty">nothing learned yet — <code>beeline remember &lt;flow&gt;</code></div>`;

  const html = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>beeline brain</title>
<style>
  :root{--bg:#0b0e12;--panel:#12171d;--line:#232c36;--ink:#e6edf3;--dim:#7d8b99;
    --cyan:#3fd8e8;--green:#4ade80;--amber:#f2b13c;--red:#f87171;
    --mono:ui-monospace,"SF Mono","Cascadia Mono",Menlo,monospace}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--mono);
    font-size:13px;line-height:1.55;padding:32px 20px}
  .wrap{max-width:820px;margin:0 auto}
  h1{font-size:19px;margin:0 0 4px;letter-spacing:-.02em}
  h1 em{color:var(--cyan);font-style:normal}
  .sub{color:var(--dim);margin:0 0 24px;max-width:60ch}
  .stats{display:flex;gap:1px;background:var(--line);border:1px solid var(--line);
    border-radius:5px;overflow:hidden;margin-bottom:22px}
  .stat{flex:1;background:var(--panel);padding:13px 16px}
  .stat .n{font-size:22px;font-weight:700;letter-spacing:-.02em}
  .stat .l{color:var(--dim);font-size:10.5px;letter-spacing:.1em;text-transform:uppercase}
  .stat.ok .n{color:var(--green)} .stat.warn .n{color:var(--amber)}
  .api{display:flex;gap:13px;align-items:flex-start;background:var(--panel);
    border:1px solid var(--line);border-radius:5px;padding:14px 16px;margin-bottom:8px}
  .dot{width:8px;height:8px;border-radius:50%;margin-top:6px;flex-shrink:0;background:var(--dim)}
  .api.healthy .dot{background:var(--green)}
  .api.drifted .dot{background:var(--amber)}
  .api.broken .dot{background:var(--red)}
  .body{flex:1;min-width:0}
  .name{font-weight:600;font-size:14px}
  .target,.try{color:var(--dim);font-size:11.5px;word-break:break-all;display:block}
  .target{text-decoration:none}
  .target:hover{color:var(--cyan)}
  .try{margin-top:5px;color:var(--cyan);opacity:.85}
  .note{color:var(--amber);font-size:11.5px;margin-top:3px}
  .meta{text-align:right;flex-shrink:0}
  .state{font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--dim)}
  .when{color:var(--dim);font-size:11px;opacity:.7}
  .empty{color:var(--dim);padding:26px;text-align:center;background:var(--panel);
    border:1px solid var(--line);border-radius:5px}
  code{background:#1a232c;padding:1px 5px;border-radius:3px}
  footer{color:var(--dim);font-size:11.5px;margin-top:24px;padding-top:16px;
    border-top:1px solid var(--line)}
</style></head><body><div class="wrap">
  <h1>bee<em>line</em> brain</h1>
  <p class="sub">every api beeline has learned by watching a browser once. it keeps
  calling them to check the sites still behave the way they did.</p>
  <div class="stats">
    <div class="stat"><div class="n">${apis.length}</div><div class="l">remembered</div></div>
    <div class="stat ok"><div class="n">${healthy}</div><div class="l">healthy</div></div>
    <div class="stat warn"><div class="n">${attention}</div><div class="l">drifted</div></div>
  </div>
  ${rows}
  <footer>re-checks everything every 15 minutes &middot; <code>curl ${esc(url.origin)}/apis</code> for json</footer>
</div></body></html>`;

  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function paramsOf(spec?: string): string {
  if (!spec) return "";
  try {
    const parsed = JSON.parse(spec) as Spec;
    const names = [
      ...new Set(parsed.fields.filter((f) => f.kind === "param" && f.boundTo).map((f) => f.boundTo!)),
    ];
    return names.length ? `?${names.map((n) => `${n}=...`).join("&")}` : "";
  } catch {
    return "";
  }
}

function ago(iso: string): string {
  const secs = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function esc(s: unknown): string {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
    },
  });
}
