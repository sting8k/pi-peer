import type { AgentToolUpdateCallback, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Static } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

import { TalkLatestParams, TalkSessionsParams, TalkToParams } from "./schemas.ts";
import {
  getCurrentHerdrPeerContextAsync,
  getHerdrPeerStatusAsync,
  getTalkRootDir,
  type HerdrAgentStatus,
  type HerdrPeerContext,
} from "./herdr.ts";
import { readJson, writeAtomic } from "./storage.ts";
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
  ensureRecord,
  extractAssistantText,
  inboxDir,
  isTalkRequest,
  liveRecords,
  loadRecords,
  newRequestId,
  nowIso,
  publicPeerId,

  POLL_MS,
  recordPath,
  removeOwnedRecord,
  repliesDir,
  requeueProcessing,
  requestMessage,
  resolveTarget,
  routeForRequest,
  sessionDir,
  waitForResponse,
  type PeerRecord,
  type TalkProgressDetails,
  type TalkProgressState,
  type TalkRequest,
  type TalkResponse,
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
  activeRequest: TalkRequest | null;
};

async function drainInbox(pi: ExtensionAPI, runtime: Runtime, isBusy: () => boolean): Promise<void> {
  if (runtime.activeRequest || isBusy()) return;
  const dir = inboxDir(runtime.root, runtime.record.sessionId);
  if (!existsSync(dir)) return;
  const pending = readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
  for (const name of pending) {
    const path = join(dir, name);
    const request = readJson(path);
    if (!isTalkRequest(request) || request.to !== runtime.record.sessionId) {
      rmSync(path, { force: true });
      continue;
    }
    const processing = `${path}.processing`;
    try {
      renameSync(path, processing);
    } catch {
      continue;
    }
    runtime.activeRequest = request;
    try {
      const sender = loadRecords(runtime.root).find((record) => record.sessionId === request.from);
      await pi.sendMessage({
        customType: "talk_request",
        content: requestMessage(request, sender?.name ?? publicPeerId(request.from)),
        display: true,
        details: request,
      }, { triggerTurn: true, deliverAs: "steer" });
    } catch (error) {
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
      runtime.activeRequest = null;
    }
    return;
  }
}

async function executeTalkTo(
  params: TalkTo,
  runtime: Runtime,
  getStatus: typeof getHerdrPeerStatusAsync,
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
  writeAtomic(path, request);
  emitState("queued");
  const response = await waitForResponse(runtime.root, request, timeoutMs, {
    paneId: targetRecord.paneId,
    terminalId: targetRecord.terminalId,
    tabId: targetRecord.tabId,
    socketPath: runtime.peer.socketPath,
    workspaceId: targetRecord.workspaceId,
  }, getStatus, signal, emitState);
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

  const ensureRuntime = async (ctx: any, signal?: AbortSignal): Promise<Runtime> => {
    const sessionId = ctx.sessionManager.getSessionId();
    const current = runtime;
    if (current && current.record.sessionId === sessionId) {
      ensureRecord(current.root, current.record);
      return current;
    }
    const peer = await getCurrentPeer(signal);
    const root = rootDir(peer.workspaceId);
    const record: PeerRecord = {
      schemaVersion: 1,
      sessionId,
      name: basename(ctx.cwd) || publicPeerId(sessionId),
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
    runtime = { peer, record, root, activeRequest: null };
    if (!interval) {
      interval = setInterval(() => {
        if (!runtime || drainInFlight) return;
        ensureRecord(runtime.root, runtime.record);
        drainInFlight = drainInbox(pi, runtime, isBusy)
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
      const lines = peers.map(({ record, status }) =>
        `${publicPeerId(record.sessionId)}  ${record.name}  ${status}${record.sessionId === current.record.sessionId ? "  (current)" : ""}`,
      );
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
    description: "Send a blocking request to another live Pi session in the current HerdR workspace and return its final response.",
    promptSnippet: "Use `talk_to` to ask another Pi session for an independent response; call `talk_sessions` first when the target is unknown.",
    parameters: TalkToParams,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const current = await ensureRuntime(ctx, signal);
      return executeTalkTo(params as TalkTo, current, getStatus, signal, onUpdate);
    },
  });

  pi.on("session_start", (_event, ctx) => {
    void ensureRuntime(ctx)
      .then((current) => publishHistoryFromOwnSession(current, ctx))
      .catch(() => {});
  });
  pi.on("agent_start", () => {
    if (!hasBusyOverride) selfBusy = true;
  });
  pi.on("agent_end", (event, ctx) => {
    if (!hasBusyOverride) selfBusy = false;
    if (!runtime) return;
    // Session entries are persisted before the end event; rebuild from the
    // current lineage so ids are stable and no duplicate risk exists.
    publishHistoryFromOwnSession(runtime, ctx);
    const message = extractAssistantText((event as any).messages);
    if (!runtime.activeRequest) return;
    const request = runtime.activeRequest;
    runtime.activeRequest = null;
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
  });
  pi.on("session_shutdown", () => {
    if (runtime) {
      removeOwnedRecord(runtime.root, runtime.record);
    }
    if (interval) clearInterval(interval);
    interval = null;
    drainInFlight = null;
    runtime = null;
  });
}
