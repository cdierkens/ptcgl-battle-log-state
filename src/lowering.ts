/**
 * Lowering: the parser's surface AST into the locale-free event language.
 *
 * The table is **total**: every shipped template key is either mapped to an
 * event or listed as ignored with a reason. A key in neither list is a build
 * failure, not a runtime surprise — the parser's key set can move in a minor
 * when the game client changes, and a silently dropped key is a silently
 * missing constraint.
 *
 * This layer never decides what is *possible*. It says what the log stated, and
 * nothing else.
 */

import type { BattleLog, MainEntry, SubEntry, TemplateEvent } from "@dierkens.dev/ptcgl-battle-log-parser";

import { UnresolvedPlayersError } from "./errors.js";
import type {
  BreakdownLine,
  CardRef,
  DamageModifier,
  EventLocation,
  GameEvent,
  IgnoreReason,
  IgnoredEntry,
  LoweredLog,
  LoweringDiagnostic,
  UnhandledEntry,
} from "./events.js";
import { err, ok, type Result } from "./result.js";
import type { Side } from "./types.js";

/** Everything a handler needs to turn one matched line into events. */
export interface LoweringInput {
  readonly key: string;
  readonly groups: Readonly<Record<string, string>>;
  readonly raw: string;
  readonly at: EventLocation;
  /** The `• ` text attached to this entry, joined with newlines, or null. */
  readonly subString: string | null;
  /** Resolve a player name to a side, throwing when the name is unknown. */
  readonly sideOfPlayer: (playerName: string) => Side;
}

/** A handler returns every event the line states — usually one, sometimes none. */
export type Handler = (input: LoweringInput) => readonly GameEvent[];

/** A placeholder the template promised but the log did not carry. */
class MissingPlaceholder extends Error {
  readonly group: string;
  constructor(group: string) {
    super(`missing placeholder ${group}`);
    this.group = group;
  }
}

/** A numeric placeholder that is not a non-negative integer. */
class BadNumber extends Error {
  constructor(readonly group: string, readonly value: string) {
    super(`placeholder ${group} is not a number: ${value}`);
  }
}

/** A player name that appears in the log but in no turn header. */
class UnknownSide extends Error {
  constructor(readonly playerName: string) {
    super(`no side for player ${playerName}`);
  }
}

const need = (input: LoweringInput, group: string): string => {
  const value = input.groups[group];
  if (value === undefined || value === "") {
    throw new MissingPlaceholder(group);
  }
  return value;
};

const count = (input: LoweringInput, group: string): number => {
  const raw = need(input, group);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new BadNumber(group, raw);
  }
  return value;
};

/** A printed adjustment, which may be negative — resistance reads "-30". */
const signed = (input: LoweringInput, group: string): number => {
  const raw = need(input, group);
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new BadNumber(group, raw);
  }
  return value;
};

const player = (input: LoweringInput, group: string): Side =>
  input.sideOfPlayer(need(input, group));

const at = (input: LoweringInput): EventLocation => input.at;

const card = (input: LoweringInput, playerGroup: string, cardGroup: string): CardRef => ({
  name: need(input, cardGroup),
  side: player(input, playerGroup),
});

/** A weakness or resistance clause, as printed beside the total. */
interface ModifierSpec {
  readonly field: string;
  readonly kind: "weakness" | "resistance";
  readonly energy: string;
}

const modifiers = (input: LoweringInput, specs: readonly ModifierSpec[]): readonly DamageModifier[] =>
  specs.map((spec) => ({
    amount: signed(input, spec.field),
    energyType: need(input, spec.energy),
    kind: spec.kind,
  }));

const WEAKNESS: ModifierSpec = { energy: "energyType", field: "numAdditionalDamage", kind: "weakness" };
const RESISTANCE: ModifierSpec = { energy: "energyType", field: "numReducedDamage", kind: "resistance" };

/** An attack line that names attacker, attack, target and a total. */
const damageFrom =
  (spec: {
    readonly actor: string;
    readonly attacker: string;
    readonly attack: string;
    readonly defender: string;
    readonly target: string;
    readonly amount: string;
    readonly modifiers?: readonly ModifierSpec[];
  }): Handler =>
  (input) => [
    {
      amount: count(input, spec.amount),
      at: at(input),
      attack: need(input, spec.attack),
      kind: "damage",
      modifiers: modifiers(input, spec.modifiers ?? []),
      source: card(input, spec.actor, spec.attacker),
      target: card(input, spec.defender, spec.target),
    },
  ];

/** A damage line with no attacker: secondary damage from an effect. */
const secondaryDamage =
  (spec: {
    readonly defender: string;
    readonly target: string;
    readonly amount: string;
    readonly modifiers?: readonly ModifierSpec[];
  }): Handler =>
  (input) => [
    {
      amount: count(input, spec.amount),
      at: at(input),
      attack: null,
      kind: "damage",
      modifiers: modifiers(input, spec.modifiers ?? []),
      source: null,
      target: card(input, spec.defender, spec.target),
    },
  ];

