import type { CounterSpread, HpReduction, KnockoutReach } from "./oracle.js";

const WHO = String.raw`(of your opponent's |of your )?(Benched )?Pokémon`;
const EACH = new RegExp(
  String.raw`^(?:During Pokémon Checkup, )?put (\d+|a) damage counters? on each ${WHO}( that has an Ability)?( \(both yours and your opponent's\))?(?:, except any ([^,.]+))?\.$`,
  "i",
);
const CHOICE = new RegExp(
  String.raw`^put (\d+) damage counters on (your opponent's |your )(Benched )?Pokémon in any way you like\.$`,
  "i",
);

const sidesOf = (owner: string | undefined, both: boolean): CounterSpread["sides"] | null => {
  if (both) {
    return owner === undefined ? "both" : null;
  }
  if (owner?.includes("opponent") === true) {
    return "opponent";
  }
  return owner === undefined ? null : "self";
};

/**
 * Read a counter spread from English effect text. Only an unconditional
 * spread in a single counter sentence is recognised; anything else is `null`.
 */
export const counterSpreadFromText = (effect: string): CounterSpread | null => {
  const sentences = effect.replace(/[’‘]/g, "'").split(/(?<=\.)\s+/).map((sentence) => sentence.trim());
  const counterSentences = sentences.filter((sentence) => /damage counter/i.test(sentence));
  const [sentence] = counterSentences;
  if (counterSentences.length !== 1 || sentence === undefined) {
    return null;
  }
  const each = EACH.exec(sentence);
  if (each !== null) {
    const [, count, owner, bench, ability, both, except] = each;
    const sides = sidesOf(owner?.replace(/^of /, ""), both !== undefined);
    if (sides === null) {
      return null;
    }
    return {
      benchOnly: bench !== undefined,
      counters: count === "a" || count === undefined ? 1 : Number(count),
      except: except?.trim() ?? null,
      placement: "each",
      requiresAbility: ability !== undefined,
      sides,
    };
  }
  const choice = CHOICE.exec(sentence);
  if (choice !== null) {
    const [, count, owner, bench] = choice;
    const sides = sidesOf(owner, false);
    return sides === null
      ? null
      : { benchOnly: bench !== undefined, counters: Number(count), except: null, placement: "choice", requiresAbility: false, sides };
  }
  return null;
};

const LEAVES = /\b(?:put|shuffle) this Pokémon and all attached cards into your (hand|deck)\b/i;

/** Where English effect text sends the acting Pokémon with everything attached, if anywhere. */
export const leavesPlayFromText = (effect: string): "hand" | "deck" | null => {
  const match = LEAVES.exec(effect.replace(/[’‘]/g, "'"));
  return match?.[1] === undefined ? null : match[1].toLowerCase() === "hand" ? "hand" : "deck";
};

const BENCH_LIMIT = /\bcan have up to (\d+) Pokémon on (?:their|your) Bench\b/i;

/**
 * The Bench size English Stadium text allows, if it raises one. Conditions such
 * as Area Zero Underdepths' Tera requirement are dropped, so it is a ceiling.
 */
export const benchLimitFromText = (effect: string): number | null => {
  const match = BENCH_LIMIT.exec(effect);
  return match?.[1] === undefined ? null : Number(match[1]);
};

const HP_REDUCTION = /\bEach (Basic|Stage 1|Stage 2) Pokémon in play \(both yours and your opponent's\) gets -(\d+) HP\./i;

/** The HP English Stadium text takes from every Pokémon of one stage, if any. */
export const hpReductionFromText = (effect: string): HpReduction | null => {
  const match = HP_REDUCTION.exec(effect.replace(/[’‘]/g, "'"));
  if (match?.[1] === undefined || match[2] === undefined) {
    return null;
  }
  const stage = match[1].replace(/\s/g, "");
  return { amount: Number(match[2]), stage: stage === "Stage1" || stage === "Stage2" ? stage : "Basic" };
};

const KNOCKED_OUT = /\b(?:is|are) Knocked Out\.$/i;

const REPLACES = /\bswitch it with 1 of your (?:[\w-]+ )?Pokémon in play\b[^]*\bremain on the new Pokémon\b/i;

/** Whether English Trainer text puts a Pokémon into play in place of one in play. */
export const replacesInPlayFromText = (effect: string): boolean => REPLACES.test(effect);
const OPPONENT_ACTIVE = /\b(?:your opponent's Active Pokémon|the Defending Pokémon)\b/i;

/**
 * Whom English effect text Knocks Out outright. Conditions (coin flips, exact
 * counter totals) are dropped, so it is a ceiling. "The Attacking Pokémon" is
 * `attacker`: it answers a knockout rather than acting on its own.
 */
export const knocksOutFromText = (effect: string): KnockoutReach => {
  let self = false;
  let opponent = false;
  let attacker = false;
  for (const sentence of effect.replace(/[’‘]/g, "'").split(/(?<=\.)\s+/)) {
    const trimmed = sentence.trim();
    if (!KNOCKED_OUT.test(trimmed)) {
      continue;
    }
    if (/\bboth Active Pokémon are Knocked Out\.$/i.test(trimmed)) {
      self = true;
      opponent = true;
    } else if (/\bthis Pokémon is Knocked Out\.$/i.test(trimmed)) {
      self = true;
    } else if (/\bthe Attacking Pokémon is Knocked Out\.$/i.test(trimmed)) {
      attacker = true;
    } else if (OPPONENT_ACTIVE.test(trimmed)) {
      opponent = true;
    }
  }
  return self && opponent ? "both" : self ? "self" : opponent ? "opponent" : attacker ? "attacker" : null;
};
