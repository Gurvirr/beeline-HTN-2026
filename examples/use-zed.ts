// zed.dev has no api. beeline read the page and worked out the shape.
import { ZedClient } from "../out/zed.client.js";

const t0 = Date.now();
const rows = await new ZedClient().call();
console.log(`\n  ${rows.length} extensions in ${Date.now() - t0}ms\n`);
for (const r of rows.slice(0, 6)) console.log("  " + JSON.stringify(r));
