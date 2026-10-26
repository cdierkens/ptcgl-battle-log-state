/**
 * A minimal, dependency-free result type.
 *
 * This package reports two kinds of failure as values rather than exceptions: a
 * document that does not validate, and a lowering or solver step that cannot
 * proceed. Both are things a caller usually branches on, so the happy path
 * needs no wrapper.
 *
 * The discriminant is `ok`, not `_tag`. Every error this package throws is also
 * a `class extends Error` carrying an `_tag` (see `errors.ts`), so `_tag` means
 * "this is a known error type" and `ok` means "this call succeeded". Keeping the
 * two vocabularies distinct means a narrowing check reads the same whether you
 * are inspecting a result or catching an error.
 */

/** A successful computation, carrying `value`. */
export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

/** A failed computation, carrying `error`. */
export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

/** Either a success carrying a `T`, or a failure carrying an `E`. */
export type Result<T, E> = Err<E> | Ok<T>;

/** Wrap a value as a successful {@link Result}. */
export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });

/** Wrap an error as a failed {@link Result}. */
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

/** Type guard for the success arm. */
export const isOk = <T, E>(result: Result<T, E>): result is Ok<T> => result.ok;

/** Type guard for the failure arm. */
export const isErr = <T, E>(result: Result<T, E>): result is Err<E> => !result.ok;

/** Get the value, or throw the error. The one place a failure becomes an exception. */
export const unwrap = <T, E extends Error>(result: Result<T, E>): T => {
  if (isErr(result)) {
    throw result.error;
  }
  return result.value;
};
