/**
 * Fork-census aggregation — the numbers behind `docs/audits/`.
 *
 * One log in, one yes/no out for each of the three figures. Run over the
 * fixtures for a reproducible check, and over PokeDojo's corpus for the
 * measurement. Like the coverage audit, this module never prints a battle log:
 * the report is counts and rates.
 *
 * The headline is **never confirmed**, and it is a bare-mode upper bound. The
 * informed run needs PokeDojo's card data and is a separate adapter; the delta
 * is what that run will measure (D33).
 */

import { detectBattleLogLanguage, parseBattleLog } from "@dierkens.dev/ptcgl-battle-log-parser";

import { census, lower } from "../dist/index.js";

/** A fresh accumulator. */
export const createCensusAudit = () => ({
  confirmedLate: 0,
  diagnostics: new Map(),
  divergentGroupsAtEnd: 0,
  everDivergent: 0,
  forkEpisodes: 0,
  groups: 0,
  liveGroupsAtEnd: 0,
  locales: new Map(),
  logs: 0,
  lowerFailures: 0,
  maxInternalVariants: 0,
  maxRenderVariants: 0,
  neverConfirmed: 0,
  neverConfirmedMultiGroup: 0,
  neverConfirmedSingleGroup: 0,
  parseFailures: 0,
  saturatedLogs: 0,
  saturatedNeverConfirmed: 0,
  singletonDivergentGroups: 0,
  varying: new Map(),
  unexecutable: 0,
});

const bump = (map, key, by = 1) => {
  map.set(key, (map.get(key) ?? 0) + by);
};

/**
 * Census one battle log.
 *
 * Returns `"parse-failure"`, `"lower-failure"`, `"unexecutable"`, or the
 * census's own `"never-confirmed"` / `"confirmed-late"` / `"confirmed"`.
 * Nothing throws: a corpus has bad rows.
 */
export const censusLog = (audit, raw) => {
  audit.logs += 1;
  const locale = detectBattleLogLanguage(raw);
  bump(audit.locales, locale);

  const parsed = parseBattleLog(raw, { locale });
  if (!parsed.ok) {
    audit.parseFailures += 1;
    return "parse-failure";
  }

  const lowered = lower(parsed.value, raw);
  if (!lowered.ok) {
    audit.lowerFailures += 1;
    return "lower-failure";
  }

  const result = census(lowered.value.events);
  audit.groups += result.groups.length;
  audit.liveGroupsAtEnd += result.liveGroups.length;
  const divergent = result.liveGroups.filter((group) => group.renderVariants > 1);
  if (result.neverConfirmed) {
    if (divergent.length === 1 && result.saturatedGroupsAtEnd === 0) {
      audit.neverConfirmedSingleGroup += 1;
    } else {
      audit.neverConfirmedMultiGroup += 1;
    }
  }
  for (const group of divergent) {
    for (const dimension of group.varying) {
      bump(audit.varying, dimension);
    }
    if (group.members === 1) {
      audit.singletonDivergentGroups += 1;
    }
  }
  for (const diagnostic of result.diagnostics) {
    bump(audit.diagnostics, diagnostic.code);
  }
  audit.forkEpisodes += result.forkEpisodes;
  audit.maxRenderVariants = Math.max(audit.maxRenderVariants, result.maxRenderVariants);
  audit.maxInternalVariants = Math.max(audit.maxInternalVariants, result.maxInternalVariants);
  audit.divergentGroupsAtEnd += result.divergentGroupsAtEnd;
  if (result.saturatedGroups > 0) {
    audit.saturatedLogs += 1;
    if (result.neverConfirmed) {
      audit.saturatedNeverConfirmed += 1;
    }
  }

  if (result.unexecutable) {
    audit.unexecutable += 1;
    return "unexecutable";
  }

  if (result.neverConfirmed) {
    audit.neverConfirmed += 1;
  }
  if (result.everDivergent) {
    audit.everDivergent += 1;
  }
  if (result.confirmedLate) {
    audit.confirmedLate += 1;
  }

  if (result.neverConfirmed) {
    return "never-confirmed";
  }
  return result.confirmedLate ? "confirmed-late" : "confirmed";
};

/** A 95% Wilson score interval for a binomial proportion. */
export const wilson = (successes, total, z = 1.96) => {
  if (total === 0) {
    return { high: 0, low: 0, p: 0 };
  }
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const centre = (p + (z * z) / (2 * total)) / denominator;
  const spread = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denominator;
  return { high: Math.min(1, centre + spread), low: Math.max(0, centre - spread), p };
};

const percent = (value) => `${(100 * value).toFixed(1)}%`;

const interval = (successes, total) => {
  const result = wilson(successes, total);
  return `${percent(result.p)} (95% Wilson ${percent(result.low)}–${percent(result.high)})`;
};

const sorted = (map) =>
  [...map.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));

