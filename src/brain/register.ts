// hand a finished spec to the brain.
//
// learning something and then having to remember it separately meant the curl
// on screen was a lie until you ran a second command — the brain would answer
// `never learned "zed"` for an api you had just watched it build. so the
// pipeline does this itself now, and `beeline remember` is the manual door
// into the same function.
//
// it is deliberately soft: a brain that is down, unreachable or not
// configured must not fail a run that otherwise worked. you still have the
// spec and the client on disk either way.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface Registered {
  ok: boolean;
  name?: string;
  target?: string;
  why?: string;
}

export function brainUrl(): string {
  return process.env.BEELINE_BRAIN ?? "http://localhost:8788";
}

export async function register(flow: string): Promise<Registered> {
  let spec: string;
  try {
    spec = await readFile(join("out", `${flow}.spec.json`), "utf8");
  } catch {
    return { ok: false, why: "no spec on disk" };
  }

  try {
    const res = await fetch(`${brainUrl()}/apis`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: spec,
      signal: AbortSignal.timeout(12_000),
    });

    if (!res.ok) return { ok: false, why: `brain said ${res.status}` };

    const body = (await res.json()) as { registered?: string; target?: string };

    // registering is not the same as working. the brain bundles its own copy
    // of the executor, so a spec using something newer than the deployed
    // worker will register happily and then answer with nonsense. call it
    // once and look before telling anyone the url is good.
    const proof = await serves(flow, JSON.parse(spec));
    if (!proof) {
      await forget(flow);
      return { ok: false, why: "the deployed brain can't run this spec yet — redeploy it" };
    }

    return { ok: true, name: body.registered ?? flow, target: body.target };
  } catch (err) {
    // unreachable, no dns, timed out — all the same outcome from here
    return { ok: false, why: err instanceof Error ? err.message : "unreachable" };
  }
}

// does the brain actually answer correctly for this one?
async function serves(flow: string, spec: any): Promise<boolean> {
  const url = new URL(`${brainUrl()}/call/${flow}`);
  for (const f of spec.fields ?? []) {
    if (f.kind === "param" && f.boundTo && !f.optional && f.samples?.[0]) {
      url.searchParams.set(f.boundTo, f.samples[0]);
    }
  }

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return false;
    const body = (await res.json()) as { data?: unknown };

    // the client returns rows or an object. a bare string means the executor
    // handed back the raw body without understanding it — which is exactly
    // what an old worker does with an html spec.
    return body.data !== undefined && typeof body.data !== "string";
  } catch {
    return false;
  }
}

export async function forget(flow: string): Promise<void> {
  await fetch(`${brainUrl()}/apis/${flow}`, {
    method: "DELETE",
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {});
}
