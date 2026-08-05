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

export function readJson(path: string): any | null {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function writeAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  renameSync(temp, path);
}