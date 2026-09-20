// the dashboard. runs the pipeline and streams what it's doing.
//   npm run ui   ->  http://localhost:4000

import { createServer } from "node:http";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { plan } from "../capture/plan.js";
import { execute } from "../runtime/execute.js";
import { ask, primary } from "../llm.js";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 4000);

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  try {
    if (url.pathname === "/") return await serveApp(res);
    if (url.pathname === "/app") return await serveDemoApp(res);
    if (url.pathname === "/api/flows") return await serveFlows(res);
    if (url.pathname === "/api/spec") return await serveJson(res, url, "spec.json");
    if (url.pathname === "/api/client") return await serveText(res, url, "client.ts");
    if (url.pathname === "/api/run") return runPipeline(res, url);
    if (url.pathname === "/api/new") return await makeFlow(req, res);
    if (url.pathname === "/api/try") return await tryIt(res, url);
    if (url.pathname === "/api/library") return await serveLibrary(res);
    if (url.pathname === "/favicon.svg") return await serveFile(res, "favicon.svg", "image/svg+xml");
    if (url.pathname === "/api/the-old-way") return await theOldWay(res, url);
  } catch (err) {
    res.writeHead(500, { "content-type": "text/plain" });
    return res.end(String(err));
  }

  res.writeHead(404).end("not found");
});

async function serveApp(res: import("node:http").ServerResponse) {
  const html = await readFile(join(here, "app.html"), "utf8");
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    // always serve fresh — a cached dashboard during a demo is a bad afternoon
    "cache-control": "no-store",
  });
  res.end(html);
}

// the example app, served from here so it's a real page rather than file://
async function serveDemoApp(res: import("node:http").ServerResponse) {
  const html = await readFile(join(here, "..", "..", "examples", "app.html"), "utf8");
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(html);
}

async function serveFlows(res: import("node:http").ServerResponse) {
  const files = (await readdir("flows")).filter((f) => f.endsWith(".ts"));
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(files.map((f) => f.replace(/\.ts$/, ""))));
}

async function serveJson(
  res: import("node:http").ServerResponse,
  url: URL,
  suffix: string,
) {
  const flow = url.searchParams.get("flow") ?? "";
  const body = await readFile(join("out", `${flow}.${suffix}`), "utf8");
  res.writeHead(200, { "content-type": "application/json" });
  res.end(body);
}

async function serveText(
  res: import("node:http").ServerResponse,
  url: URL,
  suffix: string,
) {
  const flow = url.searchParams.get("flow") ?? "";
  const body = await readFile(join("out", `${flow}.${suffix}`), "utf8");
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end(body);
}

