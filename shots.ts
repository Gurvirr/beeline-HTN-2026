// devpost screenshots. drives the real dashboard through the zed example and
// writes one image per step into media/.
//
//   npx tsx shots.ts
//
// waits on the dom rather than on the clock, so a slow capture doesn't shear
// a screenshot half way through a repaint.

import { chromium } from "playwright";
import { mkdir, rm } from "node:fs/promises";

const UI = process.env.SHOT_UI ?? "http://localhost:4000";
const OUT = "media";

let n = 0;
const pad = () => String(++n).padStart(2, "0");

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true, channel: "chrome" });
const page = await browser.newPage({ viewportSize: { width: 1600, height: 1000 } });

async function shot(name: string, note: string) {
  // let the ascii field settle so two shots never differ only by noise
  await page.waitForTimeout(400);
  const file = `${OUT}/${pad()}-${name}.png`;
  await page.screenshot({ path: file });
  console.log(`  ${file.padEnd(34)} ${note}`);
}

try {
  await page.goto(UI, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  await shot("landing", "the empty state");

  // 2 — the ask
  await page.fill("#prompt", "build me an api to get all extensions from https://zed.dev/extensions");
  await page.waitForTimeout(300);
  await shot("prompt", "the request, in english");

  // 3 — a live browser doing the task
  await page.click("#go");
  await page.waitForSelector(".livebox iframe", { timeout: 60_000 });
  await page.waitForTimeout(6000);
  await shot("capturing", "browserbase running the flow, progress bar");

  // 4 — the model proposing, and being checked
  await page.waitForSelector(".step.ai", { timeout: 180_000 });
  await page.waitForTimeout(2500);
  await shot("thinking", "the model guesses parameters, beeline verifies");

  // 5 — finished
  await page.waitForSelector(".headline", { timeout: 240_000 });
  await page.waitForSelector(".recap", { timeout: 60_000 });
  await page.waitForTimeout(800);
  await shot("built", "speedup, and a summary of what it found");

  // 6 — the diff, which is the whole algorithm
  const folds = page.locator(".fold");
  for (let i = 0; i < (await folds.count()); i++) {
    const text = (await folds.nth(i).innerText()).toLowerCase();
    if (text.includes("what changed")) {
      await folds.nth(i).locator("summary").click();
      break;
    }
  }
  await page.waitForSelector("table tr.param", { timeout: 20_000 });
  await page.waitForTimeout(500);
  await shot("diff", "static vs parameter vs volatile, across three runs");

  // 7 — call it
  await page.waitForSelector("#callit");
  await page.fill("#p_provides", "icon-themes");
  await page.click("#callit");
  await page.waitForFunction(() => /\d+ items/.test(document.querySelector("#callout")?.textContent ?? ""), null, { timeout: 40_000 });
  await page.waitForTimeout(600);
  await shot("try-it", "calling the api it just wrote");

  // 8 — the file
  await page.click("#zoomcode");
  await page.waitForTimeout(700);
  await shot("client", "the generated typescript client");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);

  // 9 — the shelf
  await page.click("#nav");
  await page.waitForSelector(".card", { timeout: 15_000 });
  await page.waitForTimeout(900);
  await shot("library", "every api it has learned, callable without relearning");

  console.log(`\n  ${n} images in ${OUT}/\n`);
} catch (err) {
  console.error(`\n  stopped at step ${n + 1}: ${err instanceof Error ? err.message : err}\n`);
  await page.screenshot({ path: `${OUT}/ERROR.png` });
  process.exitCode = 1;
} finally {
  await browser.close();
}
