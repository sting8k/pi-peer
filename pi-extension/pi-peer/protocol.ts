import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, utimesSync } from "node:fs";
import { join } from "node:path";

import { readJson, safeKey, writeAtomic } from "./storage.ts";
import type { HerdrAgentStatus, HerdrPeerContext } from "./herdr.ts";

/**
 * Peer-talk wire protocol (protocol v1) and mailbox operations for the
 * standalone pi-peer runtime.
 *
 * Invariants of the peer-talk protocol:
 *  - HerdR-only, workspace identity verified on every status read,
 *  - atomic mailbox writes (`writeAtomic`) with queued -> `.processing` state,
 *  - route cycle rejection via `resolveTarget`/`routeForRequest`,
 *  - abort semantics via AbortSignal propagation through every wait.
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

export interface TalkRequest {
  version: 1;
  type: "request";
  id: string;
  from: string;
  to: string;
  message: string;
  route: string[];
  createdAt: string;
}

export interface TalkResponse {
  version: 1;
  type: "response";
  requestId: string;
  from: string;
  to: string;
  ok: boolean;
  message?: string;
  error?: string;
  createdAt: string;
}

export interface TalkWaiter {
  version: 1;
  type: "waiter";
  requestId: string;
  from: string;
  to: string;
  targetName?: string;
  createdAt: string;
  timedOutAt?: string;
}

export type TalkWaitResult =
  | { state: "completed"; response: TalkResponse }
  | { state: "pending" };

export type TalkProgressState = "queued" | "processing" | "pending";
export type TalkProgressDetails = {
  source: "talk_to";
  requestId: string;
  target: string;
  targetStatus: HerdrAgentStatus;
  state: TalkProgressState;
};

export const POLL_MS = 250;
export const STATUS_POLL_MS = 5_000;
export const HEARTBEAT_INTERVAL_MS = 10_000;
/** A registration older than this is treated as a dead peer (no heartbeat). */
export const RECORD_STALE_MS = 60_000;
/**
 * Max age for a waiter that never timed out: an in-flight wait loop ends no
 * later than its hard deadline (exact timeoutMs, clamped to 1–60 min), so an
 * un-timed waiter older than this is an orphaned wait (caller process died).
 * A crashed session's own waiter directory is not polled after its process
 * exits; cross-session GC collects those artifacts after DEAD_SESSION_TTL_MS.
 */
export const WAITER_TTL_MS = 90 * 60_000;
/**
 * Cross-session GC: a registration older than this (no heartbeat, no clean
 * shutdown) is a dead session whose whole artifact set is removed. 24 h is
 * far beyond any laptop suspension; deletion also requires one 5-minute
 * re-observation grace interval after the TTL is crossed.
 */
export const DEAD_SESSION_TTL_MS = 24 * 60 * 60_000;
/** Cadence for the cross-session dead-session sweep on the idle poll. */
export const DEAD_SESSION_SWEEP_MS = 5 * 60_000;
export const DEFAULT_TIMEOUT_MS = 60_000;

