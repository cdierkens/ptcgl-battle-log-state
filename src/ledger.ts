/**
 * The board ledger: a forward pass over the lowered event stream.
 *
 * The log names cards, never instances, so the ledger keeps an **identity
 * group** per `(side, card name)` and stores the possible **value multisets**
 * of its members. A value is `{ zone, damage, attachments, under, hp }`. Two
 * variants that are permutations of one multiset are one picture (D31), so the
 * ledger never enumerates permutations — a group of six costs combinations of
 * values, not a factorial.
 *
 * Where a value *leaves* a group (evolve, retreat, knockout, discard) the
 * remaining multiset depends on which body left. The ledger keeps every
 * remainder and drops the correlation with the body that left. That can only
 * over-report divergence, which is the direction an upper-bound census needs.
 *
 * Nothing here decides what is *possible*. It records what the log stated and
 * what the log has proved; a transition with no surviving variant is a
 * diagnostic, never a silent clamp (D8).
 */

import type { CardRef, CardZone, EventLocation, GameEvent } from "./events.js";
import type { HiddenZone, PrizeZone, Side, Zone } from "./types.js";

/** A monotone interval on one body's HP. `max: null` means no upper bound yet. */
export interface HpInterval {
  readonly min: number;
  readonly max: number | null;
}

/** One body's observable state, as far as the log has spoken about it. */
export interface MaterialValue {
  readonly zone: Zone;
  readonly damage: number;
  /** Energy and Tools attached to this body. */
  readonly attachments: readonly string[];
  /** Cards underneath it in the evolution stack, oldest first. */
  readonly under: readonly string[];
  readonly hp: HpInterval;
}

/** Options for {@link runLedger}. */
export interface LedgerOptions {
  /**
   * An informed HP lookup, keyed by card name. Bare mode leaves this unset and
   * learns per-body bounds from knockouts and survivals. The seam exists so the
   * informed corpus run is a data adapter, not a ledger change (D33).
   */
  readonly hp?: (name: string) => number | null;
  /** The largest variant set a group may hold before it is frozen. */
  readonly maxVariants?: number;
}

/** Something the ledger could not execute, or chose not to model. */
export interface LedgerDiagnostic {
  readonly at: EventLocation;
  readonly code:
    | "AttachmentMismatch"
    | "BenchOverflow"
    | "HealOverflow"
    | "KnockoutUnproven"
    | "NoVariant"
    | "PrizeOverflow"
    | "Saturated"
    | "SideAmbiguous"
    | "SideMismatch"
    | "UnknownGroup";
  readonly severity: "warning" | "error";
  readonly message: string;
  /** The group id the finding belongs to, or `null` when no group matched. */
  readonly group: string | null;
}

/** A group's public snapshot. Nothing here exposes a particular labelling. */
export interface LedgerGroupSnapshot {
  readonly id: string;
  readonly side: Side;
  readonly name: string;
  readonly live: boolean;
  readonly members: number;
  /** The most bodies the group ever held, including ones that later left. */
  readonly maxMembers: number;
  /** Distinct internal value multisets, including ones that differ only in HP. */
  readonly internalVariants: number;
  /** Distinct pictures: value multisets. This is the census's figure. */
  readonly renderVariants: number;
  readonly everDivergent: boolean;
  readonly firstForkAt: EventLocation | null;
  readonly resolvedAt: EventLocation | null;
  readonly leftAt: EventLocation | null;
  readonly forkCount: number;
  readonly saturated: boolean;
  /** The distinct HP intervals among the group's live bodies. */
  readonly hp: readonly HpInterval[];
  /** The distinct Active/Bench splits among the group's variants. */
  readonly zoneCounts: readonly { readonly active: number; readonly bench: number }[];
}

/** The result of one ledger pass. */
export interface LedgerRun {
  readonly groups: readonly LedgerGroupSnapshot[];
  readonly liveGroups: readonly LedgerGroupSnapshot[];
  readonly board: {
    /** The group id in the Active Spot per side, or `null` between a knockout and a promotion. */
    readonly active: Readonly<Record<Side, string | null>>;
    readonly hand: Readonly<Record<Side, HiddenZone>>;
    readonly prizes: Readonly<Record<Side, PrizeZone>>;
  };
  readonly diagnostics: readonly LedgerDiagnostic[];
  readonly maxInternalVariants: number;
  readonly maxRenderVariants: number;
  readonly saturated: boolean;
  readonly unexecutable: boolean;
}

interface MutableGroup {
  readonly key: string;
  readonly id: string;
  readonly side: Side;
  readonly name: string;
  variants: Map<string, readonly MaterialValue[]>;
  members: number;
  maxMembers: number;
  live: boolean;
  firstForkAt: EventLocation | null;
  resolvedAt: EventLocation | null;
  everDivergent: boolean;
  forkCount: number;
  lastRenderCount: number;
  saturated: boolean;
  leftAt: EventLocation | null;
  readonly cap: number;
}

interface KnockoutOption {
  readonly remaining: readonly MaterialValue[];
  readonly removed: MaterialValue;
}

interface PendingKnockout {
  readonly group: MutableGroup;
  readonly at: EventLocation;
  options: readonly KnockoutOption[];
}

interface MutableHiddenZone {
  count: number;
  known: string[];
}

interface MutablePrizeZone {
  remaining: number;
  known: string[];
}

