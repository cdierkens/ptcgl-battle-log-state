/**
 * `validateDocument` — the gate between a stored document and a consumer.
 *
 * JSON Schema can express the shape, but not the invariants that make a
 * document *trustworthy*: that a group's candidates agree, that a divergent
 * document actually diverges, that a slot inside a group does not smuggle in a
 * value the group was supposed to hold. Those are checked here, and they are why
 * this function exists at all.
 *
 * Structural issues and semantic issues are reported together when possible: a
 * caller that fixes only the shape should not have to run the validator twice.
 */

import { InvalidStateDocumentError, type ValidationIssue } from "./errors.js";
import { err, ok, type Result } from "./result.js";
import type {
  BoardSide,
  CandidateValues,
  Diagnostic,
  Determinacy,
  GroupCandidate,
  HiddenZone,
  HpBound,
  IdentityGroup,
  Prefix,
  PrizeZone,
  PropertyBlock,
  PropertySource,
  Provenance,
  Side,
  Slot,
  StateDocument,
  StateSchema,
  TargetingBound,
  Zone,
} from "./types.js";

type JsonRecord = Record<string, unknown>;

/** Issues collected while walking a document. */
class Issues {
  private readonly list: ValidationIssue[] = [];

  add(path: string, message: string): void {
    this.list.push({ message, path });
  }

  get count(): number {
    return this.list.length;
  }

  collect(): readonly ValidationIssue[] {
    return this.list;
  }
}

const SIDES: readonly Side[] = ["self", "opponent"];
const ZONES: readonly Zone[] = ["active", "bench"];
const DETERMINACIES: readonly Determinacy[] = ["whole", "divergent", "unexecutable"];
const SOURCES: readonly PropertySource[] = ["observed", "assumed", "unknown"];
/**
 * The major this build validates.
 *
 * A v1 validator must not accept a v2 document: the shapes may differ, and
 * silently accepting it would hand a consumer a document it does not understand.
 * When v2 lands it ships as a new major of the package, not as a widened regex.
 */
const SCHEMA_MAJOR = 1;
const STATE_SCHEMA = /^ptcgl-state\/(\d+)$/u;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Read a required field without asserting its type. */
const field = (source: JsonRecord, key: string, path: string, issues: Issues): unknown => {
  if (!(key in source)) {
    issues.add(`${path}.${key}`, "is required");
    return undefined;
  }
  return source[key];
};

const asRecord = (value: unknown, path: string, issues: Issues): JsonRecord | undefined => {
  if (!isRecord(value)) {
    issues.add(path, "expected an object");
    return undefined;
  }
  return value;
};

const asString = (value: unknown, path: string, issues: Issues): string | undefined => {
  if (typeof value !== "string") {
    issues.add(path, "expected a string");
    return undefined;
  }
  return value;
};

const asInteger = (value: unknown, path: string, issues: Issues): number | undefined => {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    issues.add(path, "expected an integer");
    return undefined;
  }
  return value;
};

const asCount = (value: unknown, path: string, issues: Issues): number | undefined => {
  const parsed = asInteger(value, path, issues);
  if (parsed !== undefined && parsed < 0) {
    issues.add(path, "expected a non-negative integer");
    return undefined;
  }
  return parsed;
};

const asOneOf = <T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
  issues: Issues,
): T | undefined => {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    issues.add(path, `expected one of ${allowed.join(", ")}`);
    return undefined;
  }
  // The membership check above is the proof; TypeScript cannot follow it.
  return value as T;
};

const asStringArray = (value: unknown, path: string, issues: Issues): readonly string[] | undefined => {
  if (!Array.isArray(value)) {
    issues.add(path, "expected an array of strings");
    return undefined;
  }
  const out: string[] = [];
  value.forEach((item, index) => {
    if (typeof item !== "string") {
      issues.add(`${path}[${index}]`, "expected a string");
      return;
    }
    out.push(item);
  });
  return out;
};

const read = <T>(
  source: JsonRecord,
  key: string,
  path: string,
  issues: Issues,
  parse: (value: unknown, path: string, issues: Issues) => T | undefined,
): T | undefined => parse(field(source, key, path, issues), `${path}.${key}`, issues);

