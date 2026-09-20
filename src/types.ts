// core data model
// flow --capture--> traces --analyze--> spec --synth--> client.ts

// --- capture ---

// one request/response exchange observed on the wire
export interface Exchange {
  // stable within a trace; used to reference this exchange from a Spec
  id: string;
  // ms since the flow started — lets us correlate against user actions
  t: number;
  method: string;
  url: string;
  // path only, no origin or query. used to match exchanges across runs
  path: string;
  // parsed query params
  query: Record<string, string>;
  requestHeaders: Record<string, string>;
  // parsed as JSON when possible, else the raw string, else null
  requestBody: unknown;
  status: number;
  responseHeaders: Record<string, string>;
  responseBody: unknown;
  // playwright resource type: xhr, fetch, document, script, 
  resourceType: string;
  durationMs: number;
}

// one recorded run of a flow
export interface Trace {
  runId: string;
  // name of the flow that produced this
  flow: string;
  // the inputs this run was driven with. analyzer diffs against these
  input: Record<string, string>;
  origin: string;
  startedAt: string;
  exchanges: Exchange[];
  // exchange id nominated by flow.pick(), if the flow supplied one. recorded
  // here so the analyzer depends only on traces, not on the flow module
  targetHint?: string;
  // cookies present when the flow finished
  cookies: { name: string; value: string; domain: string; path: string }[];
}

// a flow is a scripted user journey, parameterised by input
export interface Flow {
  name: string;
  // page to open before running
  entry: string;
  // input sets to drive the flow with. need >= 3 for useful diffing
  inputs: Record<string, string>[];
  // drive the UI yourself. `page` is a Playwright Page, kept loose here
  run?: (page: any, input: Record<string, string>) => Promise<void>;
  // or just say what to do and let stagehand figure it out.
  // placeholders like {q} are filled from input. needs --cloud
  task?: string;
  // optional: identify the request that did the real work. given the
  // exchanges of a run, return one id. if omitted, the analyzer guesses
  pick?: (exchanges: Exchange[], input: Record<string, string>) => string | undefined;
}

// --- analyze ---

// how a single field behaved across runs. this classification is the
// heart of the project
export type FieldKind =
  // identical in every run. freeze it into the generated client
  | "static"
  // tracked one of the flow inputs. becomes a function argument
  | "param"
  // changed between runs but not with the input. token, nonce, clock
  | "volatile";

// where in a request a field lives
export type FieldLocation = "header" | "query" | "body" | "cookie";

// how we can reproduce a volatile value without a browser
export type VolatileSource =
  // looks like a unix timestamp. emit Date.now()
  | { kind: "timestamp"; unit: "ms" | "s" }
  // found verbatim in an earlier response. extract it, then reuse
  | {
      kind: "derived";
      // exchange it came from
      fromExchangeId: string;
      fromMethod: string;
      fromPath: string;
      // where in that response we found it
      via:
        | { in: "set-cookie"; cookieName: string }
        | { in: "header"; header: string }
        | { in: "json"; pointer: string }
        | { in: "html"; pattern: string };
    }
  // random per request with no traceable source. the hard case
  | { kind: "unresolved"; note: string };

export interface Field {
  location: FieldLocation;
  // header name, query key, or dotted JSON path into the body
  name: string;
  kind: FieldKind;
  // observed values, one per run, in run order
  samples: string[];
  // set when kind === "param": which flow input this tracked
  boundTo?: string;
  // set when kind === "volatile": how to reproduce it
  source?: VolatileSource;
}

// a request that must run before the target, to obtain session material
export interface BootstrapStep {
  method: string;
  url: string;
  // what this step yields, keyed by the volatile field it satisfies
  provides: string[];
}

// the inferred protocol. this is what synth compiles
export interface Spec {
  flow: string;
  origin: string;
  // api  the page called an endpoint and we recovered it. fast, sturdy.
  // html  there was no endpoint, so we pull the data out of the page itself.
  //       more brittle, and the client has to parse — but better than nothing.
  mode?: "api" | "html";
  extraction?: import("./analyze/extract.js").Extraction;
  target: {
    method: string;
    // absolute URL with :param placeholders where inputs appeared in the path
    urlTemplate: string;
  };
  fields: Field[];
  bootstrap: BootstrapStep[];
  // inferred TypeScript type of the response body
  responseSchema: JsonSchema;
  // fields we could not reproduce. non-empty means the client may fail
  unresolved: Field[];
  meta: {
    runs: number;
    generatedAt: string;
    // wall time of the browser path, for the speed comparison
    browserMs: number;
  };
}

// --- schema ---

export type JsonSchema =
  | { type: "string" | "number" | "boolean" | "null" }
  | { type: "array"; items: JsonSchema }
  | { type: "object"; properties: Record<string, JsonSchema>; required: string[] }
  | { type: "unknown" };

// --- verify ---

export interface VerifyResult {
  ok: boolean;
  status: number;
  // mismatches between the live response and the captured schema
  drift: string[];
  httpMs: number;
  browserMs: number;
  speedup: number;
}
