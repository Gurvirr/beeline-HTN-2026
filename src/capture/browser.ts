// where the browser comes from: local chrome for dev, browserbase for the demo.
// same playwright Browser either way, so the recorder doesn't care.

import { chromium, type Browser } from "playwright";

export interface Launched {
  browser: Browser;
  // set for cloud runs — the live view / replay link
  sessionUrl?: string;
  close: () => Promise<void>;
}

// one cloud browser we can watch live and replay afterwards.
// no projectId needed, the api key resolves it
async function createSession(apiKey: string): Promise<string> {
  const res = await fetch("https://api.browserbase.com/v1/sessions", {
    method: "POST",
    headers: { "x-bb-api-key": apiKey, "content-type": "application/json" },
    body: JSON.stringify({}),
  });

  if (!res.ok) {
    throw new Error(`browserbase session failed: ${res.status} ${await res.text()}`);
  }

  return ((await res.json()) as { id: string }).id;
}

export async function launch(opts: {
  cloud: boolean;
  headed: boolean;
  channel: string;
}): Promise<Launched> {
  if (!opts.cloud) {
    const browser = await chromium.launch({
      headless: !opts.headed,
      channel: opts.channel,
    });
    return { browser, close: () => browser.close() };
  }

  const apiKey = process.env.BROWSERBASE_API_KEY;
  if (!apiKey) throw new Error("BROWSERBASE_API_KEY not set — check .env");

  const sessionId = await createSession(apiKey);
  const browser = await chromium.connectOverCDP(
    `wss://connect.browserbase.com?apiKey=${apiKey}&sessionId=${sessionId}`,
  );

  return {
    browser,
    sessionUrl: `https://www.browserbase.com/sessions/${sessionId}`,
    // closing the cdp connection ends the session on their side too
    close: () => browser.close(),
  };
}

// cloud sessions come with a context already open — reuse it instead of
// making a second one, otherwise the live view shows an empty tab
export async function contextFor(launched: Launched) {
  const existing = launched.browser.contexts()[0];
  return existing ?? (await launched.browser.newContext());
}
