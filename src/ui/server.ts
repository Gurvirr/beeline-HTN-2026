// the dashboard. runs the pipeline and streams what it's doing.
//   npm run ui   ->  http://localhost:4000

import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 4000);

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  try {
    if (url.pathname === "/") return await serveApp(res);
    if (url.pathname === "/api/flows") return await serveFlows(res);
    if (url.pathname === "/api/spec") return await serveJson(res, url, "spec.json");
    if (url.pathname === "/api/client") return await serveText(res, url, "client.ts");
    if (url.pathname === "/api/run") return runPipeline(res, url);
  } catch (err) {
    res.writeHead(500, { "content-type": "text/plain" });
    return res.end(String(err));
  }

  res.writeHead(404).end("not found");
});

async function serveApp(res: import("node:http").ServerResponse) {
  const html = await readFile(join(here, "app.html"), "utf8");
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
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

  child.on("exit", (code) => {
    send({ type: "done", code });
    res.end();
  });

  // if the browser tab goes away, don't leave a pipeline running
  res.on("close", () => child.kill());
}

function stripAnsi(s: string) {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

server.listen(PORT, () => {
  console.log(`\n  beeline dashboard  →  http://localhost:${PORT}\n`);
});
