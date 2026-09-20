// zed.dev/extensions has no documented api, and the list isn't in the page
// either — it's fetched after load. beeline found the endpoint behind it.
import { ZedClient } from "../out/zed.client.js";

const t0 = Date.now();
const res = await new ZedClient().call({ filter: "themes" });
const rows = (res as any).data as any[];

console.log(`
  ${rows.length} extensions in ${Date.now() - t0}ms
`);
for (const r of rows.slice(0, 5)) {
  console.log(`  ${r.name}  ${r.version}  — ${r.authors.join(", ")}`);
}
console.log();
