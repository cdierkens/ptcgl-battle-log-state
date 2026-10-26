#!/usr/bin/env node
/**
 * Coverage audit over the vendored fixtures.
 *
 * The reproducible half of the corpus audit: same aggregation as the PokeDojo
 * command, over logs that are committed and reviewable. It proves the report
 * format works and gives CI something to compare against.
 *
 *   pnpm run audit:fixtures
 *   pnpm run audit:fixtures -- --json
 */

import { readFileSync, readdirSync } from "node:fs";

import { auditLog, createAudit, formatReport, toJson } from "./audit.mjs";

const fixtureDir = new URL("../src/__tests__/fixtures/", import.meta.url);
const files = readdirSync(fixtureDir)
  .filter((name) => name.endsWith(".log"))
  .sort();

const audit = createAudit();
for (const file of files) {
  auditLog(audit, readFileSync(new URL(file, fixtureDir), "utf8"));
}

if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify(toJson(audit), null, 2)}\n`);
} else {
  process.stdout.write(`${formatReport(audit)}\n`);
}
