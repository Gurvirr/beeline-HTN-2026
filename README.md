# beeline

**Every website already has an API. It's just undocumented.**

The site you want data from is already calling one, with clean JSON, a couple of
parameters and a session token. Nobody hands you the client, so you end up
writing a scraper instead.

Beeline uses the site once, works out that call from its own traffic, and writes
you a typed client. No browser, no scraping, no selectors to maintain.

```ts
import { ZedClient } from "./out/zed.client.js";

const zed = new ZedClient();
await zed.call({ provides: "themes", filter: "ultraviolet" });
// [{ id: "ultraviolet-theme", name: "ultraViolet", version: "0.2.0", … }]
```

63 lines, no dependencies, and 63ms over HTTP against 3,104ms through a browser!

## How it works

It uses the flow three times with different inputs and diffs the traffic.

| what it saw | what it means | what it does |
|---|---|---|
| tracks your input | a parameter | becomes an argument |
| identical every run | static | frozen into the client |
| changes on its own | a session token | traced back to whatever issued it |

Three runs is the minimum that works. With two, a rotating session cookie and a
search query you happened to change look exactly the same, and there's no way to
tell them apart.

```
   "get all extensions from zed.dev/extensions"
                    |
   1  USE IT 3x     |  provides = themes | languages | icon-themes
                    |  315 / 292 / 353 requests recorded
                    v
   2  DIFF THE RUNS |  moved with you  -> provides            PARAMETER
                    |  never changed   -> max_schema_version  STATIC
                    |  moved by itself -> csrf_token, session VOLATILE
                    v
   3  PROBE         |  11 names proposed, 10 changed nothing
                    |  filter: 638 rows -> 1                  KEPT
                    v
   4  COMPILE       |  63 lines of TypeScript, zero dependencies
                    v
   5  VERIFY        |  63ms over HTTP  vs  3,104ms via browser
                    v
   6  REMEMBER      |  Cloudflare Worker, re-checked every 15 min
```

## Tracing a session token

The hard part isn't finding the endpoint, it's reproducing the values the site
handed itself. A captured CSRF token is worthless on its own, because you need to
know where it came from so the client can go and fetch a fresh one.

So beeline searches every earlier response for each volatile value and records how
to get it again:

```
csrf_token   <- a hidden input in the HTML of GET /login
session      <- set-cookie on that same response
sessionid    <- a JavaScript variable in the page body   (steam)
browserid    <- set-cookie from GET /search/             (steam)
```

Then it writes the handshake into the client for you:

```ts
// one-time handshake. call before `call`; safe to call again to refresh
async connect(): Promise<void> {
  const res = await fetch("https://quotes.toscrape.com/login", { method: "GET" });
  this.session["csrf_token"] =
    /input type="hidden" name="csrf_token" value="([^"'<\s]+)/
      .exec(await res.clone().text())?.[1] ?? "";
  this.cookies["session"] =
    /session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1] ?? "";
}
```

`call()` runs that automatically the first time. If a value genuinely can't be
reproduced, like a signature computed in JavaScript, it gets sent as captured and
flagged as unresolved, so you know the client has an expiry date instead of
finding out in production.

## Probing

Capture can only learn arguments the site actually sends, and plenty of endpoints
accept more than their own UI ever uses.

So once the endpoint is recovered, a model proposes candidate parameter names and
every one of them gets tested against the live API:

```
~ zai-org/GLM-5.3-Flash   guessed 11 parameters
                          query search sort order page per_page limit
                          offset cursor filter author
~ checked                 filter is real, narrowed 638 rows to 1
```

A candidate only survives if it narrows the result, returns at least one row, and
returns only rows that were in the original set. The other ten came back identical
and were dropped.

`filter` appears in no documentation, and zed's own search box filters client-side
so the site never sends it. The model is allowed to be wrong, cheaply and often,
because nothing it says reaches the output unverified.

## When there is no API

Some pages really do render on the server. Beeline says so and falls back to
reading the page, which means a model gets shown a structural summary of the
repeating elements and picks selectors, and those selectors are then validated by
running them. Fields that extract nothing get dropped rather than shipped.

