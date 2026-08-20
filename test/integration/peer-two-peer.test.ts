import assert from "node:assert";
import { describe, it } from "node:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { registerTalkTools } from "../../pi-extension/pi-peer/service.ts";
import { inboxDir, nowIso, POLL_MS } from "../../pi-extension/pi-peer/protocol.ts";
import { createTestDir } from "../peer/helpers.ts";

function waitUntil(predicate: () => boolean, message: string, timeoutMs = 4_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error(`Timed out waiting for: ${message}`));
      setTimeout(poll, 25);
    };
    poll();
  });
}

function peerMessage(from: string, fromName: string, to: string, message: string, id = "msg-default") {
  return { version: 1, type: "peer_message", id, from, fromName, to, message, createdAt: nowIso() };
}

type PeerStatus = "idle" | "working" | "blocked" | "done" | "unknown";

interface PeerHandle {
  ctx: any;
  tools: Map<string, any>;
  handlers: Map<string, Array<(...args: any[]) => any>>;
  sentMessages: Array<{ content: string; options?: any }>;
}

function createPeer(
  root: string,
  peerStatuses: Map<string, PeerStatus>,
  sessionId: string,
  paneId: string,
  opts: { busy?: () => boolean } = {},
): PeerHandle {
  const tools = new Map<string, any>();
  const sentMessages: Array<{ content: string; options?: any }> = [];
  const handlers = new Map<string, Array<(...args: any[]) => any>>();
  const sessionFile = join(root, "transcripts", `${sessionId}.jsonl`);
  const ctx = { cwd: `/work/${paneId}`, sessionManager: { getSessionId: () => sessionId, getSessionFile: () => sessionFile } };
  const api: any = {
    registerTool(tool: any) { tools.set(tool.name, tool); },
    on(name: string, handler: (...args: any[]) => any) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    sendUserMessage(content: any, options?: any) {
      assert.equal(typeof content, "string", "inbound content must be a string");
      sentMessages.push({ content, options });
    },
  };
  registerTalkTools(api, {
    getCurrentPeer: async () => ({
      paneId, terminalId: `terminal-${paneId}`, tabId: `tab-${paneId}`,
      socketPath: "/tmp/herdr.sock", workspaceId: "workspace-1",
    }),
    getPeerStatus: async (peer) => peerStatuses.get(peer.paneId) ?? "idle",
    rootDir: () => root,
    isBusy: opts.busy,
  });
  return { ctx, tools, handlers, sentMessages };
}

async function startPeers(peers: PeerHandle[], root: string): Promise<void> {
  mkdirSync(join(root, "transcripts"), { recursive: true });
  await Promise.all(peers.map((peer) => {
    for (const handler of peer.handlers.get("session_start") ?? []) handler({ type: "session_start", reason: "startup" }, peer.ctx);
  }));
  // The handler above is deliberately fire-and-forget in production
  // (service.ts session_start: `void ensureRuntime(...).then(...)`), so it
  // returns nothing awaitable itself -- Promise.all here only sequences the
  // synchronous dispatch. Wait on the real postcondition instead: every
  // peer's registration record exists on disk, exactly what a caller needing
  // a live peer actually depends on.
  await waitUntil(
    () => peers.every((peer) => existsSync(join(root, "sessions", `${peer.ctx.sessionManager.getSessionId()}.json`))),
    "all peers registered",
  );
}

function stopPeers(peers: PeerHandle[]): void {
  for (const peer of peers) {
    for (const handler of peer.handlers.get("session_shutdown") ?? []) handler({ type: "session_shutdown", reason: "quit" }, peer.ctx);
  }
}