const readNullableInteger = (
  source: JsonRecord,
  key: string,
  path: string,
  issues: Issues,
): number | null | undefined => {
  const value = field(source, key, path, issues);
  if (value === null) {
    return null;
  }
  return asInteger(value, `${path}.${key}`, issues);
};

const parseSchema = (source: JsonRecord, path: string, issues: Issues): StateSchema | undefined => {
  const raw = read(source, "schema", path, issues, asString);
  if (raw === undefined) {
    return undefined;
  }
  const major = Number(STATE_SCHEMA.exec(raw)?.[1]);
  if (!Number.isInteger(major)) {
    issues.add(`${path}.schema`, "expected ptcgl-state/<major>");
    return undefined;
  }
  if (major !== SCHEMA_MAJOR) {
    issues.add(
      `${path}.schema`,
      `this build validates ptcgl-state/${SCHEMA_MAJOR}, not ptcgl-state/${major}`,
    );
    return undefined;
  }
  return `ptcgl-state/${SCHEMA_MAJOR}`;
};

const parsePrefix = (value: unknown, path: string, issues: Issues): Prefix | undefined => {
  const source = asRecord(value, path, issues);
  if (source === undefined) {
    return undefined;
  }
  const phase = read(source, "phase", path, issues, asCount);
  const turn = readNullableInteger(source, "turn", path, issues);
  const line = read(source, "line", path, issues, asCount);
  if (phase === undefined || turn === undefined || line === undefined) {
    return undefined;
  }
  return { line, phase, turn };
};

const parseHiddenZone = (value: unknown, path: string, issues: Issues): HiddenZone | undefined => {
  const source = asRecord(value, path, issues);
  if (source === undefined) {
    return undefined;
  }
  const count = read(source, "count", path, issues, asCount);
  const known = read(source, "known", path, issues, asStringArray);
  if (count === undefined || known === undefined) {
    return undefined;
  }
  return { count, known };
};

const parsePrizeZone = (value: unknown, path: string, issues: Issues): PrizeZone | undefined => {
  const source = asRecord(value, path, issues);
  if (source === undefined) {
    return undefined;
  }
  const remaining = read(source, "remaining", path, issues, asCount);
  const known = read(source, "known", path, issues, asStringArray);
  if (remaining === undefined || known === undefined) {
    return undefined;
  }
  return { known, remaining };
};

const parseBoardSide = (value: unknown, path: string, issues: Issues): BoardSide | undefined => {
  const source = asRecord(value, path, issues);
  if (source === undefined) {
    return undefined;
  }
  const active = read(source, "active", path, issues, asString);
  const bench = read(source, "bench", path, issues, asStringArray);
  const hand = read(source, "hand", path, issues, parseHiddenZone);
  const prizes = read(source, "prizes", path, issues, parsePrizeZone);
  if (active === undefined || bench === undefined || hand === undefined || prizes === undefined) {
    return undefined;
  }
  return { active, bench, hand, prizes };
};

const parseSlot = (value: unknown, path: string, issues: Issues): Slot | undefined => {
  const source = asRecord(value, path, issues);
  if (source === undefined) {
    return undefined;
  }
  const id = read(source, "id", path, issues, asString);
  const name = read(source, "name", path, issues, asString);
  const zone = read(source, "zone", path, issues, (v, p, i) => asOneOf(v, ZONES, p, i));
  const rawGroup = field(source, "group", path, issues);
  const group = rawGroup === null ? null : asString(rawGroup, `${path}.group`, issues);
  if (id === undefined || name === undefined || zone === undefined || group === undefined) {
    return undefined;
  }
  const damage = "damage" in source ? read(source, "damage", path, issues, asCount) : undefined;
  const attachments = "attachments" in source
    ? read(source, "attachments", path, issues, asStringArray)
    : undefined;
  if ((damage === undefined && "damage" in source) || (attachments === undefined && "attachments" in source)) {
    return undefined;
  }
  return {
    ...(attachments === undefined ? {} : { attachments }),
    ...(damage === undefined ? {} : { damage }),
    group,
    id,
    name,
    zone,
  };
};

