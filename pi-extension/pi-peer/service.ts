import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Static } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

import { TalkLatestParams, TalkSessionsParams, TalkToParams } from "./schemas.ts";
import {
  getCurrentHerdrPeerContextAsync,
  getHerdrPeerStatusAsync,
  getTalkRootDir,
  type HerdrPeerContext,
} from "./herdr.ts";
import { readJson, writeAtomic } from "./storage.ts";
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
  requeueProcessing,
  resolveTarget,
  sessionDir,
  sweepDeadSessions,
  type PeerMessage,
  type PeerRecord,
} from "./protocol.ts";

type TalkTo = Static<typeof TalkToParams>;
type TalkLatest = Static<typeof TalkLatestParams>;

export type TalkDeps = {
  getCurrentPeer?: typeof getCurrentHerdrPeerContextAsync;
  getPeerStatus?: typeof getHerdrPeerStatusAsync;
  isBusy?: () => boolean;
  rootDir?: (workspaceId: string) => string;
};

type Runtime = {
  peer: HerdrPeerContext;
  record: PeerRecord;
  root: string;
};

/**
 * Send-only `talk_to`: resolve a currently-live target, atomically enqueue one
 * durable message, and return delivery confirmation immediately. A reply is
 * simply another `talk_to` in the opposite direction — there is no waiting for
 * a response and no request/response correlation.
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
      text: `Message delivered to ${targetRecord.name} (${publicPeerId(targetRecord.sessionId)}). A reply, if any, arrives later as a new <peer_message>.`,
    }],
    details: { source: "talk_to", target: publicPeerId(targetRecord.sessionId), state: "delivered" },
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

/**
 * Deliver at most one inbox message per poll tick, in FIFO (filename) order.
 * An idle receiver gets a normal user message (trigger behavior); a busy one
 * gets the message steered into its running turn via `deliverAs: "steer"`,
 * regardless of who sent it. If injection fails, the claimed `.processing`
 * message is requeued so it is never silently lost.
 */
async function drainInbox(pi: ExtensionAPI, runtime: Runtime, isBusy: () => boolean): Promise<void> {
  const dir = inboxDir(runtime.root, runtime.record.sessionId);
  if (!existsSync(dir)) return;
  const pending = readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
  for (const name of pending) {
    const path = join(dir, name);
    const message = readJson(path);
    if (!isPeerMessage(message) || message.to !== runtime.record.sessionId) {
      // Malformed or misaddressed: cannot be delivered. There is no reply
      // surface anymore, so drop it rather than block a valid sibling.
      rmSync(path, { force: true });
      continue;
    }
    const processing = `${path}.processing`;
    try {
      renameSync(path, processing);
    } catch {
      continue; // claimed by a concurrent drain this tick
    }
    try {
      await pi.sendUserMessage(
        peerMessageTag(message),
        isBusy() ? { deliverAs: "steer" } : undefined,
      );
    } catch {
      // Injection failed: requeue the claim; never silently lose the message.
      requeueProcessing(runtime.root, runtime.record.sessionId);
      return;
    }
    rmSync(processing, { force: true });
    return; // one message per tick
  }
}

/** Queue depth of a peer: count of `.json` message files still present in its
 * inbox dir (queued or currently claimed as `.processing`). A missing inbox dir
 * means zero, never an error.
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
  // Cross-session GC needs two observations: a peer waking from sleep must
  // refresh its registration before its artifacts can be removed.
  const deadSince = new Map<string, number>();
  let lastDeadSweepAt = 0;

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
    // Reclaim any `.processing` message orphaned by a crash mid-injection so
    // it is redelivered rather than lost.
    requeueProcessing(root, sessionId);
    if (current) {
      // Session-switch ownership transfer: only after the new registration is
      // written and requeued, remove the previous runtime's owned live
      // registration. The registrationId guard keeps a registration that is
      // now owned by another runtime. Other artifacts (latest/inbox) are not
      // lifecycle-owned and are left in place.
      removeOwnedRecord(current.root, current.record);
    }
    runtime = { peer, record, root };
    if (!interval) {
      interval = setInterval(() => {
        if (!runtime) return;
        const currentRuntime = runtime;
        // Heartbeat first, unconditionally: the registration liveness signal
        // must not depend on sendUserMessage semantics (fire-and-forget in
        // the host today, declared Promise<void>) or on the drain chain.
        ensureRecord(currentRuntime.root, currentRuntime.record);
        if (drainInFlight) return;
        drainInFlight = drainInbox(pi, currentRuntime, isBusy)
          .then(() => {
            // Cross-session GC on a slow cadence: dead sessions' artifacts
            // (registration, latest, inbox) are removed by whichever live
            // session reaches the interval first.
            if (Date.now() - lastDeadSweepAt >= DEAD_SESSION_SWEEP_MS) {
              sweepDeadSessions(currentRuntime.root, deadSince);
              lastDeadSweepAt = Date.now();
            }
          })
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
    description: "Send a message to another live Pi session in the current HerdR workspace. Returns delivery confirmation only; the peer's later reply arrives as a new <peer_message>. Do not reply merely to acknowledge unless useful.",
    promptSnippet: "Use `talk_to` to send a chat message to another Pi session; call `talk_sessions` first when the target is unknown.",
    parameters: TalkToParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const current = await ensureRuntime(ctx, signal);
      return executeTalkTo(params as TalkTo, current, getStatus, signal);
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
  });
  pi.on("agent_end", (event, ctx) => {
    if (!hasBusyOverride) selfBusy = false;
    if (!runtime) return;
    // Session entries are persisted before the end event; rebuild from the
    // current lineage so ids are stable and no duplicate risk exists. No
    // automatic reply is produced: a reply is a separate `talk_to` the agent
    // chooses to send.
    publishHistoryFromOwnSession(runtime, ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui?.setStatus("pi-peer", undefined);
    if (runtime) {
      // Remove the owned registration (the authoritative liveness signal);
      // inbox/latest artifacts are not lifecycle-owned and are left for the
      // cross-session GC sweep.
      removeOwnedRecord(runtime.root, runtime.record);
    }
    if (interval) clearInterval(interval);
    interval = null;
    drainInFlight = null;
    runtime = null;
  });
}