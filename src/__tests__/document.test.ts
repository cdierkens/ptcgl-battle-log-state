import { describe, expect, it } from "vitest";

import { validateDocument } from "../document.js";
import { InvalidStateDocumentError } from "../errors.js";
import { isErr, isOk, unwrap } from "../result.js";

const PREFIX = { line: 10, phase: 1, turn: 2 };

/** Narrow shapes for tests that mutate a document in place. */
interface MutableSide {
  active: string;
  bench: string[];
}
interface MutableBoard {
  opponent: MutableSide;
  self: MutableSide;
}

/** A minimal, valid `whole` document. Tests mutate a fresh copy of it. */
const wholeDocument = (): Record<string, unknown> => ({
  board: {
    opponent: {
      active: "o0",
      bench: [],
      hand: { count: 2, known: [] },
      prizes: { known: [], remaining: 3 },
    },
    self: {
      active: "s0",
      bench: ["s1"],
      hand: { count: 3, known: [] },
      prizes: { known: [], remaining: 4 },
    },
  },
  determinacy: "whole",
  diagnostics: [],
  groups: [],
  prefix: PREFIX,
  properties: {
    hp: { "self/Slowpoke": { max: 60, min: 60, source: "observed" } },
    targeting: {},
  },
  provenance: { logHash: "sha256:abc", playerName: "Me", solver: "0.1.0" },
  schema: "ptcgl-state/1",
  slots: [
    { damage: 0, group: null, id: "s0", name: "Slowking", zone: "active" },
    { damage: 30, group: null, id: "s1", name: "Slowpoke", zone: "bench" },
    {
      attachments: ["Basic Grass Energy"],
      damage: 0,
      group: null,
      id: "o0",
      name: "Beedrill ex",
      zone: "active",
    },
  ],
});

/**
 * Two Kangaskhan whose damage cannot be attributed: the divergent case the
 * whole package exists for.
 */
const divergentDocument = (): Record<string, unknown> => ({
  ...wholeDocument(),
  board: {
    opponent: {
      active: "o0",
      bench: [],
      hand: { count: 2, known: [] },
      prizes: { known: [], remaining: 3 },
    },
    self: {
      active: "s0",
      bench: ["s1", "s2"],
      hand: { count: 3, known: [] },
      prizes: { known: [], remaining: 4 },
    },
  },
  determinacy: "divergent",
  groups: [
    {
      candidates: [
        {
          s1: { attachments: ["Basic Psychic Energy"], damage: 30 },
          s2: { attachments: [], damage: 0 },
        },
        {
          s1: { attachments: [], damage: 0 },
          s2: { attachments: ["Basic Psychic Energy"], damage: 30 },
        },
      ],
      id: "g0",
      members: ["s1", "s2"],
      name: "Kangaskhan",
      resolvedAt: null,
      side: "self",
      since: PREFIX,
    },
  ],
  slots: [
    { damage: 0, group: null, id: "s0", name: "Slowking", zone: "active" },
    { group: "g0", id: "s1", name: "Kangaskhan", zone: "bench" },
    { group: "g0", id: "s2", name: "Kangaskhan", zone: "bench" },
    {
      attachments: ["Basic Grass Energy"],
      damage: 0,
      group: null,
      id: "o0",
      name: "Beedrill ex",
      zone: "active",
    },
  ],
});

