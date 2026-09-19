/**
 * The volatile-resolver test.
 *
 * quotes.toscrape.com is a sandbox published for scraping practice. Its login
 * page issues a CSRF token in the HTML and a session cookie on submit, which
 * is the exact shape the resolver exists to handle:
 *
 *   GET  /login   ->  csrf_token in a hidden input, session cookie set
 *   POST /login   ->  requires both
 *
 * If this works, the bootstrap chain works. It accepts any credentials, so
 * nothing here is a real account.
 */

import type { Flow } from "../src/types.js";

const flow: Flow = {
  name: "quotes-login",
  entry: "https://quotes.toscrape.com/login",

  // Username is the thing we vary, so the analyzer should find it and only it.
  // Everything else that changes between runs is session material.
  inputs: [
    { username: "ada" },
    { username: "grace" },
    { username: "linus" },
  ],

  async run(page, input) {
    await page.fill("input[name='username']", input.username);
    await page.fill("input[name='password']", "hunter2");
    await page.click("input[type='submit']");

    // Logged-in pages show a Logout link. Waiting on it means a failed login
    // surfaces as a timeout rather than a silently useless trace.
    await page.waitForSelector("a[href='/logout']", { timeout: 15_000 });
  },

  pick(exchanges) {
    return exchanges.find(
      (x) => x.method === "POST" && x.path === "/login",
    )?.id;
  },
};

export default flow;
