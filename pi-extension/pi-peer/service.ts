import type { AgentToolUpdateCallback, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Static } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { basename, join } from "node:path";

import { TalkLatestParams, TalkSessionsParams, TalkToParams } from "./schemas.ts";
import {
  getCurrentHerdrPeerContextAsync,
  getHerdrPeerStatusAsync,
  getTalkRootDir,
  type HerdrAgentStatus,
  type HerdrPeerContext,
} from "./herdr.ts";
import { readJson, safeKey, writeAtomic } from "./storage.ts";
import {
  HISTORY_LIMIT,
  entriesToTalkEvents,
  extractEventsFromMessage,
  publishHistory,
  publishHistoryFromOwnSession,
  readHistory,
} from "./history.ts";
import {
  DEFAULT_TIMEOUT_MS,
  correlatePeerRequestTurn,
  DEAD_SESSION_SWEEP_MS,
  ensureRecord,
  extractAssistantText,
  inboxDir,
  isRegisteredLive,
  isTalkRequest,
  isTalkResponse,
  isPeerRecord,
  liveRecords,
  loadRecords,
  newRequestId,
  nowIso,
  pickPeerName,
  publicPeerId,

  POLL_MS,
  recordPath,
  RECORD_STALE_MS,
  removeOwnedRecord,
  repliesDir,
  requeueProcessing,
  requestMessage,
  steerMessage,
  resolveTarget,
  routeForRequest,
  sessionDir,
  sweepDeadSessions,
  waitForResponseOrPending,
  waitersDir,
  WAITER_TTL_MS,
  isTalkWaiter,
  peerPongMessage,
  type PeerRecord,
  type TalkProgressDetails,
  type TalkProgressState,
  type TalkRequest,
  type TalkResponse,
  type TalkWaitResult,
  type TalkWaiter,
} from "./protocol.ts";

type TalkTo = Static<typeof TalkToParams>;
type TalkLatest = Static<typeof TalkLatestParams>;

export type TalkDeps = {
  getCurrentPeer?: typeof getCurrentHerdrPeerContextAsync;
  getPeerStatus?: typeof getHerdrPeerStatusAsync;
  isBusy?: () => boolean;
  rootDir?: (workspaceId: string) => string;
  /** Test/runtime-only override for the hard wait deadline (never a schema option). */
  hardDeadlineMs?: number;
  /** Test/runtime-only override for the liveness check cadence (never a schema option). */
  statusPollMs?: number;
  /** Test/runtime-only override for the lost-delivery watchdog tick count (never a schema option). */
  activeRequestWatchdogTicks?: number;
};

type Runtime = {
  peer: HerdrPeerContext;
  record: PeerRecord;
  root: string;
  /** Active request batch; the first entry is the batch ROOT (started the turn). */
  activeRequests: TalkRequest[];
  activeIdleTicks: number;
};

const DEFAULT_ACTIVE_REQUEST_WATCHDOG_TICKS = Math.ceil(30_000 / POLL_MS); // ~30s of consecutive idle ticks
function failStuckActiveRequest(runtime: Runtime): void {
  const batch = runtime.activeRequests;
  if (batch.length === 0) return;
  for (const request of batch) {
    const response: TalkResponse = {
      version: 1,
      type: "response",
      requestId: request.id,
      from: runtime.record.sessionId,
      to: request.from,
      ok: false,
      error: "Peer did not start a turn for the request",
      createdAt: nowIso(),
    };
    try {
      writeAtomic(join(repliesDir(runtime.root, request.from), `${request.id}.json`), response);
    } catch {
      continue;
    }
    rmSync(join(inboxDir(runtime.root, runtime.record.sessionId), `${request.id}.json.processing`), { force: true });
  }
  runtime.activeRequests = [];
  runtime.activeIdleTicks = 0;
}

