var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// ../../src/runtime/execute.ts
async function execute(spec, params) {
  const started = Date.now();
  const session = {};
  const cookies = {};
  for (const step of spec.bootstrap) {
    const res2 = await fetch(step.url, { method: step.method });
    const text = await res2.text();
    const setCookie = res2.headers.get("set-cookie") ?? "";
    for (const field of spec.fields) {
      const src = field.source;
      if (src?.kind !== "derived") continue;
      if (!step.provides.includes(field.name)) continue;
      switch (src.via.in) {
        case "set-cookie": {
          const m = new RegExp(`${escapeRe(src.via.cookieName)}=([^;]+)`).exec(setCookie);
          if (m?.[1]) cookies[src.via.cookieName] = m[1];
          break;
        }
        case "header": {
          session[field.name] = res2.headers.get(src.via.header) ?? "";
          break;
        }
        case "html": {
          const m = new RegExp(src.via.pattern).exec(text);
          if (m?.[1]) session[field.name] = m[1];
          break;
        }
        case "json": {
          try {
            session[field.name] = String(pointer(JSON.parse(text), src.via.pointer) ?? "");
          } catch {
            session[field.name] = "";
          }
          break;
        }
      }
    }
  }
  const value = /* @__PURE__ */ __name((f) => {
    if (f.kind === "param") return params[f.boundTo ?? ""] ?? "";
    if (f.kind === "static") return f.samples[0] ?? "";
    const src = f.source;
    if (src?.kind === "timestamp") {
      return src.unit === "ms" ? String(Date.now()) : String(Math.floor(Date.now() / 1e3));
    }
    if (src?.kind === "derived") {
      return session[f.name] ?? cookies[f.name] ?? "";
    }
    return f.samples[0] ?? "";
  }, "value");
  const url = new URL(spec.target.urlTemplate);
  const headers = {};
  const body = {};
  for (const f of spec.fields) {
    if (f.location === "query") url.searchParams.set(f.name, value(f));
    if (f.location === "header") headers[f.name] = value(f);
    if (f.location === "body") body[f.name] = value(f);
    if (f.location === "cookie" && !cookies[f.name]) cookies[f.name] = value(f);
  }
  if (Object.keys(cookies).length) {
    headers["cookie"] = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
  }
  const hasBody = Object.keys(body).length > 0;
  const form = /x-www-form-urlencoded/i.test(headers["content-type"] ?? "");
  const res = await fetch(url, {
    method: spec.target.method,
    headers,
    body: hasBody ? form ? new URLSearchParams(body).toString() : JSON.stringify(body) : void 0
  });
  const raw = await res.text();
  let parsed = raw;
  try {
    parsed = JSON.parse(raw);
  } catch {
  }
  return { status: res.status, body: parsed, ms: Date.now() - started };
}
__name(execute, "execute");
function pointer(obj, path) {
  return path.split(".").reduce((acc, part) => {
    const m = /^([^[]*)((?:\[\d+\])*)$/.exec(part);
    let cur = m?.[1] ? acc?.[m[1]] : acc;
    for (const i of (m?.[2] ?? "").matchAll(/\[(\d+)\]/g)) cur = cur?.[Number(i[1])];
    return cur;
  }, obj);
}
__name(pointer, "pointer");
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
__name(escapeRe, "escapeRe");

// ../../src/analyze/schema.ts
function diff(schema, value, path = "$") {
  switch (schema.type) {
    case "unknown":
      return [];
    case "null":
      return value === null ? [] : [`${path}: expected null, got ${typeName(value)}`];
    case "string":
    case "number":
    case "boolean":
      return typeof value === schema.type ? [] : [`${path}: expected ${schema.type}, got ${typeName(value)}`];
    case "array":
      if (!Array.isArray(value)) return [`${path}: expected array, got ${typeName(value)}`];
      return value.length ? diff(schema.items, value[0], `${path}[0]`) : [];
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return [`${path}: expected object, got ${typeName(value)}`];
      }
      const actual = value;
      const notes = [];
      for (const key of schema.required) {
        if (!(key in actual)) notes.push(`${path}.${key}: missing`);
      }
      for (const [key, sub] of Object.entries(schema.properties)) {
        if (key in actual) notes.push(...diff(sub, actual[key], `${path}.${key}`));
      }
      return notes;
    }
  }
}
__name(diff, "diff");
function typeName(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}
__name(typeName, "typeName");