/** Damage counters placed by a card or a Special Condition. */
const counterDamage =
  (spec: {
    readonly cause: string;
    readonly causeIsCondition?: boolean;
    readonly targetPlayer: string;
    readonly target: string;
    readonly counters: number | string;
  }): Handler =>
  (input) => {
    const counters = typeof spec.counters === "number" ? spec.counters : count(input, spec.counters);
    const cause = spec.causeIsCondition === true
      ? `Special Condition: ${need(input, spec.cause)}`
      : need(input, spec.cause);
    return [
      {
        at: at(input),
        cause,
        counters,
        damage: counters * 10,
        kind: "counterDamage",
        // Only a Special Condition line names the target's owner.
        ownerPrinted: spec.causeIsCondition === true,
        target: card(input, spec.targetPlayer, spec.target),
      },
    ];
  };

const moveCounters =
  (spec: {
    readonly cause: string;
    readonly counters: number | string;
    readonly fromPlayer: string;
    readonly from: string;
    readonly toPlayer: string;
    readonly to: string;
  }): Handler =>
  (input) => {
    const counters = typeof spec.counters === "number" ? spec.counters : count(input, spec.counters);
    return [
      {
        at: at(input),
        cause: need(input, spec.cause),
        counters,
        damage: counters * 10,
        from: card(input, spec.fromPlayer, spec.from),
        kind: "moveCounters",
        ownerPrinted: false,
        to: card(input, spec.toPlayer, spec.to),
      },
    ];
  };

const heal =
  (spec: {
    readonly targetPlayer: string;
    readonly target: string;
    readonly amount: string;
    readonly inCounters?: boolean;
  }): Handler =>
  (input) => {
    const printed = count(input, spec.amount);
    return [
      {
        at: at(input),
        damage: spec.inCounters === true ? printed * 10 : printed,
        kind: "heal",
        // A counter-removal line prints the acting card's owner, not the target's.
        ownerPrinted: spec.inCounters !== true,
        target: card(input, spec.targetPlayer, spec.target),
      },
    ];
  };

/** Split a `• ` card list into names.
 *
 * English rule only. The separator is localized, which is the main i18n risk
 * above the parser; the corpus audit is what will show whether this holds for
 * the other six locales.
 */
const splitCardList = (subString: string | null): readonly string[] =>
  subString === null
    ? []
    : subString
        .split(/\r?\n/u)
        .flatMap((line) => line.split(/,\s*/u))
        .map((name) => name.trim())
        .filter((name) => name.length > 0);

const attach =
  (zone: "active" | "bench" | null): Handler =>
  (input) => {
    const side = player(input, "playerName");
    return [
      {
        at: at(input),
        card: need(input, "sourceCardName"),
        kind: "attach",
        target: { name: need(input, "targetCardName"), side },
        zone,
      },
    ];
  };

const evolve =
  (direction: "evolve" | "devolve", zone: "active" | "bench" | null): Handler =>
  (input) => {
    const owner = direction === "evolve" ? "playerName" : "sourcePlayerName";
    return [
      {
        at: at(input),
        from: card(input, owner, "sourcePokemonCardName"),
        into: need(input, "targetPokemonCardName"),
        kind: direction,
        zone,
      },
    ];
  };

const play =
  (zone: "active" | "bench" | "stadium" | null): Handler =>
  (input) => [
    { at: at(input), card: card(input, "playerName", "cardName"), kind: "play", zone },
  ];

/** A move whose line names only the actor: `[player] shuffled [card] into their deck`. */
const moveOwnTo = (to: MoveTarget): Handler => moveCards(to, "playerName");

const moveTo = (to: MoveTarget): Handler => moveCards(to, "targetPlayerName");

/**
 * A move that may name one card or a count phrase with the real names in the
 * sub-entry.
 *
 * `[player] shuffled 2 cards into their deck` is the count; the `•` list under
 * it names them. Taking the count phrase as the card is how a Pokémon that left
 * the board stays on it, so the list wins whenever the log printed one. With no
 * list, the placeholder is carried verbatim — a phantom name is honest, a made
 * up one is not (D35).
 */
const moveCards =
  (to: MoveTarget, owner: "playerName" | "targetPlayerName"): Handler =>
  (input) => {
    const side = player(input, owner);
    const names = splitCardList(input.subString);
    if (names.length > 0) {
      return names.map((name) => ({
        at: at(input),
        card: { name, side },
        kind: "moveCard",
        to,
      }));
    }
    return [
      { at: at(input), card: { name: need(input, "cardName"), side }, kind: "moveCard", to },
    ];
  };

/**
 * `"[player] discarded [card]"` names only the actor, not a target owner.
 *
 * Board and hand discards print the same words, so the parser cannot name the
 * key; both keys lower here, which is what lets a candidate pair agree.
 */
const discardOwn: Handler = moveCards("discard", "playerName");

