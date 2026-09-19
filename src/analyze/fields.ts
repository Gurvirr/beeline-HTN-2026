import type { Exchange, FieldLocation } from "../types.js";

/** A single addressable value inside a request, before we classify it. */
export interface Candidate {
  location: FieldLocation;
  /** Header name, query key, cookie name, or dotted path into the body. */
  name: string;
  value: string;
}

/**
 * Headers every HTTP client sets for itself. Classifying them is noise — they
 * vary for reasons that have nothing to do with the site's protocol.
 */
const CLIENT_NOISE = new Set([
  // HTTP/2 pseudo-headers. These are transport framing, not protocol — :path
  // duplicates the URL and would otherwise be classified as a second copy of
  // whatever parameter is in the query string.
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

/** Pull every addressable value out of a request. */
export function extract(exchange: Exchange): Candidate[] {
  const out: Candidate[] = [];

  for (const [rawName, value] of Object.entries(exchange.requestHeaders)) {
    const name = rawName.toLowerCase();
    if (CLIENT_NOISE.has(name)) continue;

    // Cookies are many values in a trenchcoat; split so each is classified
    // on its own. A session id and a consent flag behave very differently.
    if (name === "cookie") {
      for (const pair of value.split(";")) {
        const eq = pair.indexOf("=");
        if (eq === -1) continue;
        out.push({
          location: "cookie",
          name: pair.slice(0, eq).trim(),
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

/**
 * Flatten JSON into dotted paths. Arrays use [i] so a regenerated client can
 * rebuild the exact shape.
 *
 *   {a: {b: [1, 2]}}  ->  a.b[0]=1, a.b[1]=2
 */
export function flatten(value: unknown, prefix = ""): [string, string][] {
  if (value === null || value === undefined) return prefix ? [[prefix, ""]] : [];

  if (typeof value !== "object") {
    return [[prefix || "$", String(value)]];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item, i) => flatten(item, `${prefix}[${i}]`));
  }

  // A form-encoded or otherwise non-JSON body arrives as a string and is
  // handled above; this branch is plain objects only.
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
    flatten(v, prefix ? `${prefix}.${k}` : k),
  );
}

/**
 * Choose the exchange that did the real work.
 *
 * Heuristic, in order of trust:
 *   1. The flow told us (flow.pick).
 *   2. A JSON response whose body contains one of the input values — the
 *      strongest possible signal that this request answered the user's query.
 *   3. The largest JSON response that isn't a static asset.
 */
export function pickTarget(
  exchanges: Exchange[],
  input: Record<string, string>,
  hint?: string,
): Exchange | undefined {
  if (hint) {
    const hinted = exchanges.find((x) => x.id === hint);
    if (hinted) return hinted;
  }

  // 3xx counts: a form POST that redirects on success is still the request
  // that did the work, and it carries the session material we care about.
  const candidates = exchanges.filter((x) => x.status >= 200 && x.status < 400);
  const inputValues = Object.values(input).filter(Boolean);

  const bodyOf = (x: Exchange) => JSON.stringify(x.responseBody ?? "");
  const requestOf = (x: Exchange) =>
    JSON.stringify(x.requestBody ?? "") + JSON.stringify(x.query);

  const dataFetches = candidates.filter(
    (x) =>
      (x.resourceType === "xhr" || x.resourceType === "fetch") &&
      x.responseBody !== null,
  );

  // The input came back in the response: this request answered the question.
  const answered = dataFetches.filter((x) =>
    inputValues.some((v) => bodyOf(x).includes(v)),
  );
  if (answered.length) return largestBody(answered);

  // The input went out in a state-changing request: this request *was* the
  // action. Covers form submissions, which are documents rather than XHR.
  const submitted = candidates.filter(
    (x) => x.method !== "GET" && inputValues.some((v) => requestOf(x).includes(v)),
  );
  if (submitted.length) return submitted[0];

  if (dataFetches.length) return largestBody(dataFetches);

  // Nothing echoed the input, but something changed state. Better than nothing.
  return candidates.find((x) => x.method !== "GET");
}

function largestBody(pool: Exchange[]): Exchange | undefined {
  return [...pool].sort(
    (a, b) =>
      JSON.stringify(b.responseBody ?? "").length -
      JSON.stringify(a.responseBody ?? "").length,
  )[0];
}
