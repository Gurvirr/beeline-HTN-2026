// a site with no api at all — beeline fell back to reading the page
import { QuotesPageClient } from "../out/quotes-page.client.js";

const t0 = Date.now();
const rows = await new QuotesPageClient().call();
console.log(`\n  ${rows.length} quotes in ${Date.now() - t0}ms\n`);
for (const r of rows.slice(0, 3)) {
  console.log(`  ${r.quote_text.slice(0, 62)}…`);
  console.log(`    — ${r.author}  [${r.tags}]\n`);
}