/** Zones a `move_to_*` line can name. */
type MoveTarget = "active" | "bench" | "deck" | "discard" | "hand" | "lost" | "prizes" | "stadium";

const drawOne: Handler = (input) => [
  {
    at: at(input),
    count: 1,
    kind: "draw",
    opening: false,
    revealed: [need(input, "cardName")],
    side: player(input, "playerName"),
  },
];

const drawThenPlay =
  (zone: "active" | "bench" | "stadium" | null): Handler =>
  (input) => {
    const side = player(input, "playerName");
    const name = need(input, "cardName");
    return [
      { at: at(input), count: 1, kind: "draw", opening: false, revealed: [name], side },
      { at: at(input), card: { name, side }, kind: "play", zone },
    ];
  };

const drawThenPlayMany =
  (zone: "active" | "bench" | "stadium"): Handler =>
  (input) => {
    const side = player(input, "playerName");
    const drawn = count(input, "numCards");
    const plays: GameEvent[] = splitCardList(input.subString).map((name) => ({
      at: at(input),
      card: { name, side },
      kind: "play",
      zone,
    }));
    return [
      { at: at(input), count: drawn, kind: "draw", opening: false, revealed: [], side },
      ...plays,
    ];
  };

const DETACH_MULTI = "blog_loc_discarded_attachment_multi";
const BREAKDOWN_LABEL = "blog_loc_export_damage_breakdown_label";

/**
 * Every template key that lowers to an event.
 *
 * Keys map to handlers, not to placeholder names, because the same role arrives
 * under different group names per template (`targetPokemonCardName`,
 * `pokemonCardName`, `targetCardName`, `cardName`) and some names change
 * meaning between families (`sourceCardName` is the Energy in `attach` and the
 * pre-evolution in `evolve`).
 */
