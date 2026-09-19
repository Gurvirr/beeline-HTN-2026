/**
 * Smoke-test flow.
 *
 * scrapethissite.com/pages/ajax-javascript is a sandbox published for exactly
 * this kind of practice. Clicking a year fires an XHR to
 *   /pages/ajax-javascript/?ajax=true&year=YYYY
 * so the flow input maps 1:1 onto a query parameter — the simplest possible
 * case for the analyzer to get right.
 *
 * Use this to prove the pipeline works end to end, then copy it and point the
 * copy at your real target.
 */

import type { Flow } from "../src/types.js";

const flow: Flow = {
  name: "films",
  entry: "https://www.scrapethissite.com/pages/ajax-javascript/",

  // Three runs. The analyzer needs at least three to tell a real parameter
  // apart from a value that happened to change twice.
  inputs: [{ year: "2010" }, { year: "2012" }, { year: "2015" }],

  async run(page, input) {
    // The year links are <a id="2010">2010</a>. Click by visible text so this
    // survives markup changes.
    await page.getByRole("link", { name: input.year, exact: true }).click();

    // Wait for the table the XHR populates, not a fixed sleep — a timeout here
    // means the flow broke, which is information we want.
    await page.waitForSelector("table#table-body tr, .film-title", {
      timeout: 15_000,
    });
  },

  /**
   * Optional hint. Without it the analyzer picks the request whose response
   * best explains what appeared on screen; being explicit makes the demo
   * deterministic, which matters when you only get one take.
   */
  pick(exchanges) {
    return exchanges.find(
      (x) => x.path.includes("ajax-javascript") && "ajax" in x.query,
    )?.id;
  },
};

export default flow;
