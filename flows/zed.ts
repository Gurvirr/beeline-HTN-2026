// the zed.dev test. no query string, no json on the wire — the extensions are
// rendered into the page. straight to the fallback.
//
// the input is ignored on purpose: three identical runs is how we show there
// is nothing varying on the wire to diff.

import type { Flow } from "../src/types.js";

const flow: Flow = {
  name: "zed",
  entry: "https://zed.dev/extensions",
  inputs: [{ q: "1" }, { q: "2" }, { q: "3" }],
  async run(page) {
    await page.goto("https://zed.dev/extensions", { waitUntil: "domcontentloaded" });
  },
};
export default flow;
