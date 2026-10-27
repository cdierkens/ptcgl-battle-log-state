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

/** One attack, as far as targetability is known. */
export interface CardAttack {
  readonly name: string;
  /** `true`/`false` only when the card data states it; `null` is unknown. */
  readonly canHitBench: boolean | null;
}

/** One printing of a card. */
export interface CardPrinting {
  readonly hp: number | null;
  /** Prizes the opponent takes when this body is knocked out. */
  readonly prizeValue: 1 | 2 | 3 | null;
  /** The name this card evolves from, or `null` for a Basic. */
  readonly evolvesFrom: string | null;
  readonly attacks: readonly CardAttack[];
}

/** A card-data lookup, supplied by the caller. */
export interface CardOracle {
  /**
   * Every printing of a card name, or `null` when the name is not a Pokémon or
   * the oracle has no record of it.
   */
  readonly printings: (name: string) => readonly CardPrinting[] | null;
}