export const PEER_NAME_POOL = [
  "Milo", "Coco", "Luna", "Rex", "Buddy", "Bella", "Ziggy", "Peanut", "Mochi", "Biscuit",
  "Nala", "Simba", "Toby", "Daisy", "Rocky", "Momo", "Pip", "Gizmo", "Waffle", "Boba",
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
 * The full session id stays the internal identity (artifact paths, routes,
 * inbox/reply addressing, history source); this is the only user-facing
 * formatter. A session id shorter than 3 characters yields the whole id as
 * the suffix (`peer-a`, `peer-ab`); an empty input fails closed (records
 * guarantee non-empty session ids).
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

export function waitersDir(root: string, sessionId: string): string {
  return join(root, "waiters", safeKey(sessionId));
}

export function repliesDir(root: string, sessionId: string): string {
  return join(root, "replies", safeKey(sessionId));
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

export function isTalkRequest(value: any): value is TalkRequest {
  return value?.version === 1
    && value.type === "request"
    && typeof value.id === "string"
    && value.id.length > 0
    && typeof value.from === "string"
    && value.from.length > 0
    && typeof value.to === "string"
    && value.to.length > 0
    && typeof value.message === "string"
    && typeof value.createdAt === "string"
    && Array.isArray(value.route)
    && value.route.length > 0
    && value.route.every((entry: unknown) => typeof entry === "string" && entry.length > 0)
    && value.route.at(-1) === value.from
      && !value.route.includes(value.to)
    && new Set(value.route).size === value.route.length;
}

export function isTalkResponse(value: any): value is TalkResponse {
  return value?.version === 1
    && value.type === "response"
    && typeof value.requestId === "string"
    && value.requestId.length > 0
    && typeof value.from === "string"
    && value.from.length > 0
    && typeof value.to === "string"
    && value.to.length > 0
    && typeof value.ok === "boolean"
    && typeof value.createdAt === "string"
    && (value.ok ? typeof value.message === "string" : typeof value.error === "string");
}

export function isTalkWaiter(value: any): value is TalkWaiter {
  return value?.version === 1
    && value.type === "waiter"
    && typeof value.requestId === "string"
    && value.requestId.length > 0
    && typeof value.from === "string"
    && value.from.length > 0
    && typeof value.to === "string"
    && value.to.length > 0
    && (value.targetName === undefined || typeof value.targetName === "string")
    && typeof value.createdAt === "string"
    && (value.timedOutAt === undefined || typeof value.timedOutAt === "string");
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
  for (const sub of ["inbox", "replies", "waiters"] as const) {
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
  rmSync(join(root, "replies", id), { recursive: true, force: true });
  rmSync(join(root, "waiters", id), { recursive: true, force: true });
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

/**
 * Correlate an agent_end event with the peer request that should have
 * triggered its turn. `undefined` preserves compatibility with hosts that
 * report only assistant/error messages at agent_end.
 */
export function correlatePeerRequestTurn(messages: any[] | undefined, requestIds: string[]): boolean | undefined {
  if (!Array.isArray(messages)) return undefined;
  const idSet = new Set(requestIds);
  let sawUserMessage = false;
  for (const message of messages) {
    if (message?.role !== "user") continue;
    sawUserMessage = true;
    const blocks = typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : Array.isArray(message.content) ? message.content : [];
    const text = blocks
      .filter((block: any) => block?.type === "text" && typeof block.text === "string")
      .map((block: any) => block.text)
      .join("\n");
    const match = text.match(/<peer_message\b[^>]*\brequest_id="([^"]+)"/);
    if (match?.[1] && idSet.has(match[1])) return true;
  }
  return sawUserMessage ? false : undefined;
}

export function extractAssistantText(messages: any[] | undefined): string | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "assistant" || message.stopReason === "aborted") continue;
    const blocks = Array.isArray(message.content) ? message.content : [];
    const text = blocks
      .filter((block: any) => block?.type === "text" && typeof block.text === "string")
      .map((block: any) => block.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return null;
}

export function resolveTarget(records: PeerRecord[], target: string): PeerRecord {
  const publicMatches = records.filter((record) => publicPeerId(record.sessionId) === target);
  if (publicMatches.length === 1) return publicMatches[0];
  if (publicMatches.length > 1) throw new Error(`Peer id is ambiguous: ${target}`);
  const exactName = records.filter((record) => record.name === target);
  if (exactName.length === 1) return exactName[0];
  if (exactName.length > 1) throw new Error(`Peer name is ambiguous: ${target}`);
  throw new Error(`Peer session not found: ${target}`);
}

export function routeForRequest(runtime: { activeRequests: TalkRequest[]; record: PeerRecord }): string[] {
  const root = runtime.activeRequests[0];
  return root
    ? [...root.route, runtime.record.sessionId]
    : [runtime.record.sessionId];
}

export function requeueProcessing(root: string, sessionId: string): void {
  const dir = inboxDir(root, sessionId);
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir).filter((entry) => entry.endsWith(".processing"))) {
    const processing = join(dir, name);
    const pending = join(dir, name.slice(0, -".processing".length));
    if (existsSync(pending)) rmSync(processing, { force: true });
    else renameSync(processing, pending);
  }
}