// turn a sentence into a flow file, so the pipeline can run against a site
// nobody has written any code for. this is the "paste any url" path.
// run the api we just learned, here and now. the brain gives you a public url,
// but that needs a deploy — and the point of the panel is to show the thing
// works the second it is built.
// everything beeline has ever learned, as a catalogue. the brain holds the
// same thing behind /apis once a spec is registered; this reads the specs on
// disk so the shelf is populated whether or not anything has been deployed.
async function serveFile(
  res: import("node:http").ServerResponse,
  name: string,
  type: string,
) {
  try {
    const body = await readFile(join(here, name));
    res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}

async function serveLibrary(res: import("node:http").ServerResponse) {
  let files: string[] = [];
  try {
    files = (await readdir("out")).filter((f) => f.endsWith(".spec.json"));
  } catch {
    return json(res, []);
  }

  const items = [];
  for (const f of files) {
    try {
      const spec = JSON.parse(await readFile(join("out", f), "utf8"));
      const named = spec.fields.filter((x: any) => x.kind === "param" && x.boundTo);
      items.push({
        flow: spec.flow,
        host: new URL(spec.target.urlTemplate).host,
        method: spec.target.method,
        path: new URL(spec.target.urlTemplate).pathname,
        mode: spec.mode ?? "api",
        params: [...new Set(named.filter((x: any) => !x.optional).map((x: any) => x.boundTo))],
        probed: [...new Set(named.filter((x: any) => x.optional).map((x: any) => x.boundTo))],
        counts: {
          static: spec.fields.filter((x: any) => x.kind === "static").length,
          volatile: spec.fields.filter((x: any) => x.kind === "volatile").length,
        },
        bootstrap: spec.bootstrap.length,
        learnedAt: spec.meta.generatedAt,
        browserMs: spec.meta.browserMs ?? 0,
      });
    } catch {
      // a half-written spec shouldn't take the shelf down with it
    }
  }

  items.sort((a, b) => String(b.learnedAt).localeCompare(String(a.learnedAt)));
  json(res, items);
}

async function tryIt(res: import("node:http").ServerResponse, url: URL) {
  const flow = url.searchParams.get("flow");
  if (!flow) return json(res, { error: "need a flow" }, 400);

  const spec = JSON.parse(
    await readFile(join("out", `${flow}.spec.json`), "utf8"),
  );

  const params: Record<string, string> = {};
  for (const [k, v] of url.searchParams) if (k !== "flow") params[k] = v;

  try {
    const out = await execute(spec, params);
    json(res, { status: out.status, ms: out.ms, data: out.body });
  } catch (err) {
    json(res, { error: err instanceof Error ? err.message : String(err) }, 502);
  }
}

async function makeFlow(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
) {
  const { prompt } = (await readJson(req)) as { prompt?: string };
  if (!prompt) return json(res, { error: "need a prompt" }, 400);

  let p;
  try {
    p = await plan(prompt);
  } catch (err) {
    return json(res, { error: err instanceof Error ? err.message : String(err) }, 400);
  }

  const name = slug(p.entry);
  const file = `flows/${name}.ts`;
  const inputs = p.values.map((v) => ({ q: v }));

  // url flows just navigate — no clicking, so nothing to misread. task flows
  // hand the sentence to stagehand, which is slower and can miss.
  const body =
    p.how === "url" && p.vary
      ? `  async run(page, input) {
    const u = new URL(${JSON.stringify(p.entry)});
    u.searchParams.set(${JSON.stringify(p.vary)}, input.q!);
    await page.goto(u.toString(), { waitUntil: "networkidle", timeout: 45000 });
  },`
      : `  task: ${JSON.stringify(p.task ?? prompt)},`;

  const source = `// made from the dashboard — ${new Date().toISOString()}
// "${prompt.replace(/"/g, "'")}"
// ${p.why}

import type { Flow } from "../src/types.js";

const flow: Flow = {
  name: ${JSON.stringify(name)},
  entry: ${JSON.stringify(p.entry)},
  inputs: ${JSON.stringify(inputs)},
${body}
};
export default flow;
`;

  await writeFile(file, source);
  // plan() runs in this process, so its thinking cannot reach the run
  // stream. hand it back with the response instead and let the ui show it.
  json(res, {
    flow: name,
    how: p.how,
    why: p.why,
    values: p.values,
    model: process.env.LLM_MODEL ?? "gpt-4o-mini",
  });
}

function readJson(req: import("node:http").IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch (err) {
        reject(err);
      }
    });
  });
}

function slug(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, "").replace(/[^a-z0-9]+/gi, "-");
  } catch {
    return `site-${Date.now()}`;
  }
}

// spawn the pipeline and forward its events over sse
function runPipeline(res: import("node:http").ServerResponse, url: URL) {
  const flow = url.searchParams.get("flow") ?? "films";
  const cloud = url.searchParams.get("cloud") === "1";
  const cached = url.searchParams.get("cached") === "1";

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  const args = [
    "tsx",
    "--env-file-if-exists=.env",
    "src/learn.ts",
    `flows/${flow}.ts`,
    ...(cloud ? ["--cloud"] : []),
    ...(cached ? ["--from-cache"] : []),
  ];

  const child = spawn("npx", args, {
    env: { ...process.env, BEELINE_EVENTS: "1", FORCE_COLOR: "0" },
    shell: process.platform === "win32",
  });

  let buffer = "";
  const consume = (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    // keep the last partial line for the next chunk
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith("::beeline ")) {
        try {
          send(JSON.parse(trimmed.slice("::beeline ".length)));
          continue;
        } catch {
          // fall through and treat it as a log line
        }
      }
      send({ type: "log", line: stripAnsi(trimmed) });
    }
  };

  child.stdout.on("data", consume);
  child.stderr.on("data", consume);

  child.on("exit", async (code) => {
    // one closing line that answers what was asked, rather than making the
    // reader assemble it from a spec table
    if (code === 0) {
      const line = await summarise(flow, url.searchParams.get("q") ?? flow);
      if (line) send({ type: "summary", text: line, who: primary().model });
    }
    send({ type: "done", code });
    res.end();
  });

  // if the browser tab goes away, don't leave a pipeline running
  res.on("close", () => child.kill());
}

