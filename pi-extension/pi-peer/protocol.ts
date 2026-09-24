import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, realpathSync, renameSync, rmSync, statSync, utimesSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { readJson, safeKey, writeAtomic } from "./storage.ts";
import { canonicalDirKey, type HerdrAgentStatus, type HerdrPeerContext } from "./herdr.ts";

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

export const PEER_NAME_POOL = [
  "Mark", "Coco", "Dario", "Rex", "Tibo", "Bella", "Xi", "Peanut", "Pooh", "Biscuit",
  "Mario", "Simba", "Elon", "Daisy", "Dax", "Momo", "Sam", "Gizmo", "Sundar", "Zhang",
] as const;

function peerNameHash(sessionId: string): number {
  let hash = 5381;
  for (let index = 0; index < sessionId.length; index++) {
    hash = (((hash << 5) + hash) ^ sessionId.charCodeAt(index)) >>> 0;
  }
  return hash;
}

export function pickPeerName(sessionId: string, taken: Set<string>): string {
  const start = peerNameHash(sessionId) % PEER_NAME_POOL.length;
  for (let offset = 0; offset < PEER_NAME_POOL.length; offset++) {
    const name = PEER_NAME_POOL[(start + offset) % PEER_NAME_POOL.length];
    if (!taken.has(name)) return name;
  }
  for (let suffix = 2; ; suffix++) {
    for (let offset = 0; offset < PEER_NAME_POOL.length; offset++) {
      const name = `${PEER_NAME_POOL[(start + offset) % PEER_NAME_POOL.length]}-${suffix}`;
      if (!taken.has(name)) return name;
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

export function inboxDir(root: string, sessionId: string): string {
  return join(root, "inbox", safeKey(sessionId));
}

export function recordPath(root: string, sessionId: string): string {
  return join(sessionDir(root), `${safeKey(sessionId)}.json`);
}

export function isPeerRecord(value: any): value is PeerRecord {
  return value?.schemaVersion === 1
    && typeof value.sessionId === "string"
    && value.sessionId.length > 0
    && typeof value.name === "string"
    && typeof value.cwd === "string"
    && typeof value.workspaceId === "string"
    && typeof value.paneId === "string"
    && typeof value.terminalId === "string"
    && (value.tabId === undefined || typeof value.tabId === "string")
    && (value.registrationId === undefined || typeof value.registrationId === "string")
    && typeof value.createdAt === "string";
}

export function isPeerMessage(value: any): value is PeerMessage {
  return value?.version === 1
    && value.type === "peer_message"
    && typeof value.id === "string"
    && value.id.length > 0
    && typeof value.from === "string"
    && value.from.length > 0
    && typeof value.fromName === "string"
    && value.fromName.length > 0
    && typeof value.to === "string"
    && value.to.length > 0
    && typeof value.message === "string"
    && typeof value.createdAt === "string";
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
  const pending = processingPath.slice(0, -".processing".length);
  if (existsSync(pending)) rmSync(processingPath, { force: true });
  else renameSync(processingPath, pending);
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
  throw new Error(`Peer session not found: ${target} (peers in sibling or unrelated folders are not visible; relay through a session in a shared parent folder)`);
}

/**
 * Requeue a claimed `.processing` message back to its queued `.json` form so a
 * message that was not fully injected is never lost. A pre-existing `.json`
 * (an id collision) wins and the `.processing` claim is dropped.
 */
export function requeueProcessing(
  root: string,
  sessionId: string,
  isDelivered: (message: PeerMessage) => boolean = () => false,
): void {
  const dir = inboxDir(root, sessionId);
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir).filter((entry) => entry.endsWith(".processing"))) {
    const processing = join(dir, name);
    const pending = join(dir, name.slice(0, -".processing".length));
    const message = readJson(processing);
    // Already in the receiver's transcript (e.g. the process died mid-turn,
    // before agent_end consumed the claim): consume, never redeliver.
    if (existsSync(pending) || (isPeerMessage(message) && isDelivered(message))) rmSync(processing, { force: true });
    else renameSync(processing, pending);
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

/** A peer as seen for visibility: its talk room root and bind-time cwd. */
export interface PeerLocation {
  root: string;
  cwd: string;
}

/** `ancestor` is `descendant` or one of its parents, on separator boundaries
 * (`/proj` is not a parent of `/project`). */
function isAncestorOrEqual(ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  return descendant.startsWith(ancestor === "/" ? "/" : `${ancestor}/`);
}

/**
 * The single visibility predicate for talk_sessions, talk_to, and
 * talk_latest: two peers see each other when they share a room, or when one
 * cwd is an ancestor-or-equal of the other (direct lineage, any depth, both
 * directions). Siblings do not see each other — they relay through a parent.
 * `/`, `$HOME`, and every ancestor of `$HOME` never count as an ancestor, so a
 * session opened at `~` does not see the whole machine. Paths are compared
 * after realpath on all sides; any realpath failure falls back to
 * canonicalDirKey on all sides (as paseo.ts sameDirectory does).
 */
export function canSee(me: PeerLocation, peer: PeerLocation, home: string = homedir()): boolean {
  if (me.root === peer.root) return true;
  let a: string, b: string, h: string;
  try {
    a = realpathSync(me.cwd);
    b = realpathSync(peer.cwd);
    h = realpathSync(home);
  } catch {
    a = canonicalDirKey(me.cwd);
    b = canonicalDirKey(peer.cwd);
    h = canonicalDirKey(home);
  }
  const lineage = (ancestor: string, descendant: string) =>
    !isAncestorOrEqual(ancestor, h) && isAncestorOrEqual(ancestor, descendant);
  return lineage(a, b) || lineage(b, a);
}

/** Records with a fresh heartbeat across the given talk roots, tagged with the
 * root they live in. No Herdr status read. */
export function registeredLiveRecords(roots: string[]): Array<{ record: PeerRecord; root: string }> {
  const result: Array<{ record: PeerRecord; root: string }> = [];
  for (const root of new Set(roots)) {
    for (const record of loadRecords(root)) {
      // A crashed process stops heartbeating its registration; its stale
      // record is not a live peer even if the Herdr pane still exists.
      if (isRegisteredLive(root, record.sessionId)) result.push({ record, root });
    }
  }
  return result;
}

export async function liveRecords(
  roots: string[],
  me: PeerLocation,
  socketPath: string,
  getStatus: (peerContext: HerdrPeerContext, signal?: AbortSignal) => Promise<HerdrAgentStatus>,
  signal?: AbortSignal,
): Promise<Array<{ record: PeerRecord; root: string; status: HerdrAgentStatus }>> {
  const result: Array<{ record: PeerRecord; root: string; status: HerdrAgentStatus }> = [];
  for (const { record, root } of registeredLiveRecords(roots)) {
    // Visibility is decided before the status read: each getStatus spawns a
    // Herdr CLI call. Same room (herdr-pane and paseo-provisioned peers mix
    // there, see herdr.ts roomId) or same directory lineage.
    if (!canSee(me, { root, cwd: record.cwd })) continue;
    try {
      const status = await getStatus({
        paneId: record.paneId,
        terminalId: record.terminalId,
        tabId: record.tabId,
        socketPath,
        workspaceId: record.workspaceId,
      }, signal);
      result.push({ record, root, status });
    } catch {
      // A stale or moved Herdr pane is not a live peer.
    }
  }
  return result;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
    message.message,
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