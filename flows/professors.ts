// no selectors, no playwright — a url and a sentence.
// stagehand works out the clicking, beeline works out the protocol.
//
// ratemyprofessors has no public api. its search is a private graphql
// endpoint, which makes it a good test: the query text ends up buried inside
// a bigger json body rather than sitting in a tidy query param.

import type { Flow } from "../src/types.js";

const flow: Flow = {
  name: "professors",
  entry: "https://www.ratemyprofessors.com/search/professors/1490?q=*",

  inputs: [{ q: "smith" }, { q: "chen" }, { q: "patel" }],

  task: "type {q} into the professor search box and press Enter",
};

export default flow;
