// made from the dashboard — 2026-09-20T01:12:27.279Z
// "get oscars by year from https://www.scrapethissite.com/pages/ajax-javascript/?ajax=true&year=2015"
// the page already takes ?year= — varying that

import type { Flow } from "../src/types.js";

const flow: Flow = {
  name: "scrapethissite-com",
  entry: "https://www.scrapethissite.com/pages/ajax-javascript/?ajax=true&year=2015",
  inputs: [{"q":"2013"},{"q":"2014"},{"q":"2015"}],
  async run(page, input) {
    const u = new URL("https://www.scrapethissite.com/pages/ajax-javascript/?ajax=true&year=2015");
    u.searchParams.set("year", input.q!);
    await page.goto(u.toString(), { waitUntil: "networkidle", timeout: 45000 });
  },
};
export default flow;