interface LedgerState {
  readonly groups: Map<string, MutableGroup>;
  readonly history: MutableGroup[];
  readonly diagnostics: LedgerDiagnostic[];
  readonly active: Record<Side, string | null>;
  readonly hand: Record<Side, MutableHiddenZone>;
  readonly prizes: Record<Side, MutablePrizeZone>;
  readonly pending: Map<string, PendingKnockout>;
  nextGroupId: number;
  maxInternalVariants: number;
  maxRenderVariants: number;
}

const keyOf = (side: Side, name: string): string => `${side}\u0000${name}`;

const valueKey = (value: MaterialValue): string =>
  [
    value.zone,
    String(value.damage),
    [...value.attachments].sort().join("\u0001"),
    [...value.under].join("\u0001"),
    String(value.hp.min),
    value.hp.max === null ? "inf" : String(value.hp.max),
  ].join("\u0000");

const renderKey = (value: MaterialValue): string =>
  [
    value.zone,
    String(value.damage),
    [...value.attachments].sort().join("\u0001"),
    [...value.under].join("\u0001"),
  ].join("\u0000");

const sortValues = (values: readonly MaterialValue[]): readonly MaterialValue[] =>
  [...values].sort((left, right) => valueKey(left).localeCompare(valueKey(right)));

const multisetKey = (values: readonly MaterialValue[], key: (value: MaterialValue) => string): string =>
  sortValues(values).map(key).join("\u0002");

const makeValue = (
  zone: Zone,
  hp: HpInterval,
  damage = 0,
  attachments: readonly string[] = [],
  under: readonly string[] = [],
): MaterialValue => ({ attachments, damage, hp, under, zone });

/** Everything a discard line can name: attachments and the evolution stack. */
const pileOf = (value: MaterialValue): readonly string[] => [
  ...value.attachments,
  ...value.under,
];

/** Remove one occurrence of each card from a body's pile, attachments first. */
const removeFromPile = (
  value: MaterialValue,
  cards: readonly string[],
): MaterialValue => {
  const attachments = [...value.attachments];
  const under = [...value.under];
  for (const card of cards) {
    const attached = attachments.indexOf(card);
    if (attached >= 0) {
      attachments.splice(attached, 1);
      continue;
    }
    const buried = under.indexOf(card);
    if (buried >= 0) {
      under.splice(buried, 1);
    }
  }
  return { ...value, attachments, under };
};

/** Two card piles name the same multiset. */
const sameMultiset = (left: readonly string[], right: readonly string[]): boolean => {
  if (left.length !== right.length) {
    return false;
  }
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((card, index) => card === sortedRight[index]);
};

/** Multiset containment: every card in `wanted` occurs at least as often in `have`. */
const containsAll = (have: readonly string[], wanted: readonly string[]): boolean => {  if (wanted.length === 0) {
    return true;
  }
  const counts = new Map<string, number>();
  for (const card of have) {
    counts.set(card, (counts.get(card) ?? 0) + 1);
  }
  for (const card of wanted) {
    const remaining = (counts.get(card) ?? 0) - 1;
    if (remaining < 0) {
      return false;
    }
    counts.set(card, remaining);
  }
  return true;
};

/** Every distinct subset of `cards` of size `count`, by value rather than index. */
const subsets = (cards: readonly string[], count: number): readonly (readonly string[])[] => {
  if (count === 0) {
    return [[]];
  }
  if (count > cards.length || count < 0) {
    return [];
  }
  const out = new Map<string, readonly string[]>();
  const walk = (start: number, picked: string[]): void => {
    if (picked.length === count) {
      const sorted = [...picked].sort();
      out.set(sorted.join("\u0001"), sorted);
      return;
    }
    for (let index = start; index < cards.length; index += 1) {
      const card = cards[index];
      if (card === undefined) {
        continue;
      }
      picked.push(card);
      walk(index + 1, picked);
      picked.pop();
    }
  };
  walk(0, []);
  return [...out.values()];
};

const knockoutFollows = (
  events: readonly GameEvent[],
  index: number,
  side: Side,
  name: string,
): boolean => {
  const source = events[index];
  if (source === undefined) {
    return false;
  }
  // A knockout is printed within a handful of lines of the hit that caused it
  // (damage, maybe modifiers or sub-entries, then the knockout). Eight events is
  // wide enough to cross those lines and narrow enough to stop at the next turn.
  for (let offset = 1; offset <= 8; offset += 1) {
    const event = events[index + offset];
    if (event === undefined || event.at.phaseIndex !== source.at.phaseIndex) {
      return false;
    }
    if (event.kind === "knockout" && event.target.side === side && event.target.name === name) {
      return true;
    }
    if (
      (event.kind === "damage" || event.kind === "counterDamage")
      && event.target.side === side
      && event.target.name === name
    ) {
      return false;
    }
    if (event.kind === "heal" && event.target.side === side && event.target.name === name) {
      return false;
    }
    if (event.kind === "moveCounters" && event.to.side === side && event.to.name === name) {
      return false;
    }
    if (event.kind === "endTurn" || event.kind === "endGame") {
      return false;
    }
  }
  return false;
};

/** Names the log ever treats as an in-play Pokémon, used to classify bare plays. */
const collectBoardNames = (events: readonly GameEvent[]): ReadonlySet<string> => {
  const names = new Set<string>();
  const add = (ref: CardRef): void => {
    names.add(keyOf(ref.side, ref.name));
  };
  for (const event of events) {
    switch (event.kind) {
      case "attack":
        add(event.source);
        break;
      case "attach":
        add(event.target);
        break;
      case "counterDamage":
        add(event.target);
        break;
      case "damage":
        if (event.source !== null) {
          add(event.source);
        }
        add(event.target);
        break;
      case "detach":
        add(event.body);
        break;
      case "devolve":
      case "evolve":
        add(event.from);
        names.add(keyOf(event.from.side, event.into));
        break;
      case "heal":
        add(event.target);
        break;
      case "knockout":
        add(event.target);
        break;
      case "moveCard":
        if (event.to === "active" || event.to === "bench") {
          add(event.card);
        }
        break;
      case "moveCounters":
        add(event.from);
        add(event.to);
        break;
      case "play":
        if (event.zone === "active" || event.zone === "bench") {
          add(event.card);
        }
        break;
      case "retreat":
        add(event.card);
        break;
      case "switchActive":
        add(event.outgoing);
        add(event.incoming);
        break;
      default:
        break;
    }
  }
  return names;
};

