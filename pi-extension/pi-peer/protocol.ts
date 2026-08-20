import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { readJson, safeKey, writeAtomic } from "./storage.ts";
import type { HerdrAgentStatus, HerdrPeerContext } from "./herdr.ts";

/**
 * Peer-chat wire protocol (protocol v1) and mailbox operations for the
 * standalone pi-peer runtime.
 *
 * Invariants of the peer-chat protocol:
 *  - Herdr-only, workspace identity verified on every status read,
 *  - atomic mailbox writes (`writeAtomic`) with queued -> `.processing` state,
 *  - symmetric, send-only semantics: `talk_to` enqueues one durable message and
 *    returns delivery confirmation; a reply is simply another `talk_to` in the
 *    opposite direction. There is no request/response correlation, no waiter,
 *    no `<peer_pong>`.
 *
 * This module is source-independent: no dependency on any host agent extension.
 */

export interface PeerRecord {
  schemaVersion: 1;
  sessionId: string;
  name: string;
  cwd: string;
  workspaceId: string;
  paneId: string;
  terminalId: string;
  tabId?: string;
  registrationId?: string;
  createdAt: string;
}

/**
 * A single durable chat message enqueued by `talk_to` into a target's inbox.
 * `from` is the full session id (internal addressing); `fromName` is the stable
 * display name used when rendering the inbound `<peer_message>` tag. The public
 * peer id (`peer-<last 3>`) is derived from `from` centrally at render time and
 * is the only user-facing sender identity — neither the full session id nor the
 * internal message `id` is ever exposed to the receiving agent.
 */
export interface PeerMessage {
  version: 1;
  type: "peer_message";
  id: string;
  from: string;
  fromName: string;
  to: string;
  message: string;
  createdAt: string;
}

export const POLL_MS = 250;
export const HEARTBEAT_INTERVAL_MS = 10_000;
/** A registration older than this is treated as a dead peer (no heartbeat). */
export const RECORD_STALE_MS = 60_000;
/**
 * Cross-session GC: a registration older than this (no heartbeat, no clean
 * shutdown) is a dead session whose whole artifact set is removed. 24 h is
 * far beyond any laptop suspension; deletion also requires one 5-minute
 * re-observation grace interval after the TTL is crossed.
 */
export const DEAD_SESSION_TTL_MS = 24 * 60 * 60_000;
/** Cadence for the cross-session dead-session sweep on the idle poll. */
export const DEAD_SESSION_SWEEP_MS = 5 * 60_000;
const REGISTRATION_LOCK_RETRY_MS = 10;
const REGISTRATION_LOCK_STALE_MS = 30_000;

export const PEER_NAME_POOL = [
  "Mark", "Coco", "Dario", "Rex", "Tibo", "Bella", "Xi", "Peanut", "Pooh", "Biscuit",
  "Mario", "Simba", "Elon", "Daisy", "Dax", "Momo", "Sam", "Gizmo", "Sundar", "Zhang",
] as const;

function peerNameHash(sessionId: string): number {
  let hash = 5381;
  for (const character of sessionId) {
    hash = (((hash << 5) + hash) ^ (character.codePointAt(0) ?? 0)) >>> 0;
  }
  return hash;
}

export function pickPeerName(sessionId: string, taken: Set<string>): string {
  const takenNames = new Set([...taken].map((name) => name.toLowerCase()));
  const start = peerNameHash(sessionId) % PEER_NAME_POOL.length;
  for (let offset = 0; offset < PEER_NAME_POOL.length; offset++) {
    const name = PEER_NAME_POOL[(start + offset) % PEER_NAME_POOL.length];
    if (!takenNames.has(name.toLowerCase())) return name;
  }
  for (let suffix = 2; ; suffix++) {
    for (let offset = 0; offset < PEER_NAME_POOL.length; offset++) {
      const name = `${PEER_NAME_POOL[(start + offset) % PEER_NAME_POOL.length]}-${suffix}`;
      if (!takenNames.has(name.toLowerCase())) return name;
    }
  }
}

/**
 * Derive the public peer id from a full session id: `peer-<last 3 chars>`.
 *
 * The full session id stays the internal identity (artifact paths, inbox
 * addressing, history source); this is the only user-facing formatter. A
 * session id shorter than 3 characters yields the whole id as the suffix
 * (`peer-a`, `peer-ab`); an empty input fails closed (records guarantee
 * non-empty session ids).
 */
