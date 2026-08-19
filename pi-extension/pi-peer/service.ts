import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

import { TalkLatestParams, TalkSessionsParams, TalkToParams } from "./schemas.ts";
import {
  getCurrentHerdrPeerContextAsync,
  getHerdrPeerStatusAsync,
  getTalkRootDir,
  type HerdrPeerContext,
} from "./herdr.ts";
import { readJson, readJsonChecked, writeAtomic } from "./storage.ts";
import {
  HISTORY_LIMIT,
  publishHistoryFromOwnSession,
  readHistory,
} from "./history.ts";
import {
  DEAD_SESSION_SWEEP_MS,
  ensureRecord,
  inboxDir,
  isPeerMessage,
  isPeerRecord,
  liveRecords,
  loadRecords,
  newMessageId,
  nowIso,
  peerMessageTag,
  pickPeerName,
  POLL_MS,
  publicPeerId,
  recordPath,
  removeOwnedRecord,
  requeueClaimedMessage,
  requeueProcessing,
  resolveTarget,
  sweepDeadSessions,
  withRegistrationLock,
  type PeerMessage,
  type PeerRecord,
} from "./protocol.ts";

type TalkTo = Static<typeof TalkToParams>;
type TalkLatest = Static<typeof TalkLatestParams>;

export type TalkDeps = {
  getCurrentPeer?: typeof getCurrentHerdrPeerContextAsync;
  getPeerStatus?: typeof getHerdrPeerStatusAsync;
  syncVisibleIdentity?: (
    peer: HerdrPeerContext,
    name: string,
    signal?: AbortSignal,
  ) => Promise<void>;
  isBusy?: () => boolean;
  rootDir?: (workspaceId: string) => string;
  /** Test seam for the host message-start acknowledgement deadline. */
  deliveryAckTimeoutMs?: number;
  /**
   * Test seam for `drainInbox`'s read of a queued message. Overriding this is
   * how the ok/retryable classification itself is proven at the integration
   * level, independent of whichever delete-failure guard happens to also
   * mask the same on-disk outcome.
   */
  readMessage?: (path: string) => ReturnType<typeof readJsonChecked>;
};

type Runtime = {
  peer: HerdrPeerContext;
  record: PeerRecord;
  root: string;
  generation: number;
};

type PendingDelivery = {
  runtime: Runtime;
  content: string;
  steer: boolean;
  // Non-steer only: the turn-start latch elapsed without agent_start. The claim
  // stays pending for session_start recovery, but no later turn may adopt it.
  expired: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
};

// Bounds only the non-steer turn latch: how long to wait for the host to
// engage a turn before releasing the latch. It is not a delivery deadline;
// see trackPendingDelivery.
const TURN_START_TIMEOUT_MS = 10_000;
const IDENTITY_SYNC_RETRY_DELAY_MS = 1_000;
const RUNTIME_BIND_SUPERSEDED_MESSAGE = "Peer runtime bind was superseded by a session lifecycle change";

function isExpectedLifecycleCancellation(error: unknown): boolean {
  return error instanceof Error && error.message === RUNTIME_BIND_SUPERSEDED_MESSAGE;
}

function userMessageText(message: unknown): string | undefined {
  if (
    !message
    || typeof message !== "object"
    || (message as { role?: unknown }).role !== "user"
  ) return undefined;
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter((part): part is { type: "text"; text: string } => {
      if (!part || typeof part !== "object") return false;
      const candidate = part as { type?: unknown; text?: unknown };
      return candidate.type === "text" && typeof candidate.text === "string";
    })
    .map((part) => part.text)
    .join("");
  return text || undefined;
}

/**
 * Send-only `talk_to`: resolve a currently-live target, atomically enqueue one
 * durable message, and return a confirmation that it was sent (durably queued)
 * immediately. A reply is simply another `talk_to` in the opposite direction —
 * there is no waiting for a response and no request/response correlation.
 */
