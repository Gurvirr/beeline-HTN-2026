# beeline

**Every website already has an API. Beeline finds it.**

Use a site once. Beeline watches what the page says to its own server, works out
the call underneath, and writes you a typed client that makes that call
directly — no browser, no scraping, no selectors.

```
$ beeline learn films --cloud

  ran the task with year=2010 · 36 requests
  ran it again with year=2012 · 36 requests
  ran it again with year=2015 · 36 requests
  year followed your input — that's the parameter
  wrote 52 lines of typed client

  PASS  200 · schema matches
  90ms over HTTP · 2099ms via the browser · 23.3x faster
```

## How it works

Almost every modern page fetches its data from an undocumented endpoint. That
endpoint is an API nobody published. Beeline recovers it by **differential
capture**:

1. **Capture** — do the task three times with different inputs, recording every
   request the page makes.
2. **Analyze** — line the runs up and compare every field:
   - identical every run → **static**, freeze it
   - follows your input → **parameter**, make it an argument
   - changes on its own → **token**, so trace it back through the trace to the
     response that issued it
3. **Synthesize** — emit a standalone typed client, including the handshake
   needed to get those tokens.
4. **Verify** — call it with an input it has never seen and check the response
   still matches what was learned.

Three runs is the minimum that works. With two, a session token that happened to
change is indistinguishable from a parameter that happened to change.

## Quick start

```bash
npm install
npm link                      # puts `beeline` on your path
echo "BROWSERBASE_API_KEY=..." > .env

beeline learn films --cloud   # capture, analyze, synthesize, verify
beeline ui                    # the dashboard, on localhost:4000
```

Then use what it wrote:

```ts
import { FilmsClient } from "./out/films.client.js";

const films = new FilmsClient();
const results = await films.call({ year: "2015" });
// [{ title: "Spotlight", year: 2015, awards: 2, nominations: 6 }, ...]
```

## Commands

```
beeline learn <flow>       capture, analyze, synthesize, verify
beeline ui                 the dashboard
beeline diff <flow>        what changed across runs, and what we concluded
beeline verify <flow>      run the client again and time it
beeline deploy <flow>      put the client behind a Cloudflare Worker

beeline remember <flow>    teach the brain an api
beeline health             what it knows, and what has drifted
beeline check <flow>       go look right now
```

Flags: `--cloud` (Browserbase instead of local Chrome), `--headed`,
`--from-cache` (skip capture, reuse the last recordings).

## The brain

Learning an API is only half of it — sites change without telling anyone. The
brain is a Cloudflare Worker that remembers every API beeline has learned, and
keeps calling them to check the sites still behave:

- **D1** stores each spec and its check history
- **Cron** re-checks everything every 15 minutes, unprompted
- **Drift detection** reports exactly what changed: `$[0].director: missing`
- **Self-healing** — if the request still works and only the response shape
  moved, it relearns the schema itself and carries on

It also serves every learned API, so they're callable from anything:

```bash
curl "https://beeline-brain.gurvirrandhawa28.workers.dev/call/films?year=2015"
```

It executes specs generically, so it can run any API beeline has ever learned
without that client being compiled into it.

## Writing a flow

A flow says where to go and what to do. Either script it:

```ts
const flow: Flow = {
  name: "films",
  entry: "https://www.scrapethissite.com/pages/ajax-javascript/",
  inputs: [{ year: "2010" }, { year: "2012" }, { year: "2015" }],
  async run(page, input) {
    await page.getByRole("link", { name: input.year, exact: true }).click();
    await page.waitForSelector("#table-body tr");
  },
};
```

…or describe it, and let Stagehand work out the clicking:

```ts
  task: "type {q} into the search box and press Enter",
```

## What it can't do

- **Server-rendered pages.** If the data arrives baked into the HTML there is no
  network call to find. RateMyProfessors is like this — we tried.
- **Requests signed by obfuscated client-side JS.** The information isn't in the
  traffic, so it can't be recovered from the traffic.
- **Sites that fingerprint TLS.** A plain HTTP client doesn't look like Chrome.
- Datacenter IPs get rate-limited by some sites (Steam does this), so the brain
  can be throttled where a local client isn't.

Beeline says which of these it hit rather than guessing.

## Layout

```
src/capture    drive the flow, record everything off the wire
src/analyze    diff the runs, classify fields, trace tokens to their source
src/synth      spec -> standalone typed client
src/verify     call it for real and compare
src/runtime    run a spec directly, without generating code (used by the brain)
src/ui         the dashboard
workers/brain  memory, health checks, self-healing, on Cloudflare
flows          one file per site
```

Built at Hack the North 2026.

## Running it somewhere else

The dashboard is a plain Node server, so anything that runs `npm ci && npm start`
will host it. It reads `PORT` from the environment.

```
LLM_API_KEY=...            # the planner and the page reader
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-5.4-mini
BASETEN_API_KEY=...        # optional: proposes extra parameters to probe
BROWSERBASE_API_KEY=...    # required if you want live capture
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
```

Two things to know before you point anyone at it.

**Leave "run in the cloud" ticked.** Cloud capture connects to Browserbase over
CDP and needs no local browser. Untick it and it calls `chromium.launch()`,
which is not there on a host that skipped the browser download.

**Anything learned on a deployed instance is temporary.** `out/` and `traces/`
are written to disk, so they reset whenever the host redeploys. The specs
committed to the repo are what the library shows on a fresh boot.
