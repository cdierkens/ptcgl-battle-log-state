/**
 * The record's event language: the locale-free IR the solver reads.
 *
 * This is the "core language" of the design spec — the parser's surface AST is
 * lowered into it, and nothing above this layer reads `templateKey`, `groups`,
 * or prose. Every event is exactly as ambiguous as the log: it names cards, not
 * instances, and it says nothing about which of two identical cards it means.
 *
 * Events cannot happen; they are *stated*. Whether one is possible in a state is
 * the solver's business, not this layer's.
 */

import type { Side } from "./types.js";

/** Where in the battle log an event came from. */
export interface EventLocation {
  /** Index into `BattleLog.phases`. */
  readonly phaseIndex: number;
  /** The game's own turn number, or `null` outside a turn. */
  readonly turn: number | null;
  /** The content line number in the source log. Never a byte offset. */
  readonly line: number;
}

/**
 * A card named by side, with no instance identity — deliberately.
 *
 * `name` is whatever the log printed, verbatim. When the game did not identify
 * a card, the placeholder is filled with a count phrase ("2 cards"), and this
 * layer does not try to tell the two apart: interpreting a name is the solver's
 * job, and doing it here would invent data on a guess.
 */
export interface CardRef {
  readonly side: Side;
  readonly name: string;
}

/** A place a card can be. Wider than the board's two zones. */
export type CardZone =
  | "active"
  | "bench"
  | "stadium"
  | "hand"
  | "deck"
  | "discard"
  | "prizes"
  | "lost";

/** A named damage adjustment printed beside the total. */
export interface DamageModifier {
  readonly kind: "weakness" | "resistance";
  readonly amount: number;
  readonly energyType: string;
}

/** One component of a printed damage breakdown. */
export interface BreakdownLine {
  readonly label: string;
  readonly amount: number;
}

interface EventBase {
  readonly at: EventLocation;
}

/** An attack used with no damage attached to it. */
export interface AttackEvent extends EventBase {
  readonly kind: "attack";
  readonly source: CardRef;
  readonly attack: string;
}

/** Damage from an attack or an ability. `source` is null when the log omits it. */
export interface DamageEvent extends EventBase {
  readonly kind: "damage";
  readonly source: CardRef | null;
  readonly attack: string | null;
  readonly target: CardRef;
  /** The printed total, after weakness and resistance. */
  readonly amount: number;
  readonly modifiers: readonly DamageModifier[];
  /** Present only when the log printed a breakdown for this hit. */
  readonly breakdown?: readonly BreakdownLine[];
}

/** Damage counters placed by a card or a Special Condition. */
export interface CounterDamageEvent extends EventBase {
  readonly kind: "counterDamage";
  readonly cause: string;
  readonly target: CardRef;
  readonly counters: number;
  /** `counters * 10`, computed here so no consumer re-derives it. */
  readonly damage: number;
  /**
   * Whether the line names the target's owner. A Special Condition line does.
   * A placed-counter line names the owner of the card whose effect placed them,
   * so `target.side` there is not the target's side.
   */
  readonly ownerPrinted: boolean;
}

/** Damage counters moved between two cards. */
export interface MoveCountersEvent extends EventBase {
  readonly kind: "moveCounters";
  readonly cause: string;
  readonly from: CardRef;
  readonly to: CardRef;
  readonly counters: number;
  readonly damage: number;
  /**
   * Whether the line names the two cards' owners. A moved-counter line prints
   * the owner of the card whose effect moved them for both ends.
   */
  readonly ownerPrinted: boolean;
}

/** Healing, in damage. */
export interface HealEvent extends EventBase {
  readonly kind: "heal";
  readonly target: CardRef;
  readonly damage: number;
  /**
   * Whether the line names the target's owner. `healed` does; `healed_dc`
   * prints the owner of the card whose effect removed the counters.
   */
  readonly ownerPrinted: boolean;
}

/** A Pokémon was Knocked Out. */
export interface KnockoutEvent extends EventBase {
  readonly kind: "knockout";
  readonly target: CardRef;
}

/** An Energy or Tool attached to a Pokémon. `zone` is null when the log omits it. */
export interface AttachEvent extends EventBase {
  readonly kind: "attach";
  readonly card: string;
  readonly target: CardRef;
  readonly zone: "active" | "bench" | null;
}

/**
 * Cards discarded from a Pokémon. `cards` is empty when the log printed a count
 * without a list — the conservation ledger still knows how many left.
 */
