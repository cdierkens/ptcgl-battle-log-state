import { readFileSync } from "node:fs";

import { blogTemplateBundles, parseBattleLog } from "@dierkens.dev/ptcgl-battle-log-parser";
import { describe, expect, it } from "vitest";

import type { DamageEvent, GameEvent } from "../events.js";
import { IGNORED, MAPPED, lower } from "../lowering.js";
import { isErr, unwrap } from "../result.js";

const FIXTURES = [
  "dipplin-vs-mega-excadrill",
  "slowking-vs-beedrill",
  "slowking-vs-froslass-mill",
  "slowking-vs-greninja",
] as const;

/** Every fixture was captured by cdierkens, so the sides are declared. */
const LOCAL_PLAYER = "cdierkens";

const readFixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}.log`, import.meta.url), "utf8");

const lowerFixture = (name: string) => {
  const raw = readFixture(name);
  const parsed = unwrap(parseBattleLog(raw, { locale: "en", playerName: LOCAL_PLAYER }));
  return unwrap(lower(parsed, raw));
};

const damages = (events: readonly GameEvent[]): readonly DamageEvent[] =>
  events.filter((event): event is DamageEvent => event.kind === "damage");

describe("the lowering table", () => {
  it("covers every shipped template key exactly once", () => {
    const shipped = Object.keys(blogTemplateBundles.en).sort();
    const mapped = Object.keys(MAPPED);
    const ignored = Object.values(IGNORED).flat();
    const covered = [...mapped, ...ignored];

    expect(new Set(covered).size, "a key is in both tables").toBe(covered.length);
    expect(covered.sort()).toEqual(shipped);
  });

  it("keeps the tables honest about their size", () => {
    expect(Object.keys(MAPPED)).toHaveLength(69);
    expect(Object.values(IGNORED).flat()).toHaveLength(159);
  });
});

describe("lowering the fixtures", () => {
  it.each(FIXTURES)("lowers %s with no unhandled line and no diagnostics", (name) => {
    const lowered = lowerFixture(name);

    expect(lowered.unhandled.map((entry) => entry.key)).toEqual([]);
    expect(lowered.diagnostics.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`)).toEqual([]);
    expect(lowered.events.length).toBeGreaterThan(0);
  });

  it.each(FIXTURES)("points every event at a real, ordered line in %s", (name) => {
    const lowered = lowerFixture(name);
    const lines = lowered.events.map((event) => event.at.line);

    expect(lines.every((line) => line > 0)).toBe(true);
    expect([...lines].sort((left, right) => left - right)).toEqual(lines);
  });

  it("attributes damage to the right sides", () => {
    const lowered = lowerFixture("slowking-vs-froslass-mill");
    const curse = damages(lowered.events).find(
      (event) => event.attack === "Cursed Roots" && event.target.name === "Slowpoke",
    );

    expect(curse?.source).toEqual({ name: "Trevenant", side: "opponent" });
    expect(curse?.target).toEqual({ name: "Slowpoke", side: "self" });
    expect(curse?.amount).toBe(30);
  });

  it("keeps two identical secondary damage lines on two separate cards", () => {
    const lowered = lowerFixture("slowking-vs-beedrill");
    const weedle = damages(lowered.events).filter(
      (event) => event.source === null && event.target.name === "Weedle",
    );

    // "- Wonder_Squid's Weedle took 110 damage." twice — two Weedles, not a
    // restatement. Collapsing them would invalidate the pair of knockouts.
    expect(weedle).toHaveLength(2);
    expect(weedle.map((event) => event.amount)).toEqual([110, 110]);
  });

  it("collapses a restated attack instead of dealing its damage twice", () => {
    const lowered = lowerFixture("dipplin-vs-mega-excadrill");
    const wave = damages(lowered.events).filter(
      (event) => event.attack === "Do the Wave" && event.target.name === "Mega Excadrill ex",
    );

    expect(wave).toHaveLength(1);
    expect(wave[0]?.amount).toBe(180);
    expect(lowered.ignored.some((entry) => entry.reason === "restatement")).toBe(true);
  });

  it("carries the printed breakdown as data", () => {
    const lowered = lowerFixture("dipplin-vs-mega-excadrill");
    const wave = damages(lowered.events).find(
      (event) => event.attack === "Do the Wave" && event.target.name === "Mega Excadrill ex",
    );

    expect(wave?.amount).toBe(180);
    expect(wave?.breakdown?.map((line) => line.label)).toEqual([
      "(Pokémon Tool) Brave Bangle",
      "(Supporter) Gladion's Final Battle",
      "5 Benched Pokémon",
      "Resistance to Grass",
    ]);
    // Carried as printed. Nothing asserts that these lines add up: real
    // breakdowns repeat components and some hits legitimately carry 0.
    expect(wave?.breakdown?.reduce((sum, line) => sum + line.amount, 0)).toBe(180);
  });

  it("attaches a partial breakdown without claiming it sums", () => {
    const lowered = lowerFixture("slowking-vs-greninja");
    const barrage = damages(lowered.events).find((event) => event.attack === "Mirage Barrage");

    // Only the resistance clause was printed, so the breakdown explains part of
    // the hit rather than accounting for it. It is attached, not reconciled.
    expect(barrage?.breakdown).toEqual([{ amount: -30, label: "Resistance to Fighting" }]);
  });

  it("records an unidentified count phrase as printed, without inventing a card", () => {
    const lowered = lowerFixture("slowking-vs-beedrill");
    const moved = lowered.events.filter(
      (event) => event.kind === "moveCard" && event.card.name.includes("cards"),
    );

    // "Wonder_Squid moved 2 cards to the discard pile." The log never said
    // which, so the name stays verbatim: a phantom name the solver can fail to
    // match is honest; a guessed card name is not.
    expect(moved.length).toBeGreaterThan(0);
    expect(moved.every((event) => event.kind === "moveCard" && /^\d+ cards$/u.test(event.card.name)))
      .toBe(true);
  });

  it("lowers a knockout and the pile discarded from the body", () => {
    const lowered = lowerFixture("dipplin-vs-mega-excadrill");
    const knockout = lowered.events.find(
      (event) => event.kind === "knockout" && event.target.name === "Mega Excadrill ex",
    );
    const detach = lowered.events.find(
      (event) => event.kind === "detach" && event.body.name === "Mega Excadrill ex",
    );

    expect(knockout?.kind).toBe("knockout");
    expect(detach?.kind === "detach" && detach.count).toBe(5);
    expect(detach?.kind === "detach" && detach.cards).toEqual([
      "Basic Metal Energy",
      "Basic Metal Energy",
      "Basic Metal Energy",
      "Basic Metal Energy",
      "Drilbur",
    ]);
  });

  it("refuses a log with no side to resolve", () => {
    const raw = "Setup\nAlice drew 7 cards for the opening hand.\n";
    const parsed = unwrap(parseBattleLog(raw, { locale: "en" }));

    expect(isErr(lower(parsed, raw))).toBe(true);
  });

  it("deduces the other side for a log cut off after one turn", () => {
    const raw = [
      "Setup",
      "Alice drew 7 cards for the opening hand.",
      "",
      "Alice's Turn",
      // The defending side's apostrophe is curly in the game's own template.
      // A straight one still parses — as `used_attack`, with the attack name
      // swallowing the rest of the line.
      "Alice's Slowking used Seek Inspiration on Bob’s Celebi for 110 damage.",
      "",
      "Alice ended their turn.",
    ].join("\n");
    const parsed = unwrap(parseBattleLog(raw, { locale: "en", playerName: "Alice" }));
    const lowered = unwrap(lower(parsed, raw));
    const damage = lowered.events.find((event) => event.kind === "damage");

    expect(damage?.kind).toBe("damage");
    expect(damage?.kind === "damage" && damage.target.side).toBe("opponent");
  });

  it("records counters as damage", () => {
    const lowered = lowerFixture("slowking-vs-froslass-mill");
    const counters = lowered.events.filter((event) => event.kind === "counterDamage");

    expect(counters.length).toBeGreaterThan(0);
    for (const counter of counters) {
      if (counter.kind === "counterDamage") {
        expect(counter.damage).toBe(counter.counters * 10);
        expect(counter.cause.length).toBeGreaterThan(0);
      }
    }
  });

  it("marks counter heals and moves as not naming the owner", () => {
    const raw = [
      "Alice's Turn",
      "Alice's Pikachu healed 30 damage.",
      "Alice's Pikachu was healed for 3 damage.",
      "Dusknoir moved 2 damage counters from Alice's Pikachu to Alice's Eevee.",
    ].join("\n");
    const lowered = unwrap(lower(unwrap(parseBattleLog(raw, { locale: "en", playerName: "Alice" })), raw));

    expect(lowered.events.map((event) => [event.kind, "ownerPrinted" in event && event.ownerPrinted]))
      .toEqual([["heal", true], ["heal", false], ["moveCounters", false]]);
  });
});

