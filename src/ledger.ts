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

import type { CardRef, CardZone, CounterDamageEvent, EventLocation, GameEvent, MoveCardEvent } from "./events.js";
import type { CardOracle, CounterSpread } from "./oracle.js";
import type { HiddenZone, PrizeZone, Side, Zone } from "./types.js";

/**
 * A monotone interval on one body's HP.
 *
 * `min` is inclusive: the smallest HP the body can have. A survival at damage
 * `d` raises it to `d + 1` (HP is strictly greater than the damage it survived);
 * card data sets both ends to the printing's HP. `max: null` means no upper
 * bound yet.
 */
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
   * Optional card data. Bare mode leaves this unset and learns per-body bounds
   * from knockouts and survivals. An oracle narrows those bounds by proof; it
   * never supplies a guess (D4a).
   */
  readonly oracle?: CardOracle;
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
    | "HpExceeded"
    | "KnockoutUnproven"
    | "NoVariant"
    | "PrizeOverflow"
    | "Saturated"
    | "SideAmbiguous"
    | "SideMismatch"
    | "SpreadMismatch"
    | "SpreadUnmarked"
    | "TargetZoneUnreachable"
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
  /** Which value dimensions differ among the group's variants. */
  readonly varying: readonly ("zone" | "damage" | "attachments" | "under")[];
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
  /** Per-prefix confirmation counts. A prefix is confirmed when no live group
   * renders more than one picture and none is saturated. */
  readonly prefixes: {
    readonly total: number;
    readonly confirmed: number;
    readonly divergent: number;
    readonly saturated: number;
    /** Turn boundaries only: the board a viewer would stop on. */
    readonly stableTotal: number;
    readonly stableConfirmed: number;
    readonly stableDivergent: number;
    readonly stableSaturated: number;
  };
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
  divergent: boolean;
  saturated: boolean;
  leftAt: EventLocation | null;
  readonly cap: number;
}

interface KnockoutOption {
  readonly remaining: readonly MaterialValue[];
  /** One body for a knockout; a Bench trim can take several of the same name. */
  readonly removed: readonly MaterialValue[];
}