async function executeTalkTo(
  params: TalkTo,
  runtime: Runtime,
  getStatus: typeof getHerdrPeerStatusAsync,
  signal?: AbortSignal,
): Promise<any> {
  const message = params.message.trim();
  const target = params.target.trim();
  if (!target) throw new Error("talk_to requires a target");
  if (!message) throw new Error("talk_to requires a non-empty message");
  const peers = await liveRecords(runtime.root, runtime.record.workspaceId, runtime.peer.socketPath, getStatus, signal);
  const targetRecord = resolveTarget(peers.map((entry) => entry.record), target);
  if (targetRecord.sessionId === runtime.record.sessionId) throw new Error("talk_to cannot target the current session");
  const sent: PeerMessage = {
    version: 1,
    type: "peer_message",
    id: newMessageId(),
    from: runtime.record.sessionId,
    fromName: runtime.record.name,
    to: targetRecord.sessionId,
    message,
    createdAt: nowIso(),
  };
  writeAtomic(join(inboxDir(runtime.root, targetRecord.sessionId), `${sent.id}.json`), sent);
  return {
    content: [{
      type: "text",
      text: `Message sent to ${targetRecord.name} (${publicPeerId(targetRecord.sessionId)}). A reply, if any, arrives later as a new <peer_message>.`,
    }],
    details: { source: "talk_to", target: publicPeerId(targetRecord.sessionId), state: "sent" },
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
    ...events.map((event) => `[${event.type} @ ${event.createdAt}] ${event.message}`),
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
      createdAt: events.at(-1)!.createdAt,
      events: events.map((event) => ({ type: event.type, createdAt: event.createdAt, id: event.id })),
    },
  };
}

/** Queue depth of a peer: count of still-queued `.json` message files in its
 * inbox dir. In-flight `.processing` claims are already injected and are not
 * counted. A missing inbox dir means zero, never an error.
 */
function inboxCount(root: string, sessionId: string): number {
  const dir = inboxDir(root, sessionId);
  if (!existsSync(dir)) return 0;
  // Count only still-queued `.json` messages. In-flight `.processing` claims
  // are already injected into the current turn, so they are not "queued".
  return readdirSync(dir).filter((name) => name.endsWith(".json")).length;
}

