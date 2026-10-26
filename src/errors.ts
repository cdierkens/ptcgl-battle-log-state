/**
 * Errors are values first and exceptions second.
 *
 * Every class here extends `Error` so `instanceof` works, and carries `_tag` so
 * a narrowing check can discriminate without relying on the class identity.
 */

/** One reason a document was rejected, with the path that failed. */
export interface ValidationIssue {
  /** A dotted path into the document, e.g. `groups[0].candidates[1].s2`. */
  readonly path: string;
  readonly message: string;
}

/**
 * No side could be resolved for any player.
 *
 * Lowering needs a name-to-side map; without one every card reference is
 * meaningless. That happens only for a log with no turn header at all, which is
 * a structural problem rather than an ambiguous one.
 */
export class UnresolvedPlayersError extends Error {
  readonly _tag = "UnresolvedPlayersError";

  constructor() {
    super("no player side could be resolved from the log's turn headers");
    this.name = "UnresolvedPlayersError";
  }
}
/**
 * A document that does not satisfy the schema or its semantic invariants.
 *
 * Structural problems and semantic ones are reported together when possible: a
 * caller that fixes only the shape should not have to run the validator twice.
 */
export class InvalidStateDocumentError extends Error {
  readonly _tag = "InvalidStateDocumentError";
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    const count = issues.length;
    super(`Invalid state document (${count} ${count === 1 ? "issue" : "issues"})`);
    this.name = "InvalidStateDocumentError";
    this.issues = issues;
  }
}
