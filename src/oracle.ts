/**
 * The optional card-data port.
 *
 * The core never ships a card database and never imports one. An oracle is
 * supplied by the caller and is used only to prune possibilities: HP identifies
 * which body could have been knocked out, and later printings/attacks/prizes
 * narrow the rest. A field that is `null` is unknown, which is weaker than a
 * fact and never becomes a guess.
 *
 * The oracle is keyed by the **card name the log printed**, not by set and
 * number, because the log names cards and never printings. `printings` returns
 * every printing of that name, so a name with several HP values stays a set.
 */

/**
 * Damage counters one effect puts on several Pokémon, as its text states.
 *
 * Sides are relative to the acting card's owner. `each` puts `counters` on
 * every qualifying body; `choice` splits `counters` among bodies the player
 * picks. Either way the client prints one line per body.
 */
export interface CounterSpread {
  readonly sides: "opponent" | "self" | "both";
  /** Only Benched Pokémon qualify. */
  readonly benchOnly: boolean;
  /** Only Pokémon that have an Ability qualify. */
  readonly requiresAbility: boolean;
  /** A name the text excludes ("except any Froslass"). */
  readonly except: string | null;
  readonly placement: "each" | "choice";
  readonly counters: number;
}

/** One attack, as far as targetability is known. */
export interface CardAttack {
  readonly name: string;
  /** `true`/`false` only when the card data states it; `null` is unknown. */
  readonly canHitBench: boolean | null;
  /** `null` when the attack spreads no counters or the text is not recognised. */
  readonly spread: CounterSpread | null;
  /** Where the effect puts the acting Pokémon and its attached cards, if it leaves play. */
  readonly leavesPlay: "hand" | "deck" | null;
}

/** One Ability. Older powers (Poké-Power, Poké-Body) are not Abilities. */
export interface CardAbility {
  readonly name: string;
  readonly spread: CounterSpread | null;
  readonly leavesPlay: "hand" | "deck" | null;
}

/** One printing of a card. */
export interface CardPrinting {
  readonly hp: number | null;
  /** Prizes the opponent takes when this body is knocked out. */
  readonly prizeValue: 1 | 2 | 3 | null;
  /** The name this card evolves from, or `null` for a Basic. */
  readonly evolvesFrom: string | null;
  readonly attacks: readonly CardAttack[];
  /** `null` when the card data does not say. */
  readonly abilities: readonly CardAbility[] | null;
}

/** What a Stadium changes while it is in play. */
export interface StadiumFacts {
  /** The largest Bench the Stadium can allow, or `null` when it does not raise it. */
  readonly benchLimit: number | null;
}

/** A card-data lookup, supplied by the caller. */
export interface CardOracle {
  /**
   * Every printing of a card name, or `null` when the name is not a Pokémon or
   * the oracle has no record of it.
   */
  readonly printings: (name: string) => readonly CardPrinting[] | null;
  /** Facts for a Stadium name, or `null` when it is not a Stadium or unknown. */
  readonly stadium?: (name: string) => StadiumFacts | null;
}