// index.ts
var index_default = {
  async fetch(request, env) {
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
  async scheduled(_event, env) {
    const { results } = await env.DB.prepare("select name from apis").all();
    for (const row of results ?? []) {
      await runCheck(env, row.name).catch(() => {
      });
    }
  }
};
async function status(env, url) {
  const total = await env.DB.prepare("select count(*) as n from apis").first();
  const drifted = await env.DB.prepare("select count(*) as n from apis where status != 'healthy'").first();
  return json({
    what: "beeline brain \u2014 remembers every api beeline has learned and keeps checking them",
    remembers: total?.n ?? 0,
    needsAttention: drifted?.n ?? 0,
    routes: {
      list: `${url.origin}/apis`,
      call: `${url.origin}/call/<name>?<params>`,
      check: `${url.origin}/check/<name>`
    }
  });
}
__name(status, "status");
async function register(request, env) {
  const spec = await request.json();
  await env.DB.prepare(
    `insert into apis (name, origin, target, spec, learned_at, status)
     values (?, ?, ?, ?, ?, 'unknown')
     on conflict(name) do update set
       spec = excluded.spec,
       target = excluded.target,
       learned_at = excluded.learned_at,
       status = 'unknown'`
  ).bind(
    spec.flow,
    spec.origin,
    spec.target.urlTemplate,
    JSON.stringify(spec),
    spec.meta.generatedAt
  ).run();
  return json({ registered: spec.flow, target: spec.target.urlTemplate });
}
__name(register, "register");
async function listApis(env) {
  const { results } = await env.DB.prepare(
    `select name, origin, target, learned_at, status, checked_at, note
     from apis order by name`
  ).all();
  return json({ apis: results ?? [] });
}
__name(listApis, "listApis");
async function showApi(env, name) {
  const api = await env.DB.prepare("select * from apis where name = ?").bind(name).first();
  if (!api) return json({ error: `never learned "${name}"` }, 404);
  const { results } = await env.DB.prepare("select ts, ok, status, ms, drift from checks where api = ? order by ts desc limit 20").bind(name).all();
  const { spec: _raw, ...rest } = api;
  return json({ ...rest, history: results ?? [] });
}
__name(showApi, "showApi");
async function call(env, name, url) {
  const spec = await loadSpec(env, name);
  if (!spec) return json({ error: `never learned "${name}"` }, 404);
  const params = Object.fromEntries(url.searchParams);
  const result = await execute(spec, params);
  return json({ ms: result.ms, status: result.status, data: result.body });
}
__name(call, "call");
async function checkOne(env, name) {
  const outcome = await runCheck(env, name);
  if (!outcome) return json({ error: `never learned "${name}"` }, 404);
  return json(outcome);
}
__name(checkOne, "checkOne");
async function runCheck(env, name) {
  const spec = await loadSpec(env, name);
  if (!spec) return null;
  const params = {};
  for (const f of spec.fields) {
    if (f.kind === "param" && f.boundTo) params[f.boundTo] = f.samples[0] ?? "";
  }
  let ok = false;
  let drift = [];
  let httpStatus = 0;
  let ms = 0;
  try {
    const result = await execute(spec, params);
    httpStatus = result.status;
    ms = result.ms;
    drift = result.status >= 400 ? [`http ${result.status}`] : spec.responseSchema.type === "null" ? [] : diff(spec.responseSchema, result.body);
    ok = drift.length === 0;
  } catch (err) {
    drift = [err instanceof Error ? err.message : String(err)];
  }
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const state = ok ? "healthy" : httpStatus >= 400 || !httpStatus ? "broken" : "drifted";
  await env.DB.batch([
    env.DB.prepare("insert into checks (api, ts, ok, status, ms, drift) values (?, ?, ?, ?, ?, ?)").bind(name, now, ok ? 1 : 0, httpStatus, ms, drift.join("; ") || null),
    env.DB.prepare("update apis set status = ?, checked_at = ?, note = ? where name = ?").bind(state, now, drift.join("; ") || null, name)
  ]);
  return { api: name, ok, status: state, httpStatus, ms, drift };
}
__name(runCheck, "runCheck");
async function loadSpec(env, name) {
  const row = await env.DB.prepare("select spec from apis where name = ?").bind(name).first();
  return row ? JSON.parse(row.spec) : null;
}
__name(loadSpec, "loadSpec");
function json(body, status2 = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status: status2,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*"
    }
  });
}
__name(json, "json");

// ../../../../../AppData/Local/npm-cache/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../../../../AppData/Local/npm-cache/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-kmt9LF/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = index_default;

// ../../../../../AppData/Local/npm-cache/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-kmt9LF/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