const parseCandidateValues = (value: unknown, path: string, issues: Issues): CandidateValues | undefined => {
  const source = asRecord(value, path, issues);
  if (source === undefined) {
    return undefined;
  }
  const damage = read(source, "damage", path, issues, asCount);
  const attachments = read(source, "attachments", path, issues, asStringArray);
  if (damage === undefined || attachments === undefined) {
    return undefined;
  }
  return { attachments, damage };
};

const parseGroupCandidate = (value: unknown, path: string, issues: Issues): GroupCandidate | undefined => {
  const source = asRecord(value, path, issues);
  if (source === undefined) {
    return undefined;
  }
  const entries: [string, CandidateValues][] = [];
  for (const [memberId, raw] of Object.entries(source)) {
    const parsed = parseCandidateValues(raw, `${path}.${memberId}`, issues);
    if (parsed === undefined) {
      return undefined;
    }
    entries.push([memberId, parsed]);
  }
  return Object.fromEntries(entries);
};

const parseGroup = (value: unknown, path: string, issues: Issues): IdentityGroup | undefined => {
  const source = asRecord(value, path, issues);
  if (source === undefined) {
    return undefined;
  }
  const id = read(source, "id", path, issues, asString);
  const side = read(source, "side", path, issues, (v, p, i) => asOneOf(v, SIDES, p, i));
  const name = read(source, "name", path, issues, asString);
  const members = read(source, "members", path, issues, asStringArray);
  const since = read(source, "since", path, issues, parsePrefix);
  const resolvedAt = "resolvedAt" in source && source.resolvedAt !== null
    ? parsePrefix(source.resolvedAt, `${path}.resolvedAt`, issues)
    : null;
  const rawCandidates = field(source, "candidates", path, issues);
  const candidates: GroupCandidate[] = [];
  if (Array.isArray(rawCandidates)) {
    rawCandidates.forEach((item, index) => {
      const parsed = parseGroupCandidate(item, `${path}.candidates[${index}]`, issues);
      if (parsed !== undefined) {
        candidates.push(parsed);
      }
    });
  } else if (rawCandidates !== undefined) {
    issues.add(`${path}.candidates`, "expected an array");
  }
  if (
    id === undefined || side === undefined || name === undefined || members === undefined
    || since === undefined || resolvedAt === undefined
    || !Array.isArray(rawCandidates) || candidates.length !== rawCandidates.length
  ) {
    return undefined;
  }
  return { candidates, id, members, name, resolvedAt, side, since };
};

const parseHpBound = (value: unknown, path: string, issues: Issues): HpBound | undefined => {
  const source = asRecord(value, path, issues);
  if (source === undefined) {
    return undefined;
  }
  const min = read(source, "min", path, issues, asCount);
  const max = read(source, "max", path, issues, asCount);
  const source_ = read(source, "source", path, issues, (v, p, i) => asOneOf(v, SOURCES, p, i));
  if (min === undefined || max === undefined || source_ === undefined) {
    return undefined;
  }
  return { max, min, source: source_ };
};

const parseTargetingBound = (value: unknown, path: string, issues: Issues): TargetingBound | undefined => {
  const source = asRecord(value, path, issues);
  if (source === undefined) {
    return undefined;
  }
  const rawBench = field(source, "bench", path, issues);
  let bench: boolean | null;
  if (rawBench === null) {
    bench = null;
  } else if (typeof rawBench === "boolean") {
    bench = rawBench;
  } else {
    issues.add(`${path}.bench`, "expected a boolean or null");
    return undefined;
  }
  const source_ = read(source, "source", path, issues, (v, p, i) => asOneOf(v, SOURCES, p, i));
  if (source_ === undefined) {
    return undefined;
  }
  return { bench, source: source_ };
};