// say what just happened, in one sentence, against what was asked for.
// everything here is read off the finished spec - the model is writing, not
// deciding.
async function summarise(flow: string, asked: string): Promise<string | null> {
  const p = primary();
  if (!p.key) return null;

  let spec: any;
  try {
    spec = JSON.parse(await readFile(join("out", `${flow}.spec.json`), "utf8"));
  } catch {
    return null;
  }

  const named = spec.fields.filter((f: any) => f.kind === "param" && f.boundTo);
  const facts = [
    `asked for: ${asked}`,
    `endpoint: ${spec.target.method} ${spec.target.urlTemplate}`,
    `mode: ${spec.mode ?? "recovered a json endpoint"}`,
    `arguments: ${named.map((f: any) => f.boundTo + (f.optional ? " (found by probing)" : "")).join(", ") || "none"}`,
    `values the site sent that we had to reproduce: ${
      spec.fields.filter((f: any) => f.kind === "volatile").map((f: any) => f.name).join(", ") || "none"}`,
    `handshake requests needed first: ${spec.bootstrap.length}`,
  ].join("\n");

  const raw = await ask(
    p,
    `You explain what a tool just did, to the person who asked for it.

Two sentences, plain English, no marketing, no markdown or backticks. Name the endpoint it found and the
arguments it takes. If something was found by probing rather than observed, say
so. If a handshake was needed, say what for. Do not mention speed.`,
    facts,
    { maxTokens: 160, timeoutMs: 20_000 },
  ).catch(() => null);

  // it still reaches for backticks even when told not to
  return raw ? raw.trim().replace(/[`*]/g, "").replace(/\s+/g, " ").slice(0, 340) : null;
}

// what you'd have to do without beeline: launch a browser, load the page,
// click the thing, scrape the dom. this is the honest comparison — it's the
// same work, done the way everyone does it today.
async function theOldWay(res: import("node:http").ServerResponse, url: URL) {
  const year = url.searchParams.get("year") ?? "2015";
  const started = Date.now();

  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true, channel: "chrome" });

  try {
    const page = await browser.newPage();
    await page.goto("https://www.scrapethissite.com/pages/ajax-javascript/", {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("link", { name: year, exact: true }).click();
    await page.waitForSelector("#table-body tr", { timeout: 20000 });

    // and then you parse the table by hand, and it breaks when they restyle it
    const films = await page.$$eval("#table-body tr", (rows) =>
      rows.map((r) => {
        const cells = Array.from(r.querySelectorAll("td")).map((c) => c.textContent?.trim() ?? "");
        return {
          title: cells[0] ?? "",
          year: Number(cells[1] ?? 0),
          awards: Number(cells[2] ?? 0),
          nominations: Number(cells[3] ?? 0),
        };
      }),
    );

    json(res, { ms: Date.now() - started, count: films.length, data: films });
  } catch (err) {
    json(res, { error: err instanceof Error ? err.message : String(err) }, 500);
  } finally {
    await browser.close();
  }
}

function json(
  res: import("node:http").ServerResponse,
  body: unknown,
  status = 200,
) {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
  });
  res.end(JSON.stringify(body));
}

function stripAnsi(s: string) {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

server.listen(PORT, () => {
  console.log(`\n  beeline dashboard  →  http://localhost:${PORT}\n`);
});