export async function waitForDelay(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Aborted"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function isRegisteredLive(root: string, sessionId: string): boolean {
  const path = recordPath(root, sessionId);
  try {
    return existsSync(path) && Date.now() - statSync(path).mtimeMs <= RECORD_STALE_MS;
  } catch {
    return false;
  }
}

export async function waitForResponseOrPending(
  root: string,
  request: TalkRequest,
  timeoutMs: number,
  signal?: AbortSignal,
  onState?: (state: TalkProgressState) => void,
  hardDeadlineMs?: number,
  statusPollMs?: number,
): Promise<TalkWaitResult> {
  const path = join(repliesDir(root, request.from), `${request.id}.json`);
  const waiterPath = join(waitersDir(root, request.from), `${request.id}.json`);
  const pendingPath = join(inboxDir(root, request.to), `${request.id}.json`);
  const processingPath = `${pendingPath}.processing`;
  // The registration heartbeat is the authoritative liveness signal: a local
  // FS read (cannot fail transiently) refreshed by the target's own poll tick
  // and gone or stale the instant the target shuts down or crashes. Previously
  // the first probe was scheduled at softDeadline, which equals hardDeadline
  // when timeoutMs defaults to DEFAULT_TIMEOUT_MS, so the "peer is no longer
  // live" branch was unreachable by default.
  const statusIntervalMs = statusPollMs ?? STATUS_POLL_MS;
  const hardDeadline = Date.now() + (hardDeadlineMs ?? timeoutMs);
  let statusCheckAt = Date.now() + statusIntervalMs;
  let consecutiveStale = 0;
  let reportedProcessing = false;
  try {
    while (Date.now() <= hardDeadline) {
      if (signal?.aborted) throw new Error("Aborted");
      if (!reportedProcessing && existsSync(processingPath)) {
        reportedProcessing = true;
        onState?.("processing");
      }
      const value = readJson(path);
      if (
        isTalkResponse(value)
        && value.requestId === request.id
        && value.from === request.to
        && value.to === request.from
      ) {
        if (!reportedProcessing) {
          reportedProcessing = true;
          onState?.("processing");
        }
        rmSync(path, { force: true });
        rmSync(waiterPath, { force: true });
        return { state: "completed", response: value };
      }
      const now = Date.now();
      if (now >= statusCheckAt) {
        // A missing registration is an instant, authoritative death signal
        // (session_shutdown removed it): no reply and no wake will ever arrive.
        if (!existsSync(recordPath(root, request.to))) {
          rmSync(pendingPath, { force: true });
          rmSync(waiterPath, { force: true });
          throw new Error(`Peer ${publicPeerId(request.to)} is no longer live`);
        }
        // A stale registration (heartbeat expired) also means death, but
        // requires two consecutive observations (spaced >= statusIntervalMs):
        // laptop sleep / a single blocked tick freezes the observer too, and
        // every record comes back stale at once while all peers are healthy.
        if (!isRegisteredLive(root, request.to)) {
          consecutiveStale += 1;
          if (consecutiveStale >= 2) {
            rmSync(pendingPath, { force: true });
            rmSync(waiterPath, { force: true });
            throw new Error(`Peer ${publicPeerId(request.to)} is no longer live`);
          }
        } else {
          consecutiveStale = 0;
        }
        statusCheckAt = now + statusIntervalMs;
      }
      await waitForDelay(POLL_MS, signal);
    }
    // Hard deadline reached while the target is still alive/processing: keep
    // the waiter and the pending inbox request, and return a pending result so
    // the caller reports "do not resend". A later reply is picked up by the
    // wake scanner (wakePendingPongs) and delivered as a <peer_pong> user message.
    markTimedOut(waiterPath);
    return { state: "pending" };
  } catch (error) {
    if (signal?.aborted) {
      // Abort withdraws a queued request only; an already-processing request
      // (.processing) is not interrupted. Withdrawal must be atomic: unlink
      // success proves the request was still queued, so no reply can ever
      // arrive and the waiter is removed. When the peer already claimed the
      // request (unlink misses), its reply WILL arrive: keep the waiter and
      // mark it timed-out so the wake scanner (wakePendingPongs) delivers the
      // late reply as <peer_pong>, same as a wait that ran out its deadline.
      let withdrawn = false;
      try {
        unlinkSync(pendingPath);
        withdrawn = true;
      } catch {
        // ENOENT: the peer claimed (.processing) or already replied.
      }
      if (withdrawn) rmSync(waiterPath, { force: true });
      else markTimedOut(waiterPath);
    }
    throw error;
  }
}

