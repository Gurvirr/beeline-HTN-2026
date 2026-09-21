// crates.io search. the page is an ember app that calls its own json api with
// the query on the url, which is the shape beeline handles best.

import type { Flow } from "../src/types.js";

const flow: Flow = {
  name: "crates",
  entry: "https://crates.io/search?q=serde",
  inputs: [{ q: "serde" }, { q: "tokio" }, { q: "clap" }],
  async run(page, input) {
    const u = new URL("https://crates.io/search");
    u.searchParams.set("q", input.q!);
    await page.goto(u.toString(), { waitUntil: "networkidle", timeout: 45000 });
  },
};
export default flow;
