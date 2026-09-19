// a real little app. it needs oscar data, and the only place that has it is a
// webpage with no api. beeline already turned that page into this import.

import { FilmsClient } from "../out/films.client.js";

const films = new FilmsClient();

for (const year of ["2012", "2013", "2014", "2015"]) {
  const results = await films.call({ year });
  const best = results.sort((a, b) => b.awards - a.awards)[0];
  console.log(`${year}  ${String(results.length).padStart(2)} films  →  most awards: ${best?.title} (${best?.awards})`);
}