const parseRecordOf = <T>(
  value: unknown,
  path: string,
  issues: Issues,
  parse: (value: unknown, path: string, issues: Issues) => T | undefined,
): Readonly<Record<string, T>> | undefined => {
  const source = asRecord(value, path, issues);
  if (source === undefined) {
    return undefined;
  }
  const entries: [string, T][] = [];
  for (const [key, raw] of Object.entries(source)) {
    const parsed = parse(raw, `${path}.${key}`, issues);
    if (parsed === undefined) {
      return undefined;
    }
    entries.push([key, parsed]);
  }
  return Object.fromEntries(entries);
};

const parseProperties = (value: unknown, path: string, issues: Issues): PropertyBlock | undefined => {
  const source = asRecord(value, path, issues);
  if (source === undefined) {
    return undefined;
  }
  const hp = read(source, "hp", path, issues, (v, p, i) => parseRecordOf(v, p, i, parseHpBound));
  const targeting = read(source, "targeting", path, issues, (v, p, i) => parseRecordOf(v, p, i, parseTargetingBound));
  if (hp === undefined || targeting === undefined) {
    return undefined;
  }
  return { hp, targeting };
};

const parseDiagnostic = (value: unknown, path: string, issues: Issues): Diagnostic | undefined => {
  const source = asRecord(value, path, issues);
  if (source === undefined) {
    return undefined;
  }
  const severity = read(source, "severity", path, issues, (v, p, i) =>
    asOneOf(v, ["warning", "error"] as const, p, i));
  const code = read(source, "code", path, issues, asString);
  const message = read(source, "message", path, issues, asString);
  const line = "line" in source ? read(source, "line", path, issues, asCount) : undefined;
  if (severity === undefined || code === undefined || message === undefined) {
    return undefined;
  }
  if (line === undefined && "line" in source) {
    return undefined;
  }
  return { ...(line === undefined ? {} : { line }), code, message, severity };
};

const parseProvenance = (value: unknown, path: string, issues: Issues): Provenance | undefined => {
  const source = asRecord(value, path, issues);
  if (source === undefined) {
    return undefined;
  }
  const logHash = read(source, "logHash", path, issues, asString);
  const rawPlayer = field(source, "playerName", path, issues);
  const playerName = rawPlayer === null ? null : asString(rawPlayer, `${path}.playerName`, issues);
  const solver = read(source, "solver", path, issues, asString);
  if (logHash === undefined || playerName === undefined || solver === undefined) {
    return undefined;
  }
  return { logHash, playerName, solver };
};

const parseDocument = (value: unknown, issues: Issues): StateDocument | undefined => {
  const path = "$";
  const source = asRecord(value, path, issues);
  if (source === undefined) {
    return undefined;
  }
  const schema = parseSchema(source, path, issues);
  const determinacy = read(source, "determinacy", path, issues, (v, p, i) =>
    asOneOf(v, DETERMINACIES, p, i));
  const prefix = read(source, "prefix", path, issues, parsePrefix);
  const provenance = read(source, "provenance", path, issues, parseProvenance);
  const rawBoard = field(source, "board", path, issues);
  const board = asRecord(rawBoard, `${path}.board`, issues);
  const self = board === undefined ? undefined : parseBoardSide(board.self, `${path}.board.self`, issues);
  const opponent = board === undefined ? undefined : parseBoardSide(board.opponent, `${path}.board.opponent`, issues);

  const rawSlots = field(source, "slots", path, issues);
  const slots: Slot[] = [];
  if (Array.isArray(rawSlots)) {
    rawSlots.forEach((item, index) => {
      const parsed = parseSlot(item, `${path}.slots[${index}]`, issues);
      if (parsed !== undefined) {
        slots.push(parsed);
      }
    });
  } else if (rawSlots !== undefined) {
    issues.add(`${path}.slots`, "expected an array");
  }

  const rawGroups = field(source, "groups", path, issues);
  const groups: IdentityGroup[] = [];
  if (Array.isArray(rawGroups)) {
    rawGroups.forEach((item, index) => {
      const parsed = parseGroup(item, `${path}.groups[${index}]`, issues);
      if (parsed !== undefined) {
        groups.push(parsed);
      }
    });
  } else if (rawGroups !== undefined) {
    issues.add(`${path}.groups`, "expected an array");
  }

  const properties = read(source, "properties", path, issues, parseProperties);

  const rawDiagnostics = field(source, "diagnostics", path, issues);
  const diagnostics: Diagnostic[] = [];
  if (Array.isArray(rawDiagnostics)) {
    rawDiagnostics.forEach((item, index) => {
      const parsed = parseDiagnostic(item, `${path}.diagnostics[${index}]`, issues);
      if (parsed !== undefined) {
        diagnostics.push(parsed);
      }
    });
  } else if (rawDiagnostics !== undefined) {
    issues.add(`${path}.diagnostics`, "expected an array");
  }

  if (
    schema === undefined || determinacy === undefined || prefix === undefined || provenance === undefined
    || self === undefined || opponent === undefined || properties === undefined
    || !Array.isArray(rawSlots) || slots.length !== rawSlots.length
    || !Array.isArray(rawGroups) || groups.length !== rawGroups.length
    || !Array.isArray(rawDiagnostics) || diagnostics.length !== rawDiagnostics.length
  ) {
    return undefined;
  }

  return {
    board: { opponent, self },
    determinacy,
    diagnostics,
    groups,
    prefix,
    properties,
    provenance,
    schema,
    slots,
  };
};