export interface DetachEvent extends EventBase {
  readonly kind: "detach";
  readonly body: CardRef;
  readonly cards: readonly string[];
  readonly count: number;
}

/** A Pokémon evolved. `into` is the new name; the old card leaves the board. */
export interface EvolveEvent extends EventBase {
  readonly kind: "evolve";
  readonly from: CardRef;
  readonly into: string;
  readonly zone: "active" | "bench" | null;
}

/** A Pokémon devolved; the same shape as {@link EvolveEvent} in reverse. */
export interface DevolveEvent extends EventBase {
  readonly kind: "devolve";
  readonly from: CardRef;
  readonly into: string;
  readonly zone: "active" | "bench" | null;
}

/** A card put into play. `zone` is null when the log omits the destination. */
export interface PlayEvent extends EventBase {
  readonly kind: "play";
  readonly card: CardRef;
  readonly zone: CardZone | null;
}

/** A card moved to another zone by an effect. */
export interface MoveCardEvent extends EventBase {
  readonly kind: "moveCard";
  readonly card: CardRef;
  readonly to: CardZone;
}

/** The Active Pokémon retreated to the Bench. */
export interface RetreatEvent extends EventBase {
  readonly kind: "retreat";
  readonly card: CardRef;
}

/** Two Pokémon swapped places; `outgoing` was Active and leaves it. */
export interface SwitchActiveEvent extends EventBase {
  readonly kind: "switchActive";
  readonly outgoing: CardRef;
  readonly incoming: CardRef;
}

/** Cards drawn, with whatever the log revealed. */
export interface DrawEvent extends EventBase {
  readonly kind: "draw";
  readonly side: Side;
  readonly count: number;
  readonly revealed: readonly string[];
  readonly opening: boolean;
}

/** Prize cards taken. */
export interface PrizeTakenEvent extends EventBase {
  readonly kind: "prizeTaken";
  readonly side: Side;
  readonly count: number;
}

/** A face-down Prize card's identity was revealed as it was added to hand. */
export interface PrizeRevealedEvent extends EventBase {
  readonly kind: "prizeRevealed";
  readonly side: Side;
  readonly card: string;
}

/** A turn ended. */
export interface EndTurnEvent extends EventBase {
  readonly kind: "endTurn";
  readonly side: Side;
}

/** The log's own end-of-game line. */
export interface EndGameEvent extends EventBase {
  readonly kind: "endGame";
  readonly winner: string;
  readonly reason: string;
}

/** Every event the lowering pass can produce. */
/**
 * "Damage to X was prevented": an effect reached the card and nothing landed.
 * The line names the card, never its owner.
 */
export interface PreventedEvent extends EventBase {
  readonly kind: "prevented";
  readonly name: string;
}

export type GameEvent =
  | AttackEvent
  | AttachEvent
  | CounterDamageEvent
  | DamageEvent
  | DevolveEvent
  | DetachEvent
  | DrawEvent
  | EndGameEvent
  | EndTurnEvent
  | EvolveEvent
  | HealEvent
  | KnockoutEvent
  | MoveCardEvent
  | MoveCountersEvent
  | PlayEvent
  | PreventedEvent
  | PrizeRevealedEvent
  | PrizeTakenEvent
  | RetreatEvent
  | SwitchActiveEvent;

/** A line that was matched but deliberately carries no board state. */
export interface IgnoredEntry {
  readonly key: string;
  readonly at: EventLocation;
  readonly reason: IgnoreReason;
}

/** A line that was matched, and which this build has no classification for. */
export interface UnhandledEntry {
  readonly key: string;
  readonly at: EventLocation;
  readonly raw: string;
}

/** A line that should have produced an event but could not be lowered. */
export interface LoweringDiagnostic {
  readonly code: "AmbiguousTemplate" | "MissingPlaceholder" | "UnresolvedSide" | "BadNumber";
  readonly at: EventLocation;
  readonly message: string;
  readonly raw: string;
}

/** Why a matched line carries no board state. */
export type IgnoreReason =
  | "breakdown"
  | "fragment"
  | "flavour"
  | "header"
  | "restatement"
  | "settings"
  | "unmodelled";

/** The result of lowering one battle log. */
export interface LoweredLog {
  readonly events: readonly GameEvent[];
  readonly ignored: readonly IgnoredEntry[];
  readonly unhandled: readonly UnhandledEntry[];
  readonly diagnostics: readonly LoweringDiagnostic[];
}
