// zed.dev/extensions looks server-rendered, but the list you actually search
// is fetched by the page after it loads. wait for the network to settle or we
// stop recording before the interesting request happens.

import type { Flow } from "../src/types.js";

const flow: Flow = {
  name: "zed",
  entry: "https://zed.dev/extensions",
  inputs: [{ filter: "python" }, { filter: "theme" }, { filter: "rust" }],
  async run(page, input) {
    const u = new URL("https://zed.dev/extensions");
    u.searchParams.set("filter", input.filter!);
    await page.goto(u.toString(), { waitUntil: "networkidle", timeout: 45000 });
  },
};
export default flow;