export const MAPPED: Readonly<Record<string, Handler>> = {
  blog_loc_added_prize: (input) => [
    {
      at: at(input),
      card: need(input, "cardName"),
      kind: "prizeRevealed",
      side: player(input, "playerName"),
    },
  ],
  blog_loc_applied_damage: damageFrom({
    actor: "attackingPlayerName",
    amount: "numDamage",
    attack: "attackName",
    attacker: "attackingPokemonCardName",
    defender: "defendingPlayerName",
    target: "targetPokemonCardName",
  }),
  blog_loc_attach_card_active: attach("active"),
  blog_loc_attach_card_bench: attach("bench"),
  blog_loc_attach_card_fallback: attach(null),
  blog_loc_condition_damage_many: counterDamage({
    cause: "specialConditionName",
    causeIsCondition: true,
    counters: "numDamageCounters",
    target: "targetPokemonCardName",
    targetPlayer: "targetPlayerName",
  }),
  blog_loc_condition_damage_single: counterDamage({
    cause: "specialConditionName",
    causeIsCondition: true,
    counters: 1,
    target: "targetPokemonCardName",
    targetPlayer: "targetPlayerName",
  }),
  blog_loc_devolved_active: evolve("devolve", "active"),
  blog_loc_devolved_bench: evolve("devolve", "bench"),
  blog_loc_devolved_fallback: evolve("devolve", null),
  blog_loc_discarded_attachment: (input) => [
    {
      at: at(input),
      body: card(input, "playerName", "pokemonCardName"),
      cards: [need(input, "cardName")],
      count: 1,
      kind: "detach",
    },
  ],
  [DETACH_MULTI]: (input) => {
    const cards = splitCardList(input.subString);
    return [
      {
        at: at(input),
        body: card(input, "playerName", "pokemonCardName"),
        cards,
        count: cards.length > 0 ? cards.length : count(input, "numCards"),
        kind: "detach",
      },
    ];
  },
  blog_loc_discarded_from_board: discardOwn,
  blog_loc_discarded_from_hand: discardOwn,
  blog_loc_draw_opening_hand: (input) => [
    {
      at: at(input),
      count: count(input, "numCards"),
      kind: "draw",
      opening: true,
      revealed: [],
      side: player(input, "playerName"),
    },
  ],
  blog_loc_drew_card: drawOne,
  blog_loc_drew_then_play_active: drawThenPlay("active"),
  blog_loc_drew_then_play_bench: drawThenPlay("bench"),
  blog_loc_drew_then_play_bench_multi: drawThenPlayMany("bench"),
  blog_loc_drew_then_play_fallback: drawThenPlay(null),
  blog_loc_drew_then_play_stadium: drawThenPlay("stadium"),
  blog_loc_end_game: (input) => [
    { at: at(input), kind: "endGame", reason: need(input, "gameEndReason"), winner: need(input, "playerName") },
  ],
  blog_loc_evolved_active: evolve("evolve", "active"),
  blog_loc_evolved_bench: evolve("evolve", "bench"),
  blog_loc_evolved_fallback: evolve("evolve", null),
  blog_loc_healed: heal({ amount: "numDamage", target: "pokemonCardName", targetPlayer: "playerName" }),
  blog_loc_healed_dc: heal({
    amount: "numDamageCounters",
    inCounters: true,
    target: "sourcePokemonCardName",
    targetPlayer: "sourcePlayerName",
  }),
  blog_loc_knockout: (input) => [
    { at: at(input), kind: "knockout", target: card(input, "playerName", "cardName") },
  ],
  blog_loc_manual_end: (input) => [
    { at: at(input), kind: "endTurn", side: player(input, "playerName") },
  ],
  blog_loc_move_to_active: moveTo("active"),
  blog_loc_move_to_bench: moveTo("bench"),
  blog_loc_move_to_deck: moveTo("deck"),
  blog_loc_move_to_discard: moveTo("discard"),
  blog_loc_move_on_top_deck: moveOwnTo("deck"),
  blog_loc_move_to_bottom_deck: moveOwnTo("deck"),
  blog_loc_move_to_hand: moveTo("hand"),
  blog_loc_move_to_lostzone: moveTo("lost"),
  blog_loc_move_to_prizes: moveTo("prizes"),
  blog_loc_move_to_stadium: moveTo("stadium"),
  blog_loc_shuffled_card_into_deck: moveOwnTo("deck"),
  blog_loc_shuffled_card_into_hand: moveOwnTo("hand"),
  blog_loc_shuffled_card_into_prizes: moveOwnTo("prizes"),
  blog_loc_play_to_active: play("active"),
  blog_loc_play_to_bench: play("bench"),
  blog_loc_played_card: play(null),
  blog_loc_played_to_active: play("active"),
  blog_loc_played_to_bench: play("bench"),
  blog_loc_played_to_fallback: play(null),
  blog_loc_played_to_stadium: play("stadium"),
  blog_loc_player_moved_dc: moveCounters({
    cause: "cardName",
    counters: "numDamageCounters",
    from: "sourcePokemonCardName",
    fromPlayer: "sourcePlayerName",
    to: "targetPokemonCardName",
    toPlayer: "targetPlayerName",
  }),
  blog_loc_player_moved_single_dc: moveCounters({
    cause: "cardName",
    counters: 1,
    from: "sourcePokemonCardName",
    fromPlayer: "sourcePlayerName",
    to: "targetPokemonCardName",
    toPlayer: "targetPlayerName",
  }),
  blog_loc_player_placed_dc: counterDamage({
    cause: "cardName",
    counters: "numDamageCounters",
    target: "targetPokemonCardName",
    targetPlayer: "targetPlayerName",
  }),
  blog_loc_player_placed_single_dc: counterDamage({
    cause: "cardName",
    counters: 1,
    target: "targetPokemonCardName",
    targetPlayer: "targetPlayerName",
  }),
  blog_loc_promote_to_active: (input) => [
    { at: at(input), card: card(input, "playerName", "cardName"), kind: "moveCard", to: "active" },
  ],
  blog_loc_resistant_attack: damageFrom({
    actor: "attackingPlayerName",
    amount: "numDamage",
    attack: "attackName",
    attacker: "attackingPokemonCardName",
    defender: "defendingPlayerName",
    modifiers: [RESISTANCE],
    target: "targetPokemonCardName",
  }),
  blog_loc_retreated: (input) => [
    { at: at(input), card: card(input, "playerName", "cardName"), kind: "retreat" },
  ],
  blog_loc_secondary_damage: secondaryDamage({
    amount: "numDamage",
    defender: "defendingPlayerName",
    target: "targetPokemonCardName",
  }),
  blog_loc_secondary_resistance_attack: secondaryDamage({
    amount: "numDamage",
    defender: "defendingPlayerName",
    modifiers: [RESISTANCE],
    target: "targetPokemonCardName",
  }),
  blog_loc_secondary_weak_attack: secondaryDamage({
    amount: "numDamage",
    defender: "defendingPlayerName",
    modifiers: [WEAKNESS],
    target: "targetPokemonCardName",
  }),
  blog_loc_secondary_weak_and_resistant: secondaryDamage({
    amount: "numDamage",
    defender: "defendingPlayerName",
    modifiers: [WEAKNESS, RESISTANCE],
    target: "targetPokemonCardName",
  }),
  // The template reads `[targetCardName] was switched with [sourceCardName] to
  // become the Active Pokémon`, and the line after it names the first card as
  // the new Active. So `target` is the incoming body and `source` the outgoing
  // one — the opposite of the words' usual meaning, and the reason the mapping
  // is explicit rather than inferred from placeholder names.
  blog_loc_switched_active: (input) => [
    {
      at: at(input),
      incoming: card(input, "targetPlayerName", "targetCardName"),
      kind: "switchActive",
      outgoing: card(input, "sourcePlayerName", "sourceCardName"),
    },
  ],
  blog_loc_took_prize_cards: (input) => [
    { at: at(input), count: count(input, "numCards"), kind: "prizeTaken", side: player(input, "playerName") },
  ],
  blog_loc_took_single_prize_card: (input) => [
    { at: at(input), count: 1, kind: "prizeTaken", side: player(input, "playerName") },
  ],
  blog_loc_used_attack: (input) => [
    {
      at: at(input),
      attack: need(input, "attackName"),
      kind: "attack",
      source: card(input, "playerName", "attackingPokemonCardName"),
    },
  ],
  blog_loc_weak_and_resistant_attack: damageFrom({
    actor: "attackingPlayerName",
    amount: "numDamage",
    attack: "attackName",
    attacker: "attackingPokemonCardName",
    defender: "defendingPlayerName",
    modifiers: [WEAKNESS, RESISTANCE],
    target: "targetPokemonCardName",
  }),
  blog_loc_weak_attack: damageFrom({
    actor: "attackingPlayerName",
    amount: "numDamage",
    attack: "attackName",
    attacker: "attackingPokemonCardName",
    defender: "defendingPlayerName",
    modifiers: [WEAKNESS],
    target: "targetPokemonCardName",
  }),
};