describe("lowering a line whose key the parser could not determine", () => {
  const lowerLocale = (locale: "en" | "fr" | "ptbr", lines: readonly string[]) => {
    const raw = lines.join("\n");
    return unwrap(lower(unwrap(parseBattleLog(raw, { locale, playerName: "Alice" })), raw));
  };

  it("lowers it when every candidate lowers the same way", () => {
    const lowered = lowerLocale("en", ["Alice's Turn", "Alice discarded Nest Ball."]);

    expect(lowered.events).toMatchObject([
      { card: { name: "Nest Ball", side: "self" }, kind: "moveCard", to: "discard" },
    ]);
    expect(lowered.diagnostics).toEqual([]);
  });

  it("lowers a prevention line, whichever of its keys printed it, to a name with no side", () => {
    const lowered = lowerLocale("en", ["Alice's Turn", "Damage to Pikachu was prevented."]);

    expect(lowered.events).toMatchObject([{ kind: "prevented", name: "Pikachu" }]);
    expect(lowered.diagnostics).toEqual([]);
  });

  it("lowers a hidden card play, in any locale, to its side alone", () => {
    const en = lowerLocale("en", ["Alice's Turn", "Alice played a card."]);
    const fr = lowerLocale("fr", ["Tour de Alice", "Alice a joué une carte."]);

    for (const lowered of [en, fr]) {
      expect(lowered.events).toMatchObject([{ kind: "hiddenPlay", side: "self" }]);
    }
  });

  it("reports it, rather than picking, when the candidates lower differently", () => {
    const fr = lowerLocale("fr", ["Tour de Alice", "Pikachu de Alice a été soigné de 30 dégâts."]);
    const ptbr = lowerLocale("ptbr", ["Turno de Alice", "Alice embaralhou Nest Ball no baralho dele."]);

    for (const lowered of [fr, ptbr]) {
      expect(lowered.events).toEqual([]);
      expect(lowered.diagnostics).toMatchObject([{ code: "AmbiguousTemplate" }]);
    }
  });
});
