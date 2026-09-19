// the generated client is just a file — import it and call it.
//   npx tsx examples/use-steam.ts "hollow knight"

import { SteamClient } from "../out/steam.client.js";

const term = process.argv[2] ?? "portal";
const steam = new SteamClient();

const t0 = Date.now();
const r = await steam.call({ term });

console.log(`\n  "${term}" — ${r.total_count} results in ${Date.now() - t0}ms\n`);
for (const m of [...r.results_html.matchAll(/title">([^<]+)</g)].slice(0, 5)) {
  console.log(`  ${m[1]}`);
}
console.log();