/**
 * Every template key that deliberately lowers to nothing, grouped by why.
 *
 * `unmodelled` is the honest bucket: the line does carry game state, but not
 * state this slice models (Special Conditions, effect prevention). The corpus
 * audit reports how often each ignored key fires, so this list is a work queue
 * rather than a graveyard.
 */
export const IGNORED: Readonly<Record<IgnoreReason, readonly string[]>> = {
  breakdown: [
    "blog_loc_damage_detail_ability", "blog_loc_damage_detail_attack", "blog_loc_damage_detail_base",
    "blog_loc_damage_detail_conditional_condition", "blog_loc_damage_detail_conditional_condition_s", "blog_loc_damage_detail_conditional_evolved_this_turn",
    "blog_loc_damage_detail_conditional_healed", "blog_loc_damage_detail_conditional_is_basic", "blog_loc_damage_detail_conditional_is_evolution",
    "blog_loc_damage_detail_conditional_is_property", "blog_loc_damage_detail_conditional_is_type", "blog_loc_damage_detail_conditional_knockedout",
    "blog_loc_damage_detail_conditional_more_prize_cards", "blog_loc_damage_detail_conditional_played_supporter", "blog_loc_damage_detail_count_attached_energy",
    "blog_loc_damage_detail_count_attached_energy_s", "blog_loc_damage_detail_count_attached_tool", "blog_loc_damage_detail_count_attached_tool_s",
    "blog_loc_damage_detail_count_benched", "blog_loc_damage_detail_count_benched_s", "blog_loc_damage_detail_count_card",
    "blog_loc_damage_detail_count_card_in_discard", "blog_loc_damage_detail_count_card_in_discard_s", "blog_loc_damage_detail_count_card_s",
    "blog_loc_damage_detail_count_cards_in_deck", "blog_loc_damage_detail_count_cards_in_deck_s", "blog_loc_damage_detail_count_cards_in_hand",
    "blog_loc_damage_detail_count_cards_in_hand_s", "blog_loc_damage_detail_count_damage_counters", "blog_loc_damage_detail_count_damage_counters_s",
    "blog_loc_damage_detail_count_discarded_energy", "blog_loc_damage_detail_count_discarded_energy_s", "blog_loc_damage_detail_count_discarded_pokemon",
    "blog_loc_damage_detail_count_discarded_pokemon_s", "blog_loc_damage_detail_count_discarded_stadium", "blog_loc_damage_detail_count_discarded_stadium_s",
    "blog_loc_damage_detail_count_discarded_tool", "blog_loc_damage_detail_count_discarded_tool_s", "blog_loc_damage_detail_count_energy",
    "blog_loc_damage_detail_count_energy_s", "blog_loc_damage_detail_count_has_ability", "blog_loc_damage_detail_count_has_ability_s",
    "blog_loc_damage_detail_count_heads", "blog_loc_damage_detail_count_heads_s", "blog_loc_damage_detail_count_item",
    "blog_loc_damage_detail_count_item_s", "blog_loc_damage_detail_count_pokemon", "blog_loc_damage_detail_count_pokemon_s",
    "blog_loc_damage_detail_count_pokemon_types", "blog_loc_damage_detail_count_pokemon_types_s", "blog_loc_damage_detail_count_prize_cards",
    "blog_loc_damage_detail_count_prize_cards_s", "blog_loc_damage_detail_count_selected_card", "blog_loc_damage_detail_count_selected_card_s",
    "blog_loc_damage_detail_count_selected_energy", "blog_loc_damage_detail_count_selected_energy_s", "blog_loc_damage_detail_count_selected_item",
    "blog_loc_damage_detail_count_selected_item_s", "blog_loc_damage_detail_count_selected_pokemon", "blog_loc_damage_detail_count_selected_pokemon_s",
    "blog_loc_damage_detail_count_selected_stadium", "blog_loc_damage_detail_count_selected_stadium_s", "blog_loc_damage_detail_count_selected_supporter",
    "blog_loc_damage_detail_count_selected_supporter_s", "blog_loc_damage_detail_count_selected_tool", "blog_loc_damage_detail_count_selected_tool_s",
    "blog_loc_damage_detail_count_stadium", "blog_loc_damage_detail_count_stadium_s", "blog_loc_damage_detail_count_supporter",
    "blog_loc_damage_detail_count_supporter_s", "blog_loc_damage_detail_count_tails", "blog_loc_damage_detail_count_tails_s",
    "blog_loc_damage_detail_count_tool", "blog_loc_damage_detail_count_tool_s", "blog_loc_damage_detail_energy",
    "blog_loc_damage_detail_fallback", "blog_loc_damage_detail_item", "blog_loc_damage_detail_resistance",
    "blog_loc_damage_detail_stadium", "blog_loc_damage_detail_supporter", "blog_loc_damage_detail_tool",
    "blog_loc_damage_detail_total", "blog_loc_damage_detail_weakness",
  ],
  fragment: [
    "blog_loc_a_card", "blog_loc_an_ability", "blog_loc_an_action",
    "blog_loc_an_attack", "blog_loc_another_card", "blog_loc_damage_blocked",
    "blog_loc_hidden_card", "blog_loc_move_blocked", "blog_loc_number_of_cards",
    "blog_loc_unspecified_pokemon",
  ],
  flavour: [
    "battle_draw", "blog_loc_card_activated", "blog_loc_coin_flip_multi",
    "blog_loc_coin_flip_single", "blog_loc_generic_reveal", "blog_loc_going_first",
    "blog_loc_going_second", "blog_loc_gx_moves", "blog_loc_heads",
    "blog_loc_mulligan_draw_multi", "blog_loc_mulligan_draw_single", "blog_loc_mulligan_revealed",
    "blog_loc_oncepergame_used", "blog_loc_paper", "blog_loc_performed_action",
    "blog_loc_reconnect", "blog_loc_reveal_multi", "blog_loc_rock",
    "blog_loc_rps_choice", "blog_loc_rps_won", "blog_loc_scissors",
    "blog_loc_selected_coinface", "blog_loc_selected_option", "blog_loc_shuffled_deck",
    "blog_loc_shuffled_fallback", "blog_loc_shuffled_hand", "blog_loc_shuffled_prizes",
    "blog_loc_sudden_death", "blog_loc_tails", "blog_loc_tera_effect",
    "blog_loc_timeout", "blog_loc_took_mulligan_multi", "blog_loc_took_mulligan_single",
    "blog_loc_took_mulligans", "blog_loc_vstar_abilities", "blog_loc_won_coin_toss",
  ],
  header: [
    "blog_loc_battle_log", "blog_loc_drawn_cards_grid_header", "blog_loc_export_damage_breakdown_label",
    "blog_loc_phase_checkup", "blog_loc_phase_setup", "blog_loc_phase_turn",
  ],
  restatement: [],
  settings: [
    "blog_loc_export_copied", "blog_loc_settings_category_label", "blog_loc_settings_disable_vfx",
    "blog_loc_settings_entry_sort_order", "blog_loc_settings_hide_card_ids",
  ],
  unmodelled: [
    "blog_loc_condition_asleep", "blog_loc_condition_burned", "blog_loc_condition_confused",
    "blog_loc_condition_paralyzed", "blog_loc_condition_poisoned", "blog_loc_effect_prevention_allactioneffects",
    "blog_loc_effect_prevention_allcardeffects", "blog_loc_effect_prevention_allsubactions", "blog_loc_effect_prevention_blockmovement",
    "blog_loc_effect_prevention_blockplayerselections", "blog_loc_effect_prevention_blockstatuseffects", "blog_loc_effect_prevention_burnrecovery",
    "blog_loc_effect_prevention_damage", "blog_loc_effect_prevention_damagecounters", "blog_loc_effect_prevention_fallback",
    "blog_loc_effect_prevention_heal", "blog_loc_effect_prevention_onlyeffects", "blog_loc_move_to_fallback",
    "blog_loc_remove_all_effects", "blog_loc_remove_condition", "blog_loc_special_condition",
    "blog_loc_switched_fallback",
  ],
};

