// a site with no api at all — beeline fell back to reading the page.
//
// the field names come from whatever beeline worked out the columns were, so
// print them rather than assuming; re-learning the flow can rename them.
import { QuotesPageClient } from "../out/quotes-page.client.js";

const t0 = Date.now();
const rows = await new QuotesPageClient().call();
console.log(`\n  ${rows.length} quotes in ${Date.now() - t0}ms\n`);
for (const row of rows.slice(0, 3)) console.log("  " + JSON.stringify(row));
console.log();
