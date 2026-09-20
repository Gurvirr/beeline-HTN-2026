// zed.dev/extensions has no public api. the page fetches its catalogue from
// cloud.zed.dev, and ?filter= on the page url becomes ?provides= on that
// request — a capability filter, not a text search. the search box is
// client-side over the whole list, so typing sends nothing.
//
// so we vary the one argument the site actually puts on the wire.

import type { Flow } from "../src/types.js";

const flow: Flow = {
  name: "zed",
  entry: "https://zed.dev/extensions",
  inputs: [{ provides: "themes" }, { provides: "languages" }, { provides: "icon-themes" }],
  async run(page, input) {
    const u = new URL("https://zed.dev/extensions");
    u.searchParams.set("filter", input.provides!);
    await page.goto(u.toString(), { waitUntil: "networkidle", timeout: 45000 });
  },
};
export default flow;