const IGNORE_BY_KEY: Readonly<Map<string, IgnoreReason>> = new Map(
  Object.entries(IGNORED).flatMap(([reason, keys]) =>
    keys.map((key) => [key, reason as IgnoreReason] as const)),
);

/**
 * How one event lowers: by its key, or — when the parser could not determine
 * the key — by every candidate, only if they all agree. Candidates that lower
 * differently are a diagnostic, never a pick.
 */
type Classification =
  | { readonly kind: "mapped"; readonly handler: Handler }
  | { readonly kind: "ignored"; readonly reason: IgnoreReason }
  | { readonly kind: "unhandled" }
  | { readonly kind: "ambiguous" };

const classifyKey = (key: string): Classification => {
  const handler = MAPPED[key];
  if (handler !== undefined) return { handler, kind: "mapped" };
  const reason = IGNORE_BY_KEY.get(key);
  return reason === undefined ? { kind: "unhandled" } : { kind: "ignored", reason };
};

const classify = (event: TemplateEvent): Classification => {
  if (event.templateKey !== null) return classifyKey(event.templateKey);
  const each = event.candidateKeys.map(classifyKey);
  if (each.some((c) => c.kind === "unhandled")) return { kind: "unhandled" };
  const handlers = new Set(each.flatMap((c) => (c.kind === "mapped" ? [c.handler] : [])));
  const [handler] = handlers;
  if (handler !== undefined) {
    return handlers.size === 1 && each.every((c) => c.kind === "mapped")
      ? { handler, kind: "mapped" }
      : { kind: "ambiguous" };
  }
  const reasons = new Set(each.flatMap((c) => (c.kind === "ignored" ? [c.reason] : [])));
  const [reason] = reasons;
  // Mixed reasons all lower to nothing; `unmodelled` is the one that admits
  // the line may carry state this slice does not model.
  return { kind: "ignored", reason: reasons.size === 1 && reason !== undefined ? reason : "unmodelled" };
};

