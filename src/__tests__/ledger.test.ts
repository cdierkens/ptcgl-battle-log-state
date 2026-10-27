import { readFileSync } from "node:fs";

import { parseBattleLog } from "@dierkens.dev/ptcgl-battle-log-parser";
import { describe, expect, it } from "vitest";

import type { CardRef, EventLocation, GameEvent } from "../events.js";
import { census } from "../census.js";
import { runLedger } from "../ledger.js";
import { lower } from "../lowering.js";
import { unwrap } from "../result.js";
import type { Side } from "../types.js";

const FIXTURES = [
  "dipplin-vs-mega-excadrill",
  "slowking-vs-beedrill",
  "slowking-vs-froslass-mill",
  "slowking-vs-greninja",
] as const;

const LOCAL_PLAYER = "cdierkens";

const readFixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}.log`, import.meta.url), "utf8");

const parseAndLower = (raw: string, playerName = LOCAL_PLAYER) => {
  const parsed = unwrap(parseBattleLog(raw, { locale: "en", playerName }));
  return unwrap(lower(parsed, raw));
};

const lowerFixture = (name: string) => parseAndLower(readFixture(name));

const loc = (line: number): EventLocation => ({ line, phaseIndex: 0, turn: 1 });

const card = (side: Side, name: string): CardRef => ({ name, side });

const play = (side: Side, name: string, zone: "active" | "bench", line: number): GameEvent => ({
  at: loc(line),
  card: card(side, name),
  kind: "play",
  zone,
});

const damage = (side: Side, name: string, amount: number, line: number): GameEvent => ({
  amount,
  at: loc(line),
  attack: "Test Attack",
  kind: "damage",
  modifiers: [],
  source: null,
  target: card(side, name),
});

const attach = (
  side: Side,
  target: string,
  energy: string,
  line: number,
  zone: "active" | "bench" | null = null,
): GameEvent => ({
  at: loc(line),
  card: energy,
  kind: "attach",
  target: card(side, target),
  zone,
});

const evolve = (
  side: Side,
  from: string,
  into: string,
  line: number,
  zone: "active" | "bench" | null = null,
): GameEvent => ({
  at: loc(line),
  from: card(side, from),
  into,
  kind: "evolve",
  zone,
});

const knockout = (side: Side, name: string, line: number): GameEvent => ({
  at: loc(line),
  kind: "knockout",
  target: card(side, name),
});

const detach = (
  side: Side,
  name: string,
  cards: readonly string[],
  line: number,
): GameEvent => ({
  at: loc(line),
  body: card(side, name),
  cards,
  count: cards.length,
  kind: "detach",
});

describe("the ledger over the fixtures", () => {
  it.each(FIXTURES)("censors %s without an unexecutable event", (name) => {
    const result = census(lowerFixture(name).events);

    expect(result.unexecutable).toBe(false);
    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    expect(result.everDivergent).toBe(true);
    expect(result.groups.length).toBeGreaterThan(0);
  });

  it("records every Slowpoke in beedrill, including the group that reaches two", () => {
    const lowered = lowerFixture("slowking-vs-beedrill");
    const plays = lowered.events.filter(
      (event) => event.kind === "play" && event.card.name === "Slowpoke" && event.card.side === "self",
    );
    const result = census(lowered.events);
    const slowpokes = result.groups.filter((group) => group.name === "Slowpoke" && group.side === "self");

    // The brief says "Slowpoke x3"; this log actually prints four plays, one of
    // them from an effect's "drew and played" list. They do not all coexist,
    // because earlier copies leave to evolve.
    expect(plays.length).toBeGreaterThanOrEqual(3);
    expect(Math.max(...slowpokes.map((group) => group.maxMembers))).toBeGreaterThanOrEqual(2);
    expect(slowpokes.some((group) => group.everDivergent)).toBe(true);
  });

  it("keeps the froslass worked example as a bare-mode fork", () => {
    const result = census(lowerFixture("slowking-vs-froslass-mill").events);
    const slowpokes = result.groups.filter((group) => group.name === "Slowpoke" && group.side === "self");
    const slowkings = result.groups.filter((group) => group.name === "Slowking" && group.side === "self");

    // Two Slowpokes, one sniped at 30, one evolved at line 122. The fork is
    // real at 122 and card data is what collapses it; bare mode must not.
    expect(slowpokes.some((group) => group.maxMembers >= 2)).toBe(true);
    expect(slowpokes.some((group) => group.everDivergent && (group.firstForkAt?.line ?? Infinity) <= 122))
      .toBe(true);
    expect(slowkings.some((group) => group.maxMembers >= 2 && group.everDivergent)).toBe(true);
    expect(result.neverConfirmed).toBe(true);
  });

  it("follows the Applin to Dipplin chain", () => {
    const result = census(lowerFixture("dipplin-vs-mega-excadrill").events);
    const applin = result.groups.filter((group) => group.name === "Applin" && group.side === "self");
    const dipplin = result.groups.filter((group) => group.name === "Dipplin" && group.side === "self");

    expect(applin.some((group) => group.maxMembers >= 2 && group.everDivergent)).toBe(true);
    expect(dipplin.some((group) => group.maxMembers >= 2 && group.everDivergent)).toBe(true);
    expect(applin.some((group) => (group.firstForkAt?.line ?? Infinity) <= 53)).toBe(true);
    expect(dipplin.some((group) => (group.firstForkAt?.line ?? Infinity) <= 53)).toBe(true);
  });

  it("is deterministic over the fixtures", () => {
    for (const name of FIXTURES) {
      const events = lowerFixture(name).events;
      expect(JSON.stringify(census(events))).toBe(JSON.stringify(census(events)));
    }
  });
});

describe("identity groups", () => {
  it("does not fork when damage lands on one of two identical bodies", () => {
    const result = census([
      play("self", "Kangaskhan", "bench", 1),
      play("self", "Kangaskhan", "bench", 2),
      damage("self", "Kangaskhan", 30, 3),
    ]);

    // {30, 0} is one multiset: the picture is "one of the two has 30", not two
    // pictures. Permutations are never enumerated, which is why both counts are
    // one while the group still has two members.
    expect(result.liveGroups).toHaveLength(1);
    expect(result.liveGroups[0]?.members).toBe(2);
    expect(result.liveGroups[0]?.renderVariants).toBe(1);
    expect(result.liveGroups[0]?.internalVariants).toBe(1);
    expect(result.neverConfirmed).toBe(false);
  });

  it("forks when the two bodies differ and one is Active", () => {
    const result = census([
      play("self", "Kangaskhan", "active", 1),
      play("self", "Kangaskhan", "bench", 2),
      damage("self", "Kangaskhan", 30, 3),
    ]);

    expect(result.neverConfirmed).toBe(true);
    expect(result.liveGroups[0]?.renderVariants).toBeGreaterThan(1);
  });

  it("resolves a knockout with a discard list naming one body's pile", () => {
    const result = census([
      play("self", "Kangaskhan", "bench", 1),
      play("self", "Kangaskhan", "bench", 2),
      attach("self", "Kangaskhan", "Psychic Energy", 3),
      knockout("self", "Kangaskhan", 4),
      detach("self", "Kangaskhan", ["Psychic Energy"], 5),
    ]);

    // The attach is ambiguous, so one world has the Energy on each body. The
    // knockout's discard list names the body that carried it; the survivor is
    // clean and the group collapses to one.
    expect(result.liveGroups).toHaveLength(1);
    expect(result.liveGroups[0]?.members).toBe(1);
    expect(result.liveGroups[0]?.renderVariants).toBe(1);
    expect(result.neverConfirmed).toBe(false);
  });

  it("uses an exact discard list to collapse a two-Energy fork", () => {
    const result = census([
      play("self", "Kangaskhan", "bench", 1),
      play("self", "Kangaskhan", "bench", 2),
      attach("self", "Kangaskhan", "Psychic Energy", 3),
      attach("self", "Kangaskhan", "Psychic Energy", 4),
      knockout("self", "Kangaskhan", 5),
      detach("self", "Kangaskhan", ["Psychic Energy"], 6),
    ]);

    // The two attaches leave either one Energy each or two on one body. A
    // discard list naming exactly one Energy matches the first world only, so
    // the survivor is the body with one Energy and the fork collapses.
    expect(result.liveGroups[0]?.members).toBe(1);
    expect(result.liveGroups[0]?.renderVariants).toBe(1);
    expect(result.everDivergent).toBe(true);
    expect(result.confirmedLate).toBe(true);
  });

  it("swaps two same-name bodies on a switch", () => {
    const result = runLedger([
      play("self", "Kangaskhan", "active", 1),
      play("self", "Kangaskhan", "bench", 2),
      {
        at: loc(3),
        incoming: card("self", "Kangaskhan"),
        kind: "switchActive",
        outgoing: card("self", "Kangaskhan"),
      },
    ]);

    expect(result.liveGroups[0]?.members).toBe(2);
    expect(result.liveGroups[0]?.zoneCounts).toEqual([{ active: 1, bench: 1 }]);
  });

  it("tracks a survival bound on the body that took the hit", () => {
    const run = runLedger([
      play("self", "Slowpoke", "active", 1),
      damage("self", "Slowpoke", 30, 2),
    ]);

    expect(run.liveGroups[0]?.hp).toEqual([{ max: null, min: 31 }]);
  });

  it("does not raise the bound when the hit is lethal", () => {
    const run = runLedger([
      play("self", "Slowpoke", "active", 1),
      damage("self", "Slowpoke", 30, 2),
      knockout("self", "Slowpoke", 3),
    ]);

    expect(run.liveGroups).toHaveLength(0);
  });

  it("moves an evolution's stack into the new body", () => {
    const run = runLedger([
      play("self", "Drilbur", "active", 1),
      attach("self", "Drilbur", "Metal Energy", 2),
      evolve("self", "Drilbur", "Excadrill", 3),
    ]);

    expect(run.liveGroups).toHaveLength(1);
    expect(run.liveGroups[0]?.name).toBe("Excadrill");
    expect(run.liveGroups[0]?.hp).toEqual([{ max: null, min: 0 }]);
  });

  it("resolves a side the log named wrongly by elimination", () => {
    const run = runLedger([
      play("opponent", "Slowpoke", "bench", 1),
      {
        at: loc(2),
        cause: "Test",
        counters: 1,
        damage: 10,
        kind: "counterDamage",
        target: card("self", "Slowpoke"),
      },
    ]);

    expect(run.diagnostics.map((diagnostic) => diagnostic.code)).toContain("SideMismatch");
    // The counter landed on the other side, and the body survived it.
    expect(run.liveGroups[0]?.hp).toEqual([{ max: null, min: 11 }]);
  });

  it("freezes a group once its variants exceed the cap", () => {
    const result = census(
      [
        play("self", "Kangaskhan", "bench", 1),
        play("self", "Kangaskhan", "bench", 2),
        attach("self", "Kangaskhan", "Psychic Energy", 3),
        attach("self", "Kangaskhan", "Psychic Energy", 4),
      ],
      { maxVariants: 1 },
    );

    expect(result.saturatedGroups).toBe(1);
    expect(result.saturatedGroupsAtEnd).toBe(1);
    expect(result.liveGroups[0]?.saturated).toBe(true);
    expect(result.neverConfirmed).toBe(true);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("Saturated");
  });

  it("keeps a sixth Bench play as a warning, not an unexecutable", () => {
    const run = runLedger([
      play("self", "A", "bench", 1),
      play("self", "B", "bench", 2),
      play("self", "C", "bench", 3),
      play("self", "D", "bench", 4),
      play("self", "E", "bench", 5),
      play("self", "F", "bench", 6),
    ]);

    expect(run.unexecutable).toBe(false);
    expect(run.diagnostics.map((diagnostic) => diagnostic.code)).toContain("BenchOverflow");
  });

  it("tracks hidden zones as counts and revealed cards", () => {
    const run = runLedger([
      { at: loc(1), count: 7, kind: "draw", opening: true, revealed: [], side: "self" },
      { at: loc(2), count: 2, kind: "draw", opening: false, revealed: ["Poké Pad", "Ultra Ball"], side: "self" },
      { at: loc(3), count: 1, kind: "prizeTaken", side: "self" },
      { at: loc(4), card: "Boss's Orders", kind: "prizeRevealed", side: "self" },
    ]);

    expect(run.board.hand.self.count).toBe(10);
    expect(run.board.hand.self.known).toEqual(["Poké Pad", "Ultra Ball", "Boss's Orders"]);
    expect(run.board.prizes.self.remaining).toBe(5);
  });
});

describe("the lowering fixes behind the ledger", () => {
  it("emits one move per named card instead of the count phrase", () => {
    const raw = [
      "Setup",
      "Alice drew 7 cards for the opening hand.",
      "",
      "Alice's Turn",
      "Alice played Slowpoke to the Bench.",
      "Alice played Poké Pad.",
      "- Alice shuffled 2 cards into their deck.",
      "   • Slowpoke, Poké Pad",
      "Alice ended their turn.",
    ].join("\n");
    const lowered = parseAndLower(raw, "Alice");
    const moved = lowered.events.filter((event) => event.kind === "moveCard");

    expect(moved.map((event) => event.kind === "moveCard" && event.card.name)).toEqual([
      "Slowpoke",
      "Poké Pad",
    ]);
  });

  it("treats the first card in a switch as the incoming body", () => {
    const raw = [
      "Setup",
      "Alice drew 7 cards for the opening hand.",
      "",
      "Alice's Turn",
      "Alice played Applin to the Bench.",
      "Alice played Dipplin to the Bench.",
      "Alice's Applin was switched with Alice's Dipplin to become the Active Pokémon.",
      "Alice's Applin is now in the Active Spot.",
    ].join("\n");
    const lowered = parseAndLower(raw, "Alice");
    const switched = lowered.events.find((event) => event.kind === "switchActive");

    expect(switched?.kind === "switchActive" && switched.incoming.name).toBe("Applin");
    expect(switched?.kind === "switchActive" && switched.outgoing.name).toBe("Dipplin");
  });

  it("does not turn a bare Trainer play into a body", () => {
    const events = [
      play("self", "Slowpoke", "bench", 1),
      { at: loc(2), card: card("self", "Poké Pad"), kind: "play" as const, zone: null },
      { at: loc(3), card: card("self", "Slowpoke"), kind: "play" as const, zone: null },
      damage("self", "Slowpoke", 10, 4),
    ];
    const run = runLedger(events);

    // The Trainer never becomes a group. The second bare `played Slowpoke.`
    // names a body already in play and is an ability line, not a second copy.
    expect(run.liveGroups.map((group) => group.name)).toEqual(["Slowpoke"]);
    expect(run.liveGroups[0]?.members).toBe(1);
  });
});

describe("the rest of the transition table", () => {
  const heal = (side: Side, name: string, amount: number, line: number): GameEvent => ({
    at: loc(line),
    damage: amount,
    kind: "heal",
    target: card(side, name),
  });

  const moveCounters = (
    fromSide: Side,
    fromName: string,
    toSide: Side,
    toName: string,
    counters: number,
    line: number,
  ): GameEvent => ({
    at: loc(line),
    cause: "Test",
    counters,
    damage: counters * 10,
    from: card(fromSide, fromName),
    kind: "moveCounters",
    to: card(toSide, toName),
  });

  const move = (side: Side, name: string, to: "active" | "bench" | "deck" | "discard" | "hand" | "stadium", line: number): GameEvent => ({
    at: loc(line),
    card: card(side, name),
    kind: "moveCard",
    to,
  });

  it("heals tracked damage and reports an overflow", () => {
    const run = runLedger([
      play("self", "Slowpoke", "active", 1),
      damage("self", "Slowpoke", 30, 2),
      heal("self", "Slowpoke", 10, 3),
      heal("self", "Slowpoke", 40, 4),
    ]);

    expect(run.liveGroups[0]?.hp).toEqual([{ max: null, min: 31 }]);
    expect(run.diagnostics.map((diagnostic) => diagnostic.code)).toContain("HealOverflow");
    expect(run.unexecutable).toBe(false);
  });

  it("moves counters within one group and between groups", () => {
    const same = runLedger([
      play("self", "Kangaskhan", "bench", 1),
      play("self", "Kangaskhan", "bench", 2),
      damage("self", "Kangaskhan", 30, 3),
      moveCounters("self", "Kangaskhan", "self", "Kangaskhan", 1, 4),
    ]);
    expect(same.unexecutable).toBe(false);

    const between = runLedger([
      play("self", "Slowpoke", "bench", 1),
      play("self", "Slowking", "bench", 2),
      damage("self", "Slowpoke", 30, 3),
      moveCounters("self", "Slowpoke", "self", "Slowking", 1, 4),
    ]);
    expect(between.unexecutable).toBe(false);
    expect(between.liveGroups.find((group) => group.name === "Slowking")?.hp)
      .toEqual([{ max: null, min: 11 }]);
  });

  it("devolves a body and keeps the remaining stack", () => {
    const run = runLedger([
      play("self", "Drilbur", "active", 1),
      evolve("self", "Drilbur", "Excadrill", 2),
      {
        at: loc(3),
        from: card("self", "Excadrill"),
        into: "Drilbur",
        kind: "devolve",
        zone: "active",
      },
    ]);

    expect(run.liveGroups.map((group) => group.name)).toEqual(["Drilbur"]);
    expect(run.unexecutable).toBe(false);
  });

  it("retreats and promotes through two separate lines", () => {
    const run = runLedger([
      play("self", "Kangaskhan", "active", 1),
      play("self", "Slowpoke", "bench", 2),
      { at: loc(3), card: card("self", "Kangaskhan"), kind: "retreat" },
      move("self", "Slowpoke", "active", 4),
    ]);

    expect(run.board.active.self).toBe(run.liveGroups.find((group) => group.name === "Slowpoke")?.id);
    expect(run.liveGroups.find((group) => group.name === "Kangaskhan")?.zoneCounts)
      .toEqual([{ active: 0, bench: 1 }]);
  });

  it("switches two different names", () => {
    const run = runLedger([
      play("self", "Kangaskhan", "active", 1),
      play("self", "Slowpoke", "bench", 2),
      {
        at: loc(3),
        incoming: card("self", "Slowpoke"),
        kind: "switchActive",
        outgoing: card("self", "Kangaskhan"),
      },
    ]);

    expect(run.board.active.self).toBe(run.liveGroups.find((group) => group.name === "Slowpoke")?.id);
    expect(run.liveGroups.find((group) => group.name === "Kangaskhan")?.zoneCounts)
      .toEqual([{ active: 0, bench: 1 }]);
  });

  it("ignores hidden-zone moves and a Stadium move", () => {
    const run = runLedger([
      play("self", "Kangaskhan", "bench", 1),
      move("self", "Kangaskhan", "hand", 2),
      move("self", "Kangaskhan", "deck", 3),
      move("self", "Kangaskhan", "discard", 4),
      move("self", "Kangaskhan", "stadium", 5),
      move("self", "Poké Pad", "discard", 6),
    ]);

    expect(run.liveGroups[0]?.members).toBe(1);
    expect(run.board.hand.self.count).toBe(1);
    expect(run.unexecutable).toBe(false);
  });

  it("enters play from a board move when the name is a Pokémon", () => {
    const run = runLedger([
      { at: loc(1), card: card("self", "Kangaskhan"), kind: "play", zone: null },
      { at: loc(2), card: card("self", "Kangaskhan"), kind: "moveCard", to: "bench" },
    ]);

    // The bare play is ignored (no zone), but the move to the Bench proves the
    // card is a body, so it enters play there.
    expect(run.liveGroups.map((group) => group.name)).toEqual(["Kangaskhan"]);
    expect(run.liveGroups[0]?.zoneCounts).toEqual([{ active: 0, bench: 1 }]);
  });

  it("reports a wrong attach zone, a missing evolution, and a missing knockout as warnings", () => {
    const run = runLedger([
      play("self", "Kangaskhan", "active", 1),
      attach("self", "Kangaskhan", "Psychic Energy", 2, "bench"),
      evolve("self", "Slowpoke", "Slowking", 3),
      knockout("self", "Slowpoke", 4),
    ]);

    expect(run.unexecutable).toBe(false);
    expect(run.diagnostics.map((diagnostic) => diagnostic.code)).toContain("UnknownGroup");
  });

  it("removes a count of attachments when the discard line names none", () => {
    const run = runLedger([
      play("self", "Kangaskhan", "bench", 1),
      play("self", "Kangaskhan", "bench", 2),
      attach("self", "Kangaskhan", "Psychic Energy", 3),
      attach("self", "Kangaskhan", "Grass Energy", 4),
      {
        at: loc(5),
        body: card("self", "Kangaskhan"),
        cards: [],
        count: 1,
        kind: "detach",
      },
    ]);

    expect(run.unexecutable).toBe(false);
    expect(run.liveGroups[0]?.members).toBe(2);
  });

  it("warns about a discard larger than every pile", () => {
    const run = runLedger([
      play("self", "Kangaskhan", "bench", 1),
      {
        at: loc(2),
        body: card("self", "Kangaskhan"),
        cards: [],
        count: 3,
        kind: "detach",
      },
    ]);

    expect(run.unexecutable).toBe(false);
    expect(run.diagnostics.map((diagnostic) => diagnostic.code)).toContain("AttachmentMismatch");
  });

  it("counts a same-name switch with no pair as a warning", () => {
    const run = runLedger([
      play("self", "Kangaskhan", "bench", 1),
      play("self", "Kangaskhan", "bench", 2),
      {
        at: loc(3),
        incoming: card("self", "Kangaskhan"),
        kind: "switchActive",
        outgoing: card("self", "Kangaskhan"),
      },
    ]);

    expect(run.unexecutable).toBe(false);
    expect(run.diagnostics.map((diagnostic) => diagnostic.code)).toContain("UnknownGroup");
  });

  it("removes a body on a knockout with no damage", () => {
    const run = runLedger([
      play("self", "Kangaskhan", "active", 1),
      knockout("self", "Kangaskhan", 2),
    ]);

    expect(run.liveGroups).toHaveLength(0);
    expect(run.board.active.self).toBeNull();
  });

  it("reports a prize overflow without throwing", () => {
    const run = runLedger([
      { at: loc(1), count: 7, kind: "prizeTaken", side: "self" },
    ]);

    expect(run.unexecutable).toBe(false);
    expect(run.diagnostics.map((diagnostic) => diagnostic.code)).toContain("PrizeOverflow");
    expect(run.board.prizes.self.remaining).toBe(0);
  });

  it("keeps adding members to a saturated group", () => {
    const run = runLedger(
      [
        play("self", "Kangaskhan", "bench", 1),
        play("self", "Kangaskhan", "bench", 2),
        attach("self", "Kangaskhan", "Psychic Energy", 3),
        attach("self", "Kangaskhan", "Grass Energy", 4),
        play("self", "Kangaskhan", "bench", 5),
      ],
      { maxVariants: 1 },
    );

    expect(run.liveGroups[0]?.members).toBe(3);
    expect(run.liveGroups[0]?.saturated).toBe(true);
  });

  it("reports a knockdown that resolves late as confirmed-late", () => {
    const result = census([
      play("self", "Kangaskhan", "bench", 1),
      play("self", "Kangaskhan", "bench", 2),
      attach("self", "Kangaskhan", "Psychic Energy", 3),
      attach("self", "Kangaskhan", "Grass Energy", 4),
      knockout("self", "Kangaskhan", 5),
      detach("self", "Kangaskhan", ["Psychic Energy", "Grass Energy"], 6),
    ]);

    expect(result.everDivergent).toBe(true);
    expect(result.neverConfirmed).toBe(false);
    expect(result.confirmedLate).toBe(true);
    expect(result.forkEpisodes).toBeGreaterThan(0);
  });

  it("treats end-turn, attack, and end-game as no-ops", () => {
    const run = runLedger([
      play("self", "Kangaskhan", "active", 1),
      { at: loc(2), kind: "endTurn", side: "self" },
      { at: loc(3), attack: "Test", kind: "attack", source: card("self", "Kangaskhan") },
      { at: loc(4), kind: "endGame", reason: "test", winner: "Alice" },
    ]);

    expect(run.liveGroups).toHaveLength(1);
    expect(run.unexecutable).toBe(false);
  });
});

describe("the card oracle", () => {
  const oracle = (name: string, hp: number, canHitBench: boolean | null = null) => ({
    printings: (cardName: string) =>
      cardName === name
        ? [{
            attacks: [{ canHitBench, name: "Test Attack" }],
            evolvesFrom: null,
            hp,
            prizeValue: null,
          }]
        : null,
  });

  it("makes a knockout impossible when card HP is above the cumulative damage", () => {
    const events = [
      play("self", "Slowpoke", "active", 1),
      damage("self", "Slowpoke", 30, 2),
      knockout("self", "Slowpoke", 3),
    ];
    const bare = runLedger(events);
    const informed = runLedger(events, { oracle: oracle("Slowpoke", 60) });

    // Bare mode has no HP, so 30 damage is a possible knockout. Card HP 60 says
    // it is not, and the ledger records that it could not explain the KO.
    expect(bare.diagnostics.some((diagnostic) => diagnostic.code === "KnockoutUnproven")).toBe(false);
    expect(informed.diagnostics.some((diagnostic) => diagnostic.code === "KnockoutUnproven")).toBe(true);
  });

  it("prunes a Bench copy when the attack can only hit the Active Spot", () => {
    const events: GameEvent[] = [
      play("self", "Kangaskhan", "active", 1),
      play("self", "Kangaskhan", "bench", 2),
      {
        amount: 30,
        at: loc(3),
        attack: "Test Attack",
        kind: "damage",
        modifiers: [],
        source: card("opponent", "Attacker"),
        target: card("self", "Kangaskhan"),
      },
    ];
    const bare = runLedger(events);
    const informed = runLedger(events, { oracle: oracle("Attacker", 100, false) });

    expect(bare.liveGroups[0]?.renderVariants).toBeGreaterThan(1);
    expect(informed.liveGroups[0]?.renderVariants).toBe(1);
    expect(informed.liveGroups[0]?.zoneCounts).toEqual([{ active: 1, bench: 1 }]);
  });

  it("counts turn-boundary prefixes separately", () => {
    const run = runLedger([
      play("self", "Kangaskhan", "active", 1),
      { at: loc(2), kind: "endTurn", side: "self" },
      play("self", "Slowpoke", "bench", 3),
      { at: loc(4), kind: "endTurn", side: "self" },
    ]);

    expect(run.prefixes.stableTotal).toBe(2);
    expect(run.prefixes.stableConfirmed).toBe(2);
    expect(run.prefixes.stableDivergent).toBe(0);
  });
});
