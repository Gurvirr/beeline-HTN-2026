// the zed.dev test. no query string, no json on the wire — the extensions are
// rendered into the page. straight to the fallback.

import type { Flow } from "../src/types.js";

const flow: Flow = {
  name: "zed",
  entry: "https://zed.dev/extensions",
  inputs: [{ q: "1" }, { q: "2" }],
  async run(page) {
    await page.goto("https://zed.dev/extensions", { waitUntil: "domcontentloaded" });
  },
};
export default flow;
