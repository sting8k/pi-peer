import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Shared storage seam for the standalone pi-peer runtime.
 *
 * Owns the two file-system primitives every peer-talk artifact depends on:
 *  - `safeKey`: namespace-safe path-component sanitization (fail-safe against
 *    empty / `.` / `..` so a key can never escape its storage namespace),
 *  - `readJson` / `writeAtomic`: duplicate-free, atomic JSON persistence.
 *
 * protocol, history, service and herdr all import from here instead of
 * re-implementing path-key or atomic-write logic.
 */

/** Sanitize a value into a single safe path component. */
export function safeKey(value: string): string {
  const sanitized = String(value).replace(/[^A-Za-z0-9._-]/g, "_");
  // Empty, `.` and `..` would form a dot-segment that can escape the namespace.
  if (sanitized === "" || sanitized === "." || sanitized === "..") return "_";
  return sanitized;
}

export function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Read JSON, distinguishing an unusable *file* from an unusable *read*.
 *
 * `readJson` collapses both into `null`, which is right for callers that only
 * need a value and wrong for callers that delete on failure: a transient
 * `EBUSY`/`EPERM`/`EACCES` (Windows AV, indexer, concurrent writer) is not
 * evidence that the file is corrupt. Callers that destroy data must use this.
 */
export function readJsonChecked(path: string): { ok: true; value: unknown } | { ok: false; retryable: boolean } {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return { ok: false, retryable: false };
    // Default to retryable for anything that is not confirmed-absent: an
    // unknown error code must fail safe by keeping the file, not deleting it.
    return { ok: false, retryable: true };
  }
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (error) {
    if (error instanceof SyntaxError) return { ok: false, retryable: false };
    return { ok: false, retryable: true };
  }
}

export function writeAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  renameSync(temp, path);
}