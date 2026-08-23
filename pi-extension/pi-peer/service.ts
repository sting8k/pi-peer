import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Static } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

import { TalkLatestParams, TalkSessionsParams, TalkToParams } from "./schemas.ts";
import {
  clearPaneLabelAsync,
  getCurrentHerdrPeerContextAsync,
  getHerdrPeerStatusAsync,
  getTalkRootDir,
  HerdrUnavailableError,
  probePaneCountAsync,
  renamePaneAsync,
  renameTabAsync,
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
  HEARTBEAT_INTERVAL_MS,
  POLL_MS,
  publicPeerId,
  recordPath,
  removeOwnedRecord,
  requeueClaimedMessage,
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
  renamePane?: typeof renamePaneAsync;
  clearPaneLabel?: typeof clearPaneLabelAsync;
  renameTab?: typeof renameTabAsync;
  probePaneCount?: typeof probePaneCountAsync;
  /** Cadence for re-checking the label surface (splits/panes-closed between
   * binds). Test seam; defaults to the registration heartbeat interval. */
  surfaceCheckMs?: number;
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
      createdAt: events[events.length - 1].createdAt,
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
  // isBusy/getCurrentPeer/getPeerStatus/rootDir are injectable test/runtime
  // overrides for deterministic tests; the host feature gate lives only in the
  // standalone entrypoint (index.ts) via PI_PEER_DISABLED.
  const getCurrentPeer = deps.getCurrentPeer ?? getCurrentHerdrPeerContextAsync;
  const getStatus = deps.getPeerStatus ?? getHerdrPeerStatusAsync;
  const renamePane = deps.renamePane ?? renamePaneAsync;
  const clearPaneLabel = deps.clearPaneLabel ?? clearPaneLabelAsync;
  const renameTab = deps.renameTab ?? renameTabAsync;
  const probePaneCount = deps.probePaneCount ?? probePaneCountAsync;
  const surfaceCheckMs = deps.surfaceCheckMs ?? HEARTBEAT_INTERVAL_MS;
  const hasBusyOverride = typeof deps.isBusy === "function";
  // Standalone runtime self-tracks busy through agent_start/agent_end unless a
  // caller injects an explicit busy function (test/runtime override).
  let selfBusy = false;
  const isBusy = hasBusyOverride ? deps.isBusy! : () => selfBusy;
  // Surface-label mutations are serialized: a slow rename must never complete
  // after a later clear/rename and leave a stale peer name. The visible name
  // surface is the tab when the peer is its only pane (pane labels are hidden
  // until a split exists), otherwise the pane itself. Errors are swallowed
  // inside the queue (cosmetic, never block lifecycle).
  let labelQueue: Promise<void> = Promise.resolve();
  const enqueueLabelOp = (op: () => Promise<void>): void => {
    labelQueue = labelQueue.then(op).catch(() => {});
  };
  // A surface owns its release data: panes clear (--clear), tabs are renamed
  // back to the OWNING workspace's name (empty labels render as blank tabs).
  type LabeledSurface = { kind: "pane" | "tab"; id: string; workspaceId: string };
  let labeledSurface: LabeledSurface | null = null;
  // Last label-surface re-check (splits/pane-closes between binds); 0 forces
  // a check on the first heartbeat tick after bind.
  let lastSurfaceCheckAt = 0;
  const renameSurface = (surface: LabeledSurface, label: string) =>
    surface.kind === "pane" ? renamePane(surface.id, label) : renameTab(surface.id, label);
  // Releasing a surface: panes have a real clear (--clear); tabs do not, so
  // a tab is restored to its owning workspace's name. The workspace travels
  // with the surface object so a stale surface from a previous runtime is
  // never renamed with the NEW runtime's workspace id.
  const releaseSurface = (surface: LabeledSurface) =>
    surface.kind === "pane" ? clearPaneLabel(surface.id) : renameTab(surface.id, surface.workspaceId);
  // Lifecycle generation: bumped on shutdown. A bind that was awaiting its
  // peer context when shutdown landed must not commit a runtime, write a
  // registration, or enqueue a pane rename — it belongs to a dead session.
  let lifecycleGeneration = 0;
  // F1: a non-steer (fresh-trigger) injection is in flight waiting for
  // agent_start to engage a turn. While set, no further message is drained, so
  // a burst of overlapping plain user turns cannot open in the gap between the
  // first idle injection and the host's agent_start.
  let turnStartPending = false;
  // F2: `.processing` claims already injected into the current turn. They stay
  // claimed (at-least-once) until the turn completes at agent_end, so the claim
  // covers the turn rather than just the host's sendUserMessage acceptance.
  const inFlightClaims = new Set<string>();
  // Session-bind latch: while a session_start bind is in flight (requeueing the
  // previous runtime's claims and resolving the new runtime asynchronously), the
  // poll interval must not drain the still-current old runtime's inbox and
  // redeliver a just-requeued message. Cleared once the bind completes or fails.
  let bindInProgress = false;
  const rootDir = deps.rootDir ?? getTalkRootDir;
  let runtime: Runtime | null = null;
  let interval: ReturnType<typeof setInterval> | null = null;
  let drainInFlight: Promise<void> | null = null;
  // Cross-session GC needs two observations: a peer waking from sleep must
  // refresh its registration before its artifacts can be removed.
  const deadSince = new Map<string, number>();
  let lastDeadSweepAt = 0;

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
   * F2 claim lifetime: a successfully injected `.processing` claim is NOT
   * deleted here — it is tracked in `inFlightClaims` and consumed at
   * `agent_end`, so the claim covers the turn rather than only the host's
   * sendUserMessage acceptance. A failed injection requeues only its own claim.
   */
  const drainInbox = async (pi: ExtensionAPI, runtime: Runtime): Promise<void> => {
    if (turnStartPending) return;
    if (bindInProgress) return; // a session bind is in flight; do not drain the old inbox
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
      const steer = isBusy();
      // F1: latch BEFORE the non-steer injection so a tick cannot open a second
      // overlapping plain turn while this async injection is in flight.
      if (!steer) turnStartPending = true;
      try {
        await pi.sendUserMessage(
          peerMessageTag(message),
          steer ? { deliverAs: "steer" } : undefined,
        );
      } catch {
        // Injection failed: unlatch and requeue only this claim; never lose it.
        turnStartPending = false;
        requeueClaimedMessage(processing);
        return;
      }
      // F2: keep the claim in-flight until the turn completes at agent_end.
      inFlightClaims.add(processing);
      return; // one message per tick
    }
  };

  const ensureRuntime = async (ctx: any, signal?: AbortSignal): Promise<Runtime | null> => {
    const sessionId = ctx.sessionManager.getSessionId();
    const current = runtime;
    if (current && current.record.sessionId === sessionId) {
      ensureRecord(current.root, current.record);
      return current;
    }
    const bindGeneration = lifecycleGeneration;
    const peer = await getCurrentPeer(signal);
    // The bind crossed a shutdown while awaiting the peer context: committing
    // now would resurrect a dead session (registration, pane label, footer).
    if (bindGeneration !== lifecycleGeneration) return null;
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
    // Cosmetic, best-effort: label the visible name surface with the peer
    // display name — the tab when this peer is its only pane, else the pane.
    // Fires only on fresh runtime creation (bind/switch), never the cached
    // fast-path, so a manual rename mid-session is never fought over.
    // Serialized so an op cannot complete after a later op for this surface.
    const surface: LabeledSurface = peer.paneCount === 1 && peer.tabId
      ? { kind: "tab", id: peer.tabId, workspaceId: peer.workspaceId }
      : { kind: "pane", id: peer.paneId, workspaceId: peer.workspaceId };
    if (labeledSurface && (labeledSurface.kind !== surface.kind || labeledSurface.id !== surface.id)) {
      const stale = labeledSurface;
      enqueueLabelOp(() => releaseSurface(stale));
    }
    enqueueLabelOp(() => renameSurface(surface, record.name));
    labeledSurface = surface;
    if (!interval) {
      interval = setInterval(() => {
        if (!runtime) return;
        const currentRuntime = runtime;
        // Heartbeat first, unconditionally: the registration liveness signal
        // must not depend on sendUserMessage semantics (fire-and-forget in
        // the host today, declared Promise<void>) or on the drain chain.
        ensureRecord(currentRuntime.root, currentRuntime.record);
        // Label surface re-evaluation on the heartbeat cadence: a split or
        // pane-close between binds changes which surface is visible. Probe is
        // cosmetic best-effort (undefined -> no-op). A rebind that lands
        // mid-probe re-stamps labeledSurface (fresh object), so the stale-
        // check below drops this migration instead of fighting the bind.
        if (Date.now() - lastSurfaceCheckAt >= surfaceCheckMs) {
          lastSurfaceCheckAt = Date.now();
          const surface = labeledSurface;
          if (surface && currentRuntime.peer.tabId) {
            void probePaneCount(currentRuntime.peer.tabId, currentRuntime.peer.socketPath)
              .then((count) => {
                if (runtime !== currentRuntime || labeledSurface !== surface || count === undefined) return;
                if (surface.kind === "tab" && count > 1) {
                  labeledSurface = { kind: "pane", id: currentRuntime.peer.paneId, workspaceId: currentRuntime.peer.workspaceId };
                  const next = labeledSurface;
                  enqueueLabelOp(() => releaseSurface(surface));
                  enqueueLabelOp(() => renameSurface(next, currentRuntime.record.name));
                } else if (surface.kind === "pane" && count === 1) {
                  labeledSurface = { kind: "tab", id: currentRuntime.peer.tabId!, workspaceId: currentRuntime.peer.workspaceId };
                  const next = labeledSurface;
                  enqueueLabelOp(() => releaseSurface(surface));
                  enqueueLabelOp(() => renameSurface(next, currentRuntime.record.name));
                }
              })
              .catch(() => {});
          }
        }
        if (drainInFlight) return;
        drainInFlight = drainInbox(pi, currentRuntime)
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
    description: "List live Pi peer sessions in the current Herdr workspace.",
    promptSnippet: "Use `talk_sessions` to find a peer's public id (e.g. `peer-abc`) before calling `talk_to`.",
    parameters: TalkSessionsParams,
    async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
      const current = await ensureRuntime(ctx, signal);
      if (!current) throw new Error("pi-peer unavailable: session ended during bind");
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
      if (!current) throw new Error("pi-peer unavailable: session ended during bind");
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
      if (!current) throw new Error("pi-peer unavailable: session ended during bind");
      return executeTalkTo(params as TalkTo, current, getStatus, signal);
    },
  });

  pi.on("session_start", (_event, ctx) => {
    // A reload/resume may miss the prior agent_end; never carry stale busy,
    // turn-start, or in-flight claim state across a session bind. Requeue any
    // claims tracked for the previous runtime before switching so they are not
    // stranded as `.processing` until a future restart.
    // Bind latch: hold the poll interval off the old runtime's inbox while the
    // async bind resolves, so a just-requeued message is not drained again.
    bindInProgress = true;
    for (const processing of inFlightClaims) requeueClaimedMessage(processing);
    selfBusy = false;
    turnStartPending = false;
    inFlightClaims.clear();
    void ensureRuntime(ctx)
      .then((current) => {
        // Stale bind invalidated by a shutdown that landed mid-bind: nothing
        // was committed, so there is nothing to publish or display.
        if (!current) return;
        // A rebind may have missed agent_end; requeue any orphaned in-flight
        // claims so they retry (at-least-once) rather than being lost.
        requeueProcessing(current.root, current.record.sessionId);
        ctx.ui?.setStatus("pi-peer", `${current.record.name} · ${publicPeerId(current.record.sessionId)}`);
        publishHistoryFromOwnSession(current, ctx);
      })
      .catch((err) => {
        // Bind failed: release the latch so the previous runtime is not wedged.
        if (err instanceof HerdrUnavailableError) {
          // Expected when Pi runs outside Herdr: one quiet line, no stack —
          // the extension stays loaded; talk tools fail with a clear message.
          console.error("pi-peer: not inside a Herdr pane — peer talk disabled");
          return;
        }
        console.error("pi-peer session bind failed", err);
      })
      .finally(() => { bindInProgress = false; });
  });
  pi.on("agent_start", () => {
    // F1: a triggered turn has engaged; clear the pending latch and mark busy.
    turnStartPending = false;
    if (!hasBusyOverride) selfBusy = true;
  });
  pi.on("agent_end", (event, ctx) => {
    if (!hasBusyOverride) selfBusy = false;
    turnStartPending = false;
    // F2: the turn completed; consume every claim injected into it. The claim
    // covered the turn (host lifecycle), not proof of model consumption.
    for (const processing of inFlightClaims) rmSync(processing, { force: true });
    inFlightClaims.clear();
    if (!runtime) return;
    // Session entries are persisted before the end event; rebuild from the
    // current lineage so ids are stable and no duplicate risk exists. No
    // automatic reply is produced: a reply is a separate `talk_to` the agent
    // chooses to send.
    publishHistoryFromOwnSession(runtime, ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    // Invalidate any bind still awaiting its peer context: it must not
    // commit a runtime, resurrect a registration, or enqueue a pane rename.
    lifecycleGeneration++;
    ctx.ui?.setStatus("pi-peer", undefined);
    // Clear local F1/F2 state. Unconsumed `.processing` claims are left on disk
    // (recoverable via the next startup requeue) so nothing is lost on shutdown.
    turnStartPending = false;
    inFlightClaims.clear();
    if (runtime) {
      // Remove the owned registration (the authoritative liveness signal);
      // inbox/latest artifacts are not lifecycle-owned and are left for the
      // cross-session GC sweep.
      removeOwnedRecord(runtime.root, runtime.record);
      // Return the label on whichever surface this runtime named (tab or
      // pane): a dead surface must not keep advertising the peer name.
      // Serialized behind any in-flight rename so the clear lands last.
      const surface = labeledSurface;
      labeledSurface = null;
      if (surface) enqueueLabelOp(() => releaseSurface(surface));
    }
    if (interval) clearInterval(interval);
    interval = null;
    drainInFlight = null;
    runtime = null;
  });
}
