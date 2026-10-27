/**
 * The fork census: the ledger's three figures and its cost metrics.
 *
 * This is a measurement, not the solver. It runs the forward ledger once and
 * reduces the result to counts; it never backtracks and never materialises a
 * world. The module is separate from `ledger.ts` because the board's rules and
 * the measurement's definitions change for different reasons.
 *
 * A **fork** is the moment a group first renders more than one picture. It
 * **collapses** when later evidence leaves one. A group still plural at the
 * end is **never confirmed**. A saturated group is counted as never confirmed
 * because its variant set was truncated: it may be plural, and saying so is the
 * conservative direction for an upper bound.
 */

import type { GameEvent } from "./events.js";
import {
  runLedger,
  type LedgerDiagnostic,
  type LedgerGroupSnapshot,
  type LedgerOptions,
} from "./ledger.js";

/** The three figures, plus the cost metrics the solver will care about. */
export interface CensusResult {
  readonly groups: readonly LedgerGroupSnapshot[];
  readonly liveGroups: readonly LedgerGroupSnapshot[];
  /** A group forked and collapsed before the end. */
  readonly confirmedLate: boolean;
  /** A fork occurred at any point, whether or not it collapsed. */
  readonly everDivergent: boolean;
  /**
   * At least one live group still renders more than one picture, or a live group
   * was saturated and could not be decided.
   */
  readonly neverConfirmed: boolean;
  readonly forkEpisodes: number;
  /** Live groups with more than one actual picture. */
  readonly divergentGroupsAtEnd: number;
  /** Live groups whose variant set hit the cap. */
  readonly saturatedGroupsAtEnd: number;
  readonly maxInternalVariants: number;
  readonly maxRenderVariants: number;
  /** Groups that hit the cap at any point. */
  readonly saturatedGroups: number;
  readonly unexecutable: boolean;
  readonly diagnostics: readonly LedgerDiagnostic[];
  /** Per-prefix confirmation counts across the whole log. */
  readonly prefixes: {
    readonly total: number;
    readonly confirmed: number;
    readonly divergent: number;
    readonly saturated: number;
    readonly stableTotal: number;
    readonly stableConfirmed: number;
    readonly stableDivergent: number;
    readonly stableSaturated: number;
  };
  /** `confirmed / total`, or 0 when the log has no prefixes. */
  readonly confirmedPrefixRate: number;
  /** `stableConfirmed / stableTotal`, or 0 when the log has no turn boundary. */
  readonly stablePrefixRate: number;
}

/** Run the ledger and reduce it to the figures the audit reports. */
export const census = (events: readonly GameEvent[], options: LedgerOptions = {}): CensusResult => {
  const run = runLedger(events, options);
  const liveDivergent = run.liveGroups.filter((group) => group.renderVariants > 1);
  const liveSaturated = run.liveGroups.filter((group) => group.saturated);
  const everDivergent = run.groups.some((group) => group.everDivergent || group.saturated);
  const neverConfirmed = liveDivergent.length > 0 || liveSaturated.length > 0;
  return {
    confirmedLate: everDivergent && !neverConfirmed,
    confirmedPrefixRate: run.prefixes.total === 0 ? 0 : run.prefixes.confirmed / run.prefixes.total,
    diagnostics: run.diagnostics,
    divergentGroupsAtEnd: liveDivergent.length,
    everDivergent,
    forkEpisodes: run.groups.reduce((total, group) => total + group.forkCount, 0),
    groups: run.groups,
    liveGroups: run.liveGroups,
    maxInternalVariants: run.maxInternalVariants,
    maxRenderVariants: run.maxRenderVariants,
    neverConfirmed,
    prefixes: run.prefixes,
    saturatedGroups: run.groups.filter((group) => group.saturated).length,
    saturatedGroupsAtEnd: liveSaturated.length,
    stablePrefixRate: run.prefixes.stableTotal === 0
      ? 0
      : run.prefixes.stableConfirmed / run.prefixes.stableTotal,
    unexecutable: run.unexecutable,
  };
};