/**
 * Best-effort rejection of an invalid/malformed inbox request: write an
 * `ok=false` reply to the caller's replies dir whenever its caller session id
 * can be recovered (from the parsed envelope or, when the JSON is corrupt, by
 * regex on the raw text), then remove the inbox file. The reply reuses the
 * inbox filename as request id so the caller's waiter (correlated by id) is
 * closed immediately instead of stranding until GC. A fully unaddressable
 * file is dropped without a reply - nobody can be woken by it.
 */
function rejectInvalidRequest(root: string, responderSessionId: string, path: string, readValue: unknown): void {
  const rawText = (() => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return "";
    }
  })();
  const asObj = typeof readValue === "object" && readValue !== null
    ? readValue as Record<string, unknown>
    : null;
  const from = asObj && typeof asObj.from === "string" && asObj.from.length > 0
    ? asObj.from
    : rawText.match(/"from"\s*:\s*"([^"]+)"/)?.[1];
  if (!from) {
    // Unaddressable: no caller session id, cannot deliver a reply anywhere.
    return;
  }
  // The caller's waiter correlates by the inbox filename, which is the
  // request id the sender wrote, so the reply must reuse that exact id.
  const requestId = basename(path, ".json");
  const error = readValue === null
    ? "Malformed request (unparseable JSON)"
    : "Invalid request rejected before delivery (failed protocol validation)";
  try {
    writeAtomic(join(repliesDir(root, from), `${safeKey(requestId)}.json`), {
      version: 1,
      type: "response",
      requestId,
      from: responderSessionId,
      to: from,
      ok: false,
      error,
      createdAt: nowIso(),
    } satisfies TalkResponse);
  } catch {
    // Reply write failed (unwritable replies dir): drop and let GC clean up.
  }
}

async function drainInbox(pi: ExtensionAPI, runtime: Runtime, isBusy: () => boolean): Promise<void> {
  // An empty batch must not drain while the peer is busy with its own turn; a
  // non-empty batch (peer mid-turn on a peer request) may still receive a
  // same-caller steer even while busy.
  if (runtime.activeRequests.length === 0 && isBusy()) return;
  const dir = inboxDir(runtime.root, runtime.record.sessionId);
  if (!existsSync(dir)) return;
  const pending = readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
  for (const name of pending) {
    const path = join(dir, name);
    const request = readJson(path);
    if (!isTalkRequest(request) || request.to !== runtime.record.sessionId) {
      // Never drop silently: write an ok=false reply when the caller's
      // addressing can still be recovered, so its waiter is closed instead of
      // stranding until GC. Only a fully unaddressable file is left to GC.
      rejectInvalidRequest(runtime.root, runtime.record.sessionId, path, request);
      rmSync(path, { force: true });
      continue;
    }
    // While a batch is active, only a request from the SAME caller as the batch
    // root may bypass the busy gate (a mid-turn revision/steer). Any other
    // caller keeps queueing until the batch completes, so a stranger can never
    // derail a running turn.
    if (runtime.activeRequests.length > 0 && request.from !== runtime.activeRequests[0].from) {
      continue;
    }
    const processing = `${path}.processing`;
    try {
      renameSync(path, processing);
    } catch {
      continue;
    }
    const isSteer = runtime.activeRequests.length > 0;
    runtime.activeRequests.push(request);
    runtime.activeIdleTicks = 0;
    try {
      const sender = loadRecords(runtime.root).find((record) => record.sessionId === request.from);
      const fromName = sender?.name ?? publicPeerId(request.from);
      if (isSteer) {
        // Mid-turn revision: delivered as a steer so it lands after the current
        // tool calls finish and before the next LLM call, within the SAME turn.
        await pi.sendUserMessage(steerMessage(request, runtime.activeRequests[0].id, fromName), { deliverAs: "steer" });
      } else {
        // The batch root starts a fresh turn; deliver as a real user message.
        await pi.sendUserMessage(requestMessage(request, fromName));
      }
    } catch (error) {
      // Roll back only this entry; the rest of the batch is untouched.
      writeAtomic(join(repliesDir(runtime.root, request.from), `${request.id}.json`), {
        version: 1,
        type: "response",
        requestId: request.id,
        from: runtime.record.sessionId,
        to: request.from,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        createdAt: nowIso(),
      } satisfies TalkResponse);
      rmSync(processing, { force: true });
      runtime.activeRequests = runtime.activeRequests.filter((entry) => entry.id !== request.id);
      runtime.activeIdleTicks = 0;
    }
    return; // one send per tick, like wakePendingPongs
  }
}