/** The key a lowered entry is recorded under: the key, or every candidate. */
export const keyLabel = (event: TemplateEvent): string =>
  event.templateKey ?? event.candidateKeys.join(" | ");

const BREAKDOWN_LINE = /^(?<label>.*?):\s*(?<amount>-?\d+)\s+damage$/u;

/** Parse a printed breakdown, and attach it to the damage event it explains. */
const applyBreakdown = (
  events: readonly GameEvent[],
  subString: string,
): readonly GameEvent[] => {
  const lines: BreakdownLine[] = [];
  for (const line of subString.split(/\r?\n/u)) {
    const match = BREAKDOWN_LINE.exec(line.trim());
    if (match?.groups === undefined) {
      continue;
    }
    lines.push({ amount: Number(match.groups["amount"]), label: match.groups["label"] ?? "" });
  }
  if (lines.length === 0) {
    return events;
  }

  const index = events.findIndex((event) => event.kind === "damage");
  const target = events[index];
  if (target === undefined || target.kind !== "damage") {
    return events;
  }

  // The breakdown is carried as printed and never reconciled.
  //
  // Two attempts at checking it failed against real data. Requiring the
  // components to sum to the total flagged honest partials (beedrill prints one
  // `150` weakness clause beside a `300` total). Requiring only that they not
  // exceed the total flagged duplicated component lines — `Base 60, Damage 170,
  // Damage 170, Total 230` repeats a component — and events that legitimately
  // carry `0`. What remains is prose with a shape we cannot test
  // locale-independently, so it is data, not a claim.
  const merged: GameEvent = { ...target, breakdown: lines };
  return events.map((event, position) => (position === index ? merged : event));
};

/** The `• ` text attached to an entry, or null. */
const subStringOf = (entry: MainEntry | SubEntry): string | null => {
  const parts = "subEntries" in entry
    ? entry.subEntries.map((sub) => sub.subString).filter((text): text is string => text !== null)
    : entry.subString === null
      ? []
      : [entry.subString];
  return parts.length === 0 ? null : parts.join("\n");
};

/** The breakdown text on a damage entry, if the log printed one. */
const breakdownOf = (entry: MainEntry): string | null => {
  for (const sub of entry.subEntries) {
    if (sub.event.templateKey === BREAKDOWN_LABEL && sub.subString !== null) {
      return sub.subString;
    }
  }
  return null;
};

/** A content line's canonical form: trailing space stripped, sub-entry marker removed. */
const contentOf = (line: string): string => {
  const trimmed = line.replace(/\s+$/u, "");
  const subEntry = /^\s*-\s+(?<rest>.*)$/u.exec(trimmed);
  return subEntry?.groups?.["rest"] ?? trimmed;
};

/** A content line's location in the source text. */
const createLineIndex = (rawText: string): ((raw: string) => number) => {
  const queues = new Map<string, number[]>();
  rawText.split(/\r?\n/u).forEach((line, index) => {
    const content = contentOf(line);
    const queue = queues.get(content);
    if (queue === undefined) {
      queues.set(content, [index + 1]);
    } else {
      queue.push(index + 1);
    }
  });
  return (raw) => {
    const queue = queues.get(raw);
    if (queue === undefined) {
      return 0;
    }
    return queue.shift() ?? 0;
  };
};

const signatureOf = (event: GameEvent): string | null => {
  if (event.kind !== "damage" || event.source === null || event.attack === null) {
    return null;
  }
  return [
    event.source.side,
    event.source.name,
    event.attack,
    event.target.side,
    event.target.name,
    event.amount,
  ].join("\u0000");
};

/** Options for lowering. */
export interface LowerOptions {
  /** The local player's name, used to seed the side map when turn headers are absent. */
  readonly playerName?: string;
}

