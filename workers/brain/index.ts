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
//   GET  /              status

import { execute } from "../../src/runtime/execute.js";
import { diff } from "../../src/analyze/schema.js";
import type { Spec } from "../../src/types.js";

interface Env {
  DB: D1Database;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const [, head, tail] = url.pathname.split("/");

    try {
      if (!head) return await status(env, url);
      if (head === "apis" && request.method === "POST") return await register(request, env);
      if (head === "apis" && !tail) return await listApis(env);
      if (head === "apis" && tail) return await showApi(env, tail);
      if (head === "call" && tail) return await call(env, tail, url);
      if (head === "check" && tail) return await checkOne(env, tail);
    } catch (err) {
      return json({ error: String(err instanceof Error ? err.message : err) }, 500);
    }

    return json({ error: "not found" }, 404);
  },

  // the heartbeat. nobody asked — it just goes and looks
  async scheduled(_event: ScheduledController, env: Env) {
    const { results } = await env.DB.prepare("select name from apis").all<{ name: string }>();
    for (const row of results ?? []) {
      await runCheck(env, row.name).catch(() => {});
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

async function loadSpec(env: Env, name: string): Promise<Spec | null> {
  const row = await env.DB.prepare("select spec from apis where name = ?")
    .bind(name)
    .first<{ spec: string }>();
  return row ? (JSON.parse(row.spec) as Spec) : null;
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
