// where the browser comes from: local chrome for dev, browserbase for the demo.
// same playwright Browser either way, so the recorder doesn't care.

import { chromium, type Browser } from "playwright";

export interface Launched {
  browser: Browser;
  // set for cloud runs — the live view / replay link
  sessionUrl?: string;
  // the bare id, for anything else that wants to attach to this session
  sessionId?: string;
  // embeddable live view, for the dashboard iframe
  liveUrl?: string;
  // stagehand's handle on the same session, when the flow needs it to drive
  stagehandBrowser?: any;
  close: () => Promise<void>;
}

// the embeddable inspector view for a running session
async function liveViewUrl(apiKey: string, sessionId: string) {
  try {
    const res = await fetch(
      `https://api.browserbase.com/v1/sessions/${sessionId}/debug`,
      { headers: { "x-bb-api-key": apiKey } },
    );
    if (!res.ok) return undefined;
    return ((await res.json()) as { debuggerFullscreenUrl?: string })
      .debuggerFullscreenUrl;
  } catch {
    return undefined;
  }
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
  // stagehand only works in sessions created with its extension, so it has to
  // be the one that opens the session — we attach playwright afterwards
  stagehand?: boolean;
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

  let sessionId: string;
  let stagehandBrowser: any;

  if (opts.stagehand) {
    const { browserbase } = await import("@browserbasehq/stagehand");
    stagehandBrowser = await browserbase.launch({ apiKey });
    if (!stagehandBrowser.sessionId) {
      throw new Error("stagehand launched without a browserbase session id");
    }
    sessionId = stagehandBrowser.sessionId;
  } else {
    sessionId = await createSession(apiKey);
  }

  // playwright rides along on the same session purely to record traffic
  const browser = await chromium.connectOverCDP(
    `wss://connect.browserbase.com?apiKey=${apiKey}&sessionId=${sessionId}`,
  );

  return {
    browser,
    sessionUrl: `https://www.browserbase.com/sessions/${sessionId}`,
    sessionId,
    liveUrl: await liveViewUrl(apiKey, sessionId),
    stagehandBrowser,
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

// same again for the tab. a browserbase session boots with a blank tab and the
// live view follows that one, so opening a second tab means you watch an empty
// page while the work happens somewhere you can't see
export async function pageFor(context: any) {
  const existing = context.pages()[0];
  return existing ?? (await context.newPage());
}
