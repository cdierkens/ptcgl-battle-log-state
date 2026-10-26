#!/usr/bin/env node
/**
 * Fork census over the vendored fixtures.
 *
 * The reproducible half of the corpus census: the same aggregation as the
 * PokeDojo command, over logs that are committed and reviewable.
 *
 *   pnpm run census:fixtures
 *   pnpm run census:fixtures -- --json
 */

import { readFileSync, readdirSync } from "node:fs";

import { censusLog, createCensusAudit, formatReport, toJson } from "./census.mjs";

const fixtureDir = new URL("../src/__tests__/fixtures/", import.meta.url);
const files = readdirSync(fixtureDir)
  .filter((name) => name.endsWith(".log"))
  .sort();

const audit = createCensusAudit();
for (const file of files) {
  censusLog(audit, readFileSync(new URL(file, fixtureDir), "utf8"));
}

if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify(toJson(audit), null, 2)}\n`);
} else {
  process.stdout.write(`${formatReport(audit)}\n`);
}