describe("peer two-peer lifecycle (async chat)", () => {
  it("talk_to returns promptly with delivery confirmation and no response dependency", async () => {
    const root = createTestDir();
    const peerStatuses = new Map<string, PeerStatus>();
    const sender = createPeer(root, peerStatuses, "session-alpha", "pane-alpha");
    const receiver = createPeer(root, peerStatuses, "session-beta", "pane-beta");
    try {
      await startPeers([sender, receiver], root);

      const started = Date.now();
      const result = await sender.tools.get("talk_to").execute(
        "t1", { target: "peer-eta", message: "Hello B" }, undefined, undefined, sender.ctx,
      );
      const elapsed = Date.now() - started;
      assert.ok(elapsed < 1_000, `talk_to must return promptly (took ${elapsed}ms)`);
      assert.match(result.content[0].text, /Message sent to .*\(peer-eta\)/);
      assert.equal(result.details.state, "sent");
      // The message is durably delivered to the receiver (at-least-once mailbox).
      await waitUntil(() => receiver.sentMessages.length === 1, "receiver got the message");
      assert.match(receiver.sentMessages[0].content, /Hello B/);
      assert.equal(receiver.sentMessages[0].options, undefined, "idle receiver gets a fresh user turn");
      // No response machinery is ever created.
      assert.equal(existsSync(join(root, "waiters")), false, "no waiters directory");
      assert.equal(existsSync(join(root, "replies")), false, "no replies directory");
      assert.equal(receiver.sentMessages.some((m) => m.content.startsWith("<peer_pong")), false, "no peer_pong");
    } finally {
      stopPeers([sender, receiver]);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("busy receiver is steered by messages from any peer; idle receiver is triggered", async () => {
    const root = createTestDir();
    const peerStatuses = new Map<string, PeerStatus>();
    const receiverBusy = { value: false };
    const sender = createPeer(root, peerStatuses, "session-alpha", "pane-alpha");
    const receiver = createPeer(root, peerStatuses, "session-beta", "pane-beta", { busy: () => receiverBusy.value });
    const third = createPeer(root, peerStatuses, "session-gamma", "pane-gamma");
    try {
      await startPeers([sender, receiver, third], root);

      // Idle receiver: plain fresh user turn.
      receiverBusy.value = false;
      await sender.tools.get("talk_to").execute("a", { target: "peer-eta", message: "idle msg" }, undefined, undefined, sender.ctx);
      await waitUntil(() => receiver.sentMessages.length === 1, "idle delivery");
      assert.match(receiver.sentMessages[0].content, /idle msg/);
      assert.equal(receiver.sentMessages[0].options, undefined, "idle receiver is triggered");
      // Engage the turn so later messages steer instead of opening overlapping plain turns.
      for (const handler of receiver.handlers.get("agent_start") ?? []) handler({ type: "agent_start" }, receiver.ctx);

      // Busy receiver: same sender steered.
      receiverBusy.value = true;
      await sender.tools.get("talk_to").execute("b", { target: "peer-eta", message: "busy msg" }, undefined, undefined, sender.ctx);
      await waitUntil(() => receiver.sentMessages.length === 2, "busy steer from same sender");
      assert.match(receiver.sentMessages[1].content, /busy msg/);
      assert.deepEqual(receiver.sentMessages[1].options, { deliverAs: "steer" }, "busy receiver steered");

      // Busy receiver: a DIFFERENT sender is also steered (no same-caller restriction).
      await third.tools.get("talk_to").execute("c", { target: "peer-eta", message: "third msg" }, undefined, undefined, third.ctx);
      await waitUntil(() => receiver.sentMessages.length === 3, "busy steer from any sender");
      assert.match(receiver.sentMessages[2].content, /third msg/);
      assert.deepEqual(receiver.sentMessages[2].options, { deliverAs: "steer" }, "any sender steered into busy turn");
    } finally {
      stopPeers([sender, receiver, third]);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("queued messages preserve FIFO and are delivered one per tick", async () => {
    const root = createTestDir();
    const peerStatuses = new Map<string, PeerStatus>();
    const sender = createPeer(root, peerStatuses, "session-alpha", "pane-alpha");
    const receiver = createPeer(root, peerStatuses, "session-beta", "pane-beta");
    try {
      await startPeers([sender, receiver], root);

      // Enqueue three messages synchronously (all queued before any delivery).
      const inbox = inboxDir(root, "session-beta");
      mkdirSync(inbox, { recursive: true });
      writeFileSync(join(inbox, "msg_a.json"), JSON.stringify(peerMessage("session-alpha", "alpha", "session-beta", "First")));
      writeFileSync(join(inbox, "msg_b.json"), JSON.stringify(peerMessage("session-alpha", "alpha", "session-beta", "Second")));
      writeFileSync(join(inbox, "msg_c.json"), JSON.stringify(peerMessage("session-alpha", "alpha", "session-beta", "Third")));
      assert.equal(readdirSync(inbox).filter((f) => f.endsWith(".json")).length, 3, "all three queued before delivery");

      // FIFO order, one consumed per poll tick.
      await waitUntil(() => receiver.sentMessages.length === 1, "first delivered");
      assert.equal(readdirSync(inbox).filter((f) => f.endsWith(".json")).length, 2, "exactly one consumed per tick");
      // F1: engage the turn so the remaining messages steer rather than opening overlapping plain turns.
      for (const handler of receiver.handlers.get("agent_start") ?? []) handler({ type: "agent_start" }, receiver.ctx);
      await waitUntil(() => receiver.sentMessages.length === 2, "second delivered");
      assert.equal(readdirSync(inbox).filter((f) => f.endsWith(".json")).length, 1, "exactly one consumed per tick");
      await waitUntil(() => receiver.sentMessages.length === 3, "third delivered");
      assert.deepEqual(
        receiver.sentMessages.map((m) => /(First|Second|Third)/.exec(m.content)?.[1]),
        ["First", "Second", "Third"],
        "FIFO order preserved",
      );
    } finally {
      stopPeers([sender, receiver]);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a reverse talk_to wakes idle A and steers busy A", async () => {
    const root = createTestDir();
    const peerStatuses = new Map<string, PeerStatus>();
    const senderBusy = { value: false };
    const sender = createPeer(root, peerStatuses, "session-alpha", "pane-alpha", { busy: () => senderBusy.value });
    const receiver = createPeer(root, peerStatuses, "session-beta", "pane-beta");
    try {
      await startPeers([sender, receiver], root);

      // A sends to B; B receives it.
      await sender.tools.get("talk_to").execute("a", { target: "peer-eta", message: "hello B" }, undefined, undefined, sender.ctx);
      await waitUntil(() => receiver.sentMessages.length === 1, "B received A's message");

      // B replies to A while A is idle -> A is woken with a fresh user turn.
      await receiver.tools.get("talk_to").execute("b", { target: "peer-pha", message: "hello A" }, undefined, undefined, receiver.ctx);
      await waitUntil(() => sender.sentMessages.length === 1, "A received B's reply (idle)");
      assert.match(sender.sentMessages[0].content, /hello A/);
      assert.equal(sender.sentMessages[0].options, undefined, "idle A triggered by reverse talk_to");
      // Engage A's turn so the next message steers instead of opening another plain turn.
      for (const handler of sender.handlers.get("agent_start") ?? []) handler({ type: "agent_start" }, sender.ctx);

      // B replies again while A is busy -> A is steered.
      senderBusy.value = true;
      await receiver.tools.get("talk_to").execute("b2", { target: "peer-pha", message: "steer A" }, undefined, undefined, receiver.ctx);
      await waitUntil(() => sender.sentMessages.length === 2, "A received B's reply (busy)");
      assert.match(sender.sentMessages[1].content, /steer A/);
      assert.deepEqual(sender.sentMessages[1].options, { deliverAs: "steer" }, "busy A steered by reverse talk_to");
    } finally {
      stopPeers([sender, receiver]);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sending to a missing target fails loudly before any enqueue", async () => {
    const root = createTestDir();
    const peerStatuses = new Map<string, PeerStatus>();
    const sender = createPeer(root, peerStatuses, "session-alpha", "pane-alpha");
    const receiver = createPeer(root, peerStatuses, "session-beta", "pane-beta");
    try {
      await startPeers([sender, receiver], root);

      await assert.rejects(
        sender.tools.get("talk_to").execute("dead", { target: "peer-zzz", message: "x" }, undefined, undefined, sender.ctx),
        /Peer session not found/,
      );
      // No message was enqueued anywhere.
      const inbox = inboxDir(root, "session-beta");
      if (existsSync(inbox)) {
        assert.equal(readdirSync(inbox).filter((f) => f.endsWith(".json")).length, 0, "nothing enqueued for a dead target");
      }
      assert.equal(existsSync(join(root, "waiters")), false, "no waiters created");
      assert.equal(existsSync(join(root, "replies")), false, "no replies created");
    } finally {
      stopPeers([sender, receiver]);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("talk_to and talk_latest refuse to target the current session", async () => {
    const root = createTestDir();
    const peerStatuses = new Map<string, PeerStatus>();
    const sender = createPeer(root, peerStatuses, "session-alpha", "pane-alpha");
    const receiver = createPeer(root, peerStatuses, "session-beta", "pane-beta");
    try {
      await startPeers([sender, receiver], root);
      // startPeers already waits for both peers' registration records; this is
      // now redundant but harmless (immediately true) -- left in place because
      // ownRecord is read from the same file right below.
      await waitUntil(() => existsSync(join(root, "sessions", "session-alpha.json")), "sender registration");
      const ownRecord = JSON.parse(readFileSync(join(root, "sessions", "session-alpha.json"), "utf8")) as { name: string };
      // The sender owns a non-empty history, so a missing self-guard would
      // succeed (self-send / self-read) instead of failing for another reason.
      mkdirSync(join(root, "latest"), { recursive: true });
      writeFileSync(join(root, "latest", "session-alpha.json"), JSON.stringify({
        version: 2,
        type: "latest",
        sessionId: "session-alpha",
        events: [{ type: "user", id: "own-1", createdAt: "2024-01-01T00:00:00.000Z", message: "own note" }],
        updatedAt: "2024-01-01T00:00:00.000Z",
      }));

      // Self-targeting is rejected by public peer id and by display name.
      await assert.rejects(
        sender.tools.get("talk_to").execute("self-id", { target: "peer-pha", message: "note to self" }, undefined, undefined, sender.ctx),
        /talk_to cannot target the current session/,
        "talk_to must refuse the current session addressed by public peer id",
      );
      await assert.rejects(
        sender.tools.get("talk_to").execute("self-name", { target: ownRecord.name, message: "note to self" }, undefined, undefined, sender.ctx),
        /talk_to cannot target the current session/,
        "talk_to must refuse the current session addressed by display name",
      );
      await assert.rejects(
        sender.tools.get("talk_latest").execute("self-latest", { target: "peer-pha", count: 1 }, undefined, undefined, sender.ctx),
        /talk_latest cannot target the current session/,
        "talk_latest must refuse to read the current session's own history",
      );

      // Nothing was enqueued for, or injected into, the sender itself.
      const ownInbox = inboxDir(root, "session-alpha");
      const ownQueued = existsSync(ownInbox) ? readdirSync(ownInbox) : [];
      assert.deepEqual(ownQueued, [], "a rejected self-send must not enqueue anything in the sender's own inbox");
      await new Promise((resolve) => setTimeout(resolve, POLL_MS + 100));
      assert.equal(sender.sentMessages.length, 0, "the sender must never receive its own message");

      // The guard is scoped to the current session: a real peer still works.
      const sent = await sender.tools.get("talk_to").execute("peer", { target: "peer-eta", message: "Hello B" }, undefined, undefined, sender.ctx);
      assert.equal(sent.details.state, "sent");
      await waitUntil(() => receiver.sentMessages.length === 1, "a legitimate peer target is still delivered");
    } finally {
      stopPeers([sender, receiver]);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("talk_latest still shows both sides of the chat coherently", async () => {
    const root = createTestDir();
    const peerStatuses = new Map<string, PeerStatus>();
    const sender = createPeer(root, peerStatuses, "session-alpha", "pane-alpha");
    const receiver = createPeer(root, peerStatuses, "session-beta", "pane-beta");
    try {
      await startPeers([sender, receiver], root);

      // A sends to B; B receives the inbound <peer_message>.
      await sender.tools.get("talk_to").execute("a", { target: "peer-eta", message: "Question Q" }, undefined, undefined, sender.ctx);
      await waitUntil(() => receiver.sentMessages.length === 1, "B received A's message");

      // Populate B's session file with the inbound message (user) and B's reply
      // (assistant), then fire agent_settled so B publishes its history after
      // all retries and queued work have finished.
      const bTag = receiver.sentMessages[0].content;
      writeFileSync(receiver.ctx.sessionManager.getSessionFile(), [
        { type: "session", id: "root-beta" },
        { type: "message", id: "u-q", parentId: "root-beta", timestamp: "2024-01-01T00:00:01.000Z", message: { role: "user", content: bTag } },
        { type: "message", id: "a-q", parentId: "u-q", timestamp: "2024-01-01T00:00:02.000Z", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "B's answer" }] } },
      ].map((e) => JSON.stringify(e)).join("\n") + "\n");
      for (const handler of receiver.handlers.get("agent_settled") ?? []) {
        handler({ type: "agent_settled" }, receiver.ctx);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));

      // A reads B's latest and sees both sides of the exchange.
      const latest = await sender.tools.get("talk_latest").execute("l", { target: "peer-eta", count: 5 }, undefined, undefined, sender.ctx);
      assert.match(latest.content[0].text, /Question Q/);
      assert.match(latest.content[0].text, /B's answer/);
      assert.match(latest.content[0].text, /\[assistant @ 2024-01-01T00:00:02\.000Z\] B's answer/, "talk_latest event lines carry createdAt timestamps");
      assert.equal(latest.details.target, "peer-eta");
      // No RPC artifacts anywhere after the conversation.
      assert.equal(existsSync(join(root, "waiters")), false, "no waiters directory after conversation");
      assert.equal(existsSync(join(root, "replies")), false, "no replies directory after conversation");
    } finally {
      stopPeers([sender, receiver]);
      rmSync(root, { recursive: true, force: true });
    }
  });
});