export function publicPeerId(sessionId: string): string {
  if (!sessionId) throw new Error("publicPeerId requires a non-empty session id");
  return `peer-${sessionId.slice(-3)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function sessionDir(root: string): string {
  return join(root, "sessions");
}

function registrationLockPath(root: string): string {
  return join(sessionDir(root), ".registration-lock");
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" ? (error as NodeJS.ErrnoException).code : undefined;
}

function isAlreadyExistsError(error: unknown): boolean {
  return errorCode(error) === "EEXIST";
}

function isMissingError(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

/** Serialize name selection and registration writes across peer processes. */
export async function withRegistrationLock<T>(root: string, action: () => T | Promise<T>): Promise<T> {
  const lockPath = registrationLockPath(root);
  const ownerPath = join(lockPath, "owner");
  const ownerToken = `${process.pid}-${randomUUID()}`;
  mkdirSync(sessionDir(root), { recursive: true, mode: 0o700 });

  for (;;) {
    let createdLock = false;
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      createdLock = true;
      writeFileSync(ownerPath, ownerToken, { encoding: "utf8", flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      if (createdLock) rmSync(lockPath, { recursive: true, force: true });
      if (!isAlreadyExistsError(error)) throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > REGISTRATION_LOCK_STALE_MS) {
          rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {
        // The lock was released between stat/rm; retry the acquisition.
      }
      await new Promise((resolve) => setTimeout(resolve, REGISTRATION_LOCK_RETRY_MS));
    }
  }

  try {
    return await action();
  } finally {
    try {
      if (readFileSync(ownerPath, "utf8") === ownerToken) {
        rmSync(lockPath, { recursive: true, force: true });
      }
    } catch {
      // Another process already recovered or replaced a stale lock.
    }
  }
}

export function inboxDir(root: string, sessionId: string): string {
  return join(root, "inbox", safeKey(sessionId));
}

export function recordPath(root: string, sessionId: string): string {
  return join(sessionDir(root), `${safeKey(sessionId)}.json`);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isPeerRecord(value: any): value is PeerRecord {
  return value?.schemaVersion === 1
    && nonEmptyString(value.sessionId)
    && nonEmptyString(value.name)
    && nonEmptyString(value.cwd)
    && nonEmptyString(value.workspaceId)
    && nonEmptyString(value.paneId)
    && nonEmptyString(value.terminalId)
    && (value.tabId === undefined || nonEmptyString(value.tabId))
    && (value.registrationId === undefined || nonEmptyString(value.registrationId))
    && nonEmptyString(value.createdAt);
}

export function isPeerMessage(value: any): value is PeerMessage {
  return value?.version === 1
    && value.type === "peer_message"
    && nonEmptyString(value.id)
    && nonEmptyString(value.from)
    && nonEmptyString(value.fromName)
    && nonEmptyString(value.to)
    && nonEmptyString(value.message)
    && nonEmptyString(value.createdAt);
}

/**
 * Requeue a single claimed `.processing` message back to its queued `.json`
 * form so a message that was not fully injected is never lost. Only this one
 * claim is touched — unlike {@link requeueProcessing} (startup orphan
 * recovery, which requeues every claim), this never releases another runtime's
 * in-flight claim. A pre-existing `.json` (an id collision) wins and the
 * `.processing` claim is dropped.
 */
export function requeueClaimedMessage(processingPath: string): void {
  if (!existsSync(processingPath)) return;
  const pending = processingPath.slice(0, -".processing".length);
  try {
    if (existsSync(pending)) rmSync(processingPath, { force: true });
    else renameSync(processingPath, pending);
  } catch (error) {
    if (isAlreadyExistsError(error) && existsSync(pending)) rmSync(processingPath, { force: true });
    else if (!isMissingError(error)) throw error;
  }
}

export function ensureRecord(root: string, record: PeerRecord): void {
  const path = recordPath(root, record.sessionId);
  // Heartbeat: a live session refreshes its registration on a schedule so
  // peers can treat a stale record as death (a crashed process stops
  // refreshing). Check mtime first (one syscall on 39/40 ticks) and only
  // read + possibly touch the record when a refresh is actually due.
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    // Missing or unreadable: (re)create the registration.
    writeAtomic(path, record);
    return;
  }
  if (Date.now() - mtimeMs < HEARTBEAT_INTERVAL_MS) return;
  const current = readJson(path);
  // Never clobber a record owned by a newer runtime; self-repair corrupt
  // records so an unreadable registration cannot stay alive forever.
  if (isPeerRecord(current) && current.registrationId !== record.registrationId) return;
  try {
    // Touch the record (one syscall) instead of re-serializing it.
    utimesSync(path, new Date(), new Date());
  } catch {
    // utimes failed (unlinked concurrently): restore the registration.
    writeAtomic(path, record);
  }
}

/**
 * Cross-session GC: remove artifacts of sessions that no longer exist or
 * whose registration is older than DEAD_SESSION_TTL_MS (crashed / killed, no
 * clean session_shutdown). A stale/missing registration must remain a dead
 * observation for one sweep interval before deletion, so a peer waking from
 * suspension can refresh its record before its queued work is destroyed.
 * A live session is identified by a fresh registration record, which is
 * written before any artifact of a startup. Runs on a slow cadence from any
 * live session's idle poll.
 */
export function sweepDeadSessions(root: string, deadSince: Map<string, number> = new Map()): void {
  const sessionDirPath = sessionDir(root);
  if (!existsSync(sessionDirPath)) return;
  const now = Date.now();
  const liveIds = new Set<string>();
  const observedIds = new Set<string>();
  for (const name of readdirSync(sessionDirPath).filter((n) => n.endsWith(".json"))) {
    const id = name.slice(0, -".json".length);
    observedIds.add(id);
    const path = join(sessionDirPath, name);
    let dead = false;
    try {
      dead = now - statSync(path).mtimeMs > DEAD_SESSION_TTL_MS;
    } catch {
      dead = true;
    }
    if (dead) {
      const firstDead = deadSince.get(id) ?? now;
      deadSince.set(id, firstDead);
      if (now - firstDead < DEAD_SESSION_SWEEP_MS) {
        // One stale read is not enough: the peer may be waking from sleep.
        liveIds.add(id);
        continue;
      }
      deadSince.delete(id);
      rmSync(path, { force: true });
      removeDeadSessionArtifacts(root, id);
    } else {
      deadSince.delete(id);
      liveIds.add(id);
    }
  }
  // Artifact dirs/files whose session record no longer exists at all also get
  // one grace interval, covering a concurrent registration write or cleanup.
  const artifactIds = new Set<string>();
  for (const sub of ["inbox"] as const) {
    const dir = join(root, sub);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      observedIds.add(name);
      artifactIds.add(name);
    }
  }
  const latestPath = join(root, "latest");
  if (existsSync(latestPath)) {
    for (const name of readdirSync(latestPath).filter((n) => n.endsWith(".json"))) {
      const id = name.slice(0, -".json".length);
      observedIds.add(id);
      artifactIds.add(id);
    }
  }
  for (const id of artifactIds) {
    if (liveIds.has(id)) continue;
    const firstDead = deadSince.get(id) ?? now;
    deadSince.set(id, firstDead);
    if (now - firstDead >= DEAD_SESSION_SWEEP_MS) {
      deadSince.delete(id);
      removeDeadSessionArtifacts(root, id);
    }
  }
  for (const id of deadSince.keys()) {
    if (!observedIds.has(id)) deadSince.delete(id);
  }
}

function removeDeadSessionArtifacts(root: string, id: string): void {
  rmSync(join(root, "latest", `${id}.json`), { force: true });
  rmSync(join(root, "inbox", id), { recursive: true, force: true });
}

export function removeOwnedRecord(root: string, record: PeerRecord): void {
  if (!record.registrationId) return;
  const path = recordPath(root, record.sessionId);
  const current = readJson(path);
  if (isPeerRecord(current) && current.registrationId === record.registrationId) {
    rmSync(path, { force: true });
  }
}

export function loadRecords(root: string): PeerRecord[] {
  if (!existsSync(sessionDir(root))) return [];
  return readdirSync(sessionDir(root))
    .filter((name) => name.endsWith(".json"))
    .map((name) => readJson(join(sessionDir(root), name)))
    .filter(isPeerRecord);
}

export function resolveTarget(records: PeerRecord[], target: string): PeerRecord {
  const publicMatches = records.filter((record) => publicPeerId(record.sessionId) === target);
  if (publicMatches.length === 1) return publicMatches[0];
  if (publicMatches.length > 1) throw new Error(`Peer id is ambiguous: ${target}`);
  const exactName = records.filter((record) => record.name === target);
  if (exactName.length === 1) return exactName[0];
  if (exactName.length > 1) throw new Error(`Peer name is ambiguous: ${target}`);
  // Herdr renders agent names in lowercase, but PEER_NAME_POOL is TitleCase, so
  // an agent reading a name off the UI and typing it back would otherwise never
  // match. Exact match is always attempted first, so an exact hit can never be
  // turned into an ambiguity error by this fallback.
  const folded = target.toLowerCase();
  const looseName = records.filter((record) => record.name.toLowerCase() === folded);
  if (looseName.length === 1) return looseName[0];
  if (looseName.length > 1) throw new Error(`Peer name is ambiguous: ${target}`);
  throw new Error(`Peer session not found: ${target}`);
}

/**
 * Requeue a claimed `.processing` message back to its queued `.json` form so a
 * message that was not fully injected is never lost. A pre-existing `.json`
 * (an id collision) wins and the `.processing` claim is dropped.
 */
export function requeueProcessing(root: string, sessionId: string): void {
  const dir = inboxDir(root, sessionId);
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir).filter((entry) => entry.endsWith(".processing"))) {
    requeueClaimedMessage(join(dir, name));
  }
}

export function isRegisteredLive(root: string, sessionId: string): boolean {
  const path = recordPath(root, sessionId);
  try {
    return existsSync(path) && Date.now() - statSync(path).mtimeMs <= RECORD_STALE_MS;
  } catch {
    return false;
  }
}

export async function liveRecords(
  root: string,
  workspaceId: string,
  socketPath: string,
  getStatus: (peerContext: HerdrPeerContext, signal?: AbortSignal) => Promise<HerdrAgentStatus>,
  signal?: AbortSignal,
): Promise<Array<{ record: PeerRecord; status: HerdrAgentStatus }>> {
  const result: Array<{ record: PeerRecord; status: HerdrAgentStatus }> = [];
  for (const record of loadRecords(root)) {
    if (record.workspaceId !== workspaceId) continue;
    // A crashed process stops heartbeating its registration; its stale record
    // is not a live peer even if the Herdr pane still exists.
    if (!isRegisteredLive(root, record.sessionId)) continue;
    try {
      const status = await getStatus({
        paneId: record.paneId,
        terminalId: record.terminalId,
        tabId: record.tabId,
        socketPath,
        workspaceId,
      }, signal);
      result.push({ record, status });
    } catch {
      // A stale or moved Herdr pane is not a live peer.
    }
  }
  return result;
}

// The body is agent-authored text from another peer. A literal peer_message
// delimiter inside it would close the tag early and let the sender forge a
// second block carrying a from/peer_id it does not own, so both delimiters are
// defanged before the body is embedded.
function sealPeerMessageBody(body: string): string {
  // Case- and whitespace-tolerant: the receiving agent reads the wrapper as
  // markup, so any spelling a reader would accept as a tag must be defanged, not
  // only the exact bytes this module emits.
  return body
    .replace(/<\s*\/\s*peer_message\s*>/gi, "&lt;/peer_message&gt;")
    .replace(/<\s*peer_message(?=[\s>/]|$)/gi, "&lt;peer_message");
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * Render an inbound chat message for the receiving agent as a simple
 * `<peer_message>` tag. The sender is identified by its stable display name and
 * public peer id only — the full session id and the internal message id are
 * never exposed. The instruction is one concise line telling the agent how to
 * reply with a reverse `talk_to`; the tool description carries the async
 * semantics, so they are not repeated here.
 */
export function peerMessageTag(message: PeerMessage): string {
  const peerId = publicPeerId(message.from);
  return [
    `<peer_message from="${escapeAttribute(message.fromName)}" peer_id="${escapeAttribute(peerId)}" sent_at="${escapeAttribute(message.createdAt)}">`,
    `Reply if useful with talk_to({ target: "${peerId}", message: "..." }).`,
    "",
    sealPeerMessageBody(message.message),
    "</peer_message>",
  ].join("\n");
}

/**
 * Build a message id whose components keep inbox filename sort chronological.
 *
 * The id is `msg_<ts36>_<seq6>_<uuid>`: the base36 `Date.now()` timestamp is
 * the primary sort key and a per-runtime monotonic sequence (6 base36 digits)
 * is the tie-breaker, so messages generated sequentially by one runtime sort
 * in creation order even when `Date.now()` is equal or moves backward. The
 * UUID suffix keeps ids collision-free across runtimes. FIFO is guaranteed
 * per sender/runtime; total FIFO across processes at the same millisecond is
 * not attempted.
 */
let lastMessageMs = 0;
let lastMessageSeq = 0;
export function newMessageId(): string {
  const now = Date.now();
  const ts = Math.max(now, lastMessageMs);
  const seq = ts === lastMessageMs ? lastMessageSeq + 1 : 1;
  lastMessageMs = ts;
  lastMessageSeq = seq;
  return `msg_${ts.toString(36)}_${seq.toString(36).padStart(6, "0")}_${randomUUID()}`;
}