/**
 * Lower a parsed battle log into events.
 *
 * Fails only when no side can be resolved at all: without a side map every card
 * reference is meaningless, and guessing one would be worse than refusing.
 */
export const lower = (
  battleLog: BattleLog,
  rawText: string,
  options: LowerOptions = {},
): Result<LoweredLog, UnresolvedPlayersError> => {
  const sides = new Map<string, Side>();
  for (const phase of battleLog.phases) {
    if (phase.kind === "Turn") {
      sides.set(phase.playerName, phase.side);
    }
  }
  if (options.playerName !== undefined) {
    sides.set(options.playerName, "self");
  }
  if (sides.size === 0) {
    return err(new UnresolvedPlayersError());
  }

  const sideOfPlayer = (playerName: string): Side => {
    const side = sides.get(playerName);
    if (side !== undefined) {
      return side;
    }
    // A game has exactly two players, and every name in the log is one of them.
    // So once one side is known, an unseen name is the other side — deduction,
    // not a guess. This is what keeps a log truncated after one turn lowerable.
    if (sides.size === 1) {
      const [knownName, knownSide] = [...sides.entries()][0] ?? [];
      if (knownName !== undefined && knownSide !== undefined) {
        const inferred: Side = knownSide === "self" ? "opponent" : "self";
        sides.set(playerName, inferred);
        return inferred;
      }
    }
    throw new UnknownSide(playerName);
  };

  const lineOf = createLineIndex(rawText);
  const events: GameEvent[] = [];
  const ignored: IgnoredEntry[] = [];
  const unhandled: UnhandledEntry[] = [];
  const diagnostics: LoweringDiagnostic[] = [];

  const run = (entry: MainEntry | SubEntry, location: EventLocation): readonly GameEvent[] => {
    const key = keyLabel(entry.event);
    const classification = classify(entry.event);
    switch (classification.kind) {
      case "unhandled":
        unhandled.push({ at: location, key, raw: entry.event.raw });
        return [];
      case "ignored":
        ignored.push({ at: location, key, reason: classification.reason });
        return [];
      case "ambiguous":
        diagnostics.push({
          at: location,
          code: "AmbiguousTemplate",
          message: `the line could be any of ${key}, and they lower differently`,
          raw: entry.event.raw,
        });
        return [];
      case "mapped":
        break;
    }
    const handler = classification.handler;

    const input: LoweringInput = {
      at: location,
      groups: entry.event.groups,
      key,
      raw: entry.event.raw,
      sideOfPlayer,
      subString: subStringOf(entry),
    };
    try {
      return handler(input);
    } catch (error) {
      if (error instanceof MissingPlaceholder) {
        diagnostics.push({
          at: location,
          code: "MissingPlaceholder",
          message: `placeholder ${error.group} is absent from the log line`,
          raw: entry.event.raw,
        });
        return [];
      }
      if (error instanceof BadNumber) {
        diagnostics.push({
          at: location,
          code: "BadNumber",
          message: `placeholder ${error.group} is not a number: ${error.value}`,
          raw: entry.event.raw,
        });
        return [];
      }
      if (error instanceof UnknownSide) {
        diagnostics.push({
          at: location,
          code: "UnresolvedSide",
          message: `no side resolved for player ${error.playerName}`,
          raw: entry.event.raw,
        });
        return [];
      }
      throw error;
    }
  };

  battleLog.phases.forEach((phase, phaseIndex) => {
    const turn = phase.kind === "Turn" ? phase.displayTurnNumber : null;
    const seenDamage = new Set<string>();

    for (const main of phase.mainEntries) {
      const location: EventLocation = { line: lineOf(main.event.raw), phaseIndex, turn };
      let produced = run(main, location);

      const breakdown = breakdownOf(main);
      if (breakdown !== null) {
        produced = applyBreakdown(produced, breakdown);
      }

      for (const event of produced) {
        const signature = signatureOf(event);
        if (signature !== null) {
          seenDamage.add(signature);
        }
      }
      events.push(...produced);

      for (const sub of main.subEntries) {
        const subLocation: EventLocation = { line: lineOf(sub.event.raw), phaseIndex, turn };
        if (sub.event.templateKey === BREAKDOWN_LABEL) {
          // Consumed by the damage event it describes, not lowered on its own —
          // but still recorded, so the audit's key totals reconcile.
          ignored.push({ at: subLocation, key: sub.event.templateKey, reason: "breakdown" });
          continue;
        }
        const subEvents = run(sub, subLocation);
        for (const event of subEvents) {
          // D21: a sub-entry that repeats its phase's attack is the confirmation
          // of it, not a second hit. Secondary damage has no attacker and is
          // never collapsed — two identical Weedles really do both take damage.
          const signature = signatureOf(event);
          if (signature !== null && seenDamage.has(signature)) {
            ignored.push({ at: subLocation, key: keyLabel(sub.event), reason: "restatement" });
            continue;
          }
          events.push(event);
        }
      }
    }
  });

  return ok({ diagnostics, events, ignored, unhandled });
};
