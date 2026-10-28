import { describe, expect, it } from "vitest";

import { counterSpreadFromText, leavesPlayFromText } from "../card-text.js";

describe("reading a counter spread from card text", () => {
  it("reads an each-spread with its owner, ability rule, and exception", () => {
    expect(counterSpreadFromText(
      "During Pokémon Checkup, put 1 damage counter on each Pokémon that has an Ability (both yours and your opponent's), except any Froslass.",
    )).toEqual({
      benchOnly: false,
      counters: 1,
      except: "Froslass",
      placement: "each",
      requiresAbility: true,
      sides: "both",
    });
  });

  it("reads a spread sentence after an unrelated one, with curly quotes", () => {
    expect(counterSpreadFromText(
      "Your opponent’s Active Pokémon is now Poisoned. Put 1 damage counter on each of your opponent’s Benched Pokémon.",
    )).toMatchObject({ benchOnly: true, placement: "each", sides: "opponent" });
  });

  it("reads a choice spread", () => {
    expect(counterSpreadFromText("Put 6 damage counters on your opponent's Benched Pokémon in any way you like."))
      .toEqual({ benchOnly: true, counters: 6, except: null, placement: "choice", requiresAbility: false, sides: "opponent" });
  });

  it("does not read a conditional spread", () => {
    expect(counterSpreadFromText("If this Pokémon is Poisoned, put 2 damage counters on each of your opponent's Pokémon."))
      .toBeNull();
  });
});

describe("reading whether an effect takes its Pokémon out of play", () => {
  it("reads the destination of the acting Pokémon", () => {
    expect(leavesPlayFromText("Once during your turn, you may draw 3 cards. If you drew any cards in this way, shuffle this Pokémon and all attached cards into your deck."))
      .toBe("deck");
    expect(leavesPlayFromText("Put this Pokémon and all attached cards into your hand.")).toBe("hand");
  });

  it("does not read an effect on another Pokémon", () => {
    expect(leavesPlayFromText("Your opponent shuffles their Active Pokémon and all attached cards into their deck."))
      .toBeNull();
  });
});
