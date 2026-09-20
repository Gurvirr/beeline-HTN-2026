// no api here at all. quotes.toscrape.com renders everything server-side, so
// there is nothing on the wire to diff — this is the fallback path.

import type { Flow } from "../src/types.js";

const flow: Flow = {
  name: "quotes-page",
  entry: "https://quotes.toscrape.com/",
  inputs: [{ q: "1" }, { q: "2" }, { q: "3" }],
  async run(page, input) {
    await page.goto(`https://quotes.toscrape.com/page/${input.q}/`, {
      waitUntil: "domcontentloaded",
    });
  },
};
export default flow;
