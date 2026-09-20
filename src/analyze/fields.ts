import type { Exchange, FieldLocation } from "../types.js";

// a single addressable value inside a request, before we classify it
export interface Candidate {
  location: FieldLocation;
  // header name, query key, cookie name, or dotted path into the body
  name: string;
  value: string;
}

// headers every HTTP client sets for itself. classifying them is noise — they
// vary for reasons that have nothing to do with the site's protocol
const CLIENT_NOISE = new Set([
  // HTTP/2 pseudo-headers. these are transport framing, not protocol — :path
  // duplicates the URL and would otherwise be classified as a second copy of
  // whatever parameter is in the query string
  ":authority",
  ":method",
  ":path",
  ":scheme",
  "accept-encoding",
  "connection",
  "host",
  "content-length",
  "sec-fetch-dest",
  "sec-fetch-mode",
  "sec-fetch-site",
  "sec-fetch-user",
  "sec-ch-ua",
  "sec-ch-ua-mobile",
  "sec-ch-ua-platform",
  "upgrade-insecure-requests",
  "priority",
]);

// pull every addressable value out of a request
export function extract(exchange: Exchange): Candidate[] {
  const out: Candidate[] = [];

  for (const [rawName, value] of Object.entries(exchange.requestHeaders)) {
    const name = rawName.toLowerCase();
    if (CLIENT_NOISE.has(name)) continue;

    // cookies are many values in a trenchcoat; split so each is classified
    // on its own. a session id and a consent flag behave very differently
    if (name === "cookie") {
      for (const pair of value.split(";")) {
        const eq = pair.indexOf("=");
        if (eq === -1) continue;
        const cookieName = pair.slice(0, eq).trim();
        if (isTracking(cookieName)) continue;
        out.push({
          location: "cookie",
          name: cookieName,
          value: pair.slice(eq + 1).trim(),
        });
      }
      continue;
    }

    out.push({ location: "header", name, value });
  }

  for (const [name, value] of Object.entries(exchange.query)) {
    out.push({ location: "query", name, value });
  }

  for (const [name, value] of flatten(exchange.requestBody)) {
    out.push({ location: "body", name, value });
  }

  return out;
}

// flatten JSON into dotted paths. arrays use [i] so a regenerated client can
// rebuild the exact shape
//   {a: {b: [1, 2]}}  ->  a.b[0]=1, a.b[1]=2
export function flatten(value: unknown, prefix = ""): [string, string][] {
  if (value === null || value === undefined) return prefix ? [[prefix, ""]] : [];

  if (typeof value !== "object") {
    return [[prefix || "$", String(value)]];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item, i) => flatten(item, `${prefix}[${i}]`));
  }

  // a form-encoded or otherwise non-JSON body arrives as a string and is
  // handled above; this branch is plain objects only
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
    flatten(v, prefix ? `${prefix}.${k}` : k),
  );
}

// pick the request that did the real work.
// trust order: flow.pick, then a response echoing an input, then biggest json
export function pickTarget(
  exchanges: Exchange[],
  input: Record<string, string>,
  hint?: string,
  origin?: string,
): Exchange | undefined {
  if (hint) {
    const hinted = exchanges.find((x) => x.id === hint);
    if (hinted) return hinted;
  }

  // the endpoint we want is the site's own. a busy page fires hundreds of
  // requests at ad networks, consent vendors and analytics — none of which
  // are ever the thing the user asked for
  if (origin) {
    const own = exchanges.filter((x) => sameSite(x.url, origin));
    if (own.length) exchanges = own;
  }

  // 3xx counts: a form POST that redirects on success is still the request
  // that did the work, and it carries the session material we care about
  const candidates = exchanges.filter((x) => x.status >= 200 && x.status < 400);
  const inputValues = Object.values(input).filter(Boolean);

  const bodyOf = (x: Exchange) => JSON.stringify(x.responseBody ?? "");
  const requestOf = (x: Exchange) =>
    JSON.stringify(x.requestBody ?? "") + JSON.stringify(x.query);

  // xhr and fetch are the obvious ones, but navigating straight at an endpoint
  // makes it a document — and a document that parsed into json is data, not a
  // page. that's the whole shape of a url-driven capture.
  // telemetry endpoints take a payload and answer with nothing. whatever the
  // user asked for, it is something the server sends back
  const returnsData = (x: Exchange) => {
    const b = x.responseBody;
    if (b === null || b === undefined) return false;
    if (typeof b === "string") return b.length > 40;
    return Object.keys(b as object).length > 0;
  };

  const dataFetches = candidates.filter(
    (x) =>
      returnsData(x) &&
      (x.resourceType === "xhr" ||
        x.resourceType === "fetch" ||
        (x.resourceType === "document" && typeof x.responseBody === "object")),
  );

  // the input came back in the response: this request answered the question
  const answered = dataFetches.filter((x) =>
    inputValues.some((v) => bodyOf(x).includes(v)),
  );
  if (answered.length) {
    // a page's own render payload can mention the input too. json that parsed
    // into an object is an api answering; a big string is a page describing.
    const structured = answered.filter((x) => typeof x.responseBody === "object");
    return largestBody(structured.length ? structured : answered);
  }

  // the input went out in a state-changing request: this request *was* the
  // action. covers form submissions, which are documents rather than XHR.
  const submitted = candidates.filter(
    (x) =>
      x.method !== "GET" &&
      returnsData(x) &&
      inputValues.some((v) => v.length >= 3 && requestOf(x).includes(v)),
  );
  if (submitted.length) return submitted[0];

  if (dataFetches.length) return largestBody(dataFetches);

  // nothing echoed the input, but something changed state and answered with
  // something. if even that is missing there is no api here — say so by
  // returning nothing, and the html fallback takes over.
  return candidates.find((x) => x.method !== "GET" && returnsData(x));
}

function largestBody(pool: Exchange[]): Exchange | undefined {
  return [...pool].sort(
    (a, b) =>
      JSON.stringify(b.responseBody ?? "").length -
      JSON.stringify(a.responseBody ?? "").length,
  )[0];
}

// analytics cookies are set by scripts on the page, never checked by the api.
// they're unresolvable by definition and just make the output look broken
const TRACKING = [
  /^_ga($|_)/,
  /^_gid$/,
  /^_gat/,
  /^_gcl_/,
  /^_fbp$/,
  /^_fbc$/,
  /^_hj/,
  /^_clck$/,
  /^_clsk$/,
  /^ajs_/,
  /^amplitude_/,
  /^mp_/,
  /^intercom-/,
  /^__utm/,
];

function isTracking(name: string): boolean {
  return TRACKING.some((re) => re.test(name));
}

// api.example.com and example.com are the same site wearing two hats. an exact
// origin match throws away the endpoint on the sibling subdomain, which is
// usually exactly the one we came for.
function sameSite(url: string, origin: string): boolean {
  try {
    const registrable = (h: string) => h.split(".").slice(-2).join(".");
    return registrable(new URL(url).hostname) === registrable(new URL(origin).hostname);
  } catch {
    return false;
  }
}