/**
 * Wake scanner: when a reply has landed for a request this peer timed out on
 * (tracked by a waiter), deliver the reply as a <peer_pong> user message so the
 * caller's session resumes. Runs after the inbox drain inside the single poll
 * interval. A pong may be delivered while this session is busy with its OWN
 * work (steered into the running turn), but MUST keep waiting while a
 * peer-request batch is active: with activeRequests non-empty this session's
 * final assistant message becomes the reply written to the requesting peer at
 * agent_end, and injecting a pong into that turn would corrupt the protocol.
 * Consumes reply + waiter only after the send succeeded so a failed send
 * retries on the next tick.
 */
async function wakePendingPongs(pi: ExtensionAPI, runtime: Runtime, isBusy: () => boolean): Promise<void> {
  if (runtime.activeRequests.length > 0) return;
  const dir = waitersDir(runtime.root, runtime.record.sessionId);
  if (!existsSync(dir)) return;
  const names = readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
  for (const name of names) {
    const waiterPath = join(dir, name);
    const waiter = readJson(waiterPath);
    if (!isTalkWaiter(waiter) || waiter.from !== runtime.record.sessionId) {
      rmSync(waiterPath, { force: true });
      continue;
    }
    // Only a timed-out waiter may be woken. An un-timed waiter is still owned
    // by an in-flight waitForResponseOrPending, which consumes reply + waiter
    // itself; waking it would delete the reply out from under the direct wait.
    if (!waiter.timedOutAt) continue;
    const replyPath = join(repliesDir(runtime.root, runtime.record.sessionId), `${waiter.requestId}.json`);
    const reply = readJson(replyPath);
    if (
      !isTalkResponse(reply)
      || reply.requestId !== waiter.requestId
      || reply.from !== waiter.to
      || reply.to !== runtime.record.sessionId
    ) {
      continue;
    }
    try {
      await pi.sendUserMessage(peerPongMessage(waiter, reply, waiter.targetName), isBusy() ? { deliverAs: "steer" } : undefined);
    } catch {
      // Leave waiter + reply in place; retry on a later idle tick.
      return;
    }
    rmSync(replyPath, { force: true });
    rmSync(waiterPath, { force: true });
    return;
  }
}

