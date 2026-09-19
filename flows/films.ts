// smoke test. scrapethissite is a sandbox meant for this.
// clicking a year fires an xhr with ?year=YYYY, so input maps straight to a param.
// copy this and point the copy at a real target

import type { Flow } from "../src/types.js";

const flow: Flow = {
  name: "films",
  entry: "https://www.scrapethissite.com/pages/ajax-javascript/",

  // three runs. the analyzer needs at least three to tell a real parameter
  // apart from a value that happened to change twice
  inputs: [{ year: "2010" }, { year: "2012" }, { year: "2015" }],

  async run(page, input) {
    // the year links are <a id="2010">2010</a>. click by visible text so this
    // survives markup changes
    await page.getByRole("link", { name: input.year, exact: true }).click();

    // wait for the table the XHR populates, not a fixed sleep — a timeout here
    // means the flow broke, which is information we want
    await page.waitForSelector("table#table-body tr, .film-title", {
      timeout: 15_000,
    });
  },

  // optional hint. without it the analyzer picks the request whose response
  // best explains what appeared on screen; being explicit makes the demo
  // deterministic, which matters when you only get one take
  pick(exchanges) {
    return exchanges.find(
      (x) => x.path.includes("ajax-javascript") && "ajax" in x.query,
    )?.id;
  },
};

export default flow;