/** A JSON-safe projection of the accumulator. */
export const toJson = (audit) => {
  const executable = audit.logs - audit.parseFailures - audit.lowerFailures - audit.unexecutable;
  const unsaturated = executable - audit.saturatedLogs;
  const neverConfirmedUnsaturated = audit.neverConfirmed - audit.saturatedNeverConfirmed;
  return {
    confirmedLate: audit.confirmedLate,
    diagnostics: Object.fromEntries(sorted(audit.diagnostics)),
    divergentGroupsAtEnd: audit.divergentGroupsAtEnd,
    everDivergent: audit.everDivergent,
    forkEpisodes: audit.forkEpisodes,
    groups: audit.groups,
    liveGroupsAtEnd: audit.liveGroupsAtEnd,
    locales: Object.fromEntries(sorted(audit.locales)),
    logs: audit.logs,
    logsCensused: audit.logs - audit.parseFailures - audit.lowerFailures,
    logsExecutable: executable,
    logsExecutableUnsaturated: unsaturated,
    logsFailedToLower: audit.lowerFailures,
    logsFailedToParse: audit.parseFailures,
    maxInternalVariants: audit.maxInternalVariants,
    maxRenderVariants: audit.maxRenderVariants,
    neverConfirmed: audit.neverConfirmed,
    neverConfirmedMultiGroup: audit.neverConfirmedMultiGroup,
    neverConfirmedSingleGroup: audit.neverConfirmedSingleGroup,
    neverConfirmedUnsaturated,
    saturatedLogs: audit.saturatedLogs,
    saturatedNeverConfirmed: audit.saturatedNeverConfirmed,
    singletonDivergentGroups: audit.singletonDivergentGroups,
    unexecutable: audit.unexecutable,
    varying: Object.fromEntries(sorted(audit.varying)),
    wilson: {
      confirmedLate: wilson(audit.confirmedLate, executable),
      everDivergent: wilson(audit.everDivergent, executable),
      neverConfirmed: wilson(audit.neverConfirmed, executable),
      neverConfirmedUnsaturated: wilson(neverConfirmedUnsaturated, unsaturated),
    },
  };
};

/** A human-readable report. Nothing here is a battle log. */
export const formatReport = (audit) => {
  const report = toJson(audit);
  const lines = [];
  const push = (line = "") => lines.push(line);

  push(`logs                    ${report.logs}`);
  push(`  parsed                ${report.logs - report.logsFailedToParse}`);
  push(`  lowered               ${report.logsCensused}`);
  push(`  executable            ${report.logsExecutable}`);
  push(`  failed to parse       ${report.logsFailedToParse}`);
  push(`  failed to lower       ${report.logsFailedToLower}`);

  push();
  push("three figures (bare mode, executable logs)");
  push(`  never confirmed       ${interval(report.neverConfirmed, report.logsExecutable)}`);
  push(`    excluding saturated ${interval(report.neverConfirmedUnsaturated, report.logsExecutableUnsaturated)}`);
  push(`  ever divergent        ${interval(report.everDivergent, report.logsExecutable)}`);
  push(`  confirmed late        ${interval(report.confirmedLate, report.logsExecutable)}`);

  push();
  push("unexecutable is a gate, not a figure");
  push(`  unexecutable          ${report.unexecutable} (${percent(report.unexecutable / Math.max(1, report.logsCensused))} of censused)`);

  push();
  push("cost");
  push(`  groups censused       ${report.groups}`);
  push(`  fork episodes         ${report.forkEpisodes}`);
  push(`  max render variants   ${report.maxRenderVariants}`);
  push(`  max internal variants ${report.maxInternalVariants}`);
  push(`  logs saturated        ${report.saturatedLogs}`);
  push(`  live groups at end     ${report.liveGroupsAtEnd}`);
  push(`  divergent groups/end  ${report.divergentGroupsAtEnd} (${percent(report.divergentGroupsAtEnd / Math.max(1, report.liveGroupsAtEnd))} of live groups)`);
  push(`  singleton divergent   ${report.singletonDivergentGroups}`);
  push(`  never-confirmed, one  ${report.neverConfirmedSingleGroup}`);
  push(`  never-confirmed, many ${report.neverConfirmedMultiGroup}`);

  push();
  push("locales");
  for (const [locale, count] of Object.entries(report.locales)) {
    push(`  ${locale.padEnd(6)} ${String(count).padStart(6)}`);
  }

  if (Object.keys(report.varying).length > 0) {
    push();
    push("divergent groups by varying dimension");
    for (const [dimension, count] of Object.entries(report.varying)) {
      push(`  ${dimension.padEnd(20)} ${String(count).padStart(7)}`);
    }
  }

  if (Object.keys(report.diagnostics).length > 0) {
    push();
    push("ledger diagnostics");
    for (const [code, count] of Object.entries(report.diagnostics)) {
      push(`  ${code.padEnd(20)} ${String(count).padStart(7)}`);
    }
  }

  return lines.join("\n");
};
