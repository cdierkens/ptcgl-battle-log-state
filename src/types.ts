/**
 * The `ptcgl-state/1` document contract.
 *
 * A document is the reconstructed board at one prefix of a battle log. Its
 * governing rule is that a consumer must never be able to mistake a *set of
 * possibilities* for a fact: `determinacy` is required, and anything the log
 * could not split lives in a group's `candidates`, never in a slot.
 *
 * See `docs/specs/2026-10-25-state-format.md` for the reasoning.
 */

/** Which side of the board a card belongs to. */
export type Side = "self" | "opponent";

/** The two places a Pokémon in play can be. */
export type Zone = "active" | "bench";

/**
 * How well determined a prefix is.
 *
 * - `whole` — one board, no group has more than one candidate
 * - `divergent` — at least one group has two or more
 * - `unexecutable` — no board survives the log's own constraints
 *
 * `whole` is stronger than *confirmed*: two candidates that render identically
 * are still two candidates.
 */
export type Determinacy = "whole" | "divergent" | "unexecutable";

/** The document's schema identifier. The suffix is the major version. */
export type StateSchema = `ptcgl-state/${number}`;

/** Where a learnt card property came from. */
export type PropertySource = "observed" | "assumed" | "unknown";

/** A point in the battle log: phase index, the game's turn number, and the line. */
export interface Prefix {
  readonly phase: number;
  readonly turn: number | null;
  /** The content line number in the source log. Never a byte offset. */
  readonly line: number;
}

/** A zone whose contents the log never reveals, only counts. */
export interface HiddenZone {
  readonly count: number;
  /** Cards whose identity the log happened to reveal, in reveal order. */
  readonly known: readonly string[];
}

/** The Prize cards. `remaining` is a count; face-down identities are unknown. */
export interface PrizeZone {
  readonly remaining: number;
  readonly known: readonly string[];
}

/** One side's board. Slots are referenced by id, never inlined twice. */
export interface BoardSide {
  /** Slot id of the Active Pokémon. Every side always has one. */
  readonly active: string;
  readonly bench: readonly string[];
  readonly hand: HiddenZone;
  readonly prizes: PrizeZone;
}

/**
 * A Pokémon in play.
 *
 * A slot inside a group carries only the facts every candidate agrees on; the
 * values that vary live in the group's `candidates`. A slot outside a group
 * carries its own values directly.
 */
export interface Slot {
  readonly id: string;
  readonly name: string;
  readonly zone: Zone;
  /** The identity group this slot belongs to, or `null` when it is its own truth. */
  readonly group: string | null;
  readonly damage?: number;
  readonly attachments?: readonly string[];
}

/** One candidate's values for one member of a group. */
export interface CandidateValues {
  readonly damage: number;
  readonly attachments: readonly string[];
}

/** One consistent assignment of values to a group's members. */
export type GroupCandidate = Readonly<Record<string, CandidateValues>>;

/** Pokémon the log cannot tell apart, with the assignments still standing. */
export interface IdentityGroup {
  readonly id: string;
  readonly side: Side;
  readonly name: string;
  /** Slot ids this group covers. */
  readonly members: readonly string[];
  /** The prefix at which the group first had more than one possibility. */
  readonly since: Prefix;
  /** The prefix at which it collapsed to one, or `null` if it never did. */
  readonly resolvedAt: Prefix | null;
  readonly candidates: readonly GroupCandidate[];
}

/** A monotone bound on a card's HP, learnt from knockouts and survivals. */
export interface HpBound {
  readonly min: number;
  readonly max: number;
  readonly source: PropertySource;
}

/** Whether an attack can hit the Bench, as far as the log has shown. */
export interface TargetingBound {
  readonly bench: boolean | null;
  readonly source: PropertySource;
}

/** What the solver has learnt about the game's cards, as opposed to its board. */
export interface PropertyBlock {
  /** Keyed by `${side}/${cardName}`. */
  readonly hp: Readonly<Record<string, HpBound>>;
  /** Keyed by `${cardName}/${attackName}`. */
  readonly targeting: Readonly<Record<string, TargetingBound>>;
}

/** A non-fatal or fatal finding about the reconstruction. */
export interface Diagnostic {
  readonly severity: "warning" | "error";
  readonly code: string;
  readonly message: string;
  readonly line?: number;
}

/** Provenance for a document: what produced it, and from which log. */
export interface Provenance {
  readonly logHash: string;
  readonly playerName: string | null;
  /** The solver's version, so a snapshot can be tied to the code that made it. */
  readonly solver: string;
}

/** A reconstructed board at one prefix. */
export interface StateDocument {
  readonly schema: StateSchema;
  readonly determinacy: Determinacy;
  readonly prefix: Prefix;
  readonly provenance: Provenance;
  readonly board: Readonly<Record<Side, BoardSide>>;
  readonly slots: readonly Slot[];
  readonly groups: readonly IdentityGroup[];
  readonly properties: PropertyBlock;
  readonly diagnostics: readonly Diagnostic[];
}