/**
 * Run the ledger over one lowered log.
 *
 * The pass is forward-only. It never backtracks: a later line can narrow a
 * group's variants, but a variant once dropped is not reconsidered. That is
 * what keeps the census an upper bound rather than a solver.
 */
export const runLedger = (events: readonly GameEvent[], options: LedgerOptions = {}): LedgerRun => {
  const cap = options.maxVariants ?? 4096;
  const hpOf = options.hp;
  const boardNames = collectBoardNames(events);
  const state: LedgerState = {
    active: { opponent: null, self: null },
    diagnostics: [],
    groups: new Map(),
    hand: {
      opponent: { count: 0, known: [] },
      self: { count: 0, known: [] },
    },
    history: [],
    maxInternalVariants: 0,
    maxRenderVariants: 0,
    nextGroupId: 0,
    pending: new Map(),
    prizes: {
      opponent: { known: [], remaining: 6 },
      self: { known: [], remaining: 6 },
    },
  };

  const initialHp = (name: string): HpInterval => {
    const known = hpOf?.(name) ?? null;
    return known === null ? { max: null, min: 0 } : { max: known, min: known };
  };

  const diagnose = (
    code: LedgerDiagnostic["code"],
    severity: LedgerDiagnostic["severity"],
    message: string,
    at: EventLocation,
    group: MutableGroup | null,
  ): void => {
    state.diagnostics.push({
      at,
      code,
      group: group === null ? null : group.id,
      message,
      severity,
    });
  };

  const otherSide = (side: Side): Side => (side === "self" ? "opponent" : "self");

  /**
   * Find the group a target names, resolving a side the log got wrong.
   *
   * The corpus contains client exports that name the acting player for a placed
   * counter (`TSLAUJ put 2 damage counters on TSLAUJ's Slowpoke` while the card
   * is cdierkens's). The game has two sides and the card is only on the other
   * one, so the target side is forced by elimination — the same deduction that
   * lets a log with one turn header resolve the second player. The event is
   * reported, not silently rewritten: a caller can see every correction.
   */
  const resolveGroup = (
    target: CardRef,
    what: string,
    at: EventLocation,
  ): MutableGroup | null => {
    const direct = state.groups.get(keyOf(target.side, target.name));
    const opposite = state.groups.get(keyOf(otherSide(target.side), target.name));
    if (direct !== undefined && opposite !== undefined) {
      diagnose(
        "SideAmbiguous",
        "warning",
        `${what} names ${target.name}, which is on both sides; using the side the log named`,
        at,
        direct,
      );
      return direct;
    }
    if (direct !== undefined) {
      return direct;
    }
    if (opposite !== undefined) {
      diagnose(
        "SideMismatch",
        "warning",
        `${what} names ${target.side}'s ${target.name}, but the ledger has it on ${otherSide(target.side)}`,
        at,
        opposite,
      );
      return opposite;
    }
    diagnose(
      "UnknownGroup",
      "warning",
      `${what} names ${target.name}, which the ledger does not have on the board`,
      at,
      null,
    );
    return null;
  };

  const renderCount = (group: MutableGroup): number => {
    const out = new Set<string>();
    for (const values of group.variants.values()) {
      out.add(multisetKey(values, renderKey));
    }
    return out.size;
  };

  const observe = (group: MutableGroup, at: EventLocation): void => {
    const render = renderCount(group);
    if (render > 1 && group.lastRenderCount <= 1) {
      group.forkCount += 1;
    }
    group.lastRenderCount = render;
    if (render > 1) {
      group.everDivergent = true;
      if (group.firstForkAt === null) {
        group.firstForkAt = at;
      }
      group.resolvedAt = null;
    } else if (group.saturated) {
      // Truncation hid whether the remaining variants would render differently.
      // Keep it unresolved; the census counts saturation as never confirmed.
      group.resolvedAt = null;
    } else if (group.everDivergent && group.resolvedAt === null) {
      group.resolvedAt = at;
    }
    state.maxInternalVariants = Math.max(state.maxInternalVariants, group.variants.size);
    state.maxRenderVariants = Math.max(state.maxRenderVariants, render);
  };

  const retire = (group: MutableGroup, at: EventLocation): void => {
    group.live = false;
    group.leftAt = at;
    if (state.groups.get(group.key) === group) {
      state.groups.delete(group.key);
    }
    if (state.active[group.side] === group.id) {
      state.active[group.side] = null;
    }
  };

  const createGroup = (
    side: Side,
    name: string,
    variants: readonly (readonly MaterialValue[])[],
    at: EventLocation,
  ): MutableGroup => {
    const key = keyOf(side, name);
    const group: MutableGroup = {
      cap,
      everDivergent: false,
      firstForkAt: null,
      forkCount: 0,
      id: `g${state.nextGroupId}`,
      key,
      lastRenderCount: 1,
      leftAt: null,
      live: true,
      members: variants[0]?.length ?? 0,
      maxMembers: variants[0]?.length ?? 0,
      name,
      resolvedAt: null,
      saturated: false,
      side,
      variants: new Map(),
    };
    state.nextGroupId += 1;
    for (const values of variants) {
      const sorted = sortValues(values);
      group.variants.set(multisetKey(sorted, valueKey), sorted);
    }
    state.groups.set(key, group);
    state.history.push(group);
    observe(group, at);
    return group;
  };

  const expand = (
    group: MutableGroup,
    at: EventLocation,
    next: (values: readonly MaterialValue[]) => readonly (readonly MaterialValue[])[],
  ): void => {
    if (group.saturated) {
      return;
    }
    const out = new Map<string, readonly MaterialValue[]>();
    outer: for (const values of group.variants.values()) {
      for (const candidate of next(values)) {
        const sorted = sortValues(candidate);
        out.set(multisetKey(sorted, valueKey), sorted);
        // Bound the intermediate map as well as the stored one: a transition
        // can generate a product far larger than the cap, and building it all
        // only to trim is a memory spike for no information. Saturation already
        // means "at least two pictures survive", which is all the census needs.
        if (out.size > cap * 4) {
          break outer;
        }
      }
    }
    if (out.size === 0) {
      diagnose(
        "NoVariant",
        "error",
        "the event is undefined on every surviving variant",
        at,
        group,
      );
      group.saturated = true;
      group.everDivergent = true;
      observe(group, at);
      return;
    }
    if (out.size > cap) {
      group.saturated = true;
      group.variants = new Map(
        [...out.entries()].sort(([left], [right]) => left.localeCompare(right)).slice(0, cap),
      );
      diagnose(
        "Saturated",
        "warning",
        `variants exceeded ${String(cap)}; the group is frozen as divergent`,
        at,
        group,
      );
    } else {
      group.variants = out;
    }
    observe(group, at);
  };

  const addMember = (
    group: MutableGroup,
    choices: readonly MaterialValue[],
    at: EventLocation,
  ): void => {
    if (choices.length === 0) {
      return;
    }
    group.members += 1;
    group.maxMembers = Math.max(group.maxMembers, group.members);
    if (group.saturated) {
      observe(group, at);
      return;
    }
    expand(group, at, (values) => choices.map((choice) => [...values, choice]));
  };

  const place = (
    side: Side,
    name: string,
    choices: readonly MaterialValue[],
    at: EventLocation,
  ): MutableGroup => {
    const existing = state.groups.get(keyOf(side, name));
    if (existing !== undefined) {
      addMember(existing, choices, at);
      return existing;
    }
    return createGroup(side, name, choices.map((choice) => [choice]), at);
  };

  const hasMatch = (
    group: MutableGroup,
    predicate: (value: MaterialValue) => boolean,
  ): boolean => {
    for (const values of group.variants.values()) {
      if (values.some(predicate)) {
        return true;
      }
    }
    return false;
  };

  /** Remove one matching body and return every distinct value that could have left. */
  const removeAny = (
    group: MutableGroup,
    at: EventLocation,
    predicate: (value: MaterialValue) => boolean,
  ): readonly MaterialValue[] => {
    if (!hasMatch(group, predicate)) {
      return [];
    }
    const removed = new Map<string, MaterialValue>();
    expand(group, at, (values) => {
      const nexts: (readonly MaterialValue[])[] = [];
      values.forEach((value, index) => {
        if (!predicate(value)) {
          return;
        }
        removed.set(valueKey(value), value);
        nexts.push([...values.slice(0, index), ...values.slice(index + 1)]);
      });
      return nexts;
    });
    group.members -= 1;
    if (group.members <= 0) {
      retire(group, at);
    }
    return [...removed.values()];
  };

  /** Replace one matching body in every variant. */
  const replaceOne = (
    group: MutableGroup,
    at: EventLocation,
    predicate: (value: MaterialValue) => boolean,
    transform: (value: MaterialValue) => MaterialValue,
  ): boolean => {
    if (!hasMatch(group, predicate)) {
      return false;
    }
    expand(group, at, (values) => {
      const nexts: (readonly MaterialValue[])[] = [];
      values.forEach((value, index) => {
        if (!predicate(value)) {
          return;
        }
        nexts.push([
          ...values.slice(0, index),
          transform(value),
          ...values.slice(index + 1),
        ]);
      });
      return nexts;
    });
    return true;
  };

  /** Apply a transform to one body, whichever it is. */
  const applyToAny = (
    group: MutableGroup,
    at: EventLocation,
    transform: (value: MaterialValue) => MaterialValue,
  ): void => {
    if (group.variants.size === 0) {
      return;
    }
    expand(group, at, (values) =>
      values.map((value, index) => [
        ...values.slice(0, index),
        transform(value),
        ...values.slice(index + 1),
      ]));
  };

  const damageValue = (
    value: MaterialValue,
    amount: number,
    lethal: boolean,
  ): MaterialValue => {
    const damage = value.damage + amount;
    return {
      ...value,
      damage,
      hp: lethal ? value.hp : { ...value.hp, min: Math.max(value.hp.min, damage) },
    };
  };

  const activeStates = (group: MutableGroup): readonly boolean[] =>
    [...group.variants.values()].map((values) =>
      values.some((value) => value.zone === "active"));

  /** Subtract damage from one body; warn when no body carries enough. */
  const subtractDamage = (
    group: MutableGroup,
    at: EventLocation,
    amount: number,
    name: string,
    what: string,
  ): void => {
    const exact = (value: MaterialValue): boolean => value.damage >= amount;
    const exactPossible = hasMatch(group, exact);
    if (!exactPossible) {
      diagnose("HealOverflow", "warning", `${what} exceeds the tracked damage on ${name}`, at, group);
    }
    replaceOne(
      group,
      at,
      (value) => (exactPossible ? exact(value) : true),
      (value) => ({ ...value, damage: Math.max(0, value.damage - amount) }),
    );
  };

  const minBench = (side: Side): number => {
    let total = 0;
    for (const group of state.groups.values()) {
      if (group.side !== side || !group.live || group.saturated) {
        continue;
      }
      let least = Number.POSITIVE_INFINITY;
      for (const values of group.variants.values()) {
        least = Math.min(least, values.filter((value) => value.zone === "bench").length);
      }
      if (Number.isFinite(least)) {
        total += least;
      }
    }
    return total;
  };

  const damageGroup = (
    target: CardRef,
    amount: number,
    lethal: boolean,
    at: EventLocation,
  ): void => {
    const group = resolveGroup(target, "damage", at);
    if (group === null) {
      return;
    }
    applyToAny(group, at, (value) => damageValue(value, amount, lethal));
  };

  const healGroup = (
    target: CardRef,
    amount: number,
    at: EventLocation,
  ): void => {
    const group = resolveGroup(target, "healing", at);
    if (group === null) {
      return;
    }
    subtractDamage(group, at, amount, target.name, `healing ${String(amount)}`);
  };

  const attachTo = (
    target: CardRef,
    card: string,
    zone: "active" | "bench" | null,
    at: EventLocation,
  ): void => {
    const group = resolveGroup(target, "an attachment", at);
    if (group === null) {
      return;
    }
    const inZone = (value: MaterialValue): boolean => zone === null || value.zone === zone;
    if (!hasMatch(group, inZone)) {
      diagnose(
        "UnknownGroup",
        "warning",
        `an attachment names ${target.name} in a zone the ledger does not have`,
        at,
        group,
      );
      return;
    }
    replaceOne(group, at, inZone, (value) => ({
      ...value,
      attachments: [...value.attachments, card],
    }));
  };

  const startKnockout = (target: CardRef, at: EventLocation): void => {
    const group = resolveGroup(target, "knockout", at);
    if (group === null) {
      return;
    }

    const preferred = group.id === state.active[group.side]
      ? (value: MaterialValue): boolean => value.zone === "active"
      : (value: MaterialValue): boolean => value.zone === "bench";
    const lethal = (value: MaterialValue): boolean => value.damage > value.hp.min;

    const options = new Map<string, KnockoutOption>();
    for (const values of group.variants.values()) {
      let indices = values
        .map((value, index) => ({ index, value }))
        .filter((entry) => preferred(entry.value) && lethal(entry.value))
        .map((entry) => entry.index);
      if (indices.length === 0) {
        indices = values
          .map((value, index) => ({ index, value }))
          .filter((entry) => preferred(entry.value))
          .map((entry) => entry.index);
      }
      if (indices.length === 0) {
        indices = values.map((_value, index) => index);
      }
      for (const index of indices) {
        const removed = values[index];
        if (removed === undefined) {
          continue;
        }
        const remaining = [...values.slice(0, index), ...values.slice(index + 1)];
        const option = { remaining, removed };
        options.set(`${multisetKey(remaining, valueKey)}\u0003${valueKey(removed)}`, option);
      }
    }

    state.pending.set(group.key, { at, group, options: [...options.values()] });

    const lethalOptions = [...options.values()].filter((option) =>
      option.removed.damage > option.removed.hp.min);
    if (lethalOptions.length === 0) {
      diagnose(
        "KnockoutUnproven",
        "warning",
        `no tracked body of ${target.name} carried enough damage to explain the knockout`,
        at,
        group,
      );
    }
  };

  const commitKnockout = (pending: PendingKnockout): void => {
    const { at, group, options } = pending;
    if (options.length === 0) {
      return;
    }
    const next = new Map<string, readonly MaterialValue[]>();
    for (const option of options) {
      const sorted = sortValues(option.remaining);
      next.set(multisetKey(sorted, valueKey), sorted);
    }
    group.variants = next;
    group.members -= 1;
    if (group.id === state.active[group.side]) {
      const states = activeStates(group);
      if (states.length === 0 || !states.every(Boolean)) {
        state.active[group.side] = null;
      }
    }
    if (group.members <= 0) {
      retire(group, at);
    }
    observe(group, at);
  };

  const commitAllKnockouts = (): void => {
    for (const pending of state.pending.values()) {
      commitKnockout(pending);
    }
    state.pending.clear();
  };

  const moveZone = (
    side: Side,
    name: string,
    from: Zone,
    to: Zone,
    at: EventLocation,
  ): MutableGroup | null => {
    const group = state.groups.get(keyOf(side, name));
    if (group === undefined) {
      return null;
    }
    const moved = replaceOne(
      group,
      at,
      (value) => value.zone === from,
      (value) => ({ ...value, zone: to }),
    );
    if (!moved) {
      diagnose(
        "UnknownGroup",
        "warning",
        `${name} was expected in the ${from === "active" ? "Active Spot" : "Bench"} and was not there`,
        at,
        group,
      );
    }
    return group;
  };

  const switchSameGroup = (
    group: MutableGroup,
    at: EventLocation,
  ): void => {
    const canSwitch = [...group.variants.values()].some((values) =>
      values.some((value) => value.zone === "active")
      && values.some((value) => value.zone === "bench"));
    if (!canSwitch) {
      diagnose(
        "UnknownGroup",
        "warning",
        `a same-name switch found no Active/Bench pair for ${group.name}`,
        at,
        group,
      );
      return;
    }
    expand(group, at, (values) => {
      const active = values
        .map((value, index) => ({ index, value }))
        .filter((entry) => entry.value.zone === "active")
        .map((entry) => entry.index);
      const bench = values
        .map((value, index) => ({ index, value }))
        .filter((entry) => entry.value.zone === "bench")
        .map((entry) => entry.index);
      const nexts: (readonly MaterialValue[])[] = [];
      for (const outgoing of active) {
        for (const incoming of bench) {
          if (incoming === outgoing) {
            continue;
          }
          const next = [...values];
          const outgoingValue = next[outgoing];
          const incomingValue = next[incoming];
          if (outgoingValue === undefined || incomingValue === undefined) {
            continue;
          }
          next[outgoing] = { ...outgoingValue, zone: "bench" };
          next[incoming] = { ...incomingValue, zone: "active" };
          nexts.push(next);
        }
      }
      return nexts;
    });
  };

  const draw = (side: Side, count: number, revealed: readonly string[], opening: boolean): void => {
    const hand = state.hand[side];
    // The opening hand is the one draw whose count is absolute, not additive.
    hand.count = opening ? count : hand.count + count;
    hand.known.push(...revealed);
  };

  const playCard = (card: CardRef, zone: CardZone | null, at: EventLocation): void => {
    const hand = state.hand[card.side];
    hand.count = Math.max(0, hand.count - 1);
    if (zone === "active" || zone === "bench") {
      if (zone === "bench" && minBench(card.side) >= 5) {
        // The game does not allow a sixth Bench Pokémon, so either the log is
        // wrong or the ledger over-counted a earlier departure. A move to a
        // hidden zone has no source, so the ledger deliberately keeps bodies
        // there; report the symptom and place the body rather than inventing a
        // departure to make room. The census can only over-report.
        diagnose(
          "BenchOverflow",
          "warning",
          `a sixth Pokémon was played to ${card.name}'s Bench`,
          at,
          null,
        );
      }
      const group = place(card.side, card.name, [makeValue(zone, initialHp(card.name))], at);
      if (zone === "active") {
        state.active[card.side] = group.id;
      }
      return;
    }
    if (zone !== null) {
      return;
    }
    if (!boardNames.has(keyOf(card.side, card.name))) {
      // "played X." with no zone is how the log prints a Trainer, an Energy, or
      // a Stadium. The text is identical for all of them, so only a name the
      // log later treats as a Pokémon is allowed to become a body (D35).
      return;
    }
    if (state.groups.has(keyOf(card.side, card.name))) {
      // A bare "played X." naming a body already in play is the client's
      // ability activation after an evolution (`played Dudunsparce`), not a
      // second card. Treating it as a body doubles the group and breaks Bench
      // capacity. A genuine second copy played with no zone is rare enough to
      // miss rather than to invent (D35).
      return;
    }
    place(
      card.side,
      card.name,
      [makeValue("active", initialHp(card.name)), makeValue("bench", initialHp(card.name))],
      at,
    );
  };

  const moveCard = (card: CardRef, to: CardZone, at: EventLocation): void => {
    if (to === "active" || to === "bench") {
      const group = state.groups.get(keyOf(card.side, card.name));
      if (group === undefined) {
        if (boardNames.has(keyOf(card.side, card.name))) {
          const created = place(
            card.side,
            card.name,
            [makeValue(to, initialHp(card.name))],
            at,
          );
          if (to === "active") {
            state.active[card.side] = created.id;
          }
        }
        return;
      }
      const from: Zone = to === "active" ? "bench" : "active";
      if (to === "active") {
        const alreadyActive = [...group.variants.values()].some((values) =>
          values.some((value) => value.zone === "active"));
        if (state.active[card.side] === group.id && alreadyActive) {
          // The log prints a switch or retreat and then, on the next line,
          // "X is now in the Active Spot." That second line confirms the move
          // the switch already made; applying it again would promote a second
          // copy and leave the side with two Active Pokémon.
          return;
        }
      }
      if (to === "bench" && minBench(card.side) >= 5) {
        diagnose("BenchOverflow", "warning", `a sixth Pokémon moved to ${card.name}'s Bench`, at, group);
      }
      moveZone(card.side, card.name, from, to, at);
      if (to === "active") {
        state.active[card.side] = group.id;
      } else if (state.active[card.side] === group.id) {
        state.active[card.side] = null;
      }
      return;
    }
    if (to === "hand") {
      state.hand[card.side].count += 1;
    }
    if (to === "stadium") {
      return;
    }
    // A move to a hidden zone does not name its source. `Night Stretcher: moved
    // Mega Excadrill ex to hand` is the discard, not the board, and treating it
    // as a departure deletes the active Pokémon on no evidence. The card may
    // have left the board; keeping it can only over-report, which is the safe
    // direction for an upper bound. A knockout or detach still removes it.
  };

  const evolveGroup = (
    direction: "evolve" | "devolve",
    from: CardRef,
    into: string,
    zone: "active" | "bench" | null,
    at: EventLocation,
  ): void => {
    const source = state.groups.get(keyOf(from.side, from.name));
    if (source === undefined) {
      diagnose(
        "UnknownGroup",
        "warning",
        `${from.name} evolved, but the ledger does not have it on the board`,
        at,
        null,
      );
      return;
    }
    const inZone = (value: MaterialValue): boolean => zone === null || value.zone === zone;
    if (!hasMatch(source, inZone)) {
      diagnose(
        "UnknownGroup",
        "warning",
        `${from.name} evolved in a zone the ledger does not have`,
        at,
        source,
      );
      return;
    }
    const wasActive = source.id === state.active[from.side];
    const removed = removeAny(source, at, inZone);
    if (removed.length === 0) {
      return;
    }
    const choices = new Map<string, MaterialValue>();
    for (const value of removed) {
      const under = [...value.under];
      if (direction === "evolve") {
        under.push(from.name);
      } else {
        const buried = under.lastIndexOf(into);
        if (buried >= 0) {
          under.splice(buried, 1);
        }
      }
      const evolved: MaterialValue = {
        ...value,
        // The new card has its own HP; damage, attachments, and the evolution
        // stack carry over. The stack is what a later discard line enumerates.
        hp: initialHp(into),
        under,
      };
      choices.set(valueKey(evolved), evolved);
    }
    const destination = place(from.side, into, [...choices.values()], at);
    if (wasActive) {
      const states = activeStates(source);
      if (states.length > 0 && states.every((hasActive) => !hasActive)) {
        // Every variant lost its active body to this evolution.
        state.active[from.side] = destination.id;
      } else if (!states.every(Boolean)) {
        // Some variants evolved the active body and some did not.
        state.active[from.side] = null;
      }
    }
  };

  const handleDetach = (
    body: CardRef,
    cards: readonly string[],
    count: number,
    at: EventLocation,
  ): void => {
    const group = resolveGroup(body, "a discard", at);
    if (group === null) {
      return;
    }
    const pending = state.pending.get(group.key);
    if (pending !== undefined) {
      if (cards.length > 0) {
        // Exact pile first: D14's strongest evidence. Only when no body's pile
        // matches exactly do we accept a superset, because the ledger may have
        // missed an attachment rather than the log being wrong.
        const exact = pending.options.filter((option) =>
          sameMultiset(pileOf(option.removed), cards));
        const filtered = exact.length > 0
          ? exact
          : pending.options.filter((option) => containsAll(pileOf(option.removed), cards));
        if (filtered.length > 0) {
          pending.options = filtered;
        } else {
          diagnose(
            "AttachmentMismatch",
            "warning",
            `the discard list for ${body.name} matches no possible body`,
            at,
            pending.group,
          );
        }
      }
      return;
    }

    if (cards.length > 0) {
      const exactMatches = (value: MaterialValue): boolean => sameMultiset(pileOf(value), cards);
      const matches = hasMatch(group, exactMatches)
        ? exactMatches
        : (value: MaterialValue): boolean => containsAll(pileOf(value), cards);
      if (!hasMatch(group, matches)) {
        diagnose(
          "AttachmentMismatch",
          "warning",
          `the discard list for ${body.name} matches no body in the group`,
          at,
          group,
        );
        return;
      }
      replaceOne(group, at, matches, (value) => removeFromPile(value, cards));
      return;
    }
    if (count > 0) {
      const canRemove = [...group.variants.values()].some((values) =>
        values.some((value) => pileOf(value).length >= count));
      if (!canRemove) {
        diagnose(
          "AttachmentMismatch",
          "warning",
          `a discard of ${String(count)} cards exceeds every pile on ${body.name}`,
          at,
          group,
        );
        return;
      }
      expand(group, at, (values) =>
        values.flatMap((value, index) => {
          const pile = pileOf(value);
          if (pile.length < count) {
            return [];
          }
          return subsets(pile, count).map((picked) => [
            ...values.slice(0, index),
            removeFromPile(value, picked),
            ...values.slice(index + 1),
          ]);
        }));
    }
  };

  const handleMoveCounters = (
    from: CardRef,
    to: CardRef,
    amount: number,
    at: EventLocation,
    index: number,
  ): void => {
    const fromGroup = state.groups.get(keyOf(from.side, from.name));
    if (fromGroup === undefined || fromGroup !== state.groups.get(keyOf(to.side, to.name))) {
      if (fromGroup !== undefined) {
        subtractDamage(
          fromGroup,
          at,
          amount,
          from.name,
          `moving ${String(amount)} damage from ${from.name}`,
        );
      }
      const toGroup = state.groups.get(keyOf(to.side, to.name));
      if (toGroup !== undefined) {
        const lethal = knockoutFollows(events, index, to.side, to.name);
        applyToAny(toGroup, at, (value) => damageValue(value, amount, lethal));
      }
      return;
    }

    const group = fromGroup;
    const canMove = [...group.variants.values()].some((values) =>
      values.some((source, sourceIndex) =>
        source.damage >= amount && values.some((_target, targetIndex) => targetIndex !== sourceIndex)));
    if (!canMove) {
      diagnose(
        "HealOverflow",
        "warning",
        `${String(amount)} counters could not move within ${from.name}: no body carries them`,
        at,
        group,
      );
      return;
    }
    const lethal = knockoutFollows(events, index, to.side, to.name);
    expand(group, at, (values) => {
      const nexts: (readonly MaterialValue[])[] = [];
      values.forEach((source, sourceIndex) => {
        if (source.damage < amount) {
          return;
        }
        values.forEach((target, targetIndex) => {
          if (sourceIndex === targetIndex) {
            return;
          }
          const next = [...values];
          next[sourceIndex] = { ...source, damage: source.damage - amount };
          next[targetIndex] = damageValue(target, amount, lethal);
          nexts.push(next);
        });
      });
      return nexts;
    });
  };

  events.forEach((event, index) => {
    const at = event.at;

    // A detach immediately after a knockout describes the dying body; keep the
    // pending knockout open so the discard list can filter its options. Every
    // other event commits the pending first.
    if (event.kind === "detach") {
      const direct = state.pending.get(keyOf(event.body.side, event.body.name));
      const opposite = state.pending.get(keyOf(otherSide(event.body.side), event.body.name));
      if (direct !== undefined || opposite !== undefined) {
        handleDetach(event.body, event.cards, event.count, at);
        return;
      }
    }
    commitAllKnockouts();

    switch (event.kind) {
      case "attach":
        attachTo(event.target, event.card, event.zone, at);
        break;
      case "counterDamage":
        damageGroup(
          event.target,
          event.damage,
          knockoutFollows(events, index, event.target.side, event.target.name),
          at,
        );
        break;
      case "damage":
        damageGroup(
          event.target,
          event.amount,
          knockoutFollows(events, index, event.target.side, event.target.name),
          at,
        );
        break;
      case "devolve":
      case "evolve":
        evolveGroup(event.kind, event.from, event.into, event.zone, at);
        break;
      case "detach":
        handleDetach(event.body, event.cards, event.count, at);
        break;
      case "draw":
        draw(event.side, event.count, event.revealed, event.opening);
        break;
      case "knockout":
        startKnockout(event.target, at);
        break;
      case "endGame":
      case "endTurn":
      case "attack":
        break;
      case "heal":
        healGroup(event.target, event.damage, at);
        break;
      case "moveCard":
        moveCard(event.card, event.to, at);
        break;
      case "moveCounters":
        handleMoveCounters(event.from, event.to, event.damage, at, index);
        break;
      case "play":
        playCard(event.card, event.zone, at);
        break;
      case "prizeRevealed":
        state.hand[event.side].known.push(event.card);
        break;
      case "prizeTaken": {
        const prizes = state.prizes[event.side];
        if (event.count > prizes.remaining) {
          diagnose(
            "PrizeOverflow",
            "warning",
            `${String(event.count)} Prize cards were taken with ${String(prizes.remaining)} left`,
            at,
            null,
          );
        }
        prizes.remaining = Math.max(0, prizes.remaining - event.count);
        state.hand[event.side].count += event.count;
        break;
      }
      case "retreat":
        if (moveZone(event.card.side, event.card.name, "active", "bench", at) !== null) {
          state.active[event.card.side] = null;
        }
        break;
      case "switchActive":
        if (event.outgoing.side === event.incoming.side && event.outgoing.name === event.incoming.name) {
          const group = state.groups.get(keyOf(event.outgoing.side, event.outgoing.name));
          if (group === undefined) {
            diagnose(
              "UnknownGroup",
              "warning",
              `a switch names ${event.outgoing.name}, which is not on the board`,
              at,
              null,
            );
          } else {
            switchSameGroup(group, at);
            state.active[event.outgoing.side] = group.id;
          }
        } else {
          moveZone(event.outgoing.side, event.outgoing.name, "active", "bench", at);
          const incoming = moveZone(event.incoming.side, event.incoming.name, "bench", "active", at);
          if (incoming !== null) {
            state.active[event.incoming.side] = incoming.id;
          }
        }
        break;
      default:
        break;
    }
  });

  commitAllKnockouts();

  const snapshot = (group: MutableGroup): LedgerGroupSnapshot => {
    const hp = new Map<string, HpInterval>();
    const zones = new Map<string, { readonly active: number; readonly bench: number }>();
    for (const values of group.variants.values()) {
      const active = values.filter((value) => value.zone === "active").length;
      zones.set(`${String(active)}|${String(values.length - active)}`, {
        active,
        bench: values.length - active,
      });
      for (const value of values) {
        hp.set(
          `${String(value.hp.min)}|${value.hp.max === null ? "inf" : String(value.hp.max)}`,
          value.hp,
        );
      }
    }
    return {
      everDivergent: group.everDivergent,
      firstForkAt: group.firstForkAt,
      forkCount: group.forkCount,
      hp: [...hp.values()].sort((left, right) =>
        left.min - right.min || (left.max ?? Number.POSITIVE_INFINITY) - (right.max ?? Number.POSITIVE_INFINITY)),
      id: group.id,
      internalVariants: group.variants.size,
      leftAt: group.leftAt,
      live: group.live,
      maxMembers: group.maxMembers,
      members: group.members,
      name: group.name,
      renderVariants: renderCount(group),
      resolvedAt: group.resolvedAt,
      saturated: group.saturated,
      side: group.side,
      zoneCounts: [...zones.values()].sort((left, right) =>
        left.active - right.active || left.bench - right.bench),
    };
  };

  const groups = state.history.map(snapshot);
  const liveGroups = groups.filter((group) => group.live);
  const unexecutable = state.diagnostics.some((diagnostic) => diagnostic.severity === "error");

  return {
    board: {
      active: { ...state.active },
      hand: {
        opponent: { count: state.hand.opponent.count, known: [...state.hand.opponent.known] },
        self: { count: state.hand.self.count, known: [...state.hand.self.known] },
      },
      prizes: {
        opponent: {
          known: [...state.prizes.opponent.known],
          remaining: state.prizes.opponent.remaining,
        },
        self: {
          known: [...state.prizes.self.known],
          remaining: state.prizes.self.remaining,
        },
      },
    },
    diagnostics: [...state.diagnostics].sort((left, right) =>
      left.at.line - right.at.line || left.code.localeCompare(right.code)),
    groups,
    liveGroups,
    maxInternalVariants: state.maxInternalVariants,
    maxRenderVariants: state.maxRenderVariants,
    saturated: groups.some((group) => group.saturated),
    unexecutable,
  };
};
