// resolver test. sandbox login: GET /login hands out a csrf token + session
// cookie, POST /login needs both. if this works the bootstrap chain works.
// takes any credentials, so nothing here is a real account

import type { Flow } from "../src/types.js";

const flow: Flow = {
  name: "quotes-login",
  entry: "https://quotes.toscrape.com/login",

  // username is the thing we vary, so the analyzer should find it and only it
  // everything else that changes between runs is session material
  inputs: [
    { username: "ada" },
    { username: "grace" },
    { username: "linus" },
  ],

  async run(page, input) {
    await page.fill("input[name='username']", input.username);
    await page.fill("input[name='password']", "hunter2");
    await page.click("input[type='submit']");

    // logged-in pages show a Logout link. waiting on it means a failed login
    // surfaces as a timeout rather than a silently useless trace
    await page.waitForSelector("a[href='/logout']", { timeout: 15_000 });
  },

  pick(exchanges) {
    return exchanges.find(
      (x) => x.method === "POST" && x.path === "/login",
    )?.id;
  },
};

export default flow;