function markTimedOut(waiterPath: string): void {
  const current = readJson(waiterPath);
  if (!isTalkWaiter(current) || current.timedOutAt) return;
  writeAtomic(waiterPath, { ...current, timedOutAt: nowIso() });
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
    // is not a live peer even if the HerdR pane still exists.
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
      // A stale or moved HerdR pane is not a live peer.
    }
  }
  return result;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function requestMessage(request: TalkRequest, fromName: string): string {
  return [
    `<peer_message request_id="${escapeAttribute(request.id)}" from="${escapeAttribute(fromName)}" from_session="${escapeAttribute(request.from)}" peer_id="${escapeAttribute(publicPeerId(request.from))}">`,
    "Another Pi session is asking for your independent response.",
    "Respond normally. Your final assistant response will be returned to the sender automatically.",
    "",
    request.message,
    "</peer_message>",
  ].join("\n");
}

/**
 * Steered variant of {@link requestMessage} for a same-caller update while the
 * receiving peer is mid-turn on a prior request from the same session. Keeps the
 * `<peer_message request_id=...>` tag shape (correlation depends on it), adds an
 * `amends="<rootRequestId>"` attribute linking this update to the request that
 * started the turn, and reframes the body as an in-flight revision rather than a
 * new independent request.
 */
export function steerMessage(request: TalkRequest, rootRequestId: string, fromName: string): string {
  return [
    `<peer_message request_id="${escapeAttribute(request.id)}" from="${escapeAttribute(fromName)}" from_session="${escapeAttribute(request.from)}" peer_id="${escapeAttribute(publicPeerId(request.from))}" amends="${escapeAttribute(rootRequestId)}">`,
    "This is an update from the same session for the request you are currently working on.",
    "Adjust your current work; do not restart from scratch.",
    "Your final response is returned for all of these requests automatically.",
    "",
    request.message,
    "</peer_message>",
  ].join("\n");
}

export function peerPongMessage(waiter: TalkWaiter, response: TalkResponse, senderName?: string): string {
  // The pong comes from the responder (response.from === waiter.to), never
  // from the caller (waiter.from). response.from is the authoritative source.
  const source = senderName ?? waiter.targetName ?? publicPeerId(response.from);
  return [
    `<peer_pong request_id="${escapeAttribute(waiter.requestId)}" from="${escapeAttribute(source)}" from_session="${escapeAttribute(response.from)}" peer_id="${escapeAttribute(publicPeerId(response.from))}" ok="${response.ok ? "true" : "false"}">`,
    "Another Pi session has finished a pending response.",
    "",
    response.ok ? (response.message ?? "") : (response.error ?? ""),
    "</peer_pong>",
  ].join("\n");
}

/** Build a request id whose base36 timestamp prefix keeps inbox filename sort chronological. */
export function newRequestId(): string {
  return `req_${Date.now().toString(36)}_${randomUUID()}`;
}