export async function sweepStaleArtifacts(
  pi: ExtensionAPI,
  runtime: Runtime,
  isBusy: () => boolean,
  staleSince: Map<string, number> = new Map(),
): Promise<void> {
  if (runtime.activeRequests.length > 0) return;
  const { root, record } = runtime;
  const sessionId = record.sessionId;
  // Waiters owned by this session:
  //  - a timed-out (pending) waiter with no reply whose TARGET has died can
  //    never carry a real answer, but the caller was promised a wake: close
  //    the promise with a <peer_pong ok="false"> failure wake, then remove it.
  //    Death is only declared after the staleness persists >= RECORD_STALE_MS:
  //    after laptop sleep every record is stale at once while all peers are
  //    healthy, and a single fresh observation cancels the pending verdict.
  //  - an un-timed waiter older than WAITER_TTL_MS is an orphaned wait (the
  //    in-flight wait loop has long since exited; max hard deadline is 60 min).
  const waiters = waitersDir(root, sessionId);
  const waiterIds = new Set<string>();
  if (existsSync(waiters)) {
    for (const name of readdirSync(waiters).filter((n) => n.endsWith(".json")).sort()) {
      const waiterPath = join(waiters, name);
      waiterIds.add(name.slice(0, -".json".length));
      const waiter = readJson(waiterPath);
      if (!isTalkWaiter(waiter) || waiter.from !== sessionId) {
        rmSync(waiterPath, { force: true });
        continue;
      }
      if (waiter.timedOutAt) {
        // A reply exists: wakePendingPongs (next in the tick chain) delivers it.
        if (existsSync(join(repliesDir(root, sessionId), `${waiter.requestId}.json`))) {
          staleSince.delete(waiter.requestId);
          continue;
        }
        if (!isRegisteredLive(root, waiter.to)) {
          const firstStale = staleSince.get(waiter.requestId) ?? Date.now();
          staleSince.set(waiter.requestId, firstStale);
          if (Date.now() - firstStale < RECORD_STALE_MS) continue;
          staleSince.delete(waiter.requestId);
          try {
            await pi.sendUserMessage(peerPongMessage(waiter, {
              version: 1,
              type: "response",
              requestId: waiter.requestId,
              from: waiter.to,
              to: sessionId,
              ok: false,
              error: "Peer session is no longer live and never replied",
              createdAt: nowIso(),
            } satisfies TalkResponse, waiter.targetName), isBusy() ? { deliverAs: "steer" } : undefined);
            rmSync(waiterPath, { force: true });
            return; // one user-message send per tick, like drainInbox/wakePendingPongs
          } catch {
            // Leave the waiter; retry on a later idle tick.
            return;
          }
        }
        staleSince.delete(waiter.requestId);
        continue;
      }
      const created = Date.parse(waiter.createdAt);
      if (!Number.isFinite(created) || Date.now() - created > WAITER_TTL_MS) {
        rmSync(waiterPath, { force: true });
      }
    }
  }
  // Prune grace state for waiters that no longer exist (abort, shutdown),
  // including when the waiters directory itself was removed.
  for (const key of staleSince.keys()) {
    if (!waiterIds.has(key)) staleSince.delete(key);
  }
  // Replies whose waiter is gone can never be consumed (late abort, swept
  // waiter, dead caller): orphans.
  const replies = repliesDir(root, sessionId);
  if (existsSync(replies)) {
    for (const name of readdirSync(replies).filter((n) => n.endsWith(".json"))) {
      const requestId = name.slice(0, -".json".length);
      if (!existsSync(join(waitersDir(root, sessionId), `${requestId}.json`))) {
        rmSync(join(replies, name), { force: true });
      }
    }
  }
}