export function registerTalkTools(
  pi: ExtensionAPI,
  deps: TalkDeps = {},
): void {
  // isBusy/getCurrentPeer/getPeerStatus/syncVisibleIdentity/rootDir are injectable
  // test/runtime overrides for deterministic tests; the host feature gate lives
  // only in the standalone entrypoint (index.ts) via PI_PEER_DISABLED.
  const getCurrentPeer = deps.getCurrentPeer ?? getCurrentHerdrPeerContextAsync;
  const getStatus = deps.getPeerStatus ?? getHerdrPeerStatusAsync;
  const syncIdentity = deps.syncVisibleIdentity;
  const readMessage = deps.readMessage ?? readJsonChecked;
  const hasBusyOverride = typeof deps.isBusy === "function";
  // Standalone runtime self-tracks busy through agent_start/agent_settled unless
  // a caller injects an explicit busy function (test/runtime override).
  let selfBusy = false;
  const isBusy = hasBusyOverride ? deps.isBusy! : () => selfBusy;
  // F1: a non-steer (fresh-trigger) injection is in flight waiting for
  // agent_start to engage a turn. While set, no further message is drained, so
  // a burst of overlapping plain user turns cannot open in the gap between the
  // first idle injection and the host's agent_start.
  let turnStartPending = false;
  // F2: `.processing` claims the host has committed to. They stay claimed
  // until the whole agent run settles, so the claim covers the turn rather
  // than just the host's fire-and-forget API call.
  const inFlightClaims = new Set<string>();
  const pendingDeliveries = new Map<string, PendingDelivery>();
  const configuredDeliveryAckTimeoutMs = deps.deliveryAckTimeoutMs;
  const deliveryAckTimeoutMs = typeof configuredDeliveryAckTimeoutMs === "number"
    && Number.isFinite(configuredDeliveryAckTimeoutMs)
    && configuredDeliveryAckTimeoutMs > 0
    ? configuredDeliveryAckTimeoutMs
    : TURN_START_TIMEOUT_MS;
  // Session binds are serialized so session_start and an early tool call cannot
  // race to replace runtime ownership. A generation invalidates stale binds and
  // identity updates when the host switches sessions or shuts down.
  let pendingBinds = 0;
  let bindQueue: Promise<void> = Promise.resolve();
  let lifecycleGeneration = 0;
  let lifecycleSessionId: string | undefined;
  const rootDir = deps.rootDir ?? getTalkRootDir;
  let runtime: Runtime | null = null;
  let interval: ReturnType<typeof setInterval> | null = null;
  // Cross-session GC needs two observations: a peer waking from sleep must
  // refresh its registration before its artifacts can be removed.
  const deadSince = new Map<string, number>();
  let lastDeadSweepAt = 0;
  let identitySyncInFlight: Promise<void> | null = null;
  let identitySyncAbortController: AbortController | null = null;
  let identitySyncRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let identitySyncRefreshPending = false;

  const contextSessionId = (ctx: any): string | undefined => {
    const sessionId = ctx?.sessionManager?.getSessionId?.();
    return typeof sessionId === "string" && sessionId ? sessionId : undefined;
  };

  const isCurrentRuntime = (candidate: Runtime): boolean =>
    runtime === candidate && candidate.generation === lifecycleGeneration;

  const takePendingDelivery = (processingPath: string): PendingDelivery | undefined => {
    const pending = pendingDeliveries.get(processingPath);
    if (!pending) return undefined;
    pendingDeliveries.delete(processingPath);
    clearTimeout(pending.timer);
    return pending;
  };

  const commitPendingDelivery = (processingPath: string, pending: PendingDelivery): void => {
    if (isCurrentRuntime(pending.runtime)) inFlightClaims.add(processingPath);
    else requeueClaimedMessage(processingPath);
  };

  // Acknowledges a steered injection once the host actually replays it into the
  // transcript. Matching is by rendered content because a steered message has
  // no other correlator; identical contents are interchangeable, so acking the
  // oldest match is always sound.
  const acknowledgePendingDelivery = (content: string): void => {
    for (const [processingPath, pending] of pendingDeliveries) {
      if (pending.content !== content) continue;
      takePendingDelivery(processingPath);
      commitPendingDelivery(processingPath, pending);
      return;
    }
  };

  // A non-steer injection is acknowledged by the turn it triggers rather than
  // by message_start: the host may rewrite the text through an `input` handler
  // before it reaches the transcript, which no content match can follow. Once
  // agent_start fires the prompt is committed to the run.
  //
  // An unexpired claim always wins: it is the unambiguous trigger for this
  // turn. When none exists, the oldest expired non-steer claim is adopted
  // instead — a claim that expired only because the host was slow (compaction
  // can hold a turn past the deadline) is still the injection this turn was
  // started for. Adopting it here is what keeps agent_settled from leaking the
  // claim to disk, where session_start would requeue an already-processed
  // message. A claim with no following agent_start at all is untouched by this
  // function and stays pending for session_start recovery.
  const commitTriggeredDeliveries = (): void => {
    const entries = [...pendingDeliveries].filter(([, pending]) => !pending.steer);
    const fresh = entries.filter(([, pending]) => !pending.expired);
    const chosen = fresh.length > 0 ? fresh : entries.slice(0, 1);
    for (const [processingPath, pending] of chosen) {
      takePendingDelivery(processingPath);
      commitPendingDelivery(processingPath, pending);
    }
  };

  // The host never engaged a turn for a non-steer injection: an `input` handler
  // consumed the prompt, or the host threw after accepting it (no model, no
  // auth, compaction in progress). The host's sendUserMessage is fire-and-forget
  // and swallows that rejection into its own error channel, so the synchronous
  // catch around the injection cannot see it. Release the latch so delivery is
  // not blocked forever, but keep the claim pending: the message may still be in
  // flight inside the host, and requeueing here is what caused the same message
  // to be delivered twice. An abandoned claim is recovered at session_start.
  const expireTurnStartLatch = (processingPath: string): void => {
    const pending = pendingDeliveries.get(processingPath);
    if (!pending || !isCurrentRuntime(pending.runtime)) return;
    pending.timer = undefined;
    pending.expired = true;
    turnStartPending = false;
    console.error("pi-peer message injection did not start a turn before the deadline");
  };

  const trackPendingDelivery = (
    current: Runtime,
    processingPath: string,
    content: string,
    steer: boolean,
  ): void => {
    const pending: PendingDelivery = { runtime: current, content, steer, expired: false, timer: undefined };
    // Only the non-steer path gets a timer, and only to release the turn latch.
    // A steered message is queued inside the host until the running turn drains
    // it (the agent loop drains steering after the assistant stream and every
    // tool call), so no wall-clock deadline can bound its acknowledgement.
    if (!steer) {
      pending.timer = setTimeout(() => expireTurnStartLatch(processingPath), deliveryAckTimeoutMs);
      pending.timer.unref?.();
    }
    pendingDeliveries.set(processingPath, pending);
  };

  const requeuePendingDeliveries = (): void => {
    for (const processingPath of pendingDeliveries.keys()) {
      takePendingDelivery(processingPath);
      requeueClaimedMessage(processingPath);
    }
  };

  const eventBelongsToLifecycle = (ctx: any): boolean => {
    const sessionId = contextSessionId(ctx);
    return !lifecycleSessionId || !sessionId || lifecycleSessionId === sessionId;
  };

  const releaseBind = (): void => {
    pendingBinds--;
  };

  const enqueueBind = <T>(work: () => Promise<T>): Promise<T> => {
    pendingBinds++;
    const result = bindQueue.then(work);
    bindQueue = result.then(() => undefined, () => undefined);
    void result.then(releaseBind, releaseBind);
    return result;
  };

  const cancelIdentitySync = (): void => {
    identitySyncAbortController?.abort();
    identitySyncAbortController = null;
    identitySyncInFlight = null;
    identitySyncRefreshPending = false;
    if (identitySyncRetryTimer) {
      clearTimeout(identitySyncRetryTimer);
      identitySyncRetryTimer = null;
    }
  };

  /**
   * Keep Herdr's visible identity aligned with the stable peer name. This is
   * attempted at session_start and on every agent_start because Herdr clears
   * agent names when the foreground process is replaced. Sync failures are
   * cosmetic and retried once after a short delay.
   */
  const syncVisibleIdentity = (current: Runtime, isRetry = false): void => {
    if (!syncIdentity || !isCurrentRuntime(current)) return;
    if (identitySyncRetryTimer) {
      clearTimeout(identitySyncRetryTimer);
      identitySyncRetryTimer = null;
    }
    if (identitySyncInFlight) {
      identitySyncRefreshPending = true;
      return;
    }

    const controller = new AbortController();
    identitySyncAbortController = controller;
    const syncRun = Promise.resolve()
      .then(() => {
        if (!isCurrentRuntime(current)) return;
        return syncIdentity(current.peer, current.record.name, controller.signal);
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        console.error("pi-peer Herdr identity sync failed", error);
        if (isCurrentRuntime(current) && !isRetry && !identitySyncRetryTimer) {
          identitySyncRetryTimer = setTimeout(() => {
            identitySyncRetryTimer = null;
            if (runtime) syncVisibleIdentity(runtime, true);
          }, IDENTITY_SYNC_RETRY_DELAY_MS);
          identitySyncRetryTimer.unref?.();
        }
      })
      .then(() => undefined, () => undefined)
      .finally(() => {
        if (identitySyncAbortController === controller) identitySyncAbortController = null;
        if (identitySyncInFlight === syncRun) identitySyncInFlight = null;
        if (identitySyncRefreshPending) {
          identitySyncRefreshPending = false;
          if (runtime) syncVisibleIdentity(runtime);
        }
      });
    identitySyncInFlight = syncRun;
  };

  /**
   * Deliver at most one inbox message per poll tick, in FIFO (filename) order.
   * An idle receiver gets a normal user message (trigger behavior); a busy one
   * gets the message steered into its running turn via `deliverAs: "steer"`,
   * regardless of who sent it.
   *
   * F1 idle-burst latch: a non-steer (fresh-trigger) injection sets
   * `turnStartPending` BEFORE the injection, so no further message is drained
   * until `agent_start` confirms a turn engaged (after which the receiver is
   * busy and later messages steer). This prevents a burst of overlapping plain
   * user turns in the gap between the first idle injection and agent_start.
   *
   * F2 claim lifetime: an acknowledged `.processing` claim is NOT deleted here
   * — it is tracked in `inFlightClaims` and consumed at `agent_settled`, so the
   * claim covers the whole host run. Pi's sendUserMessage API is
   * fire-and-forget, so acknowledgement comes from a later host event:
   * `agent_start` for a non-steer injection (the turn it triggered) and
   * `message_start` for a steered one (the host replaying it). Neither is
   * bounded by a wall clock, so an unacknowledged claim is never requeued into
   * a live host — only `session_start` recovers it, which keeps redelivery from
   * duplicating a message the host still holds.
   */
  const drainInbox = (pi: ExtensionAPI, current: Runtime): void => {
    const canDeliver = (): boolean => isCurrentRuntime(current) && pendingBinds === 0;
    if (turnStartPending || !canDeliver()) return;
    const dir = inboxDir(current.root, current.record.sessionId);
    if (!existsSync(dir)) return;
    const pending = readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .sort((left, right) => left.localeCompare(right));
    for (const name of pending) {
      if (!canDeliver()) return;
      const path = join(dir, name);
      const read = readMessage(path);
      if (!read.ok) {
        // A transient read failure is not evidence the message is corrupt.
        // Leave it queued and let a later tick retry; deleting here loses it.
        if (read.retryable) continue;
        // A corrupt entry that cannot be removed must not block the queue: the
        // tick would throw on the same entry forever and starve every message
        // behind it.
        try {
          rmSync(path, { force: true });
        } catch {
          // fall through: skip it this tick
        }
        continue;
      }
      const message = read.value;
      if (!isPeerMessage(message) || message.to !== current.record.sessionId) {
        // Malformed or misaddressed: cannot be delivered. There is no reply
        // surface anymore, so drop it rather than block a valid sibling.
        try {
          rmSync(path, { force: true });
        } catch {
          // fall through: skip it this tick
        }
        continue;
      }
      const processing = `${path}.processing`;
      try {
        renameSync(path, processing);
      } catch {
        continue; // claimed by a concurrent drain this tick
      }
      if (!canDeliver()) {
        requeueClaimedMessage(processing);
        return;
      }
      const steer = isBusy();
      const content = peerMessageTag(message);
      // F1: latch BEFORE the non-steer injection so a tick cannot open a second
      // overlapping plain turn while the host engages the turn.
      if (!steer) turnStartPending = true;
      trackPendingDelivery(current, processing, content, steer);
      try {
        pi.sendUserMessage(content, steer ? { deliverAs: "steer" } : undefined);
      } catch {
        const pending = takePendingDelivery(processing);
        if (pending && isCurrentRuntime(current) && !pending.steer) turnStartPending = false;
        if (!inFlightClaims.has(processing)) requeueClaimedMessage(processing);
        return;
      }
      // A shutdown/session switch can happen while the host accepts the
      // message. The pending claim remains recoverable and is requeued by the
      // lifecycle handler rather than being attached to the next runtime.
      if (!isCurrentRuntime(current)) return;
      return; // one message per tick
    }
  };

  const bindRuntime = async (
    ctx: any,
    signal: AbortSignal | undefined,
    generation: number,
  ): Promise<Runtime> => {
    if (generation !== lifecycleGeneration) {
      throw new Error(RUNTIME_BIND_SUPERSEDED_MESSAGE);
    }
    const sessionId = contextSessionId(ctx);
    if (!sessionId) throw new Error("Peer runtime requires a session id");
    const peer = await getCurrentPeer(signal);
    if (generation !== lifecycleGeneration) {
      throw new Error(RUNTIME_BIND_SUPERSEDED_MESSAGE);
    }
    const root = rootDir(peer.workspaceId);
    const record = await withRegistrationLock(root, () => {
      const existing = readJson(recordPath(root, sessionId));
      const name = isPeerRecord(existing) && existing.sessionId === sessionId
        ? existing.name
        : pickPeerName(
          sessionId,
          new Set(loadRecords(root)
            .filter((candidate) => candidate.sessionId !== sessionId)
            .map((candidate) => candidate.name)),
        );
      const nextRecord: PeerRecord = {
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
      writeAtomic(recordPath(root, sessionId), nextRecord);
      return nextRecord;
    });
    if (generation !== lifecycleGeneration) {
      removeOwnedRecord(root, record);
      throw new Error(RUNTIME_BIND_SUPERSEDED_MESSAGE);
    }

    // Reclaim any `.processing` message orphaned by a crash mid-injection so
    // it is redelivered rather than lost.
    requeueProcessing(root, sessionId);
    const previous = runtime;
    if (previous) {
      // Session-switch ownership transfer: only after the new registration is
      // written and requeued, remove the previous runtime's owned live
      // registration. The registrationId guard keeps a registration that is
      // now owned by another runtime. Other artifacts (latest/inbox) are not
      // lifecycle-owned and are left in place.
      removeOwnedRecord(previous.root, previous.record);
    }
    const nextRuntime: Runtime = { peer, record, root, generation };
    runtime = nextRuntime;
    interval ??= setInterval(() => {
      if (!runtime || !isCurrentRuntime(runtime)) return;
      const currentRuntime = runtime;
      try {
        // Heartbeat first, unconditionally: the registration liveness signal
        // must not depend on message injection semantics.
        ensureRecord(currentRuntime.root, currentRuntime.record);
        drainInbox(pi, currentRuntime);
        // Cross-session GC on a slow cadence: dead sessions' artifacts
        // (registration, latest, inbox) are removed by whichever live
        // session reaches the interval first.
        if (Date.now() - lastDeadSweepAt >= DEAD_SESSION_SWEEP_MS) {
          sweepDeadSessions(currentRuntime.root, deadSince);
          lastDeadSweepAt = Date.now();
        }
      } catch (error) {
        console.error("pi-peer inbox poll failed", error);
      }
    }, POLL_MS);
    return nextRuntime;
  };

  const ensureRuntime = (
    ctx: any,
    signal?: AbortSignal,
    forceBind = false,
  ): Promise<Runtime> => {
    const sessionId = contextSessionId(ctx);
    if (!sessionId) return Promise.reject(new Error("Peer runtime requires a session id"));
    const currentRuntime = runtime;
    if (!forceBind && currentRuntime?.record.sessionId === sessionId && pendingBinds === 0) {
      ensureRecord(currentRuntime.root, currentRuntime.record);
      return Promise.resolve(currentRuntime);
    }

    const generation = lifecycleGeneration;
    return enqueueBind(async () => {
      if (generation !== lifecycleGeneration) {
        throw new Error(RUNTIME_BIND_SUPERSEDED_MESSAGE);
      }
      const currentRuntime = runtime;
      if (!forceBind && currentRuntime?.record.sessionId === sessionId) {
        ensureRecord(currentRuntime.root, currentRuntime.record);
        return currentRuntime;
      }
      return bindRuntime(ctx, signal, generation);
    });
  };

  pi.registerTool({
    name: "talk_sessions",
    label: "Talk Sessions",
    description: "List live Pi peer sessions in the current Herdr workspace.",
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
    description: "Send a message to another live Pi session in the current Herdr workspace. Returns confirmation that the message was sent (durably queued in the peer's mailbox); the peer's later reply arrives as a new <peer_message>. Do not reply merely to acknowledge unless useful.",
    promptSnippet: "Use `talk_to` to send a chat message to another Pi session; call `talk_sessions` first when the target is unknown.",
    parameters: TalkToParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const current = await ensureRuntime(ctx, signal);
      return executeTalkTo(params as TalkTo, current, getStatus, signal);
    },
  });

  pi.on("session_start", (_event, ctx) => {
    lifecycleGeneration++;
    lifecycleSessionId = contextSessionId(ctx);
    // A reload/resume may miss the prior agent_settled; never carry stale
    // busy, turn-start, or delivery state across a session bind. Requeue any
    // claims tracked for the previous runtime before switching so they are not
    // stranded as `.processing` until a future restart.
    requeuePendingDeliveries();
    for (const processing of inFlightClaims) requeueClaimedMessage(processing);
    if (runtime) {
      requeueProcessing(runtime.root, runtime.record.sessionId);
      removeOwnedRecord(runtime.root, runtime.record);
      runtime = null;
    }
    selfBusy = false;
    turnStartPending = false;
    inFlightClaims.clear();
    cancelIdentitySync();
    void ensureRuntime(ctx, undefined, true)
      .then((current) => {
        if (!isCurrentRuntime(current)) return;
        // Orphaned claims were already reclaimed inside bindRuntime, before this
        // runtime went live. Sweeping again here would release a claim the newly
        // bound host may already hold, redelivering it (see ADR 0013).
        syncVisibleIdentity(current);
        ctx.ui?.setStatus("pi-peer", `${current.record.name} · ${publicPeerId(current.record.sessionId)}`);
        publishHistoryFromOwnSession(current, ctx);
      })
      .catch((error) => {
        if (!isExpectedLifecycleCancellation(error)) {
          console.error("pi-peer session bind failed", error);
        }
      });
  });
  pi.on("agent_start", (_event, ctx) => {
    if (!eventBelongsToLifecycle(ctx)) return;
    // F1: a triggered turn has engaged; clear the pending latch and mark busy.
    turnStartPending = false;
    // The turn carries whatever non-steer injection triggered it.
    commitTriggeredDeliveries();
    if (!hasBusyOverride) selfBusy = true;
    // Refresh the visible identity after Herdr observes Pi as foreground.
    if (runtime && isCurrentRuntime(runtime)) syncVisibleIdentity(runtime);
  });
  pi.on("message_start", (event, ctx) => {
    if (!eventBelongsToLifecycle(ctx)) return;
    const content = userMessageText(event?.message);
    if (content) acknowledgePendingDelivery(content);
  });
  pi.on("agent_settled", (_event, ctx) => {
    if (!eventBelongsToLifecycle(ctx)) return;
    const current = runtime;
    if (!current || !isCurrentRuntime(current)) {
      if (!hasBusyOverride) selfBusy = false;
      turnStartPending = false;
      return;
    }
    if (!hasBusyOverride) selfBusy = false;
    turnStartPending = false;
    // Deliveries still pending here are steered messages the host has accepted
    // but not yet replayed (it drains its steering queue at turn boundaries and
    // keeps the queue across an abort). They stay pending so a later
    // message_start can acknowledge them; requeueing would hand the host a
    // second copy of a message it already holds.
    for (const processing of inFlightClaims) rmSync(processing, { force: true });
    inFlightClaims.clear();
    // Rebuild after all retries, compaction, and queued continuations settle.
    // No automatic reply is produced: a reply is a separate `talk_to` the
    // agent chooses to send.
    publishHistoryFromOwnSession(current, ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    if (!eventBelongsToLifecycle(ctx)) return;
    lifecycleGeneration++;
    lifecycleSessionId = undefined;
    ctx.ui?.setStatus("pi-peer", undefined);
    // Clear local F1/F2 state. Unconsumed `.processing` claims are left on disk
    // (recoverable via the next startup requeue) so nothing is lost on shutdown.
    turnStartPending = false;
    for (const pending of pendingDeliveries.values()) clearTimeout(pending.timer);
    pendingDeliveries.clear();
    inFlightClaims.clear();
    cancelIdentitySync();
    if (runtime) {
      // Remove the owned registration (the authoritative liveness signal);
      // inbox/latest artifacts are not lifecycle-owned and are left for the
      // cross-session GC sweep.
      removeOwnedRecord(runtime.root, runtime.record);
    }
    if (interval) clearInterval(interval);
    interval = null;
    runtime = null;
  });
}