interface PendingKnockout {
  readonly group: MutableGroup;
  readonly at: EventLocation;
  readonly trim: boolean;
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
  divergentGroups: number;
  saturatedGroupsLive: number;
  maxInternalVariants: number;
  maxRenderVariants: number;
  readonly prefixes: {
    total: number;
    confirmed: number;
    divergent: number;
    saturated: number;
    stableTotal: number;
    stableConfirmed: number;
    stableDivergent: number;
    stableSaturated: number;
  };
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

/** Every distinct non-empty part of `cards` that `pile` also holds. */
const sharedParts = (pile: readonly string[], cards: readonly string[]): readonly (readonly string[])[] => {
  const held = new Map<string, number>();
  for (const card of pile) {
    held.set(card, (held.get(card) ?? 0) + 1);
  }
  const wanted = new Map<string, number>();
  for (const card of cards) {
    wanted.set(card, (wanted.get(card) ?? 0) + 1);
  }
  let parts: string[][] = [[]];
  for (const [card, n] of wanted) {
    const most = Math.min(n, held.get(card) ?? 0);
    parts = parts.flatMap((part) =>
      Array.from({ length: most + 1 }, (_, k) => [...part, ...Array<string>(k).fill(card)]));
  }
  return parts.filter((part) => part.length > 0);
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

/**
 * Whether surviving the hit at `index` proves nothing about printed HP: a
 * knockout of that name follows, or the hit card's own effect heals it in the
 * same phase (Resolute Heart prints the damage it undoes as a heal).
 */
const survivalUnproven = (
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
  // A hit late in a turn can have its knockout printed in the Checkup block that
  // follows, so that one boundary is crossed; a Turn header never is.
  const sameOrCheckup = (at: EventLocation): boolean =>
    at.phaseIndex === source.at.phaseIndex
    || (at.phaseIndex === source.at.phaseIndex + 1 && at.turn === null && source.at.turn !== null);
  for (let offset = 1; ; offset += 1) {
    const event = events[index + offset];
    // The game ended before the client printed a knockout (a concession).
    if (event?.kind === "endGame") {
      return true;
    }
    if (event === undefined || !sameOrCheckup(event.at)) {
      return false;
    }
    if (event.kind === "knockout" && event.target.side === side && event.target.name === name) {
      return true;
    }
    const previous = events[index + offset - 1];
    if (
      event.kind === "heal" && event.target.name === name && event.at.phaseIndex === source.at.phaseIndex
      && previous?.kind === "attack" && previous.source.name === name
    ) {
      return true;
    }
  }
  return false;
};

/**
 * Whether the knocked-out card is the source of the latest attack or ability
 * in this phase. Its own effect can knock it out (Cursed Blast, Overvolt
 * Discharge), so the knockout needs no lethal damage.
 */
const actedLast = (events: readonly GameEvent[], index: number, target: CardRef): boolean => {
  const at = events[index]?.at;
  for (let back = index - 1; back >= 0; back -= 1) {
    const event = events[back];
    if (event === undefined || at === undefined || event.at.phaseIndex !== at.phaseIndex) {
      return false;
    }
    if (event.kind === "attack") {
      return event.source.side === target.side && event.source.name === target.name;
    }
  }
  return false;
};

const CHECKUP_EFFECTS: ReadonlySet<GameEvent["kind"]> = new Set([
  "attack",
  "counterDamage",
  "prevented",
  "damage",
  "heal",
  "moveCounters",
]);

/**
 * Put each Checkup's effects before its knockouts. Knockouts are checked after
 * every Checkup effect resolves, but the export can print them first (Freezing
 * Shroud's counters follow the knockouts they cause).
 */
const checkupOrder = (events: readonly GameEvent[]): readonly GameEvent[] => {
  const out: GameEvent[] = [];
  let index = 0;
  while (index < events.length) {
    const first = events[index];
    if (first === undefined) {
      break;
    }
    let end = index;
    while (events[end]?.at.phaseIndex === first.at.phaseIndex) {
      end += 1;
    }
    const phase = events.slice(index, end);
    const knockoutAt = phase.findIndex((event) => event.kind === "knockout");
    if (first.at.turn !== null || knockoutAt < 0) {
      out.push(...phase);
    } else {
      const tail = phase.slice(knockoutAt);
      out.push(
        ...phase.slice(0, knockoutAt),
        ...tail.filter((event) => CHECKUP_EFFECTS.has(event.kind)),
        ...tail.filter((event) => !CHECKUP_EFFECTS.has(event.kind)),
      );
    }
    index = end;
  }
  return out;
};

/**
 * Put counters printed after a knockout and its discard line before the
 * knockout. Retaliation (Punk Helmet, Spiky Energy) resolves during the attack,
 * before knockouts are checked, but the export prints it after them.
 */
const retaliationOrder = (
  events: readonly GameEvent[],
): { readonly events: readonly GameEvent[]; readonly moved: ReadonlySet<GameEvent> } => {
  const out = [...events];
  const moved = new Set<GameEvent>();
  for (let index = 1; index < out.length; index += 1) {
    const event = out[index];
    if (event?.kind !== "counterDamage") {
      continue;
    }
    let start = index;
    while (start > 0) {
      const before = out[start - 1];
      if (
        before === undefined || before.at.phaseIndex !== event.at.phaseIndex
        || (before.kind !== "knockout" && before.kind !== "detach")
      ) {
        break;
      }
      start -= 1;
    }
    if (start < index && out[start]?.kind === "knockout") {
      out.splice(index, 1);
      out.splice(start, 0, event);
      moved.add(event);
    }
  }
  return { events: out, moved };
};

/** Moved retaliation lines never share a run with the attack's own counter lines. */
const sameStep = (moved: ReadonlySet<GameEvent>, previous: GameEvent, line: GameEvent): boolean =>
  previous.at.phaseIndex === line.at.phaseIndex && moved.has(previous) === moved.has(line);

/**
 * Owner-unnamed counter lines from one effect step, by the index of the first
 * line of each target name. The client builds one modification per step with
 * one entry per target card and prints them as a contiguous run, so k lines
 * naming one card in a run are k distinct bodies.
 */
const counterRuns = (
  events: readonly GameEvent[],
  moved: ReadonlySet<GameEvent>,
): ReadonlyMap<number, readonly CounterDamageEvent[]> => {
  const batches = new Map<number, CounterDamageEvent[]>();
  let firstByName = new Map<string, number>();
  let previous: GameEvent | undefined;
  events.forEach((line, index) => {
    const continues = previous?.kind === "counterDamage" && !previous.ownerPrinted
      && sameStep(moved, previous, line);
    if (!continues) {
      firstByName = new Map();
    }
    previous = line;
    if (line.kind !== "counterDamage" || line.ownerPrinted) {
      return;
    }
    const first = firstByName.get(line.target.name) ?? index;
    firstByName.set(line.target.name, first);
    batches.set(first, [...(batches.get(first) ?? []), line]);
  });
  return batches;
};

/** The effect behind a counter run: the acting card and its stated spread. */
interface SpreadCause {
  readonly actor: CardRef;
  readonly spread: CounterSpread;
}

/** Each run of owner-unnamed counter lines, by the index of its first line. */
const counterRunStarts = (
  events: readonly GameEvent[],
  moved: ReadonlySet<GameEvent>,
): ReadonlyMap<number, readonly CounterDamageEvent[]> => {
  const runs = new Map<number, CounterDamageEvent[]>();
  let current: CounterDamageEvent[] | null = null;
  events.forEach((line, index) => {
    if (line.kind !== "counterDamage" || line.ownerPrinted) {
      current = null;
      return;
    }
    const last = current?.at(-1);
    if (current === null || last === undefined || !sameStep(moved, last, line)) {
      current = [];
      runs.set(index, current);
    }
    current.push(line);
  });
  return runs;
};

const sameDamage = (batch: readonly CounterDamageEvent[]): boolean =>
  batch.every((line) => line.damage === batch[0]?.damage && line.target.side === batch[0].target.side);

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
export const runLedger = (logged: readonly GameEvent[], options: LedgerOptions = {}): LedgerRun => {
  const { events, moved } = retaliationOrder(checkupOrder(logged));
  const cap = options.maxVariants ?? 4096;
  const oracle = options.oracle;
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
    divergentGroups: 0,
    saturatedGroupsLive: 0,
    pending: new Map(),
    prefixes: {
      confirmed: 0,
      divergent: 0,
      saturated: 0,
      stableConfirmed: 0,
      stableDivergent: 0,
      stableSaturated: 0,
      stableTotal: 0,
      total: 0,
    },
    prizes: {
      opponent: { known: [], remaining: 6 },
      self: { known: [], remaining: 6 },
    },
  };

  const initialHp = (name: string): HpInterval => {
    const printings = oracle?.printings(name) ?? null;
    const hps = printings?.flatMap((printing) =>
      printing.hp === null || printing.hp <= 0 ? [] : [printing.hp]) ?? [];
    if (hps.length === 0) {
      return { max: null, min: 0 };
    }
    // An Ability that may raise its own HP lifts only the ceiling.
    const raised = printings?.flatMap((printing) =>
      printing.hp === null || printing.hp <= 0
        ? []
        : [printing.hp + Math.max(0, ...(printing.abilities ?? []).map((ability) => ability.hpRaise ?? 0))]) ?? [];
    return { max: Math.max(...raised), min: Math.min(...hps) };
  };

  const targetZone = (
    source: CardRef | null,
    attack: string | null,
  ): "active" | "bench" | null => {
    if (source === null || attack === null || oracle === undefined) {
      return null;
    }
    const printings = oracle.printings(source.name);
    if (printings === null) {
      return null;
    }
    let sawUnknown = false;
    let sawBench = false;
    let sawAttack = false;
    for (const printing of printings) {
      for (const candidate of printing.attacks) {
        if (candidate.name !== attack) {
          continue;
        }
        sawAttack = true;
        if (candidate.canHitBench === true) {
          sawBench = true;
        } else if (candidate.canHitBench === null) {
          sawUnknown = true;
        }
      }
    }
    if (!sawAttack || sawBench || sawUnknown) {
      return null;
    }
    return "active";
  };

  const lineFindings: ReadonlySet<LedgerDiagnostic["code"]> = new Set([
    // Counted by `minBench`, which already skips frozen groups.
    "BenchOverflow",
    "NoVariant",
    "Saturated",
    "SideAmbiguous",
    "SideMismatch",
  ]);

  const diagnose = (
    code: LedgerDiagnostic["code"],
    severity: LedgerDiagnostic["severity"],
    message: string,
    at: EventLocation,
    group: MutableGroup | null,
  ): void => {
    // A saturated group is frozen, so checking later events against it reports
    // the freeze, not the log. `Saturated` already said it stopped checking.
    if (group?.saturated === true && !lineFindings.has(code)) {
      return;
    }
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
   * Find the group a target names, resolving a side the line does not prove.
   *
   * When the card is only on the other side, the target side is forced by
   * elimination — the same deduction that lets a log with one turn header
   * resolve the second player. The event is reported, not silently rewritten:
   * a caller can see every correction.
   *
   * When both sides have the card, the printed side is used. Only lines that
   * name the owner come here with both sides possible; a placed counter does
   * not, and `placeCounters` forks instead.
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
    const wasDivergent = group.divergent;
    group.divergent = render > 1;
    if (wasDivergent !== group.divergent) {
      state.divergentGroups += group.divergent ? 1 : -1;
    }
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

  /**
   * Count one prefix as confirmed, divergent, or saturated.
   *
   * A prefix is confirmed when no live group renders more than one picture and
   * none is saturated. This is the per-state rate the audit needs alongside the
   * strict per-log headline.
   */
  const prefixState = (): "confirmed" | "divergent" | "saturated" => {
    if (state.divergentGroups > 0) {
      return "divergent";
    }
    return state.saturatedGroupsLive > 0 ? "saturated" : "confirmed";
  };

  const observePrefix = (stable: boolean): void => {
    const outcome = prefixState();
    state.prefixes.total += 1;
    if (outcome === "divergent") {
      state.prefixes.divergent += 1;
    } else if (outcome === "saturated") {
      state.prefixes.saturated += 1;
    } else {
      state.prefixes.confirmed += 1;
    }
    if (!stable) {
      return;
    }
    state.prefixes.stableTotal += 1;
    if (outcome === "divergent") {
      state.prefixes.stableDivergent += 1;
    } else if (outcome === "saturated") {
      state.prefixes.stableSaturated += 1;
    } else {
      state.prefixes.stableConfirmed += 1;
    }
  };

  const retire = (group: MutableGroup, at: EventLocation): void => {
    // A group can leave with bodies still in it (Sudden Death), so its
    // divergence and saturation counters are cleared here.
    if (group.divergent) {
      state.divergentGroups = Math.max(0, state.divergentGroups - 1);
      group.divergent = false;
    }
    if (group.saturated) {
      state.saturatedGroupsLive = Math.max(0, state.saturatedGroupsLive - 1);
      group.saturated = false;
    }
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
      divergent: false,
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

  /** Values produced by a survival their card's HP cannot allow; `expand` prunes them. */
  const impossibleSurvivals = new WeakSet<MaterialValue>();

  const expand = (
    group: MutableGroup,
    at: EventLocation,
    next: (values: readonly MaterialValue[]) => readonly (readonly MaterialValue[])[],
  ): void => {
    if (group.saturated) {
      return;
    }
    const out = new Map<string, readonly MaterialValue[]>();
    const impossible = new Map<string, readonly MaterialValue[]>();
    outer: for (const values of group.variants.values()) {
      for (const candidate of next(values)) {
        const sorted = sortValues(candidate);
        if (sorted.some((value) => impossibleSurvivals.has(value))) {
          impossible.set(multisetKey(sorted, valueKey), sorted);
          continue;
        }
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
    if (out.size === 0 && impossible.size > 0) {
      diagnose(
        "HpExceeded",
        "warning",
        "every variant has a body surviving more damage than its card's HP",
        at,
        group,
      );
      // Fresh objects, so the kept bodies are not pruned again by later events.
      for (const [key, values] of impossible) {
        out.set(key, values.map((value) => ({ ...value })));
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
      state.saturatedGroupsLive += 1;
      group.everDivergent = true;
      observe(group, at);
      return;
    }
    if (out.size > cap) {
      group.saturated = true;
      state.saturatedGroupsLive += 1;
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
    const next = {
      ...value,
      damage,
      hp: lethal ? value.hp : { ...value.hp, min: Math.max(value.hp.min, damage + 1) },
    };
    // Surviving more damage than the largest printing allows is impossible,
    // unless a non-Energy attachment (a Tool such as Hero's Cape) may add HP.
    // A Stadium's raise counts whatever the body's stage: it only loosens.
    // A body already over its max was reported once; don't prune it again.
    const ceiling = next.hp.max === null ? null : next.hp.max + stadiumRaise();
    if (
      !lethal && ceiling !== null && next.hp.min > ceiling
      && value.hp.min <= ceiling
      && next.attachments.every((attached) => attached.includes("Energy"))
    ) {
      impossibleSurvivals.add(next);
    }
    return next;
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

  let stadium: string | null = null;
  let raisedBenchLeftAt: number | null = null;

  const raisedBench = (name: string | null): number | null =>
    name === null ? null : oracle?.stadium?.(name)?.benchLimit ?? null;

  /** Both players share the Stadium; an unmet condition on it only loosens the check. */
  const benchLimit = (): number => Math.max(5, raisedBench(stadium) ?? 5);

  /**
   * HP the Stadium may take from a body of this name. An unknown stage counts
   * as reduced, and a Stadium that has left play may linger: both only loosen.
   */
  const hpReduction = (name: string): number => {
    const reduction = stadium === null ? null : oracle?.stadium?.(stadium)?.hpReduction ?? null;
    if (reduction === null) {
      return 0;
    }
    const printings = oracle?.printings(name) ?? null;
    return printings === null || printings.some((printing) => printing.stage === null || printing.stage === reduction.stage)
      ? reduction.amount
      : 0;
  };

  const stadiumRaise = (): number =>
    stadium === null ? 0 : oracle?.stadium?.(stadium)?.hpRaise?.amount ?? 0;

  const setStadium = (name: string, at: EventLocation): void => {
    if (raisedBench(stadium) !== null) {
      raisedBenchLeftAt = at.phaseIndex;
    }
    stadium = name;
  };

  /** Sudden Death starts a new game: an empty board and hand, and one Prize card each. */
  const suddenDeath = (at: EventLocation): void => {
    for (const group of [...state.groups.values()]) {
      retire(group, at);
    }
    for (const side of ["self", "opponent"] as const) {
      state.hand[side] = { count: 0, known: [] };
      state.prizes[side] = { known: [], remaining: 1 };
    }
    stadium = null;
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
    zone: "active" | "bench" | null = null,
  ): void => {
    const group = resolveGroup(target, "damage", at);
    if (group === null) {
      return;
    }
    damageResolved(group, target, amount, lethal, at, zone);
  };

  /**
   * Place counters from a line that does not name the target's owner.
   *
   * One side only: elimination, as `resolveGroup` does. Both sides: each group
   * forks into "received" and "did not", because the line cannot say which.
   * The groups are independent, so the fork loses the "exactly one" link; later
   * evidence (a heal larger than the damage left) prunes each side on its own.
   */
  const placeCounters = (
    target: CardRef,
    amount: number,
    lethal: (side: Side) => boolean,
    at: EventLocation,
  ): void => {
    const printed = state.groups.get(keyOf(target.side, target.name));
    const other = state.groups.get(keyOf(otherSide(target.side), target.name));
    if (printed === undefined || other === undefined) {
      const group = resolveGroup(target, "placed counters", at);
      if (group !== null) {
        damageResolved(group, target, amount, lethal(group.side), at, null);
      }
      return;
    }
    diagnose(
      "SideAmbiguous",
      "warning",
      `placed counters name ${target.name}, which is on both sides; the line does not name the target's owner, so both sides carry the fork`,
      at,
      printed,
    );
    for (const group of [printed, other]) {
      const hit = lethal(group.side);
      expand(group, at, (values) => [
        values,
        ...values.map((value, index) => [
          ...values.slice(0, index),
          damageValue(value, amount, hit),
          ...values.slice(index + 1),
        ]),
      ]);
    }
  };

  /**
   * Remove counters named by a line that does not name the card's owner.
   *
   * The counters must have been on the card, so a side whose group has no body
   * carrying them is eliminated. Both sides viable: each forks into "lost them"
   * and "did not". Neither viable: the printed side reports the overflow.
   */
  const removeCounters = (
    target: CardRef,
    amount: number,
    at: EventLocation,
    what: string,
  ): void => {
    const printed = state.groups.get(keyOf(target.side, target.name));
    const other = state.groups.get(keyOf(otherSide(target.side), target.name));
    if (printed === undefined || other === undefined) {
      const group = resolveGroup(target, what, at);
      if (group !== null) {
        subtractDamage(group, at, amount, target.name, what);
      }
      return;
    }
    const carries = (value: MaterialValue): boolean => value.damage >= amount;
    const viable = [printed, other].filter((group) => hasMatch(group, carries));
    const only = viable.length === 1 ? viable[0] : undefined;
    if (only !== undefined) {
      if (only === other) {
        diagnose(
          "SideMismatch",
          "warning",
          `${what} names ${target.side}'s ${target.name}; only ${only.side}'s carries the counters`,
          at,
          only,
        );
      }
      subtractDamage(only, at, amount, target.name, what);
      return;
    }
    diagnose(
      "SideAmbiguous",
      "warning",
      `${what} names ${target.name}, which is on both sides; the line does not name the owner`,
      at,
      printed,
    );
    if (viable.length === 0) {
      subtractDamage(printed, at, amount, target.name, what);
      return;
    }
    for (const group of viable) {
      expand(group, at, (values) => [
        values,
        ...values.flatMap((value, index) =>
          carries(value)
            ? [[
              ...values.slice(0, index),
              { ...value, damage: value.damage - amount },
              ...values.slice(index + 1),
            ]]
            : []),
      ]);
    }
  };

  /**
   * Both ends of an owner-unnamed move are one name, so the counters may stay
   * on a side or cross between sides. Every placement the board can carry is
   * kept: one fits, it applies; several fit, each group forks over every
   * outcome it has in any of them, including "untouched".
   */
  const sameNameMove = (
    ref: CardRef,
    amount: number,
    at: EventLocation,
    index: number,
  ): void => {
    const carries = (value: MaterialValue): boolean => value.damage >= amount;
    const groupOn = (side: Side): MutableGroup | undefined => state.groups.get(keyOf(side, ref.name));
    const within = (group: MutableGroup | undefined): boolean =>
      group !== undefined && [...group.variants.values()].some((values) =>
        values.length > 1 && values.some(carries));
    const sides: readonly Side[] = [ref.side, otherSide(ref.side)];
    const placements = sides.flatMap((source) => sides.flatMap((target) => {
      const from = groupOn(source);
      const fits = source === target
        ? within(from)
        : from !== undefined && hasMatch(from, carries) && groupOn(target) !== undefined;
      return fits ? [{ source, target }] : [];
    }));
    const only = placements.length === 1 ? placements[0] : undefined;
    if (placements.length === 0 || (only !== undefined && only.source === only.target)) {
      const side = only?.source ?? ref.side;
      if (side !== ref.side) {
        diagnose("SideMismatch", "warning", `moved counters name ${ref.side}'s ${ref.name}; only ${side}'s can carry the move`, at, groupOn(side) ?? null);
      }
      handleMoveCounters({ ...ref, side }, { ...ref, side }, amount, at, index);
      return;
    }
    if (only !== undefined) {
      diagnose("SideMismatch", "warning", `moved counters name ${ref.side}'s ${ref.name} twice; only ${only.source} to ${only.target} can carry the move`, at, groupOn(only.target) ?? null);
      handleMoveCounters({ ...ref, side: only.source }, { ...ref, side: only.target }, amount, at, index);
      return;
    }
    diagnose(
      "SideAmbiguous",
      "warning",
      `moved counters name ${ref.name} twice; the line does not name either owner and the move fits ${String(placements.length)} ways`,
      at,
      groupOn(ref.side) ?? null,
    );
    for (const side of sides) {
      const group = groupOn(side);
      if (group === undefined) {
        continue;
      }
      const lethal = survivalUnproven(events, index, side, ref.name);
      const roles = placements.map(({ source, target }) =>
        source === side && target === side ? "within" : source === side ? "lose" : target === side ? "gain" : "untouched");
      expand(group, at, (values) => roles.flatMap((role) => {
        if (role === "untouched") {
          return [values];
        }
        const nexts: (readonly MaterialValue[])[] = [];
        values.forEach((source, sourceIndex) => {
          if (role === "gain") {
            nexts.push(values.map((value, i) => (i === sourceIndex ? damageValue(value, amount, lethal) : value)));
            return;
          }
          if (!carries(source)) {
            return;
          }
          const lost = values.map((value, i) => (i === sourceIndex ? { ...value, damage: value.damage - amount } : value));
          if (role === "lose") {
            nexts.push(lost);
            return;
          }
          values.forEach((_target, targetIndex) => {
            if (targetIndex !== sourceIndex) {
              nexts.push(lost.map((value, i) => (i === targetIndex ? damageValue(value, amount, lethal) : value)));
            }
          });
        });
        return nexts;
      }));
    }
  };

  /**
   * Apply one effect step's k owner-unnamed counter lines on one name: each
   * lands on a different body. The printed side is the effect owner's, so the
   * lines split between the sides: each group forks over every count it could
   * have taken, each count over every choice of distinct bodies.
   */
  const placeDistinct = (batch: readonly CounterDamageEvent[], index: number): void => {
    const [first] = batch;
    if (first === undefined) {
      return;
    }
    const { at, damage: amount, target } = first;
    const sides: readonly Side[] = [target.side, otherSide(target.side)];
    const groups = sides.flatMap((side) => {
      const group = state.groups.get(keyOf(side, target.name));
      return group === undefined ? [] : [group];
    });
    const capacity = (group: MutableGroup): number =>
      Math.max(0, ...[...group.variants.values()].map((values) => values.length));
    const total = groups.reduce((sum, group) => sum + capacity(group), 0);
    if (groups.length === 0 || total < batch.length) {
      // More lines than bodies: the one-per-body reading fails; fall back.
      for (const line of batch) {
        placeCounters(line.target, line.damage, (side) => survivalUnproven(events, index, side, line.target.name), line.at);
      }
      return;
    }
    if (groups.length > 1) {
      diagnose(
        "SideAmbiguous",
        "warning",
        `${String(batch.length)} counter lines name ${target.name}, which is on both sides; the lines do not name the owners`,
        at,
        groups[0] ?? null,
      );
    }
    for (const group of groups) {
      const others = total - capacity(group);
      const least = Math.max(0, batch.length - others);
      const most = Math.min(batch.length, capacity(group));
      const lethal = survivalUnproven(events, index + batch.length - 1, group.side, target.name);
      expand(group, at, (values) => {
        const nexts: (readonly MaterialValue[])[] = [];
        const pick = (start: number, left: number, current: readonly MaterialValue[]): void => {
          if (left === 0) {
            nexts.push(current);
            return;
          }
          for (let body = start; body <= current.length - left; body += 1) {
            const hit = current[body];
            if (hit !== undefined) {
              pick(body + 1, left - 1, current.map((value, i) => (i === body ? damageValue(hit, amount, lethal) : value)));
            }
          }
        };
        for (let count = least; count <= Math.min(most, values.length); count += 1) {
          pick(0, count, values);
        }
        return nexts;
      });
    }
  };

  /**
   * The counter spread of the effect printed just before a run, if the card
   * data states one. Every printing of the actor that has the effect must agree.
   */
  const spreadOf = (
    cause: GameEvent | undefined,
    line: CounterDamageEvent,
  ): SpreadCause | null => {
    if (oracle === undefined || cause === undefined || cause.at.phaseIndex !== line.at.phaseIndex) {
      return null;
    }
    const source = cause.kind === "attack" || cause.kind === "damage" ? cause.source : null;
    const effect = cause.kind === "attack" || cause.kind === "damage" ? cause.attack : null;
    if (source === null || effect === null) {
      return null;
    }
    const spreads = (oracle.printings(source.name) ?? []).flatMap((printing) =>
      [...printing.attacks, ...(printing.abilities ?? [])]
        .filter((candidate) => candidate.name === effect)
        .map((candidate) => candidate.spread));
    const [first] = spreads;
    if (first === undefined || first === null || spreads.some((spread) => JSON.stringify(spread) !== JSON.stringify(first))) {
      return null;
    }
    return { actor: source, spread: first };
  };

  /** `true`/`false` only when every printing of the name agrees. */
  const hasAbility = (name: string): boolean | null => {
    const printings = oracle?.printings(name) ?? null;
    if (printings === null || printings.length === 0) {
      return null;
    }
    const has = printings.map((printing) => (printing.abilities === null ? null : printing.abilities.length > 0));
    if (has.every((value) => value === true)) {
      return true;
    }
    return has.every((value) => value === false) ? false : null;
  };

  const departedBy = new Set<number>();

  /**
   * A discard after "played a card." while a Stadium raises the Bench limit, or
   * in the phase it left, is the Bench being cut back to size: the player picks
   * Bench Pokémon to discard. Returns the discarded group, or `null` when the
   * move is not such a discard.
   */
  const benchTrimOf = (event: MoveCardEvent, index: number): MutableGroup | null => {
    if (event.to !== "discard") {
      return null;
    }
    if (raisedBench(stadium) === null && raisedBenchLeftAt !== event.at.phaseIndex) {
      return null;
    }
    let causeIndex = index - 1;
    let cause = events[causeIndex];
    while (cause?.kind === "moveCard" && cause.to === "discard" && cause.at.phaseIndex === event.at.phaseIndex) {
      causeIndex -= 1;
      cause = events[causeIndex];
    }
    if (cause?.kind !== "hiddenPlay" || cause.at.phaseIndex !== event.at.phaseIndex) {
      return null;
    }
    const group = state.groups.get(keyOf(event.card.side, event.card.name));
    return group !== undefined && hasMatch(group, (value) => value.zone === "bench") ? group : null;
  };

  /**
   * Hold a trimmed Bench body open like a knockout, so its discard lines can say
   * which one left. A second trim of the same name widens the same entry, since
   * every name is printed before any discard line.
   */
  const trimBench = (group: MutableGroup, at: EventLocation): void => {
    const earlier = state.pending.get(group.key);
    if (earlier !== undefined && !earlier.trim) {
      commitKnockout(earlier);
      state.pending.delete(group.key);
    }
    const before = earlier?.trim === true
      ? earlier.options
      : [...group.variants.values()].map((remaining) => ({ remaining, removed: [] }));
    const options = new Map<string, KnockoutOption>();
    for (const option of before) {
      option.remaining.forEach((value, position) => {
        if (value.zone !== "bench") {
          return;
        }
        const remaining = [...option.remaining.slice(0, position), ...option.remaining.slice(position + 1)];
        const removed = [...option.removed, value];
        options.set(`${multisetKey(remaining, valueKey)}\u0003${multisetKey(removed, valueKey)}`, { remaining, removed });
      });
    }
    if (options.size === 0) {
      return;
    }
    state.pending.set(group.key, { at: earlier?.trim === true ? earlier.at : at, group, options: [...options.values()], trim: true });
  };

  /**
   * "moved A to the Bench" then "moved B to the discard pile" under a Trainer
   * whose text replaces a Pokémon in play is A taking B's place: B's zone and
   * attached cards carry over. The client prints "Bench" whatever B's zone was,
   * and prints any damage counters that carry over as their own line.
   */
  const replaceInPlay = (event: MoveCardEvent, index: number): boolean => {
    const outgoing = events[index + 1];
    if (
      oracle?.trainer === undefined
      || (event.to !== "bench" && event.to !== "active")
      || outgoing?.kind !== "moveCard"
      || outgoing.to !== "discard"
      || outgoing.card.side !== event.card.side
      || outgoing.at.phaseIndex !== event.at.phaseIndex
    ) {
      return false;
    }
    let causeIndex = index - 1;
    let cause = events[causeIndex];
    while (cause?.kind === "moveCard" && cause.to === "discard") {
      causeIndex -= 1;
      cause = events[causeIndex];
    }
    if (
      cause?.kind !== "play"
      || cause.zone !== null
      || cause.card.side !== event.card.side
      || cause.at.phaseIndex !== event.at.phaseIndex
      || oracle.trainer(cause.card.name)?.replacesInPlay !== true
    ) {
      return false;
    }
    const group = state.groups.get(keyOf(outgoing.card.side, outgoing.card.name));
    if (group === undefined) {
      return false;
    }
    const wasActive = group.id === state.active[group.side];
    const removed = removeAny(group, event.at, () => true);
    if (removed.length === 0) {
      return false;
    }
    const choices = new Map<string, MaterialValue>();
    for (const value of removed) {
      const incoming = makeValue(value.zone, initialHp(event.card.name), 0, value.attachments);
      choices.set(valueKey(incoming), incoming);
    }
    const destination = place(event.card.side, event.card.name, [...choices.values()], event.at);
    if (wasActive) {
      const states = activeStates(group);
      if (states.length > 0 && states.every((hasActive) => !hasActive)) {
        state.active[group.side] = destination.id;
      } else if (!states.every(Boolean)) {
        state.active[group.side] = null;
      }
    }
    return true;
  };

  /**
   * A move of X to hand or deck right after X's own effect (a bare "played X",
   * or X's attack or Ability) is X leaving play, when the card text says that
   * effect returns X with its attached cards there. Remove one body; without
   * the text the move stays a hidden-zone move with no source.
   */
  const leavePlay = (event: MoveCardEvent, index: number): void => {
    if (oracle === undefined || (event.to !== "hand" && event.to !== "deck")) {
      return;
    }
    let causeIndex = index - 1;
    let cause = events[causeIndex];
    while (cause !== undefined && (cause.kind === "draw" || cause.kind === "moveCard")) {
      causeIndex -= 1;
      cause = events[causeIndex];
    }
    if (cause === undefined || departedBy.has(causeIndex) || cause.at.phaseIndex !== event.at.phaseIndex) {
      return;
    }
    let actor: CardRef | null = null;
    let effect: string | null = null;
    if (cause.kind === "play" && cause.zone === null) {
      actor = cause.card;
    } else if (cause.kind === "attack" || cause.kind === "damage") {
      actor = cause.source;
      effect = cause.attack;
    }
    if (actor?.side !== event.card.side || actor.name !== event.card.name) {
      return;
    }
    const group = state.groups.get(keyOf(actor.side, actor.name));
    if (group === undefined) {
      return;
    }
    const effects = (oracle.printings(actor.name) ?? []).flatMap((printing) => [
      ...printing.attacks.map((attack) => ({ isAttack: true, name: attack.name, to: attack.leavesPlay })),
      ...(printing.abilities ?? []).map((ability) => ({ isAttack: false, name: ability.name, to: ability.leavesPlay })),
    ]).filter((candidate) => effect === null || candidate.name === effect);
    // A named effect must return the card on every printing; a bare "played X"
    // names no effect, so any of X's effects that returns it will do. Attacks
    // count: the client prints Meowth ex's Tuck Tail as "played Meowth ex".
    const returning = effects.filter((candidate) => candidate.to === event.to);
    if (returning.length === 0 || (effect !== null && returning.length !== effects.length)) {
      return;
    }
    departedBy.add(causeIndex);
    const onlyActive = returning.every((candidate) => candidate.isAttack);
    removeAny(group, event.at, (value) => !onlyActive || value.zone === "active");
    if (group.id === state.active[group.side]) {
      const states = activeStates(group);
      if (states.length === 0 || !states.every(Boolean)) {
        state.active[group.side] = null;
      }
    }
  };

  /**
   * Apply a run of counter lines through the scope of the effect that printed
   * them, centred on the acting card. The printed side is the actor's owner,
   * so the scope, not the line, picks the side. `each` marks every qualifying
   * body once, and a qualifying body left unmarked kills its world; `choice`
   * puts each line on a different body the effect can reach. Returns `false`
   * when the run does not fit the scope, leaving the lines to the generic path.
   */
  const placeSpread = (
    run: readonly CounterDamageEvent[],
    cause: SpreadCause,
    start: number,
  ): boolean => {
    const { spread } = cause;
    const actor = cause.actor.side;
    const [first] = run;
    if (first === undefined) {
      return false;
    }
    const at = first.at;
    const last = start + run.length - 1;
    const sides: readonly Side[] = spread.sides === "both"
      ? [actor, otherSide(actor)]
      : [spread.sides === "self" ? actor : otherSide(actor)];
    const reaches = (value: MaterialValue): boolean => !spread.benchOnly || value.zone === "bench";
    const groupsOf = (name: string): readonly MutableGroup[] => sides.flatMap((side) => {
      const group = state.groups.get(keyOf(side, name));
      return group === undefined ? [] : [group];
    });
    const reachable = (group: MutableGroup): ReadonlySet<number> =>
      new Set([...group.variants.values()].map((values) => values.filter(reaches).length));
    const mismatch = (why: string): boolean => {
      diagnose("SpreadMismatch", "warning", `${why}; placing the lines without the effect's scope`, at, null);
      return false;
    };

    // A Checkup trigger resolves once per body of the actor, under one printed
    // "used" line, so the run is that many resolutions back to back.
    const resolutions = at.turn === null
      ? Math.max(1, state.groups.get(keyOf(actor, cause.actor.name))?.members ?? 1)
      : 1;
    const byName = new Map<string, CounterDamageEvent[]>();
    for (const line of run) {
      byName.set(line.target.name, [...(byName.get(line.target.name) ?? []), line]);
    }
    // "Damage to X was prevented" right after the run: the step reached X too.
    const prevented = new Map<string, number>();
    for (let next = last + 1; ; next += 1) {
      const line = events[next];
      if (line?.kind !== "prevented" || line.at.phaseIndex !== at.phaseIndex) {
        break;
      }
      prevented.set(line.name, (prevented.get(line.name) ?? 0) + 1);
    }
    const marked = new Set([...byName.keys(), ...prevented.keys()]);
    const total = run.reduce((sum, line) => sum + line.counters, 0);
    const wrongTotal = prevented.size > 0 ? total > spread.counters : total !== spread.counters;
    if (spread.placement === "each" ? run.some((line) => line.counters !== spread.counters) : wrongTotal) {
      return mismatch(`the lines put ${String(total)} counters, which the effect does not`);
    }
    // Sums of reachable bodies the name's groups can show together.
    const sums = (groups: readonly MutableGroup[]): ReadonlySet<number> =>
      groups.reduce<ReadonlySet<number>>(
        (acc, group) => new Set([...acc].flatMap((sum) => [...reachable(group)].map((count) => sum + count))),
        new Set([0]),
      );
    const hits = (name: string): number => byName.get(name)?.length ?? 0;
    const bodiesOf = (name: string): number => (hits(name) + (prevented.get(name) ?? 0)) / resolutions;
    for (const [name, lines] of byName) {
      if (name === spread.except || (spread.requiresAbility && hasAbility(name) === false)) {
        return mismatch(`${name} does not qualify for the effect`);
      }
      const groups = groupsOf(name);
      const fits = spread.placement === "each"
        ? lines.length % resolutions === 0 && Number.isInteger(bodiesOf(name)) && sums(groups).has(bodiesOf(name))
        : groups.length === 1 && [...reachable(groups[0] as MutableGroup)].some((count) => count >= lines.length);
      if (!fits) {
        return mismatch(`${String(lines.length)} lines name ${name}, which no reachable board explains`);
      }
    }

    for (const [name, lines] of byName) {
      const groups = groupsOf(name);
      for (const group of groups) {
        const lethal = survivalUnproven(events, last, group.side, name);
        if (spread.placement === "each") {
          const otherGroups = groups.filter((other) => other !== group);
          const others = sums(otherGroups);
          const otherMost = otherGroups.reduce((sum, other) => sum + Math.max(0, ...reachable(other)), 0);
          const amount = first.damage * resolutions;
          const damaged = lines.length / resolutions;
          const spared = bodiesOf(name) - damaged;
          expand(group, at, (values) => {
            const count = values.filter(reaches).length;
            if (![...others].some((other) => other + count === bodiesOf(name))) {
              return [];
            }
            // Every reachable body was marked; choose which took counters.
            const nexts: (readonly MaterialValue[])[] = [];
            const pick = (start: number, left: number, current: readonly MaterialValue[]): void => {
              const free = current.slice(start).filter(reaches).length;
              if (left === 0) {
                nexts.push(current);
                return;
              }
              if (free < left) {
                return;
              }
              current.forEach((value, body) => {
                if (body >= start && reaches(value)) {
                  pick(body + 1, left - 1, current.map((v, i) => (i === body ? damageValue(value, amount, lethal) : v)));
                }
              });
            };
            const least = Math.max(0, damaged - otherMost, count - spared);
            for (let take = least; take <= Math.min(count, damaged); take += 1) {
              pick(0, take, values);
            }
            return nexts;
          });
          continue;
        }
        const amounts = lines.map((line) => line.damage);
        expand(group, at, (values) => {
          const nexts: (readonly MaterialValue[])[] = [];
          const assign = (next: number, current: readonly MaterialValue[], used: ReadonlySet<number>): void => {
            const amount = amounts[next];
            if (amount === undefined) {
              nexts.push(current);
              return;
            }
            current.forEach((value, body) => {
              if (!used.has(body) && reaches(value)) {
                assign(next + 1, current.map((v, i) => (i === body ? damageValue(value, amount, lethal) : v)), new Set([...used, body]));
              }
            });
          };
          assign(0, values, new Set());
          return nexts;
        });
      }
    }

    if (spread.placement === "each") {
      for (const group of state.groups.values()) {
        const qualifies = group.live && group.members > 0 && sides.includes(group.side) && !marked.has(group.name)
          && group.name !== spread.except && (!spread.requiresAbility || hasAbility(group.name) === true);
        if (!qualifies) {
          continue;
        }
        if (!reachable(group).has(0)) {
          diagnose("SpreadUnmarked", "warning", `${group.name} qualifies for the effect but no line marks it`, at, group);
          continue;
        }
        expand(group, at, (values) => (values.some(reaches) ? [] : [values]));
      }
    }
    return true;
  };

  /** Move counters named by a line that does not name either owner. */
  const moveUnprinted = (
    from: CardRef,
    to: CardRef,
    amount: number,
    at: EventLocation,
    index: number,
  ): void => {
    if (from.name === to.name) {
      sameNameMove(from, amount, at, index);
      return;
    }
    removeCounters(from, amount, at, `moving ${String(amount)} damage from ${from.name}`);
    placeCounters(to, amount, (side) => survivalUnproven(events, index, side, to.name), at);
  };

  const damageResolved = (
    group: MutableGroup,
    target: CardRef,
    amount: number,
    lethal: boolean,
    at: EventLocation,
    zone: "active" | "bench" | null,
  ): void => {
    const inZone = (value: MaterialValue): boolean => zone === null || value.zone === zone;
    if (!hasMatch(group, inZone)) {
      diagnose(
        "TargetZoneUnreachable",
        "warning",
        `an attack that can only hit the Active Spot names ${target.name}, which the ledger has on the Bench`,
        at,
        group,
      );
      applyToAny(group, at, (value) => damageValue(value, amount, lethal));
      return;
    }
    replaceOne(group, at, inZone, (value) => damageValue(value, amount, lethal));
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

  /**
   * Whether the latest attack or ability in this phase Knocks Out `target` by
   * its text alone (Terminal Period), including an attack it copied by choice
   * (Seek Inspiration choosing Destined Fight). Text conditions are not checked.
   */
  const effectKnocksOut = (index: number, target: CardRef): boolean => {
    const at = events[index]?.at;
    if (oracle === undefined || at === undefined) {
      return false;
    }
    const chosen: string[] = [];
    for (let back = index - 1; back >= 0; back -= 1) {
      const event = events[back];
      if (event === undefined || event.at.phaseIndex !== at.phaseIndex) {
        return false;
      }
      if (event.kind === "choice") {
        chosen.push(event.option);
      }
      const source = event.kind === "attack" || event.kind === "damage" ? event.source : null;
      const name = event.kind === "attack" || event.kind === "damage" ? event.attack : null;
      if (source === null || name === null) {
        continue;
      }
      const own = (oracle.printings(source.name) ?? [])
        .flatMap((printing) => [...printing.attacks, ...(printing.abilities ?? [])])
        .filter((effect) => effect.name === name);
      const copied = chosen.flatMap((option) => oracle.attack?.(option) ?? []);
      const reach = source.side !== target.side
        ? ["opponent", "both"]
        : source.name === target.name ? ["self", "both"] : [];
      return [...own, ...copied].some((effect) => effect.knocksOut !== null && reach.includes(effect.knocksOut));
    }
    return false;
  };

  /** A bare "played X" naming the Active Pokémon is the export's print of X's attack (Tuck Tail). */
  const bareAttack = (event: GameEvent | undefined): CardRef | null => {
    if (event?.kind !== "play" || event.zone !== null) {
      return null;
    }
    const group = state.groups.get(keyOf(event.card.side, event.card.name));
    return group?.live === true && state.active[event.card.side] === group.id ? event.card : null;
  };

  /**
   * The Pokémon whose attack or effect `index` follows in its phase, and
   * whether the log printed damage for it: a named attack, or any damage or
   * counter line after a bare one.
   */
  const attackerBefore = (index: number): { card: CardRef; printed: boolean } | null => {
    const at = events[index]?.at;
    let damaged = false;
    for (let back = index - 1; back >= 0; back -= 1) {
      const event = events[back];
      if (event === undefined || at === undefined || event.at.phaseIndex !== at.phaseIndex) {
        return null;
      }
      if ((event.kind === "attack" || event.kind === "damage") && event.source !== null) {
        return { card: event.source, printed: true };
      }
      if (event.kind === "damage" || event.kind === "counterDamage") {
        damaged = true;
      }
      const bare = bareAttack(event);
      if (bare !== null) {
        return { card: bare, printed: damaged };
      }
    }
    return null;
  };

  /**
   * Whether `target` attacked a Pokémon Knocked Out earlier in this phase whose
   * text Knocks Out the Attacking Pokémon (Fainting Spell). Conditions are not checked.
   */
  const answersKnockout = (index: number, target: CardRef): boolean => {
    const at = events[index]?.at;
    if (oracle === undefined || at === undefined) {
      return false;
    }
    for (let back = index - 1; back >= 0; back -= 1) {
      const event = events[back];
      if (event === undefined || event.at.phaseIndex !== at.phaseIndex) {
        return false;
      }
      if (event.kind !== "knockout" || event.target.side === target.side) {
        continue;
      }
      const answers = (oracle.printings(event.target.name) ?? [])
        .flatMap((printing) => [...printing.attacks, ...(printing.abilities ?? [])])
        .some((effect) => effect.knocksOut === "attacker");
      const attacker = attackerBefore(back)?.card;
      if (answers && attacker?.side === target.side && attacker.name === target.name) {
        return true;
      }
    }
    return false;
  };

  /** Whether `target`'s knockout follows an opposing attack the export printed without its damage. */
  const unprintedDamage = (index: number, target: CardRef): boolean => {
    const attacker = attackerBefore(index);
    return attacker !== null && !attacker.printed && attacker.card.side !== target.side;
  };

  const startKnockout = (target: CardRef, at: EventLocation, index: number): void => {
    const group = resolveGroup(target, "knockout", at);
    if (group === null) {
      return;
    }

    // The Stadium's reduction may not apply (unknown stage, a Stadium that has
    // left play), so it only widens the candidates and never narrows them.
    const reduction = hpReduction(target.name);
    const lethal = (value: MaterialValue): boolean => value.damage >= value.hp.min - reduction;
    const lethalAtPrintedHp = (value: MaterialValue): boolean => value.damage >= value.hp.min;

    // Any body that damage could have knocked out is a candidate, in any zone;
    // later lines such as the discard list prune the rest. With none, every
    // body stays a candidate and the knockout is reported unproven below.
    const options = new Map<string, KnockoutOption>();
    for (const values of group.variants.values()) {
      const indices = values.some(lethalAtPrintedHp)
        ? values.flatMap((value, index) => (lethal(value) ? [index] : []))
        : values.map((_value, index) => index);
      for (const index of indices) {
        const removed = values[index];
        if (removed === undefined) {
          continue;
        }
        const remaining = [...values.slice(0, index), ...values.slice(index + 1)];
        const option = { remaining, removed: [removed] };
        options.set(`${multisetKey(remaining, valueKey)}\u0003${valueKey(removed)}`, option);
      }
    }

    state.pending.set(group.key, { at, group, options: [...options.values()], trim: false });

    const lethalOptions = [...options.values()].filter((option) =>
      option.removed.every(lethal));
    if (
      lethalOptions.length === 0
      && !actedLast(events, index, target)
      && !effectKnocksOut(index, target)
      && !answersKnockout(index, target)
      && !unprintedDamage(index, target)
    ) {
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
    group.members -= options[0]?.removed.length ?? 1;
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
      if (zone === "bench" && minBench(card.side) >= benchLimit()) {
        // The game does not allow a sixth Bench Pokémon, so either the log is
        // wrong or the ledger over-counted a earlier departure. A move to a
        // hidden zone has no source, so the ledger deliberately keeps bodies
        // there; report the symptom and place the body rather than inventing a
        // departure to make room. The census can only over-report.
        diagnose(
          "BenchOverflow",
          "warning",
          `a Pokémon was played to ${card.name}'s full Bench`,
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
    if (zone === "stadium") {
      setStadium(card.name, at);
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
      if (to === "bench" && minBench(card.side) >= benchLimit()) {
        diagnose("BenchOverflow", "warning", `a Pokémon moved to ${card.name}'s full Bench`, at, group);
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
      setStadium(card.name, at);
      return;
    }
    // A discard naming the Stadium may be another copy from the hand (Ultra
    // Ball), so only a new Stadium proves the old one left.
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

  /**
   * What the rest of one side's Bench could add to a pooled discard line: per
   * card, the most any variant of each other group holds on Benched bodies.
   */
  const benchSupply = (side: Side, except: MutableGroup): ReadonlyMap<string, number> => {
    const supply = new Map<string, number>();
    for (const group of state.groups.values()) {
      if (group === except || group.side !== side) {
        continue;
      }
      const most = new Map<string, number>();
      for (const values of group.variants.values()) {
        const here = new Map<string, number>();
        for (const value of values) {
          if (value.zone === "bench") {
            for (const card of pileOf(value)) {
              here.set(card, (here.get(card) ?? 0) + 1);
            }
          }
        }
        for (const [card, n] of here) {
          most.set(card, Math.max(most.get(card) ?? 0, n));
        }
      }
      for (const [card, n] of most) {
        supply.set(card, (supply.get(card) ?? 0) + n);
      }
    }
    return supply;
  };

  /**
   * The client folds every attachment leaving one side's Bench in one action
   * into a single line and names only the first body. So a Benched body named
   * on a multi-card line gave a non-empty part of it; the rest came from other
   * Benched bodies on that side.
   */
  const pooledParts = (
    group: MutableGroup,
    value: MaterialValue,
    cards: readonly string[],
  ): readonly (readonly string[])[] => {
    if (cards.length < 2 || value.zone !== "bench") {
      return [];
    }
    const supply = benchSupply(group.side, group);
    return sharedParts(pileOf(value), cards).filter((part) => {
      const rest = new Map<string, number>();
      for (const card of cards) {
        rest.set(card, (rest.get(card) ?? 0) + 1);
      }
      for (const card of part) {
        rest.set(card, (rest.get(card) ?? 0) - 1);
      }
      return [...rest].every(([card, n]) => n <= (supply.get(card) ?? 0));
    });
  };

  const canTake = (group: MutableGroup, cards: readonly string[]): boolean =>
    hasMatch(group, (value) => containsAll(pileOf(value), cards) || pooledParts(group, value, cards).length > 0);

  /**
   * The line names the acting player, not the body's owner, so a Crushing
   * Hammer prints its target under the wrong side. Cross over only when the
   * printed side cannot hold the cards and the other side can.
   */
  const detachGroup = (body: CardRef, cards: readonly string[], at: EventLocation): MutableGroup | null => {
    const direct = state.groups.get(keyOf(body.side, body.name));
    const opposite = state.groups.get(keyOf(otherSide(body.side), body.name));
    if (
      direct !== undefined
      && opposite !== undefined
      && cards.length > 0
      && !state.pending.has(direct.key)
      && !state.pending.has(opposite.key)
      && !canTake(direct, cards)
      && canTake(opposite, cards)
    ) {
      diagnose(
        "SideMismatch",
        "warning",
        `a discard names ${body.side}'s ${body.name}, but only ${otherSide(body.side)}'s can hold the cards`,
        at,
        opposite,
      );
      return opposite;
    }
    return resolveGroup(body, "a discard", at);
  };

  const handleDetach = (
    body: CardRef,
    cards: readonly string[],
    count: number,
    at: EventLocation,
  ): void => {
    const group = detachGroup(body, cards, at);
    if (group === null) {
      return;
    }
    const pending = state.pending.get(group.key);
    if (pending !== undefined) {
      if (cards.length > 0) {
        // Exact pile first: D14's strongest evidence. Only when no body's pile
        // matches exactly do we accept a superset, because the ledger may have
        // missed an attachment rather than the log being wrong. A trim's line
        // pools every trimmed body, so last it may hold their joint pile.
        const joint = (option: KnockoutOption): readonly string[] => option.removed.flatMap(pileOf);
        const exact = pending.options.filter((option) =>
          option.removed.some((value) => sameMultiset(pileOf(value), cards)));
        const superset = pending.options.filter((option) =>
          option.removed.some((value) => containsAll(pileOf(value), cards)));
        const pooled = pending.trim
          ? pending.options.filter((option) => joint(option).length > 0 && containsAll(cards, joint(option)))
          : [];
        const filtered = exact.length > 0 ? exact : superset.length > 0 ? superset : pooled;
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
      if (hasMatch(group, matches)) {
        replaceOne(group, at, matches, (value) => removeFromPile(value, cards));
        return;
      }
      if (hasMatch(group, (value) => pooledParts(group, value, cards).length > 0)) {
        expand(group, at, (values) =>
          values.flatMap((value, index) =>
            pooledParts(group, value, cards).map((part) => [
              ...values.slice(0, index),
              removeFromPile(value, part),
              ...values.slice(index + 1),
            ])));
        return;
      }
      diagnose(
        "AttachmentMismatch",
        "warning",
        `the discard list for ${body.name} matches no body in the group`,
        at,
        group,
      );
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
        const lethal = survivalUnproven(events, index, to.side, to.name);
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
    const lethal = survivalUnproven(events, index, to.side, to.name);
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

  const counterBatches = counterRuns(events, moved);
  const spreadRuns = new Map(
    [...counterRunStarts(events, moved)].flatMap(([start, run]) => {
      const [line] = run;
      const cause = line === undefined ? null : spreadOf(events[start - 1], line);
      return cause === null ? [] : [[start, { cause, run }] as const];
    }),
  );
  const spreadLines = new Set<GameEvent>();
  const batchedLines = new Set<GameEvent>(
    [...counterBatches.values()].flatMap((batch) => (batch.length > 1 && sameDamage(batch) ? batch : [])),
  );

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
        observePrefix(false);
        return;
      }
    }
    if (event.kind === "moveCard") {
      // Every discard in a Bench trim stays open until its detach lines arrive.
      const trimmed = benchTrimOf(event, index);
      if (trimmed !== null) {
        trimBench(trimmed, at);
        observePrefix(false);
        return;
      }
    }
    commitAllKnockouts();

    switch (event.kind) {
      case "attach":
        attachTo(event.target, event.card, event.zone, at);
        break;
      case "counterDamage": {
        if (spreadLines.has(event)) {
          break;
        }
        const scoped = spreadRuns.get(index);
        if (scoped !== undefined && placeSpread(scoped.run, scoped.cause, index)) {
          scoped.run.forEach((line) => spreadLines.add(line));
          break;
        }
        if (batchedLines.has(event)) {
          const batch = counterBatches.get(index);
          if (batch !== undefined) {
            placeDistinct(batch, index);
          }
          break;
        }
        if (event.ownerPrinted) {
          damageGroup(
            event.target,
            event.damage,
            survivalUnproven(events, index, event.target.side, event.target.name),
            at,
          );
        } else {
          placeCounters(
            event.target,
            event.damage,
            (side) => survivalUnproven(events, index, side, event.target.name),
            at,
          );
        }
        break;
      }
      case "damage":
        damageGroup(
          event.target,
          event.amount,
          survivalUnproven(events, index, event.target.side, event.target.name),
          at,
          targetZone(event.source, event.attack),
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
        startKnockout(event.target, at, index);
        break;
      case "endGame":
      case "endTurn":
      case "attack":
      case "choice":
        break;
      case "suddenDeath":
        suddenDeath(at);
        break;
      case "heal":
        if (event.ownerPrinted) {
          healGroup(event.target, event.damage, at);
        } else {
          removeCounters(event.target, event.damage, at, `healing ${String(event.damage)}`);
        }
        break;
      case "moveCard":
        if (replaceInPlay(event, index)) {
          break;
        }
        moveCard(event.card, event.to, at);
        leavePlay(event, index);
        break;
      case "moveCounters":
        if (event.ownerPrinted) {
          handleMoveCounters(event.from, event.to, event.damage, at, index);
        } else {
          moveUnprinted(event.from, event.to, event.damage, at, index);
        }
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
    observePrefix(event.kind === "endTurn" || event.kind === "endGame");
  });

  commitAllKnockouts();

  const snapshot = (group: MutableGroup): LedgerGroupSnapshot => {
    const hp = new Map<string, HpInterval>();
    const zones = new Map<string, { readonly active: number; readonly bench: number }>();
    const variants = [...group.variants.values()];
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
    const varying: ("zone" | "damage" | "attachments" | "under")[] = [];
    for (const dimension of ["zone", "damage", "attachments", "under"] as const) {
      const shapes = new Set(
        variants.map((values) =>
          values.map((value) => JSON.stringify(value[dimension])).sort().join("|")),
      );
      if (shapes.size > 1) {
        varying.push(dimension);
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
      varying,
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
    prefixes: { ...state.prefixes },
    saturated: groups.some((group) => group.saturated),
    unexecutable,
  };
};
