/**
 * Corpus coverage audit — the aggregation behind `docs/audits/`.
 *
 * Answers one question: does the lowering cover what real logs actually
 * contain? It counts template keys, ignored reasons, unhandled keys, and the
 * events that came out. It does **not** measure divergence; that needs the
 * solver and is a later audit.
 *
 * Privacy: this module never prints a battle log. `report()` returns counts;
 * raw text appears only when a caller explicitly opts in, which the corpus
 * command does not.
 */

import { detectBattleLogLanguage, parseBattleLog } from "@dierkens.dev/ptcgl-battle-log-parser";

import { lower } from "../dist/index.js";

/** One key's tally: how often it fired, and how it was classified. */
const emptyKey = () => ({ ignored: 0, lines: 0, unhandled: 0 });

/** A fresh accumulator. */
export const createAudit = () => ({
  diagnostics: new Map(),
  events: new Map(),
  ignored: new Map(),
  keys: new Map(),
  locales: new Map(),
  logs: 0,
  lowerFailures: 0,
  parseFailures: [],
  suspiciousAttacks: 0,
  unhandled: new Map(),
});

const bump = (map, key, by = 1) => {
  map.set(key, (map.get(key) ?? 0) + by);
};

const keyTally = (audit, key) => {
  const tally = audit.keys.get(key) ?? emptyKey();
  audit.keys.set(key, tally);
  return tally;
};

/** Count every content line by key, straight from the tree. */
const countKeys = (audit, phases) => {
  for (const phase of phases) {
    for (const main of phase.mainEntries) {
      keyTally(audit, main.event.templateKey).lines += 1;
      for (const sub of main.subEntries) {
        keyTally(audit, sub.event.templateKey).lines += 1;
      }
    }
  }
};

/**
 * Audit one battle log.
 *
 * Returns `"parse-failure"`, `"lower-failure"`, or `"audited"`. Nothing throws:
 * a corpus has bad rows, and stopping on the first one is how a survey becomes
 * an outage.
 */
export const auditLog = (audit, raw) => {
  audit.logs += 1;

  const locale = detectBattleLogLanguage(raw);
  bump(audit.locales, locale);

  const parsed = parseBattleLog(raw, { locale });
  if (!parsed.ok) {
    audit.parseFailures.push({
      lineLength: parsed.error.line.length,
      lineNumber: parsed.error.lineNumber,
      locale,
    });
    return "parse-failure";
  }

  countKeys(audit, parsed.value.phases);

  const lowered = lower(parsed.value, raw);
  if (!lowered.ok) {
    audit.lowerFailures += 1;
    return "lower-failure";
  }

  for (const entry of lowered.value.ignored) {
    bump(audit.ignored, entry.reason);
    keyTally(audit, entry.key).ignored += 1;
  }
  for (const entry of lowered.value.unhandled) {
    bump(audit.unhandled, entry.key);
    keyTally(audit, entry.key).unhandled += 1;
  }
  for (const diagnostic of lowered.value.diagnostics) {
    bump(audit.diagnostics, diagnostic.code);
  }
  for (const event of lowered.value.events) {
    bump(audit.events, event.kind);
    // A `used_attack` whose name swallowed a damage clause means the hit was
    // lost to a template mismatch — each one is a damage event that vanished.
    if (event.kind === "attack" && /\d/u.test(event.attack)) {
      audit.suspiciousAttacks += 1;
    }
  }

  return "audited";
};

const sorted = (map) =>
  [...map.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));

/** A JSON-safe projection of an accumulator. */
export const toJson = (audit) => ({
  diagnostics: Object.fromEntries(sorted(audit.diagnostics)),
  events: Object.fromEntries(sorted(audit.events)),
  ignored: Object.fromEntries(sorted(audit.ignored)),
  keys: [...audit.keys.entries()]
    .sort((left, right) => right[1].lines - left[1].lines)
    .map(([key, tally]) => [key, { ...tally, mapped: tally.lines - tally.ignored - tally.unhandled }]),
  locales: Object.fromEntries(sorted(audit.locales)),
  logs: audit.logs,
  logsAudited: audit.logs - audit.parseFailures.length - audit.lowerFailures,
  logsFailedToLower: audit.lowerFailures,
  logsFailedToParse: audit.parseFailures.length,
  parseFailuresByLocale: audit.parseFailures.reduce((totals, failure) => {
    totals[failure.locale] = (totals[failure.locale] ?? 0) + 1;
    return totals;
  }, {}),
  suspiciousAttacks: audit.suspiciousAttacks,
  unhandled: Object.fromEntries(sorted(audit.unhandled)),
});

const percent = (part, whole) => (whole === 0 ? "0.0" : ((100 * part) / whole).toFixed(1));

/** A human-readable report. */
export const formatReport = (audit) => {
  const report = toJson(audit);
  const lines = [];
  const push = (line = "") => lines.push(line);

  push(`logs                 ${report.logs}`);
  push(`  audited            ${report.logsAudited}`);
  push(`  failed to parse    ${report.logsFailedToParse} (${percent(report.logsFailedToParse, report.logs)}%)`);
  push(`  failed to lower    ${report.logsFailedToLower}`);
  push(`  suspicious attacks ${report.suspiciousAttacks}`);

  push();
  push("locales");
  for (const [locale, count] of Object.entries(report.locales)) {
    push(`  ${locale.padEnd(6)} ${String(count).padStart(6)}`);
  }

  push();
  push("events by kind");
  for (const [kind, count] of Object.entries(report.events)) {
    push(`  ${kind.padEnd(18)} ${String(count).padStart(7)}`);
  }

  push();
  push("ignored by reason");
  for (const [reason, count] of Object.entries(report.ignored)) {
    push(`  ${reason.padEnd(18)} ${String(count).padStart(7)}`);
  }

  if (Object.keys(report.unhandled).length > 0) {
    push();
    push("UNHANDLED KEYS — a key the table does not cover");
    for (const [key, count] of Object.entries(report.unhandled)) {
      push(`  ${key.padEnd(44)} ${String(count).padStart(6)}`);
    }
  }

  if (Object.keys(report.diagnostics).length > 0) {
    push();
    push("lowering diagnostics");
    for (const [code, count] of Object.entries(report.diagnostics)) {
      push(`  ${code.padEnd(18)} ${String(count).padStart(7)}`);
    }
  }

  if (report.logsFailedToParse > 0) {
    push();
    push("parse failures by locale");
    for (const [locale, count] of Object.entries(report.parseFailuresByLocale)) {
      push(`  ${locale.padEnd(6)} ${String(count).padStart(6)}`);
    }
    push("  (line text is deliberately not reported)");
  }

  push();
  push("top template keys");
  for (const [key, tally] of report.keys.slice(0, 20)) {
    const status = tally.unhandled > 0 ? "UNHANDLED" : tally.mapped > 0 ? "mapped" : "ignored";
    push(`  ${String(tally.lines).padStart(6)}  ${key.padEnd(44)} ${status}`);
  }

  return lines.join("\n");
};
