/**
 * Published-artefact smoke test.
 *
 * Runs against the *installed* package, not the source tree, so it catches
 * anything `tsc` and vitest cannot see: a missing file in `files`, a broken
 * `exports` map, or a runtime dependency that only resolves through the
 * workspace link.
 *
 * CI installs the packed tarball and runs this. Locally:
 *
 *   pnpm run build && pnpm pack
 *   mkdir -p /tmp/smoke && cd /tmp/smoke && npm init -y && npm pkg set type=module
 *   npm install <path-to-tgz>
 *   node <path-to-this-file>
 */

import {
  InvalidStateDocumentError,
  err,
  isErr,
  isOk,
  lower,
  ok,
  unwrap,
  validateDocument,
} from "@dierkens.dev/ptcgl-battle-log-state";

const failures = [];
const check = (label, condition, detail = "") => {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
    failures.push(label);
  }
};

const document = {
  board: {
    opponent: {
      active: "o0",
      bench: [],
      hand: { count: 2, known: [] },
      prizes: { known: [], remaining: 3 },
    },
    self: {
      active: "s0",
      bench: [],
      hand: { count: 4, known: [] },
      prizes: { known: [], remaining: 4 },
    },
  },
  determinacy: "whole",
  diagnostics: [],
  groups: [],
  prefix: { line: 1, phase: 0, turn: 1 },
  properties: { hp: {}, targeting: {} },
  provenance: { logHash: "sha256:smoke", playerName: "Alice", solver: "0.0.0" },
  schema: "ptcgl-state/1",
  slots: [
    { damage: 0, group: null, id: "s0", name: "Slowking", zone: "active" },
    { damage: 0, group: null, id: "o0", name: "Beedrill ex", zone: "active" },
  ],
};

console.log("document validation:");
const valid = validateDocument(document);
check("accepts a whole document", isOk(valid), valid.ok ? "" : String(valid.error.message));

const divergent = {
  ...document,
  determinacy: "divergent",
  slots: [
    { damage: 0, group: null, id: "s0", name: "Slowking", zone: "active" },
    { group: "g0", id: "s1", name: "Kangaskhan", zone: "bench" },
  ],
  board: {
    ...document.board,
    self: { ...document.board.self, bench: ["s1"] },
  },
  groups: [
    {
      candidates: [{ s1: { attachments: [], damage: 30 } }],
      id: "g0",
      members: ["s1"],
      name: "Kangaskhan",
      resolvedAt: null,
      side: "self",
      since: { line: 2, phase: 0, turn: 1 },
    },
  ],
};
check("rejects divergent with no divergent group", isErr(validateDocument(divergent)));

console.log("results:");
check("ok()", ok(1).value === 1);
check("err()", err(new Error("x")).ok === false);
check("unwrap()", unwrap(ok(2)) === 2);
check(
  "unwrap() throws the error",
  (() => {
    try {
      unwrap(err(new InvalidStateDocumentError([])));
      return false;
    } catch (error) {
      return error instanceof InvalidStateDocumentError;
    }
  })(),
);

// The lowering reads a parsed battle log. Building one by hand keeps this
// script independent of the parser's own module resolution: what is under test
// here is this package's export surface inside the packed tarball.
console.log("lowering:");
const damageLine = "Alice's Slowking used Seek Inspiration on Bob’s Celebi for 110 damage.";
const parsed = {
  phases: [
    {
      displayTurnNumber: 1,
      kind: "Turn",
      mainEntries: [
        {
          event: {
            groups: {
              attackingPlayerName: "Alice",
              attackingPokemonCardName: "Slowking",
              attackName: "Seek Inspiration",
              defendingPlayerName: "Bob",
              numDamage: "110",
              targetPokemonCardName: "Celebi",
            },
            candidateKeys: ["blog_loc_applied_damage"],
            raw: damageLine,
            templateKey: "blog_loc_applied_damage",
          },
          subEntries: [],
        },
      ],
      playerName: "Alice",
      plainTextPhaseTitle: "Alice's Turn",
      side: "self",
      sideSource: "declared",
    },
  ],
};
const lowered = lower(parsed, `Setup\n${damageLine}\n`);
check("lower() succeeds", isOk(lowered), lowered.ok ? "" : String(lowered.error));
if (lowered.ok) {
  const [event] = lowered.value.events;
  check("lowers one damage event", lowered.value.events.length === 1);
  check(
    "attributes the damage to both sides",
    event?.kind === "damage"
      && event.source?.side === "self"
      && event.target.side === "opponent"
      && event.amount === 110,
  );
  check("finds the line", event?.at.line === 2, String(event?.at.line));
}

if (failures.length > 0) {
  console.error(`\nSMOKE FAILED — ${failures.length} check(s): ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nSMOKE OK");
