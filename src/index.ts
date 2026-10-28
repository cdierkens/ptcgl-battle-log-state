/**
 * `@dierkens.dev/ptcgl-battle-log-state`
 *
 * Reconstruct a Pokémon TCG Live board from a battle log, and say so when the
 * log cannot settle it. This entry point exports the document contract and its
 * validator; the lowering pass and the solver land behind the same types.
 *
 * Nothing here guesses. A prefix that could not be resolved is `divergent`, and
 * the alternatives travel with the document.
 */

export { validateDocument } from "./document.js";
export { InvalidStateDocumentError, type ValidationIssue, UnresolvedPlayersError } from "./errors.js";
export type {
  AttackEvent,
  AttachEvent,
  BreakdownLine,
  CardRef,
  CardZone,
  ChoiceEvent,
  CounterDamageEvent,
  DamageEvent,
  DamageModifier,
  DevolveEvent,
  DetachEvent,
  DrawEvent,
  EndGameEvent,
  EndTurnEvent,
  EventLocation,
  EvolveEvent,
  GameEvent,
  HealEvent,
  HiddenPlayEvent,
  IgnoreReason,
  IgnoredEntry,
  KnockoutEvent,
  LoweredLog,
  LoweringDiagnostic,
  MoveCardEvent,
  MoveCountersEvent,
  PlayEvent,
  PreventedEvent,
  PrizeRevealedEvent,
  PrizeTakenEvent,
  RetreatEvent,
  SwitchActiveEvent,
  UnhandledEntry,
} from "./events.js";
export { lower, type LowerOptions } from "./lowering.js";
export { census, type CensusResult } from "./census.js";
export type { CardAbility, CardAttack, CardOracle, CardPrinting, CounterSpread, KnockoutReach, StadiumFacts } from "./oracle.js";
export { benchLimitFromText, counterSpreadFromText, knocksOutFromText, leavesPlayFromText } from "./card-text.js";
export {
  runLedger,
  type HpInterval,
  type LedgerDiagnostic,
  type LedgerGroupSnapshot,
  type LedgerOptions,
  type LedgerRun,
  type MaterialValue,
} from "./ledger.js";
export {
  err,
  isErr,
  isOk,
  ok,
  unwrap,
  type Err,
  type Ok,
  type Result,
} from "./result.js";
export type {
  BoardSide,
  CandidateValues,
  Determinacy,
  Diagnostic,
  GroupCandidate,
  HiddenZone,
  HpBound,
  IdentityGroup,
  Prefix,
  PrizeZone,
  PropertyBlock,
  PropertySource,
  Provenance,
  Side,
  Slot,
  StateDocument,
  StateSchema,
  TargetingBound,
  Zone,
} from "./types.js";