async function executeTalkTo(
  params: TalkTo,
  runtime: Runtime,
  getStatus: typeof getHerdrPeerStatusAsync,
  hardDeadlineMs?: number,
  statusPollMs?: number,
  signal?: AbortSignal,
  onUpdate?: AgentToolUpdateCallback<TalkProgressDetails>,
): Promise<any> {
  const message = params.message.trim();
  const target = params.target.trim();
  if (!target) throw new Error("talk_to requires a target");
  if (!message) throw new Error("talk_to requires a non-empty message");
  const timeoutMs = typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
    ? Math.min(3_600_000, Math.max(1_000, Math.trunc(params.timeoutMs)))
    : DEFAULT_TIMEOUT_MS;
  const peers = await liveRecords(runtime.root, runtime.record.workspaceId, runtime.peer.socketPath, getStatus, signal);
  const targetRecord = resolveTarget(peers.map((entry) => entry.record), target);
  const targetStatus = peers.find((entry) => entry.record.sessionId === targetRecord.sessionId)?.status ?? "unknown";
  if (targetRecord.sessionId === runtime.record.sessionId) throw new Error("talk_to cannot target the current session");
  const route = routeForRequest(runtime);
  if (route.includes(targetRecord.sessionId)) {
    throw new Error(`talk_to rejected cycle through ${publicPeerId(targetRecord.sessionId)}`);
  }
  const request: TalkRequest = {
    version: 1,
    type: "request",
    id: newRequestId(),
    from: runtime.record.sessionId,
    to: targetRecord.sessionId,
    message,
    route,
    createdAt: nowIso(),
  };
  const emitState = (state: TalkProgressState) => onUpdate?.({
    content: [{
      type: "text",
      text: state === "queued"
        ? `Queued for ${targetRecord.name} (${publicPeerId(targetRecord.sessionId)}); target status: ${targetStatus}.`
        : `${targetRecord.name} (${publicPeerId(targetRecord.sessionId)}) accepted the request and is processing it.`,
    }],
    details: { source: "talk_to", requestId: request.id, target: publicPeerId(targetRecord.sessionId), targetStatus, state },
  });
  const path = join(inboxDir(runtime.root, targetRecord.sessionId), `${request.id}.json`);
  const waiter: TalkWaiter = {
    version: 1,
    type: "waiter",
    requestId: request.id,
    from: runtime.record.sessionId,
    to: targetRecord.sessionId,
    targetName: targetRecord.name,
    createdAt: nowIso(),
  };
  // Default-on: a waiter is written for every request before the inbox write
  // so a timed-out talk_to can still be woken later by <peer_pong>.
  writeAtomic(join(waitersDir(runtime.root, runtime.record.sessionId), `${request.id}.json`), waiter);
  try {
    writeAtomic(path, request);
  } catch (error) {
    rmSync(join(waitersDir(runtime.root, runtime.record.sessionId), `${request.id}.json`), { force: true });
    throw error;
  }
  emitState("queued");
  const waitResult = await waitForResponseOrPending(runtime.root, request, timeoutMs, signal, emitState, hardDeadlineMs, statusPollMs);
  if (waitResult.state === "pending") {
    return {
      content: [{
        type: "text",
        text: `Request ${request.id} to ${targetRecord.name} (${publicPeerId(targetRecord.sessionId)}) is still processing; the peer did not reply within the wait deadline. Do not resend: this session will be woken automatically when the peer finishes.`,
      }],
      details: { source: "talk_to", requestId: request.id, target: publicPeerId(targetRecord.sessionId), targetStatus, state: "pending" },
    };
  }
  const response = waitResult.response;
  if (!response.ok) throw new Error(response.error ?? "Peer request failed");
  return {
    content: [{ type: "text", text: response.message ?? "" }],
    details: { source: "talk_to", requestId: request.id, from: publicPeerId(response.from), target: publicPeerId(targetRecord.sessionId), state: "completed" },
  };
}

async function executeTalkLatest(
  params: TalkLatest,
  runtime: Runtime,
  getStatus: typeof getHerdrPeerStatusAsync,
  signal?: AbortSignal,
): Promise<any> {
  const target = params.target.trim();
  if (!target) throw new Error("talk_latest requires a target");
  const count = params.count ?? 1;
  if (!Number.isInteger(count) || count < 1 || count > HISTORY_LIMIT) {
    throw new Error(`talk_latest count must be an integer between 1 and ${HISTORY_LIMIT}`);
  }
  const peers = await liveRecords(runtime.root, runtime.record.workspaceId, runtime.peer.socketPath, getStatus, signal);
  const targetRecord = resolveTarget(peers.map((entry) => entry.record), target);
  const peerStatus = peers.find((entry) => entry.record.sessionId === targetRecord.sessionId)?.status ?? "unknown";
  const currentTurnInProgress = peerStatus === "working" || peerStatus === "blocked";
  if (targetRecord.sessionId === runtime.record.sessionId) throw new Error("talk_latest cannot target the current session");
  const history = readHistory(runtime.root, targetRecord.sessionId);
  if (history.events.length === 0) {
    throw new Error(`Peer ${publicPeerId(targetRecord.sessionId)} has no completed conversation events`);
  }
  const events = history.events.slice(-count);
  const snapshotNote = currentTurnInProgress
    ? "Snapshot note: this excludes the peer's in-progress turn."
    : "";
  const content = [
    `Peer: ${targetRecord.name} (${publicPeerId(targetRecord.sessionId)})`,
    `Peer status: ${peerStatus}`,
    snapshotNote,
    `Latest completed events (${events.length}):`,
    ...events.map((event) => `[${event.type}] ${event.message}`),
  ].filter(Boolean).join("\n");
  return {
    content: [{
      type: "text",
      text: content,
    }],
    details: {
      source: "talk_latest",
      target: publicPeerId(targetRecord.sessionId),
      count,
      peerStatus,
      currentTurnInProgress,
      createdAt: events[events.length - 1].createdAt,
      events: events.map((event) => ({ type: event.type, createdAt: event.createdAt, id: event.id })),
    },
  };
}

