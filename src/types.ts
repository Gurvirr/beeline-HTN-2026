/**
 * Core data model.
 *
 *   Flow  ──capture──>  Trace[]  ──analyze──>  Spec  ──synth──>  client.ts
 *
 * A Trace is one recorded run of a flow with one set of inputs.
 * A Spec is the protocol we inferred by diffing several Traces.
 */

// ─────────────────────────────── capture ───────────────────────────────

/** One request/response exchange observed on the wire. */
export interface Exchange {
  /** Stable within a trace; used to reference this exchange from a Spec. */
  id: string;
  /** ms since the flow started — lets us correlate against user actions. */
  t: number;
  method: string;
  url: string;
  /** Path only, no origin or query. Used to match exchanges across runs. */
  path: string;
  /** Parsed query params. */
  query: Record<string, string>;
  requestHeaders: Record<string, string>;
  /** Parsed as JSON when possible, else the raw string, else null. */
  requestBody: unknown;
  status: number;
  responseHeaders: Record<string, string>;
  responseBody: unknown;
  /** Playwright resource type: xhr, fetch, document, script, ... */
  resourceType: string;
  durationMs: number;
}

/** One recorded run of a flow. */
export interface Trace {
  runId: string;
  /** Name of the flow that produced this. */
  flow: string;
  /** The inputs this run was driven with. Analyzer diffs against these. */
  input: Record<string, string>;
  origin: string;
  startedAt: string;
  exchanges: Exchange[];
  /**
   * Exchange id nominated by flow.pick(), if the flow supplied one. Recorded
   * here so the analyzer depends only on traces, not on the flow module.
   */
  targetHint?: string;
  /** Cookies present when the flow finished. */
  cookies: { name: string; value: string; domain: string; path: string }[];
}

/** A flow is a scripted user journey, parameterised by input. */
export interface Flow {
  name: string;
  /** Page to open before running. */
  entry: string;
  /** Input sets to drive the flow with. Need >= 3 for useful diffing. */
  inputs: Record<string, string>[];
  /** Drive the UI. `page` is a Playwright Page, kept loose to avoid a hard dep here. */
  run: (page: any, input: Record<string, string>) => Promise<void>;
  /**
   * Optional: identify the request that did the real work. Given the
   * exchanges of a run, return one id. If omitted, the analyzer guesses.
   */
  pick?: (exchanges: Exchange[], input: Record<string, string>) => string | undefined;
}

// ─────────────────────────────── analyze ───────────────────────────────

/**
 * How a single field behaved across runs. This classification is the
 * heart of the project.
 */
export type FieldKind =
  /** Identical in every run. Freeze it into the generated client. */
  | "static"
  /** Tracked one of the flow inputs. Becomes a function argument. */
  | "param"
  /** Changed between runs but not with the input. Token, nonce, clock. */
  | "volatile";

/** Where in a request a field lives. */
export type FieldLocation = "header" | "query" | "body" | "cookie";

/** How we can reproduce a volatile value without a browser. */
export type VolatileSource =
  /** Looks like a unix timestamp. Emit Date.now(). */
  | { kind: "timestamp"; unit: "ms" | "s" }
  /** Found verbatim in an earlier response. Extract it, then reuse. */
  | {
      kind: "derived";
      /** Exchange it came from. */
      fromExchangeId: string;
      fromMethod: string;
      fromPath: string;
      /** Where in that response we found it. */
      via:
        | { in: "set-cookie"; cookieName: string }
        | { in: "header"; header: string }
        | { in: "json"; pointer: string }
        | { in: "html"; pattern: string };
    }
  /** Random per request with no traceable source. The hard case. */
  | { kind: "unresolved"; note: string };

export interface Field {
  location: FieldLocation;
  /** Header name, query key, or dotted JSON path into the body. */
  name: string;
  kind: FieldKind;
  /** Observed values, one per run, in run order. */
  samples: string[];
  /** Set when kind === "param": which flow input this tracked. */
  boundTo?: string;
  /** Set when kind === "volatile": how to reproduce it. */
  source?: VolatileSource;
}

/** A request that must run before the target, to obtain session material. */
export interface BootstrapStep {
  method: string;
  url: string;
  /** What this step yields, keyed by the volatile field it satisfies. */
  provides: string[];
}

/** The inferred protocol. This is what synth compiles. */
export interface Spec {
  flow: string;
  origin: string;
  target: {
    method: string;
    /** Absolute URL with :param placeholders where inputs appeared in the path. */
    urlTemplate: string;
  };
  fields: Field[];
  bootstrap: BootstrapStep[];
  /** Inferred TypeScript type of the response body. */
  responseSchema: JsonSchema;
  /** Fields we could not reproduce. Non-empty means the client may fail. */
  unresolved: Field[];
  meta: {
    runs: number;
    generatedAt: string;
    /** Wall time of the browser path, for the speed comparison. */
    browserMs: number;
  };
}

// ─────────────────────────────── schema ───────────────────────────────

export type JsonSchema =
  | { type: "string" | "number" | "boolean" | "null" }
  | { type: "array"; items: JsonSchema }
  | { type: "object"; properties: Record<string, JsonSchema>; required: string[] }
  | { type: "unknown" };

// ─────────────────────────────── verify ───────────────────────────────

export interface VerifyResult {
  ok: boolean;
  status: number;
  /** Mismatches between the live response and the captured schema. */
  drift: string[];
  httpMs: number;
  browserMs: number;
  speedup: number;
}
