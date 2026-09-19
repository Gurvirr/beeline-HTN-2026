// two ways to perform a flow.
//
//   run:  you write playwright. exact, fast, never surprises you.
//   task: you write a sentence. stagehand works out the clicks.
//
// task is the one that makes beeline site-agnostic — no selectors, nothing
// about how the page is built. run stays as the reliable path for targets
// you're going to demo.

import { emit } from "../events.js";
import type { Flow } from "../types.js";

// "search for {q}" + {q: "smith"} -> "search for smith"
function fill(template: string, input: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key) => input[key] ?? whole);
}

export async function drive(
  flow: Flow,
  input: Record<string, string>,
  ctx: { page: any; stagehandBrowser?: any },
): Promise<void> {
  if (flow.run) {
    await flow.run(ctx.page, input);
    return;
  }

  if (!flow.task) {
    throw new Error(`flow ${flow.name} has neither run() nor task`);
  }

  if (!ctx.stagehandBrowser) {
    throw new Error("task flows need --cloud: stagehand has to open the session");
  }

  const instruction = fill(flow.task, input);
  emit({ type: "log", line: `task: ${instruction}` });

  // the session was opened by stagehand and playwright is recording it, so
  // whatever stagehand clicks shows up in our trace like any other traffic
  const { Stagehand } = await import("@browserbasehq/stagehand");
  const stagehand = await Stagehand.create({ browser: ctx.stagehandBrowser });

  // deliberately not closing stagehand here: close() ends the whole
  // browserbase session, and capture still needs the page to read cookies.
  // the session dies with launched.close() a moment later anyway
  await stagehand.act(instruction);
}