/** Queue depth of a peer: count of `.json` request files still present in
 * its inbox dir (queued or currently claimed as `.processing`). A missing
 * inbox dir means zero, never an error.
 */
function inboxCount(root: string, sessionId: string): number {
  const dir = inboxDir(root, sessionId);
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((name) => name.endsWith(".json") || name.endsWith(".json.processing")).length;
}

export function registerTalkTools(
  pi: ExtensionAPI,
  deps: TalkDeps = {},
): void {
  // isBusy/getCurrentPeer/getPeerStatus/rootDir are injectable test/runtime
  // overrides for deterministic tests; the host feature gate lives only in the
  // standalone entrypoint (index.ts) via PI_PEER_DISABLED.
  const getCurrentPeer = deps.getCurrentPeer ?? getCurrentHerdrPeerContextAsync;
  const getStatus = deps.getPeerStatus ?? getHerdrPeerStatusAsync;
  const hasBusyOverride = typeof deps.isBusy === "function";
  // Standalone runtime self-tracks busy through agent_start/agent_end unless a
  // caller injects an explicit busy function (test/runtime override).
  let selfBusy = false;
  const isBusy = hasBusyOverride ? deps.isBusy! : () => selfBusy;
  const rootDir = deps.rootDir ?? getTalkRootDir;
  let runtime: Runtime | null = null;
  let interval: ReturnType<typeof setInterval> | null = null;
  let drainInFlight: Promise<void> | null = null;
  // Suspension-grace state: requestId -> first tick the target was observed
  // stale. Only staleness persisting >= RECORD_STALE_MS may close a pending
  // wake with a failure pong (laptop sleep makes every record stale at once).
  const staleSince = new Map<string, number>();
  // Cross-session GC also needs two observations: a peer waking from sleep
  // must refresh its registration before its artifacts can be removed.
  const deadSince = new Map<string, number>();
  let lastDeadSweepAt = 0;
  const activeRequestWatchdogTicks = typeof deps.activeRequestWatchdogTicks === "number" && Number.isFinite(deps.activeRequestWatchdogTicks)
    ? Math.max(1, Math.trunc(deps.activeRequestWatchdogTicks))
    : DEFAULT_ACTIVE_REQUEST_WATCHDOG_TICKS;

  const ensureRuntime = async (ctx: any, signal?: AbortSignal): Promise<Runtime> => {
    const sessionId = ctx.sessionManager.getSessionId();
    const current = runtime;
    if (current && current.record.sessionId === sessionId) {
      ensureRecord(current.root, current.record);
      return current;
    }
    const peer = await getCurrentPeer(signal);
    const root = rootDir(peer.workspaceId);
    const existing = readJson(recordPath(root, sessionId));
    const name = isPeerRecord(existing) && existing.sessionId === sessionId
      ? existing.name
      : pickPeerName(
        sessionId,
        new Set(loadRecords(root).filter((record) => record.sessionId !== sessionId).map((record) => record.name)),
      );
    const record: PeerRecord = {
      schemaVersion: 1,
      sessionId,
      name,
      cwd: ctx.cwd,
      workspaceId: peer.workspaceId,
      paneId: peer.paneId,
      terminalId: peer.terminalId,
      tabId: peer.tabId,
      registrationId: randomUUID(),
      createdAt: nowIso(),
    };
    mkdirSync(sessionDir(root), { recursive: true, mode: 0o700 });
    writeAtomic(recordPath(root, sessionId), record);
    requeueProcessing(root, sessionId);
    if (current) {
      // Session-switch ownership transfer: only after the new registration is
      // written and requeued, remove the previous runtime's owned live
      // registration. The registrationId guard keeps a registration that is
      // now owned by another runtime. Other artifacts (latest/inbox/replies)
      // are not lifecycle-owned and are left in place.
      removeOwnedRecord(current.root, current.record);
    }
    runtime = { peer, record, root, activeRequests: [], activeIdleTicks: 0 };
    if (!interval) {
      interval = setInterval(() => {
        if (!runtime) return;
        const currentRuntime = runtime;
        // Heartbeat first, unconditionally: the registration liveness signal
        // must not depend on sendUserMessage semantics (fire-and-forget in
        // the host today, declared Promise<void>) or on the drain chain.
        ensureRecord(currentRuntime.root, currentRuntime.record);
        if (currentRuntime.activeRequests.length > 0) {
          if (isBusy()) {
            currentRuntime.activeIdleTicks = 0;
          } else if (++currentRuntime.activeIdleTicks >= activeRequestWatchdogTicks) {
            failStuckActiveRequest(currentRuntime);
          }
        }
        if (drainInFlight) return;
        drainInFlight = drainInbox(pi, currentRuntime, isBusy)
          .then(() => {
            // Cross-session GC on a slow cadence: dead sessions' artifacts
            // (registration, latest, inbox, replies, waiters) are removed by
            // whichever live session reaches the interval first.
            if (Date.now() - lastDeadSweepAt >= DEAD_SESSION_SWEEP_MS) {
              sweepDeadSessions(currentRuntime.root, deadSince);
              lastDeadSweepAt = Date.now();
            }
          })
          .then(() => sweepStaleArtifacts(pi, currentRuntime, isBusy, staleSince))
          .then(() => wakePendingPongs(pi, currentRuntime, isBusy))
          .catch(() => {})
          .finally(() => { drainInFlight = null; });
      }, POLL_MS);
    }
    return runtime;
  };

  pi.registerTool({
    name: "talk_sessions",
    label: "Talk Sessions",
    description: "List live Pi peer sessions in the current HerdR workspace.",
    promptSnippet: "Use `talk_sessions` to find a peer's public id (e.g. `peer-abc`) before calling `talk_to`.",
    parameters: TalkSessionsParams,
    async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
      const current = await ensureRuntime(ctx, signal);
      const peers = await liveRecords(current.root, current.record.workspaceId, current.peer.socketPath, getStatus, signal);
      const lines = peers.map(({ record, status }) => {
        const base = `${publicPeerId(record.sessionId)}  ${record.name}  ${status}${record.sessionId === current.record.sessionId ? "  (current)" : ""}`;
        const queued = inboxCount(current.root, record.sessionId);
        return queued > 0 ? `${base}  (${queued} queued)` : base;
      });
      return {
        content: [{ type: "text", text: lines.length > 0 ? lines.join("\n") : "No live peer sessions." }],
        details: { source: "talk_sessions", workspaceId: current.record.workspaceId, count: lines.length },
      };
    },
  });

  pi.registerTool({
    name: "talk_latest",
    label: "Latest Peer Events",
    description: "Fetch the N most recent completed conversation events published by another live Pi peer (count defaults to 1, max 10).",
    promptSnippet: "Use `talk_latest` to read the peer's most recent completed conversation events (user, assistant text, tool call, tool result) without reading its transcript.",
    parameters: TalkLatestParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const current = await ensureRuntime(ctx, signal);
      return executeTalkLatest(params as TalkLatest, current, getStatus, signal);
    },
  });

  pi.registerTool({
    name: "talk_to",
    label: "Talk To",
    description: "Send a request to another live Pi session in the current HerdR workspace. Returns the peer's response if it arrives within the wait; otherwise returns a non-error pending result and the reply arrives later as a <peer_pong>.",
    promptSnippet: "Use `talk_to` to ask another Pi session for an independent response; call `talk_sessions` first when the target is unknown.",
    parameters: TalkToParams,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const current = await ensureRuntime(ctx, signal);
      return executeTalkTo(
        params as TalkTo,
        current,
        getStatus,
        deps.hardDeadlineMs,
        deps.statusPollMs,
        signal,
        onUpdate,
      );
    },
  });

  pi.on("session_start", (_event, ctx) => {
    // A reload/resume may miss the prior agent_end; never carry stale busy state across a session bind.
    selfBusy = false;
    void ensureRuntime(ctx)
      .then((current) => {
        ctx.ui?.setStatus("pi-peer", `${current.record.name} · ${publicPeerId(current.record.sessionId)}`);
        publishHistoryFromOwnSession(current, ctx);
      })
      .catch(() => {});
  });
  pi.on("agent_start", () => {
    if (!hasBusyOverride) selfBusy = true;
    if (runtime?.activeRequests.length) runtime.activeIdleTicks = 0;
  });
  pi.on("agent_end", (event, ctx) => {
    if (!hasBusyOverride) selfBusy = false;
    if (!runtime) return;
    // Session entries are persisted before the end event; rebuild from the
    // current lineage so ids are stable and no duplicate risk exists.
    publishHistoryFromOwnSession(runtime, ctx);
    const message = extractAssistantText((event as any).messages);
    if (runtime.activeRequests.length === 0) return;
    const ids = runtime.activeRequests.map((entry) => entry.id);
    // A normal user turn can finish while a queued peer request is still
    // marked active. If the host exposes the user prompt, only a turn whose
    // user messages carry one of this batch's `<peer_message request_id=...>`
    // ids may consume the batch; hosts that expose no user message keep the
    // legacy fallback.
    if (correlatePeerRequestTurn((event as any).messages, ids) === false) return;
    const batch = runtime.activeRequests;
    runtime.activeRequests = [];
    runtime.activeIdleTicks = 0;
    // Reply ONCE, with the same final assistant message, for every request in
    // the batch (one reply file per request id preserves the 1:1 invariant),
    // and release every .processing claim.
    for (const request of batch) {
      const response: TalkResponse = {
        version: 1,
        type: "response",
        requestId: request.id,
        from: runtime.record.sessionId,
        to: request.from,
        ok: !!message,
        ...(message ? { message } : { error: "Peer did not produce a final assistant response" }),
        createdAt: nowIso(),
      };
      writeAtomic(join(repliesDir(runtime.root, request.from), `${request.id}.json`), response);
      rmSync(join(inboxDir(runtime.root, runtime.record.sessionId), `${request.id}.json.processing`), { force: true });
    }
  });
  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui?.setStatus("pi-peer", undefined);
    if (runtime) {
      const batch = runtime.activeRequests;
      try {
        // The callers may still be waiting (direct wait) or may already have
        // timed out (pending wake). Either way each must not hang or be promised
        // a wake that can never arrive: answer EVERY entry in the batch with a
        // terminal error reply so the callers fail instead of waiting out the
        // deadline.
        for (const request of batch) {
          try {
            writeAtomic(join(repliesDir(runtime.root, request.from), `${request.id}.json`), {
              version: 1,
              type: "response",
              requestId: request.id,
              from: runtime.record.sessionId,
              to: request.from,
              ok: false,
              error: "Peer session shut down before finishing the request",
              createdAt: nowIso(),
            } satisfies TalkResponse);
          } catch {
            // Continue answering the rest; the finally still releases claims.
          }
        }
      } finally {
        // The .processing claims and the registration removal must not be
        // skipped if an error reply write fails: leaking a claim would let
        // a same-id restart re-deliver the request, and leaking the
        // registration (the authoritative liveness signal) would make every
        // future caller believe a dead session is alive.
        for (const request of batch) {
          rmSync(join(inboxDir(runtime.root, runtime.record.sessionId), `${request.id}.json.processing`), { force: true });
        }
        removeOwnedRecord(runtime.root, runtime.record);
        // This session can no longer be woken or wake itself: drop its own
        // waiters and replies (the error replies for the active requests live in
        // the CALLER's replies dir and stay for the callers to consume).
        rmSync(waitersDir(runtime.root, runtime.record.sessionId), { recursive: true, force: true });
        rmSync(repliesDir(runtime.root, runtime.record.sessionId), { recursive: true, force: true });
      }
    }
    if (interval) clearInterval(interval);
    interval = null;
    drainInFlight = null;
    runtime = null;
  });
}