describe("validateDocument", () => {
  it("accepts a whole document", () => {
    const result = validateDocument(wholeDocument());
    expect(isOk(result)).toBe(true);
  });

  it("accepts a divergent document and keeps both candidates", () => {
    const result = unwrap(validateDocument(divergentDocument()));
    expect(result.determinacy).toBe("divergent");
    const group = result.groups[0];
    expect(group?.candidates).toHaveLength(2);
  });

  it("rejects a document whose schema is not ptcgl-state/<major>", () => {
    const result = validateDocument({ ...wholeDocument(), schema: "ptcgl-state" });
    expect(isErr(result)).toBe(true);
    expect(result.ok === false && result.error.issues[0]?.path).toBe("$.schema");
  });

  it("rejects a group candidate that invents damage", () => {
    const document = divergentDocument();
    const groups = document.groups as Record<string, unknown>[];
    const first = groups[0] as Record<string, unknown>;
    const candidates = first.candidates as Record<string, unknown>[];
    const second = candidates[1] as Record<string, unknown>;
    (second.s2 as Record<string, unknown>).damage = 40;

    const result = validateDocument(document);
    expect(isErr(result)).toBe(true);
    expect(
      result.ok === false && result.error.issues.some((issue) =>
        issue.message.includes("same multiset")),
    ).toBe(true);
  });

  it("rejects a candidate that does not assign every member", () => {
    const document = divergentDocument();
    const groups = document.groups as Record<string, unknown>[];
    const first = groups[0] as Record<string, unknown>;
    const candidates = first.candidates as Record<string, unknown>[];
    delete (candidates[0] as Record<string, unknown>).s2;

    const result = validateDocument(document);
    expect(isErr(result)).toBe(true);
    expect(
      result.ok === false && result.error.issues.some((issue) =>
        issue.message.startsWith("must assign exactly")),
    ).toBe(true);
  });

  it("rejects a group slot that carries its own damage", () => {
    const document = divergentDocument();
    const slots = document.slots as Record<string, unknown>[];
    (slots[1] as Record<string, unknown>).damage = 30;

    const result = validateDocument(document);
    expect(isErr(result)).toBe(true);
    expect(
      result.ok === false && result.error.issues.some((issue) =>
        issue.message.includes("belong in candidates")),
    ).toBe(true);
  });

  it("rejects divergent when no group actually diverges", () => {
    const document = { ...wholeDocument(), determinacy: "divergent" };
    const result = validateDocument(document);
    expect(isErr(result)).toBe(true);
    expect(
      result.ok === false && result.error.issues.some((issue) =>
        issue.message.includes("at least one group with two or more candidates")),
    ).toBe(true);
  });

  it("rejects whole when a group has two candidates", () => {
    const document = { ...divergentDocument(), determinacy: "whole" };
    const result = validateDocument(document);
    expect(isErr(result)).toBe(true);
    expect(
      result.ok === false && result.error.issues.some((issue) =>
        issue.message.includes("whole contradicts")),
    ).toBe(true);
  });

  it("rejects unexecutable without an error diagnostic", () => {
    const document = { ...wholeDocument(), determinacy: "unexecutable" };
    const result = validateDocument(document);
    expect(isErr(result)).toBe(true);
    expect(
      result.ok === false && result.error.issues.some((issue) =>
        issue.message.includes("requires an error diagnostic")),
    ).toBe(true);
  });

  it("rejects a board reference to a slot that does not exist", () => {
    const document = wholeDocument();
    const board = document.board as MutableBoard;
    board.self.active = "nope";

    const result = validateDocument(document);
    expect(isErr(result)).toBe(true);
    expect(
      result.ok === false && result.error.issues.some((issue) =>
        issue.message.includes("unknown slot nope")),
    ).toBe(true);
  });

  it("rejects a slot outside a group that carries no damage", () => {
    const document = wholeDocument();
    const slots = document.slots as Record<string, unknown>[];
    delete (slots[1] as Record<string, unknown>).damage;

    const result = validateDocument(document);
    expect(isErr(result)).toBe(true);
    expect(
      result.ok === false && result.error.issues.some((issue) =>
        issue.message.includes("must carry its own damage")),
    ).toBe(true);
  });

  it("rejects duplicate slot ids", () => {
    const document = wholeDocument();
    const slots = document.slots as Record<string, unknown>[];
    (slots[1] as Record<string, unknown>).id = "s0";

    const result = validateDocument(document);
    expect(isErr(result)).toBe(true);
    expect(
      result.ok === false && result.error.issues.some((issue) =>
        issue.message.includes("duplicate slot id")),
    ).toBe(true);
  });

  it("reports every issue it finds, not the first", () => {
    const document = wholeDocument();
    const board = document.board as MutableBoard;
    board.self.active = "nope";
    board.opponent.active = "also-nope";

    const result = validateDocument(document);
    expect(isErr(result)).toBe(true);
    if (result.ok) {
      return;
    }
    expect(result.error.issues.length).toBeGreaterThan(1);
  });

  it("throws through unwrap as InvalidStateDocumentError", () => {
    expect(() => unwrap(validateDocument({}))).toThrow(InvalidStateDocumentError);
    expect(() => unwrap(validateDocument({}))).toThrow(/Invalid state document/);
  });
});

