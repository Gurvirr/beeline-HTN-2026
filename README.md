# curlew

Perform a web flow once in a browser. Get back a typed SDK that does the same
thing over raw HTTP, with no browser at all.

Most sites have no public API. Automating them today means driving a headless
browser — seconds per call, and it breaks whenever the UI is redesigned.
curlew watches the network while you do the thing once, works out the protocol
underneath, and compiles it into a standalone client.

## How it works

```
flow ──capture──> traces ──analyze──> spec ──synth──> client.ts ──verify──> ✓
```

**capture** drives the flow three times with different inputs, recording every
request and response.

**analyze** diffs the runs field by field:

| behaviour across runs | classification | what happens to it |
| --- | --- | --- |
| identical every run | `static` | frozen into the client |
| tracks a flow input | `param` | becomes a function argument |
| changes on its own | `volatile` | resolved separately |

Volatile fields are then traced to their origin. A token the client sends must
have reached the client somehow, so it's sitting in an earlier response — find
it there and you have a bootstrap step. Values that look like clocks become
`Date.now()`. Anything with no traceable source is reported as unresolved
rather than silently baked in.

**synth** compiles the spec to TypeScript. **verify** calls the generated
client with an input it has never seen and diffs the response against the
captured schema.

Three runs is the practical minimum. With two, a session token that happened to
change is indistinguishable from a parameter that happened to change.

## Usage

```bash
npm install
npx playwright install chromium   # optional — uses system Chrome by default

npm run capture -- flows/films.ts          # add --headed to watch
npm run analyze -- films
npm run synth   -- films
npm run verify  -- films year=2014
```

## Writing a flow

```ts
import type { Flow } from "../src/types.js";

const flow: Flow = {
  name: "films",
  entry: "https://example.com/search",
  inputs: [{ year: "2010" }, { year: "2012" }, { year: "2015" }],

  async run(page, input) {
    await page.getByRole("link", { name: input.year }).click();
    await page.waitForSelector(".results");   // wait for the XHR, not a sleep
  },
};

export default flow;
```

Vary exactly one thing at a time across inputs. The analyzer infers meaning
from what changed, so a flow where two inputs move together can't be
disambiguated.

## What it can't do

- **Client-side signed requests.** If the payload is hashed by obfuscated JS,
  the information isn't in the traffic and can't be recovered from it.
- **TLS fingerprinting.** Some sites check the handshake, so a perfect request
  still gets blocked because the client isn't Chrome.
- **Server-rendered pages with no JSON API.** There's no protocol to recover —
  the response *is* the HTML.

These are reported, not hidden. `verify` fails loudly with a precise diff.

## Notes on the numbers

`browserMs` is measured from flow start to the moment the target request
fires. It's a fair proxy for the browser path but doesn't include full page
render, so the real-world gap is wider than the reported speedup.

The size of the speedup depends heavily on the target: a lightweight page
gives maybe 5×, a heavy SPA with a long boot sequence gives far more.