/** A candidate's values, canonicalised so two candidates can be compared. */
const candidateValueKey = (values: CandidateValues): string =>
  `${values.damage}|${[...values.attachments].sort().join(",")}`;

/** The multiset of values a candidate assigns, as a sorted list. */
const candidateMultiset = (candidate: GroupCandidate): readonly string[] =>
  Object.values(candidate).map(candidateValueKey).sort();

/**
 * Check the invariants JSON Schema cannot express.
 *
 * The one that matters most: a group reorders evidence, it never invents or
 * loses any. Every candidate must assign the same multiset of values, or the
 * solver has manufactured or dropped damage and the document is a lie.
 */
const checkSemantics = (document: StateDocument, issues: Issues): void => {
  const byId = new Map<string, Slot>();
  for (const slot of document.slots) {
    if (byId.has(slot.id)) {
      issues.add(`$.slots`, `duplicate slot id ${slot.id}`);
      continue;
    }
    byId.set(slot.id, slot);
  }

  // Every slot belongs to exactly one side's board. Without this, the same id
  // could be the Active Pokémon of both sides, and a slot referenced by neither
  // board would sit in the document as unreachable data.
  const sidesOfSlot = new Map<string, Side>();

  for (const side of SIDES) {
    const board = document.board[side];
    const references: { readonly id: string; readonly expected: Zone; readonly path: string }[] = [
      { expected: "active", id: board.active, path: `$.board.${side}.active` },
      ...board.bench.map((id) => ({ expected: "bench" as const, id, path: `$.board.${side}.bench` })),
    ];

    for (const reference of references) {
      const slot = byId.get(reference.id);
      if (slot === undefined) {
        issues.add(reference.path, `unknown slot ${reference.id}`);
        continue;
      }
      if (slot.zone !== reference.expected) {
        issues.add(reference.path, `slot ${slot.id} is not a ${reference.expected} slot`);
      }
      if (sidesOfSlot.has(reference.id)) {
        issues.add(reference.path, `slot ${reference.id} is referenced more than once`);
        continue;
      }
      sidesOfSlot.set(reference.id, side);
    }
  }

  const groupsById = new Map<string, IdentityGroup>();
  document.groups.forEach((group, index) => {
    const path = `$.groups[${index}]`;
    if (groupsById.has(group.id)) {
      issues.add(path, `duplicate group id ${group.id}`);
      return;
    }
    groupsById.set(group.id, group);

    if (group.members.length === 0) {
      issues.add(`${path}.members`, "a group must cover at least one slot");
    }
    if (group.candidates.length === 0) {
      issues.add(`${path}.candidates`, "a group must have at least one candidate");
    }

    for (const memberId of group.members) {
      const member = byId.get(memberId);
      if (member === undefined) {
        issues.add(`${path}.members`, `unknown slot ${memberId}`);
        continue;
      }
      if (member.group !== group.id) {
        issues.add(`${path}.members`, `slot ${memberId} does not point at group ${group.id}`);
      }
      if (member.name !== group.name) {
        issues.add(`${path}.members`, `slot ${memberId} is named ${member.name}, not ${group.name}`);
      }
      if (member.damage !== undefined || member.attachments !== undefined) {
        issues.add(`${path}.members`, `slot ${memberId} carries values that belong in candidates`);
      }
    }

    document.slots.forEach((slot, slotIndex) => {
      if (slot.group === group.id && !group.members.includes(slot.id)) {
        issues.add(`$.slots[${slotIndex}]`, `slot ${slot.id} claims group ${group.id} but is not a member`);
      }
    });

    const memberSet = [...group.members].sort();
    for (const [candidateIndex, candidate] of group.candidates.entries()) {
      const candidatePath = `${path}.candidates[${candidateIndex}]`;
      const assigned = Object.keys(candidate).sort();
      if (assigned.length !== memberSet.length || assigned.some((id, i) => id !== memberSet[i])) {
        issues.add(candidatePath, `must assign exactly [${memberSet.join(", ")}]`);
        continue;
      }
      for (const [memberId, values] of Object.entries(candidate)) {
        if (values.attachments.some((attachment) => attachment.length === 0)) {
          issues.add(`${candidatePath}.${memberId}.attachments`, "expected non-empty card names");
        }
      }
    }

    const multisets = group.candidates.map(candidateMultiset);
    const [first, ...rest] = multisets;
    if (first !== undefined) {
      for (const [candidateIndex, multiset] of rest.entries()) {
        if (multiset.join("\u0000") !== first.join("\u0000")) {
          issues.add(
            `${path}.candidates[${candidateIndex + 1}]`,
            "candidates must carry the same multiset of values",
          );
        }
      }
    }
  });

  for (const [index, slot] of document.slots.entries()) {
    if (!sidesOfSlot.has(slot.id)) {
      issues.add(`$.slots[${index}]`, `slot ${slot.id} is not on either board`);
    }
    if (slot.group === null) {
      if (slot.damage === undefined) {
        issues.add(`$.slots[${index}]`, "a slot outside a group must carry its own damage");
      }
      continue;
    }
    if (!groupsById.has(slot.group)) {
      issues.add(`$.slots[${index}]`, `unknown group ${slot.group}`);
    }
  }

  if (document.determinacy === "whole") {
    for (const [index, group] of document.groups.entries()) {
      if (group.candidates.length > 1) {
        issues.add(
          `$.determinacy`,
          `whole contradicts groups[${index}], which has ${group.candidates.length} candidates`,
        );
      }
    }
  }

  if (document.determinacy === "divergent") {
    const anyDivergent = document.groups.some((group) => group.candidates.length > 1);
    if (!anyDivergent) {
      issues.add("$.determinacy", "divergent requires at least one group with two or more candidates");
    }
  }

  if (document.determinacy === "unexecutable") {
    // R4: an unexecutable document must point at the line that broke it, or the
    // defect it reports is untraceable.
    const traceable = document.diagnostics.some(
      (diagnostic) => diagnostic.severity === "error" && diagnostic.line !== undefined,
    );
    if (!traceable) {
      issues.add(
        "$.diagnostics",
        "unexecutable requires an error diagnostic carrying the offending line",
      );
    }
  }
};

/**
 * Validate an unknown value as a {@link StateDocument}.
 *
 * Returns every issue it found, not the first, and never throws.
 */
export const validateDocument = (value: unknown): Result<StateDocument, InvalidStateDocumentError> => {
  const issues = new Issues();
  const document = parseDocument(value, issues);

  if (document === undefined || issues.count > 0) {
    return err(new InvalidStateDocumentError(issues.collect()));
  }

  checkSemantics(document, issues);
  if (issues.count > 0) {
    return err(new InvalidStateDocumentError(issues.collect()));
  }

  return ok(document);
};
