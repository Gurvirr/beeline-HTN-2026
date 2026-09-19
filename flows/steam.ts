// steam has no public api for store search. the store page pulls results from
// a private endpoint as you scroll, which is exactly the shape beeline wants:
// a real json response behind a page that never documented it.

import type { Flow } from "../src/types.js";

const flow: Flow = {
  name: "steam",
  entry: "https://store.steampowered.com/search/?term=portal",

  inputs: [{ term: "portal" }, { term: "stardew" }, { term: "hades" }],

  async run(page, input) {
    await page.goto(
      `https://store.steampowered.com/search/?term=${encodeURIComponent(input.term!)}`,
      { waitUntil: "domcontentloaded" },
    );
    // results load as you scroll — that's what fires the json endpoint
    await page.mouse.wheel(0, 4000);
    await page.waitForResponse(
      (r: any) => r.url().includes("/search/results/") && r.status() === 200,
      { timeout: 20000 },
    );
  },

  pick(exchanges) {
    return exchanges.find((x) => x.path.includes("/search/results/"))?.id;
  },
};
export default flow;