Those clients need a parser and the generated file says so. It's more brittle than
a recovered endpoint and beeline doesn't pretend otherwise.

## Quick start

```bash
npm install
cp .env.example .env     # add your keys
npm run ui               # dashboard on localhost:4000
```

```bash
npm link                     # gives you `beeline`
beeline learn films          # capture, analyze, synth, verify
beeline learn films --cloud  # run the browsers on browserbase
```

Only `LLM_API_KEY` is required:

```
LLM_API_KEY=...          # planning, and reading pages that have no api
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-5.4-mini
BASETEN_API_KEY=...      # optional: proposes parameters to probe
BROWSERBASE_API_KEY=...  # optional: cloud browsers and a live view
BEELINE_BRAIN=...        # optional: where learned specs are registered
```

Without Baseten, probing falls back to the primary model. Without Browserbase,
capture runs a local Chrome.

## Commands

```
beeline learn <flow>      the whole pipeline
beeline capture <flow>    record the runs only
beeline analyze <flow>    diff the recordings into a spec
beeline diff <flow>       show what changed across runs
beeline synth <flow>      spec into client.ts
beeline verify <flow>     run the client and time it
beeline remember <flow>   hand the spec to the brain
beeline health            what the brain knows, and what has drifted
beeline ui                the dashboard

  --cloud        browserbase instead of local chrome
  --headed       watch it locally
  --from-cache   reuse the last capture
```

## The brain

A Cloudflare Worker with D1 and a cron trigger. A finished pipeline registers its
spec automatically, so a learned API is callable straight away:

```bash
curl "https://your-worker.workers.dev/call/zed?provides=themes&filter=ultraviolet"
```

Every 15 minutes it re-calls everything it knows, compares the response against the
schema it learned, and re-infers the shape when a site moves underneath it.

Registration verifies itself too. The Worker bundles its own copy of the executor,
so a spec newer than the deployment would register happily and then answer with
nonsense. Instead it calls the endpoint once and checks, and if the deployed brain
can't serve it the entry gets withdrawn rather than left advertising a broken URL.

## Writing a flow

A flow is the recipe: where to start, what to vary, and what to do on the page.

```ts
import type { Flow } from "../src/types.js";

const flow: Flow = {
  name: "films",
  entry: "https://www.scrapethissite.com/pages/ajax-javascript/",
  inputs: [{ year: "2013" }, { year: "2014" }, { year: "2015" }],
  async run(page, input) {
    await page.click(`#${input.year}`);
    await page.waitForSelector("#table-body tr");
  },
};
export default flow;
```

Three inputs, deliberately. You can also skip the file entirely and type a sentence
into the dashboard, and it'll work out an entry URL and what to vary.

## What it can't do

Requests signed in JavaScript are out of reach, because beeline can't reproduce the
signature. It sends the captured value instead, which works until it expires, and
the verifier says so loudly when it stops.

Sites that fingerprint the TLS connection rather than checking what's in it will
reject a plain `fetch`, and there's nothing to be done about that from here.

Natural-language flows are the weak path. Driving a page by instruction instead of
by URL takes around 40s a run and can report success without having done the task,
so prefer a site that takes its arguments in the query string.

## Layout

```
src/capture/    drive the browser, record every exchange
src/analyze/    diff the runs, classify fields, trace volatiles, probe
src/synth/      spec into a typed client
src/verify/     call it, time it against the browser
src/runtime/    execute a spec directly, without generating code
src/brain/      register and query the worker
src/ui/         dashboard, SSE, live browser
workers/brain/  the cloudflare worker
flows/          one file per site
out/            generated specs and clients
```

## Running it somewhere else

The dashboard is a plain Node server, so anything that runs `npm ci && npm start`
will host it, and it reads `PORT` from the environment. Leave cloud capture on,
since local capture needs a Chrome the host has probably skipped installing, and
keep in mind that anything learned there resets on redeploy.