describe("validateDocument — edges", () => {
  it("accepts a null turn and a null player name", () => {
    const document = wholeDocument();
    document.prefix = { line: 10, phase: 1, turn: null };
    document.provenance = { logHash: "sha256:abc", playerName: null, solver: "0.1.0" };
    expect(isOk(validateDocument(document))).toBe(true);
  });

  it("rejects a schema major this build was not written for", () => {
    const result = validateDocument({ ...wholeDocument(), schema: "ptcgl-state/2" });
    expect(isErr(result)).toBe(true);
    expect(
      result.ok === false && result.error.issues.some((issue) =>
        issue.message.includes("this build validates ptcgl-state/1")),
    ).toBe(true);
  });

  it("rejects a non-object document", () => {
    expect(isErr(validateDocument([]))).toBe(true);
    expect(isErr(validateDocument("nope"))).toBe(true);
    expect(isErr(validateDocument(null))).toBe(true);
  });

  it("rejects a non-integer damage value", () => {
    const document = wholeDocument();
    const slots = document.slots as Record<string, unknown>[];
    (slots[1] as Record<string, unknown>).damage = 12.5;

    const result = validateDocument(document);
    expect(isErr(result)).toBe(true);
    expect(
      result.ok === false && result.error.issues.some((issue) =>
        issue.message.includes("expected an integer")),
    ).toBe(true);
  });

  it("rejects an empty attachment name", () => {
    const document = divergentDocument();
    const groups = document.groups as Record<string, unknown>[];
    const candidates = (groups[0] as Record<string, unknown>).candidates as Record<string, unknown>[];
    const s1 = (candidates[0] as Record<string, Record<string, unknown>>).s1;
    if (s1 !== undefined) {
      s1.attachments = [""];
    }

    const result = validateDocument(document);
    expect(isErr(result)).toBe(true);
    expect(
      result.ok === false && result.error.issues.some((issue) =>
        issue.message.includes("non-empty card names")),
    ).toBe(true);
  });

  it("rejects duplicate group ids", () => {
    const document = divergentDocument();
    const groups = document.groups as Record<string, unknown>[];
    groups.push(groups[0] as Record<string, unknown>);

    const result = validateDocument(document);
    expect(isErr(result)).toBe(true);
    expect(
      result.ok === false && result.error.issues.some((issue) =>
        issue.message.includes("duplicate group id")),
    ).toBe(true);
  });

  it("rejects a slot claiming a group it is not a member of", () => {
    const document = divergentDocument();
    const slots = document.slots as Record<string, unknown>[];
    slots.push({ group: "g0", id: "s3", name: "Kangaskhan", zone: "bench" });

    const result = validateDocument(document);
    expect(isErr(result)).toBe(true);
    expect(
      result.ok === false && result.error.issues.some((issue) =>
        issue.message.includes("is not a member")),
    ).toBe(true);
  });

  it("rejects a slot claiming a group that does not exist", () => {
    const document = wholeDocument();
    const slots = document.slots as Record<string, unknown>[];
    (slots[1] as Record<string, unknown>).group = "nope";
    delete (slots[1] as Record<string, unknown>).damage;

    const result = validateDocument(document);
    expect(isErr(result)).toBe(true);
    expect(
      result.ok === false && result.error.issues.some((issue) =>
        issue.message.includes("unknown group nope")),
    ).toBe(true);
  });

  it("rejects a group whose member has a different name", () => {
    const document = divergentDocument();
    const slots = document.slots as Record<string, unknown>[];
    (slots[1] as Record<string, unknown>).name = "Slowpoke";

    const result = validateDocument(document);
    expect(isErr(result)).toBe(true);
    expect(
      result.ok === false && result.error.issues.some((issue) =>
        issue.message.includes("is named Slowpoke")),
    ).toBe(true);
  });

  it("rejects a candidate assigning a slot that is not a member", () => {
    const document = divergentDocument();
    const groups = document.groups as Record<string, unknown>[];
    const candidates = (groups[0] as Record<string, unknown>).candidates as Record<string, unknown>[];
    (candidates[0] as Record<string, unknown>).s0 = { attachments: [], damage: 0 };

    const result = validateDocument(document);
    expect(isErr(result)).toBe(true);
    expect(
      result.ok === false && result.error.issues.some((issue) =>
        issue.message.startsWith("must assign exactly")),
    ).toBe(true);
  });

  it("rejects a slot referenced by both sides", () => {
    const document = wholeDocument();
    const board = document.board as MutableBoard;
    board.opponent.bench.push("s1");

    const result = validateDocument(document);
    expect(isErr(result)).toBe(true);
    expect(
      result.ok === false && result.error.issues.some((issue) =>
        issue.message.includes("referenced more than once")),
    ).toBe(true);
  });

  it("rejects a slot that is on neither board", () => {
    const document = wholeDocument();
    const slots = document.slots as Record<string, unknown>[];
    slots.push({ damage: 0, group: null, id: "s9", name: "Slowpoke", zone: "bench" });

    const result = validateDocument(document);
    expect(isErr(result)).toBe(true);
    expect(
      result.ok === false && result.error.issues.some((issue) =>
        issue.message.includes("is not on either board")),
    ).toBe(true);
  });

  it("rejects unexecutable when the error diagnostic carries no line", () => {
    const document = {
      ...wholeDocument(),
      determinacy: "unexecutable",
      diagnostics: [{ code: "UnmatchedLine", message: "no idea", severity: "error" }],
    };

    const result = validateDocument(document);
    expect(isErr(result)).toBe(true);
    expect(
      result.ok === false && result.error.issues.some((issue) =>
        issue.message.includes("carrying the offending line")),
    ).toBe(true);
  });

  it("accepts unexecutable when the error diagnostic names its line", () => {
    const document = {
      ...wholeDocument(),
      determinacy: "unexecutable",
      diagnostics: [{ code: "UnmatchedLine", line: 42, message: "no idea", severity: "error" }],
    };

    expect(isOk(validateDocument(document))).toBe(true);
  });
});
