import assert from "node:assert";
import { describe, it } from "node:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";

import piPeerExtension from "../../pi-extension/pi-peer/index.ts";
import { getTalkRootDir } from "../../pi-extension/pi-peer/herdr.ts";
import { DEAD_SESSION_SWEEP_MS, inboxDir, nowIso, POLL_MS, publicPeerId, recordPath, sessionDir, sweepDeadSessions } from "../../pi-extension/pi-peer/protocol.ts";
import { safeKey } from "../../pi-extension/pi-peer/storage.ts";
import { registerTalkTools } from "../../pi-extension/pi-peer/service.ts";
import { createMockExtensionApi, createTestDir, restoreEnvVar, importSpecifiers } from "./helpers.ts";

function waitUntil(predicate: () => boolean, message: string, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error(`Timed out after ${timeoutMs}ms waiting for: ${message}`));
      setTimeout(poll, 10);
    };
    poll();
  });
}

function peerMessage(from: string, fromName: string, to: string, message: string, id = "msg-x") {
  return { version: 1, type: "peer_message", id, from, fromName, to, message, createdAt: nowIso() };
}

describe("pi-peer standalone runtime", () => {
  it("entrypoint registers exactly the three talk tools", () => {
    const { api, registeredTools, registeredCommands, registeredRenderers } = createMockExtensionApi();
    piPeerExtension(api as any);
    const names = registeredTools.map((tool: any) => tool.name).sort();
    assert.deepEqual(names, ["talk_latest", "talk_sessions", "talk_to"]);
    assert.equal(registeredCommands.length, 0, "no commands are registered");
    assert.equal(registeredRenderers.length, 0, "no message renderers are registered");
  });

  it("PI_PEER_DISABLED=1 opts out of registration", () => {
    const prev = process.env.PI_PEER_DISABLED;
    process.env.PI_PEER_DISABLED = "1";
    try {
      const { api, registeredTools } = createMockExtensionApi();
      piPeerExtension(api as any);
      assert.equal(registeredTools.length, 0);
    } finally {
      restoreEnvVar("PI_PEER_DISABLED", prev);
    }
  });

  it("standalone source has no import dependency on subagents/loop/agents", () => {
    const dirUrl = new URL("../../pi-extension/pi-peer/", import.meta.url);
    const files = readdirSync(dirUrl).filter((f) => f.endsWith(".ts"));
    assert.ok(files.includes("storage.ts"), "storage seam should be part of the standalone source");
    for (const file of files) {
      const src = readFileSync(new URL(`../../pi-extension/pi-peer/${file}`, import.meta.url), "utf8");
      const banned = importSpecifiers(src).filter((s) => /subagents|loop|agents/.test(s));
      assert.deepEqual(banned, [], `pi-peer/${file} must not import from subagents/loop/agents; got: ${banned.join(", ")}`);
    }
  });

  it("safeKey is fail-safe against empty, dot, and dot-dot keys", () => {
    assert.equal(safeKey(""), "_");
    assert.equal(safeKey("."), "_");
    assert.equal(safeKey(".."), "_");
    assert.equal(safeKey("a/b"), "a_b", "slash must not produce a traversal segment");
    assert.equal(safeKey("../../etc"), ".._.._etc", "slash clusters collapse into a single safe segment");
    assert.equal(safeKey("workspace-1"), "workspace-1", "normal ids remain unchanged");
    assert.equal(safeKey("9f8e7d6c-5b4a-4c3d-9e2f-1a0b0c0d0e0f"), "9f8e7d6c-5b4a-4c3d-9e2f-1a0b0c0d0e0f", "UUIDs remain unchanged");
  });

  it("talk storage namespace is <agent dir>/pi-peer/talk/<workspace-id> and refuses traversal", () => {
    const dir = createTestDir();
    const prev = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
      const base = join(dir, "pi-peer", "talk");
      assert.equal(getTalkRootDir("workspace-1"), join(base, "workspace-1"));
      assert.equal(getTalkRootDir("ws"), join(base, "ws"));
      const evil = getTalkRootDir("..");
      assert.equal(evil, join(base, "_"), "dot-dot workspace id must be sanitized to a safe segment");
      assert.equal(evil.includes("/../"), false, "must not contain a traversal segment");
      const slashTraversal = getTalkRootDir("../evil");
      assert.equal(slashTraversal, join(base, ".._evil"), "slash must be collapsed into one safe segment");
      assert.equal(slashTraversal.startsWith(base + sep), true, "must stay inside the namespace");
    } finally {
      restoreEnvVar("PI_CODING_AGENT_DIR", prev);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("standalone self-tracks busy: busy inbound is steered, idle inbound is a fresh user turn", async () => {
    const root = createTestDir();
    const tools = new Map<string, any>();
    const sentMessages: Array<{ content: any; options?: any }> = [];
    const handlers = new Map<string, Array<(...args: any[]) => any>>();
    const sessionId = "session-standalone";
    const sessionFile = join(root, "transcripts", `${sessionId}.jsonl`);
    const ctx = { cwd: "/work/standalone", sessionManager: { getSessionId: () => sessionId, getSessionFile: () => sessionFile } };
    const api: any = {
      registerTool(tool: any) { tools.set(tool.name, tool); },
      on(name: string, handler: (...args: any[]) => any) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
      sendUserMessage(content: any, options?: any) {
        sentMessages.push({ content, options });
      },
    };
    // No isBusy override: the standalone runtime must self-track via agent_start/agent_settled.
    registerTalkTools(api, {
      getCurrentPeer: async () => ({
        paneId: "pane-standalone", terminalId: "terminal-s", tabId: "tab-s",
        socketPath: "/tmp/herdr.sock", workspaceId: "workspace-1",
      }),
      getPeerStatus: async () => "idle",
      rootDir: () => root,
    });
    try {
      mkdirSync(join(root, "transcripts"), { recursive: true });
      for (const handler of handlers.get("session_start") ?? []) handler({ type: "session_start", reason: "startup" }, ctx);
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Peer is busy: agent_start fired.
      for (const handler of handlers.get("agent_start") ?? []) handler({ type: "agent_start" }, ctx);
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Inbound message while busy must be steered into the running turn.
      const inbox = join(root, "inbox", sessionId);
      mkdirSync(inbox, { recursive: true });
      writeFileSync(join(inbox, "msg-busy.json"), JSON.stringify(peerMessage("session-sender", "sender", sessionId, "Steer me.")));

      await waitUntil(() => sentMessages.length === 1, "busy inbound delivered");
      assert.equal(typeof sentMessages[0].content, "string");
      assert.match(sentMessages[0].content, /<peer_message from="sender"/);
      assert.match(sentMessages[0].content, /peer_id=/, "sends a public peer id");
      assert.deepEqual(sentMessages[0].options, { deliverAs: "steer" }, "busy message steered mid-turn");
      assert.equal(existsSync(join(inbox, "msg-busy.json")), false, "message claimed after delivery");
      for (const handler of handlers.get("message_start") ?? []) handler({
        type: "message_start",
        message: { role: "user", content: [{ type: "text", text: sentMessages[0].content }] },
      }, ctx);
      // F2: the claim is kept in-flight (at-least-once) until the turn completes.
      assert.equal(existsSync(join(inbox, "msg-busy.json.processing")), true, "claim kept until agent_settled (F2)");
      // QUEUE UX: an in-flight `.processing` claim is not counted as queued.
      const sessionsInFlight = await tools.get("talk_sessions").execute("s", {}, undefined, undefined, ctx);
      assert.doesNotMatch(sessionsInFlight.content[0].text, /\([0-9]+ queued\)/, "in-flight claim is not counted as queued");

      // Peer settles: a later message is a fresh user turn.
      for (const handler of handlers.get("agent_settled") ?? []) handler({ type: "agent_settled" }, ctx);
      await new Promise((resolve) => setTimeout(resolve, 20));
      // F2: agent_settled consumes the in-flight claim for the steered message.
      assert.equal(existsSync(join(inbox, "msg-busy.json.processing")), false, "claim consumed at agent_settled");
      writeFileSync(join(inbox, "msg-idle.json"), JSON.stringify(peerMessage("session-sender", "sender", sessionId, "Idle me.")));
      // QUEUE UX: only a still-queued `.json` message shows as `(1 queued)`.
      const sessionsQueued = await tools.get("talk_sessions").execute("s", {}, undefined, undefined, ctx);
      assert.match(sessionsQueued.content[0].text, /\(1 queued\)/, "queued .json message shows as (1 queued)");
      await waitUntil(() => sentMessages.length === 2, "idle inbound delivered");
      assert.match(sentMessages[1].content, /Idle me\./);
      assert.equal(sentMessages[1].options, undefined, "idle message delivered as a fresh user turn (trigger)");
    } finally {
      for (const handler of handlers.get("session_shutdown") ?? []) handler({ type: "session_shutdown", reason: "quit" }, ctx);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("handles Pi's void sendUserMessage contract through message_start and agent_settled", async () => {
    const root = createTestDir();
    const sentMessages: Array<{ content: any; options?: any }> = [];
    const handlers = new Map<string, Array<(...args: any[]) => any>>();
    const sessionId = "session-void-send";
    const ctx = {
      cwd: "/work/void-send",
      sessionManager: {
        getSessionId: () => sessionId,
        getSessionFile: () => join(root, "transcripts", `${sessionId}.jsonl`),
      },
    };
    const api: any = {
      registerTool() {},
      on(name: string, handler: (...args: any[]) => any) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
      sendUserMessage(content: any, options?: any) {
        sentMessages.push({ content, options });
        // Match Pi's real ExtensionAPI contract: this deliberately returns void.
      },
    };
    registerTalkTools(api, {
      getCurrentPeer: async () => ({
        paneId: "pane-void-send", terminalId: "term-void-send", tabId: "tab-void-send",
        socketPath: "/tmp/herdr.sock", workspaceId: "workspace-1",
      }),
      getPeerStatus: async () => "idle" as const,
      rootDir: () => root,
      deliveryAckTimeoutMs: 500,
    });
    try {
      mkdirSync(join(root, "transcripts"), { recursive: true });
      for (const handler of handlers.get("session_start") ?? []) handler({ type: "session_start" }, ctx);
      await waitUntil(() => existsSync(recordPath(root, sessionId)), "void-send registration");
      const inbox = inboxDir(root, sessionId);
      mkdirSync(inbox, { recursive: true });
      writeFileSync(join(inbox, "msg-void.json"), JSON.stringify(peerMessage("session-sender", "sender", sessionId, "Void API.")));
      await waitUntil(() => sentMessages.length === 1, "void send invoked");
      assert.equal(existsSync(join(inbox, "msg-void.json.processing")), true, "void return is not treated as delivery acknowledgement");

      for (const handler of handlers.get("agent_start") ?? []) handler({ type: "agent_start" }, ctx);
      for (const handler of handlers.get("message_start") ?? []) handler({
        type: "message_start",
        message: { role: "user", content: [{ type: "text", text: sentMessages[0].content }] },
      }, ctx);
      assert.equal(existsSync(join(inbox, "msg-void.json.processing")), true, "message_start keeps the claim through the run");

      // agent_end is deliberately not the settlement boundary.
      for (const handler of handlers.get("agent_end") ?? []) handler({ type: "agent_end" }, ctx);
      assert.equal(existsSync(join(inbox, "msg-void.json.processing")), true, "agent_end does not consume the claim");
      for (const handler of handlers.get("agent_settled") ?? []) handler({ type: "agent_settled" }, ctx);
      assert.equal(existsSync(join(inbox, "msg-void.json.processing")), false, "agent_settled consumes the acknowledged claim");
    } finally {
      for (const handler of handlers.get("session_shutdown") ?? []) handler({ type: "session_shutdown" }, ctx);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requeues a void injection when message_start never arrives", async () => {
    const root = createTestDir();
    const sentMessages: string[] = [];
    const handlers = new Map<string, Array<(...args: any[]) => any>>();
    const sessionId = "session-no-ack";
    const ctx = {
      cwd: "/work/no-ack",
      sessionManager: {
        getSessionId: () => sessionId,
        getSessionFile: () => join(root, "transcripts", `${sessionId}.jsonl`),
      },
    };
    const api: any = {
      registerTool() {},
      on(name: string, handler: (...args: any[]) => any) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
      sendUserMessage(content: string) {
        sentMessages.push(content);
      },
    };
    registerTalkTools(api, {
      getCurrentPeer: async () => ({
        paneId: "pane-no-ack", terminalId: "term-no-ack", tabId: "tab-no-ack",
        socketPath: "/tmp/herdr.sock", workspaceId: "workspace-1",
      }),
      getPeerStatus: async () => "idle" as const,
      rootDir: () => root,
      deliveryAckTimeoutMs: 30,
    });
    try {
      mkdirSync(join(root, "transcripts"), { recursive: true });
      for (const handler of handlers.get("session_start") ?? []) handler({ type: "session_start" }, ctx);
      await waitUntil(() => existsSync(recordPath(root, sessionId)), "no-ack registration");
      const inbox = inboxDir(root, sessionId);
      mkdirSync(inbox, { recursive: true });
      writeFileSync(join(inbox, "msg-no-ack.json"), JSON.stringify(peerMessage("session-sender", "sender", sessionId, "No acknowledgement.")));

      await waitUntil(() => sentMessages.length === 1, "void send invoked");

      // The host never engaged a turn. The claim must NOT be handed back to the
      // live host: it may still be in flight inside it, and redelivering would
      // duplicate the message. It stays claimed for session_start to recover.
      await new Promise((resolve) => setTimeout(resolve, POLL_MS + 100));
      assert.equal(existsSync(join(inbox, "msg-no-ack.json.processing")), true, "claim retained for restart recovery");
      assert.equal(existsSync(join(inbox, "msg-no-ack.json")), false, "claim not requeued into the live host");
      assert.equal(sentMessages.length, 1, "no duplicate redelivery");

      // The turn latch is released, so delivery is not blocked forever.
      writeFileSync(join(inbox, "msg-later.json"), JSON.stringify(peerMessage("session-sender", "sender", sessionId, "Later message.")));
      await waitUntil(() => sentMessages.length === 2, "latch released so later messages still flow", 1_000);
      assert.match(sentMessages[1], /Later message\./);

      // The later message engages its own turn. Only that message's claim is
      // committed: the abandoned one belongs to a turn the host never started,
      // so agent_settled must not consume it along with the turn's own claim.
      for (const handler of handlers.get("agent_start") ?? []) handler({ type: "agent_start" }, ctx);
      for (const handler of handlers.get("agent_settled") ?? []) handler({ type: "agent_settled" }, ctx);
      assert.equal(existsSync(join(inbox, "msg-later.json.processing")), false, "the turn consumes its own claim");
      assert.equal(existsSync(join(inbox, "msg-no-ack.json.processing")), true, "an unrelated turn never destroys the abandoned claim");
    } finally {
      for (const handler of handlers.get("session_shutdown") ?? []) handler({ type: "session_shutdown" }, ctx);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("agent settlement emits no automatic reply and never creates waiter/reply artifacts", async () => {
    const root = createTestDir();
    const sentMessages: Array<{ content: any; options?: any }> = [];
    const handlers = new Map<string, Array<(...args: any[]) => any>>();
    const sessionId = "session-no-reply";
    const ctx = {
      cwd: "/work/no-reply",
      sessionManager: {
        getSessionId: () => sessionId,
        getSessionFile: () => join(root, "transcripts", `${sessionId}.jsonl`),
      },
    };
    const api: any = {
      registerTool() {},
      on(name: string, handler: (...args: any[]) => any) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
      sendUserMessage(content: any, options?: any) {
        sentMessages.push({ content, options });
      },
    };
    registerTalkTools(api, {
      getCurrentPeer: async () => ({
        paneId: "pane-no-reply", terminalId: "term-no-reply", tabId: "tab-no-reply",
        socketPath: "/tmp/herdr.sock", workspaceId: "workspace-1",
      }),
      getPeerStatus: async () => "idle" as const,
      rootDir: () => root,
      isBusy: () => false,
    });
    try {
      mkdirSync(join(root, "transcripts"), { recursive: true });
      for (const handler of handlers.get("session_start") ?? []) handler({ type: "session_start", reason: "startup" }, ctx);
      await waitUntil(() => existsSync(recordPath(root, sessionId)), "session registration");
      const inbox = inboxDir(root, sessionId);
      mkdirSync(inbox, { recursive: true });
      writeFileSync(join(inbox, "msg-only.json"), JSON.stringify(peerMessage("session-sender", "sender", sessionId, "No reply expected.")));
      await waitUntil(() => sentMessages.length === 1, "inbound delivered");
      assert.match(sentMessages[0].content, /No reply expected\./);
      for (const handler of handlers.get("message_start") ?? []) handler({
        type: "message_start",
        message: { role: "user", content: [{ type: "text", text: sentMessages[0].content }] },
      }, ctx);

      // Agent settlement produces no automatic reply and no peer_pong/waiter/replies.
      for (const handler of handlers.get("agent_settled") ?? []) {
        handler({ type: "agent_settled" }, ctx);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(sentMessages.filter((m) => m.content.startsWith("<peer_pong")).length, 0, "no peer_pong ever sent");
      assert.equal(existsSync(join(root, "waiters")), false, "no waiters directory created");
      assert.equal(existsSync(join(root, "replies")), false, "no replies directory created");
      assert.equal(readdirSync(inbox).filter((f) => f.endsWith(".json") || f.endsWith(".processing")).length, 0, "no residual inbox artifacts");
    } finally {
      for (const handler of handlers.get("session_shutdown") ?? []) handler({ type: "session_shutdown", reason: "quit" }, ctx);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("failed injection requeues the claimed message and startup reclaims orphaned .processing", async () => {
    const root = createTestDir();
    const sentMessages: string[] = [];
    const handlers = new Map<string, Array<(...args: any[]) => any>>();
    const sessionId = "session-requeue";
    const ctx = {
      cwd: "/work/requeue",
      sessionManager: {
        getSessionId: () => sessionId,
        getSessionFile: () => join(root, "transcripts", `${sessionId}.jsonl`),
      },
    };
    let injectAttempts = 0;
    const api: any = {
      registerTool() {},
      on(name: string, handler: (...args: any[]) => any) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
      sendUserMessage(content: any) {
        injectAttempts++;
        if (injectAttempts === 1) throw new Error("simulated injection failure");
        sentMessages.push(content);
      },
    };
    registerTalkTools(api, {
      getCurrentPeer: async () => ({
        paneId: "pane-requeue", terminalId: "term-requeue", tabId: "tab-requeue",
        socketPath: "/tmp/herdr.sock", workspaceId: "workspace-1",
      }),
      getPeerStatus: async () => "idle" as const,
      rootDir: () => root,
      isBusy: () => false,
    });
    try {
      mkdirSync(join(root, "transcripts"), { recursive: true });

      // (A) Injection fails: the claimed message must be requeued, not lost.
      for (const handler of handlers.get("session_start") ?? []) handler({ type: "session_start", reason: "startup" }, ctx);
      await waitUntil(() => existsSync(recordPath(root, sessionId)), "session registration");
      const inbox = inboxDir(root, sessionId);
      mkdirSync(inbox, { recursive: true });
      writeFileSync(join(inbox, "msg-retry.json"), JSON.stringify(peerMessage("session-sender", "sender", sessionId, "Retry me.")));
      // First injection attempt fails; the claimed message must be requeued.
      await waitUntil(() => injectAttempts >= 1, "first injection attempted");
      assert.equal(injectAttempts, 1);
      assert.equal(existsSync(join(inbox, "msg-retry.json")), true, "failed send requeued the message (not lost)");
      assert.equal(existsSync(join(inbox, "msg-retry.json.processing")), false, "claim released back to queued");
      // A later tick retries and delivers.
      await waitUntil(() => sentMessages.length === 1, "requeued message delivered on retry");
      assert.match(sentMessages[0], /Retry me\./);
      assert.equal(existsSync(join(inbox, "msg-retry.json")), false, "delivered message consumed");
    } finally {
      for (const handler of handlers.get("session_shutdown") ?? []) handler({ type: "session_shutdown", reason: "quit" }, ctx);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("session_start sets the footer status to '<Name> · peer-<last3>' and shutdown clears it", async () => {
    const root = createTestDir();
    const handlers = new Map<string, Array<(...args: any[]) => any>>();
    const statusCalls: Array<[string, string | undefined]> = [];
    const ctx: any = {
      cwd: "/work/status",
      sessionManager: {
        getSessionId: () => "session-status",
        getSessionFile: () => join(root, "transcripts", "session-status.jsonl"),
      },
      ui: {
        setStatus: (key: string, text?: string) => { statusCalls.push([key, text]); },
      },
    };
    const api: any = {
      registerTool() {},
      on(name: string, handler: (...args: any[]) => any) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
      sendUserMessage() {},
    };
    registerTalkTools(api, {
      getCurrentPeer: async () => ({
        paneId: "pane-status", terminalId: "term-status", tabId: "tab-status",
        socketPath: "/tmp/herdr.sock", workspaceId: "workspace-1",
      }),
      getPeerStatus: async () => "idle",
      rootDir: () => root,
    });
    try {
      for (const handler of handlers.get("session_start") ?? []) handler({ type: "session_start", reason: "startup" }, ctx);
      await waitUntil(() => existsSync(join(root, "sessions", "session-status.json")), "session registration to appear");
      const record = JSON.parse(readFileSync(recordPath(root, "session-status"), "utf8"));
      assert.deepEqual(statusCalls, [["pi-peer", `${record.name} · ${publicPeerId("session-status")}`]]);
      for (const handler of handlers.get("session_shutdown") ?? []) handler({ type: "session_shutdown", reason: "quit" }, ctx);
      assert.deepEqual(statusCalls, [
        ["pi-peer", `${record.name} · ${publicPeerId("session-status")}`],
        ["pi-peer", undefined],
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("coalesces a session_start bind with an early tool call", async () => {
    const root = createTestDir();
    const handlers = new Map<string, Array<(...args: any[]) => any>>();
    const tools = new Map<string, any>();
    let getPeerCalls = 0;
    let releaseBind: (() => void) | undefined;
    const bindGate = new Promise<void>((resolve) => { releaseBind = resolve; });
    const ctx: any = {
      cwd: "/work/coalesced-bind",
      sessionManager: {
        getSessionId: () => "session-coalesced-bind",
        getSessionFile: () => join(root, "transcripts", "session-coalesced-bind.jsonl"),
      },
    };
    const api: any = {
      registerTool(tool: any) { tools.set(tool.name, tool); },
      on(name: string, handler: (...args: any[]) => any) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
      sendUserMessage() {},
    };
    registerTalkTools(api, {
      getCurrentPeer: async () => {
        getPeerCalls++;
        await bindGate;
        return {
          paneId: "pane-coalesced", terminalId: "term-coalesced", tabId: "tab-coalesced",
          socketPath: "/tmp/herdr.sock", workspaceId: "workspace-1",
        };
      },
      getPeerStatus: async () => "idle",
      rootDir: () => root,
    });
    try {
      for (const handler of handlers.get("session_start") ?? []) handler({ type: "session_start" }, ctx);
      await waitUntil(() => getPeerCalls === 1, "first bind to start");
      const toolCall = tools.get("talk_sessions").execute("call", {}, undefined, undefined, ctx);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(getPeerCalls, 1, "the early tool call shares the session_start bind");
      releaseBind?.();
      await toolCall;
    } finally {
      releaseBind?.();
      for (const handler of handlers.get("session_shutdown") ?? []) handler({ type: "session_shutdown" }, ctx);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("invalidates a pending bind on shutdown instead of registering after exit", async () => {
    const root = createTestDir();
    const handlers = new Map<string, Array<(...args: any[]) => any>>();
    let releaseBind: (() => void) | undefined;
    const bindGate = new Promise<void>((resolve) => { releaseBind = resolve; });
    const ctx: any = {
      cwd: "/work/cancelled-bind",
      sessionManager: {
        getSessionId: () => "session-cancelled-bind",
        getSessionFile: () => join(root, "transcripts", "session-cancelled-bind.jsonl"),
      },
    };
    const api: any = {
      registerTool() {},
      on(name: string, handler: (...args: any[]) => any) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
      sendUserMessage() {},
    };
    registerTalkTools(api, {
      getCurrentPeer: async () => {
        await bindGate;
        return {
          paneId: "pane-cancelled", terminalId: "term-cancelled", tabId: "tab-cancelled",
          socketPath: "/tmp/herdr.sock", workspaceId: "workspace-1",
        };
      },
      getPeerStatus: async () => "idle",
      rootDir: () => root,
    });
    try {
      for (const handler of handlers.get("session_start") ?? []) handler({ type: "session_start" }, ctx);
      await new Promise((resolve) => setTimeout(resolve, 20));
      for (const handler of handlers.get("session_shutdown") ?? []) handler({ type: "session_shutdown" }, ctx);
      releaseBind?.();
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.equal(existsSync(recordPath(root, "session-cancelled-bind")), false, "cancelled bind writes no registration");
    } finally {
      releaseBind?.();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("shutdown during a session switch cancels the pending replacement bind", async () => {
    const root = createTestDir();
    const handlers = new Map<string, Array<(...args: any[]) => any>>();
    let getPeerCalls = 0;
    let releaseBind: (() => void) | undefined;
    const bindGate = new Promise<void>((resolve) => { releaseBind = resolve; });
    const ctx = (sessionId: string) => ({
      cwd: `/work/${sessionId}`,
      sessionManager: {
        getSessionId: () => sessionId,
        getSessionFile: () => join(root, "transcripts", `${sessionId}.jsonl`),
      },
    });
    const api: any = {
      registerTool() {},
      on(name: string, handler: (...args: any[]) => any) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
      sendUserMessage() {},
    };
    registerTalkTools(api, {
      getCurrentPeer: async () => {
        getPeerCalls++;
        if (getPeerCalls === 2) await bindGate;
        return {
          paneId: "pane-switch-shutdown", terminalId: "term-switch-shutdown", tabId: "tab-switch-shutdown",
          socketPath: "/tmp/herdr.sock", workspaceId: "workspace-1",
        };
      },
      getPeerStatus: async () => "idle",
      rootDir: () => root,
    });
    const ctxA = ctx("session-switch-A");
    const ctxB = ctx("session-switch-B");
    try {
      for (const handler of handlers.get("session_start") ?? []) handler({ type: "session_start" }, ctxA);
      await waitUntil(() => existsSync(recordPath(root, "session-switch-A")), "session A registration");
      for (const handler of handlers.get("session_start") ?? []) handler({ type: "session_start" }, ctxB);
      await waitUntil(() => getPeerCalls === 2, "session B bind to start");

      for (const handler of handlers.get("session_shutdown") ?? []) handler({ type: "session_shutdown" }, ctxB);
      releaseBind?.();
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(existsSync(recordPath(root, "session-switch-B")), false, "shutdown B prevents its pending bind");
      assert.equal(existsSync(recordPath(root, "session-switch-A")), false, "shutdown removes the previous runtime registration");
    } finally {
      releaseBind?.();
      for (const handler of handlers.get("session_shutdown") ?? []) handler({ type: "session_shutdown" }, ctxB);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("session_start reuses a persisted friendly name for the same session", async () => {
    const root = createTestDir();
    const handlers = new Map<string, Array<(...args: any[]) => any>>();
    const sessionId = "session-reuse";
    const ctx: any = {
      cwd: "/work/reloaded",
      sessionManager: {
        getSessionId: () => sessionId,
        getSessionFile: () => join(root, "transcripts", `${sessionId}.jsonl`),
      },
    };
    const api: any = {
      registerTool() {},
      on(name: string, handler: (...args: any[]) => any) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
      sendUserMessage() {},
    };
    registerTalkTools(api, {
      getCurrentPeer: async () => ({
        paneId: "pane-reuse", terminalId: "terminal-reuse", tabId: "tab-reuse",
        socketPath: "/tmp/herdr.sock", workspaceId: "workspace-1",
      }),
      getPeerStatus: async () => "idle",
      rootDir: () => root,
    });
    try {
      mkdirSync(join(root, "sessions"), { recursive: true });
      writeFileSync(recordPath(root, sessionId), JSON.stringify({
        schemaVersion: 1, sessionId, name: "Mochi", cwd: "/work/old",
        workspaceId: "workspace-1", paneId: "pane-old", terminalId: "terminal-old",
        tabId: "tab-old", registrationId: "old-registration", createdAt: nowIso(),
      }));
      for (const handler of handlers.get("session_start") ?? []) handler({ type: "session_start", reason: "reload" }, ctx);
      await waitUntil(() => existsSync(recordPath(root, sessionId)), "reloaded session registration to appear");
      assert.equal(JSON.parse(readFileSync(recordPath(root, sessionId), "utf8")).name, "Mochi");
    } finally {
      for (const handler of handlers.get("session_shutdown") ?? []) handler({ type: "session_shutdown", reason: "quit" }, ctx);
      rmSync(root, { recursive: true, force: true });
    }
  });

  function createSessionSwitchFixture() {
    const root = createTestDir();
    const handlers = new Map<string, Array<(...args: any[]) => any>>();
    const api: any = {
      registerTool() {},
      on(name: string, handler: (...args: any[]) => any) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
      sendUserMessage() {},
    };
    registerTalkTools(api, {
      getCurrentPeer: async () => ({
        paneId: "pane-switch", terminalId: "terminal-switch", tabId: "tab-switch",
        socketPath: "/tmp/herdr.sock", workspaceId: "workspace-1",
      }),
      getPeerStatus: async () => "idle",
      rootDir: () => root,
    });
    const ctxA = { cwd: "/work/a", sessionManager: { getSessionId: () => "session-A", getSessionFile: () => join(root, "transcripts", "session-A.jsonl") } };
    const ctxB = { cwd: "/work/b", sessionManager: { getSessionId: () => "session-B", getSessionFile: () => join(root, "transcripts", "session-B.jsonl") } };
    return {
      root,
      ctxA,
      ctxB,
      fireSessionStart(ctx: any) {
        for (const handler of handlers.get("session_start") ?? []) handler({ type: "session_start", reason: "test" }, ctx);
      },
      cleanup() {
        for (const handler of handlers.get("session_shutdown") ?? []) handler({ type: "session_shutdown", reason: "quit" }, ctxB);
        rmSync(root, { recursive: true, force: true });
      },
    };
  }

  it("startup reclaims an orphaned .processing message and delivers it", async () => {
    const root = createTestDir();
    const sentMessages: string[] = [];
    const handlers = new Map<string, Array<(...args: any[]) => any>>();
    const sessionId = "session-reclaim";
    const ctx: any = {
      cwd: "/work/reclaim",
      sessionManager: {
        getSessionId: () => sessionId,
        getSessionFile: () => join(root, "transcripts", `${sessionId}.jsonl`),
      },
    };
    const api: any = {
      registerTool() {},
      on(name: string, handler: (...args: any[]) => any) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
      sendUserMessage(content: any) { sentMessages.push(content); },
    };
    registerTalkTools(api, {
      getCurrentPeer: async () => ({
        paneId: "pane-reclaim", terminalId: "term-reclaim", tabId: "tab-reclaim",
        socketPath: "/tmp/herdr.sock", workspaceId: "workspace-1",
      }),
      getPeerStatus: async () => "idle",
      rootDir: () => root,
    });
    try {
      mkdirSync(join(root, "transcripts"), { recursive: true });
      // Pre-seed an orphaned claim from a prior crash before session_start.
      const inbox = inboxDir(root, sessionId);
      mkdirSync(inbox, { recursive: true });
      writeFileSync(join(inbox, "msg-orphan.json.processing"), JSON.stringify(peerMessage("session-sender", "sender", sessionId, "Reclaim me.")));
      for (const handler of handlers.get("session_start") ?? []) handler({ type: "session_start", reason: "startup" }, ctx);
      await waitUntil(() => sentMessages.length === 1, "orphaned claim reclaimed and delivered");
      assert.match(sentMessages[0], /Reclaim me\./);
      assert.equal(existsSync(join(inbox, "msg-orphan.json")), false, "no residual queued file");
      // F2: the reclaimed claim is kept in-flight until the turn completes.
      assert.equal(existsSync(join(inbox, "msg-orphan.json.processing")), true, "reclaimed claim kept in-flight (F2)");
      // The host engages the turn the injection triggered, then settles it.
      for (const handler of handlers.get("agent_start") ?? []) handler({ type: "agent_start" }, ctx);
      for (const handler of handlers.get("agent_settled") ?? []) handler({ type: "agent_settled" }, ctx);
      assert.equal(existsSync(join(inbox, "msg-orphan.json.processing")), false, "claim consumed at agent_settled");
    } finally {
      for (const handler of handlers.get("session_shutdown") ?? []) handler({ type: "session_shutdown", reason: "quit" }, ctx);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("session switch transfers registration ownership: previous owned registration removed", async () => {
    const fixture = createSessionSwitchFixture();
    try {
      fixture.fireSessionStart(fixture.ctxA);
      await waitUntil(() => existsSync(join(fixture.root, "sessions", "session-A.json")), "session A registration to appear");

      fixture.fireSessionStart(fixture.ctxB);
      // Session A's owned record is removed before the replacement bind, and
      // B's existence confirms the new runtime is registered.
      await waitUntil(() => existsSync(join(fixture.root, "sessions", "session-B.json")), "session B registration to appear");
      assert.equal(existsSync(join(fixture.root, "sessions", "session-A.json")), false, "A owned registration removed after switch");
    } finally {
      fixture.cleanup();
    }
  });

  it("session switch keeps a registration now owned by another runtime", async () => {
    const fixture = createSessionSwitchFixture();
    try {
      fixture.fireSessionStart(fixture.ctxA);
      await waitUntil(() => existsSync(join(fixture.root, "sessions", "session-A.json")), "session A registration to appear");
      const recordA = JSON.parse(readFileSync(join(fixture.root, "sessions", "session-A.json"), "utf8"));
      assert.equal(typeof recordA.registrationId, "string");

      // Another runtime re-registered at session A: the current runtime no
      // longer owns that registration and must not delete it on switch.
      const foreign = { ...recordA, registrationId: "foreign-registration" };
      writeFileSync(join(fixture.root, "sessions", "session-A.json"), JSON.stringify(foreign));

      fixture.fireSessionStart(fixture.ctxB);
      await waitUntil(() => existsSync(join(fixture.root, "sessions", "session-B.json")), "session B registration to appear");
      assert.equal(existsSync(join(fixture.root, "sessions", "session-A.json")), true, "foreign-owned A registration is not removed");
      assert.equal(JSON.parse(readFileSync(join(fixture.root, "sessions", "session-A.json"), "utf8")).registrationId, "foreign-registration");
    } finally {
      fixture.cleanup();
    }
  });

  it("sweepDeadSessions removes artifacts of dead sessions and keeps live ones", async () => {
    const root = createTestDir();
    const now = nowIso();
    const recordFor = (sessionId: string, name: string) => JSON.stringify({
      schemaVersion: 1, sessionId, name, cwd: `/work/${name}`, workspaceId: "w",
      paneId: `pane-${name}`, terminalId: `term-${name}`, createdAt: now,
    });
    try {
      mkdirSync(sessionDir(root), { recursive: true });
      mkdirSync(join(root, "latest"), { recursive: true });
      mkdirSync(join(root, "inbox", "session-dead"), { recursive: true });
      writeFileSync(recordPath(root, "session-dead"), recordFor("session-dead", "dead"));
      utimesSync(recordPath(root, "session-dead"), new Date(Date.now() - 25 * 60 * 60_000), new Date(Date.now() - 25 * 60 * 60_000));
      writeFileSync(join(root, "latest", "session-dead.json"), "{}");
      writeFileSync(join(root, "inbox", "session-dead", "req.json"), "{}");
      // Live session: fresh registration, must survive untouched.
      writeFileSync(recordPath(root, "session-live"), recordFor("session-live", "live"));
      writeFileSync(join(root, "latest", "session-live.json"), "{}");
      mkdirSync(join(root, "inbox", "session-live"), { recursive: true });
      writeFileSync(join(root, "inbox", "session-live", "req.json"), "{}");

      const deadSince = new Map<string, number>();
      // A single stale read is suspension noise: all of the dead session's
      // artifacts must remain available while it gets a chance to heartbeat.
      sweepDeadSessions(root, deadSince);
      assert.equal(existsSync(recordPath(root, "session-dead")), true, "dead registration held during grace");
      assert.equal(existsSync(join(root, "inbox", "session-dead")), true, "dead inbox held during grace");

      // The same dead verdict on the next cadence is safe to collect.
      deadSince.set("session-dead", Date.now() - (DEAD_SESSION_SWEEP_MS + 1));
      sweepDeadSessions(root, deadSince);

      assert.equal(existsSync(recordPath(root, "session-dead")), false, "dead registration removed");
      assert.equal(existsSync(join(root, "latest", "session-dead.json")), false, "dead latest removed");
      assert.equal(existsSync(join(root, "inbox", "session-dead")), false, "dead inbox removed");
      assert.equal(existsSync(recordPath(root, "session-live")), true, "live registration kept");
      assert.equal(existsSync(join(root, "latest", "session-live.json")), true, "live latest kept");
      assert.equal(existsSync(join(root, "inbox", "session-live", "req.json")), true, "live inbox kept");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("drops malformed or misaddressed inbox messages without delivering them", async () => {
    const root = createTestDir();
    const tools = new Map<string, any>();
    const sentMessages: string[] = [];
    const handlers = new Map<string, Array<(...args: any[]) => any>>();
    const sessionId = "session-receiver";
    const sessionFile = join(root, "transcripts", `${sessionId}.jsonl`);
    const ctx = { cwd: "/work/receiver", sessionManager: { getSessionId: () => sessionId, getSessionFile: () => sessionFile } };
    const api: any = {
      registerTool(tool: any) { tools.set(tool.name, tool); },
      on(name: string, handler: (...args: any[]) => any) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
      sendUserMessage(content: any) { sentMessages.push(content); },
    };
    registerTalkTools(api, {
      getCurrentPeer: async () => ({
        paneId: "pane-r", terminalId: "term-r", tabId: "tab-r",
        socketPath: "/tmp/herdr.sock", workspaceId: "workspace-1",
      }),
      getPeerStatus: async () => "idle",
      rootDir: () => root,
    });
    try {
      mkdirSync(join(root, "transcripts"), { recursive: true });
      for (const handler of handlers.get("session_start") ?? []) handler({ type: "session_start", reason: "startup" }, ctx);
      await waitUntil(() => existsSync(recordPath(root, sessionId)), "receiver session registration");

      const inbox = join(root, "inbox", sessionId);
      mkdirSync(inbox, { recursive: true });
      // Malformed JSON.
      writeFileSync(join(inbox, "msg-bad-json.json"), `{"from": "session-sender", ???`);
      // Parseable but fails protocol validation.
      writeFileSync(join(inbox, "msg-bad-type.json"), JSON.stringify({ version: 1, type: "request", id: "x", from: "a", to: sessionId, message: "x" }));
      // Misaddressed (to another session).
      writeFileSync(join(inbox, "msg-misaddressed.json"), JSON.stringify(peerMessage("session-sender", "sender", "session-elsewhere", "wrong target")));

      await new Promise((resolve) => setTimeout(resolve, 400));

      assert.equal(sentMessages.length, 0, "invalid messages are never delivered");
      assert.equal(existsSync(join(inbox, "msg-bad-json.json")), false, "malformed JSON dropped");
      assert.equal(existsSync(join(inbox, "msg-bad-type.json")), false, "protocol-invalid message dropped");
      assert.equal(existsSync(join(inbox, "msg-misaddressed.json")), false, "misaddressed message dropped");
    } finally {
      for (const handler of handlers.get("session_shutdown") ?? []) handler({ type: "session_shutdown", reason: "quit" }, ctx);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("shutdown is clean: no fabricated reply, no waiter/reply dirs, registration removed, polling stops", async () => {
    const root = createTestDir();
    const sentMessages: string[] = [];
    const handlers = new Map<string, Array<(...args: any[]) => any>>();
    const sessionId = "session-clean";
    const ctx: any = {
      cwd: "/work/clean",
      sessionManager: {
        getSessionId: () => sessionId,
        getSessionFile: () => join(root, "transcripts", `${sessionId}.jsonl`),
      },
    };
    const api: any = {
      registerTool() {},
      on(name: string, handler: (...args: any[]) => any) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
      sendUserMessage(content: any) { sentMessages.push(content); },
    };
    registerTalkTools(api, {
      getCurrentPeer: async () => ({
        paneId: "pane-clean", terminalId: "term-clean", tabId: "tab-clean",
        socketPath: "/tmp/herdr.sock", workspaceId: "workspace-1",
      }),
      getPeerStatus: async () => "idle",
      rootDir: () => root,
    });
    try {
      mkdirSync(join(root, "transcripts"), { recursive: true });
      for (const handler of handlers.get("session_start") ?? []) handler({ type: "session_start", reason: "startup" }, ctx);
      await waitUntil(() => existsSync(recordPath(root, sessionId)), "session registration");
      // An inbound message is in flight when shutdown arrives.
      const inbox = inboxDir(root, sessionId);
      mkdirSync(inbox, { recursive: true });
      writeFileSync(join(inbox, "msg-flight.json"), JSON.stringify(peerMessage("session-sender", "sender", sessionId, "In flight.")));
      await waitUntil(() => sentMessages.length === 1, "inbound delivered");

      for (const handler of handlers.get("session_shutdown") ?? []) handler({ type: "session_shutdown", reason: "quit" }, ctx);
      assert.equal(existsSync(recordPath(root, sessionId)), false, "owned registration removed");
      assert.equal(existsSync(join(root, "waiters")), false, "no waiters dir");
      assert.equal(existsSync(join(root, "replies")), false, "no replies dir");
      assert.equal(sentMessages.some((m) => m.startsWith("<peer_pong")), false, "no fabricated reply on shutdown");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("holds a second message queued until agent_start engages the turn, then steers it (F1)", async () => {
    const root = createTestDir();
    const sentMessages: Array<{ content: any; options?: any }> = [];
    const handlers = new Map<string, Array<(...args: any[]) => any>>();
    const sessionId = "session-f1";
    const ctx = { cwd: "/work/f1", sessionManager: { getSessionId: () => sessionId, getSessionFile: () => join(root, "transcripts", `${sessionId}.jsonl`) } };
    const api: any = {
      registerTool() {},
      on(name: string, handler: (...args: any[]) => any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
      sendUserMessage(content: any, options?: any) { sentMessages.push({ content, options }); },
    };
    registerTalkTools(api, {
      getCurrentPeer: async () => ({ paneId: "pane-f1", terminalId: "terminal-f", tabId: "tab-f", socketPath: "/tmp/herdr.sock", workspaceId: "workspace-1" }),
      getPeerStatus: async () => "idle",
      rootDir: () => root,
    });
    try {
      mkdirSync(join(root, "transcripts"), { recursive: true });
      for (const handler of handlers.get("session_start") ?? []) handler({ type: "session_start", reason: "startup" }, ctx);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const inbox = join(root, "inbox", sessionId);
      mkdirSync(inbox, { recursive: true });
      // Two plain messages queued while idle; agent_start has NOT fired yet.
      writeFileSync(join(inbox, "m1.json"), JSON.stringify(peerMessage("s1", "sender", sessionId, "First.")));
      writeFileSync(join(inbox, "m2.json"), JSON.stringify(peerMessage("s1", "sender", sessionId, "Second.")));
      await waitUntil(() => sentMessages.length === 1, "first message drains as a fresh trigger turn");
      assert.equal(sentMessages[0].options, undefined, "first message is a fresh user turn");
      // F1: the triggered turn is pending (agent_start not yet seen); m2 must NOT
      // drain. The window must outlast a poll tick, otherwise a missing latch is
      // indistinguishable from a tick that simply has not fired yet.
      await new Promise((resolve) => setTimeout(resolve, POLL_MS + 100));
      assert.equal(sentMessages.length, 1, "no second message drained while turnStartPending");
      assert.equal(existsSync(join(inbox, "m2.json")), true, "m2 stays queued");
      // agent_start engages the turn; the next tick steers m2 rather than opening a second plain turn.
      for (const handler of handlers.get("agent_start") ?? []) handler({ type: "agent_start" }, ctx);
      await waitUntil(() => sentMessages.length === 2, "second message drains after agent_start");
      assert.deepEqual(sentMessages[1].options, { deliverAs: "steer" }, "m2 is steered, not a second plain turn");
    } finally {
      for (const handler of handlers.get("session_shutdown") ?? []) handler({ type: "session_shutdown", reason: "quit" }, ctx);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps a fresh-trigger claim in-flight until agent_start/agent_settled (F2)", async () => {
    const root = createTestDir();
    const sentMessages: Array<{ content: any; options?: any }> = [];
    const handlers = new Map<string, Array<(...args: any[]) => any>>();
    const sessionId = "session-f2a";
    const ctx = { cwd: "/work/f2a", sessionManager: { getSessionId: () => sessionId, getSessionFile: () => join(root, "transcripts", `${sessionId}.jsonl`) } };
    const api: any = {
      registerTool() {},
      on(name: string, handler: (...args: any[]) => any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
      sendUserMessage(content: any, options?: any) { sentMessages.push({ content, options }); },
    };
    registerTalkTools(api, {
      getCurrentPeer: async () => ({ paneId: "pane-f2a", terminalId: "terminal-2", tabId: "tab-2", socketPath: "/tmp/herdr.sock", workspaceId: "workspace-1" }),
      getPeerStatus: async () => "idle",
      rootDir: () => root,
    });
    let claim = "";
    try {
      mkdirSync(join(root, "transcripts"), { recursive: true });
      for (const handler of handlers.get("session_start") ?? []) handler({ type: "session_start", reason: "startup" }, ctx);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const inbox = join(root, "inbox", sessionId);
      mkdirSync(inbox, { recursive: true });
      writeFileSync(join(inbox, "m1.json"), JSON.stringify(peerMessage("s1", "sender", sessionId, "Trigger.")));
      await waitUntil(() => sentMessages.length === 1, "message drains as a fresh trigger turn");
      claim = join(inbox, "m1.json.processing");
      assert.equal(existsSync(claim), true, "claim kept while the turn is pending (F2)");
      // No agent_start: the claim must persist across a full poll tick.
      await new Promise((resolve) => setTimeout(resolve, POLL_MS + 100));
      assert.equal(existsSync(claim), true, "claim still in-flight with a delayed agent_start");
    } finally {
      // Shutdown without agent_settled leaves the unconsumed claim recoverable on disk.
      for (const handler of handlers.get("session_shutdown") ?? []) handler({ type: "session_shutdown", reason: "quit" }, ctx);
      assert.equal(existsSync(claim), true, "unconsumed claim left on disk after shutdown");
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requeues an orphaned claim on session rebind when agent_settled was missed (F2)", async () => {
    const root = createTestDir();
    const sentMessages: Array<{ content: any; options?: any }> = [];
    const handlers = new Map<string, Array<(...args: any[]) => any>>();
    const sessionId = "session-f2d";
    const ctx = { cwd: "/work/f2d", sessionManager: { getSessionId: () => sessionId, getSessionFile: () => join(root, "transcripts", `${sessionId}.jsonl`) } };
    const api: any = {
      registerTool() {},
      on(name: string, handler: (...args: any[]) => any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
      sendUserMessage(content: any, options?: any) { sentMessages.push({ content, options }); },
    };
    registerTalkTools(api, {
      getCurrentPeer: async () => ({ paneId: "pane-f2d", terminalId: "terminal-3", tabId: "tab-3", socketPath: "/tmp/herdr.sock", workspaceId: "workspace-1" }),
      getPeerStatus: async () => "idle",
      rootDir: () => root,
    });
    try {
      mkdirSync(join(root, "transcripts"), { recursive: true });
      for (const handler of handlers.get("session_start") ?? []) handler({ type: "session_start", reason: "startup" }, ctx);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const inbox = join(root, "inbox", sessionId);
      mkdirSync(inbox, { recursive: true });
      writeFileSync(join(inbox, "m1.json"), JSON.stringify(peerMessage("s1", "sender", sessionId, "Rebind.")));
      await waitUntil(() => sentMessages.length === 1, "message drains and is claimed");
      assert.equal(existsSync(join(inbox, "m1.json.processing")), true, "claim in-flight");
      // Miss agent_settled: session shuts down and rebinds.
      for (const handler of handlers.get("session_shutdown") ?? []) handler({ type: "session_shutdown", reason: "reload" }, ctx);
      for (const handler of handlers.get("session_start") ?? []) handler({ type: "session_start", reason: "reload" }, ctx);
      await new Promise((resolve) => setTimeout(resolve, 20));
      // Rebind requeues the orphaned claim so it retries (at-least-once).
      assert.equal(existsSync(join(inbox, "m1.json.processing")), false, "orphaned claim reclaimed");
      assert.equal(existsSync(join(inbox, "m1.json")), true, "message requeued to the inbox");
      await waitUntil(() => sentMessages.length === 2, "requeued message redelivered");
      assert.equal(sentMessages[1].options, undefined, "redelivered as a fresh user turn");
    } finally {
      for (const handler of handlers.get("session_shutdown") ?? []) handler({ type: "session_shutdown", reason: "quit" }, ctx);
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("session switch requeues the previous runtime's in-flight claim (F2)", async () => {
    const root = createTestDir();
    const sentMessages: Array<{ content: any; options?: any }> = [];
    const handlers = new Map<string, Array<(...args: any[]) => any>>();
    const api: any = {
      registerTool() {},
      on(name: string, handler: (...args: any[]) => any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
      sendUserMessage(content: any, options?: any) { sentMessages.push({ content, options }); },
    };
    registerTalkTools(api, {
      getCurrentPeer: async () => ({ paneId: "pane-sw2", terminalId: "terminal-sw", tabId: "tab-sw", socketPath: "/tmp/herdr.sock", workspaceId: "workspace-1" }),
      getPeerStatus: async () => "idle",
      rootDir: () => root,
    });
    const ctxA = { cwd: "/work/a", sessionManager: { getSessionId: () => "session-SW-A", getSessionFile: () => join(root, "transcripts", "session-SW-A.jsonl") } };
    const ctxB = { cwd: "/work/b", sessionManager: { getSessionId: () => "session-SW-B", getSessionFile: () => join(root, "transcripts", "session-SW-B.jsonl") } };
    try {
      mkdirSync(join(root, "transcripts"), { recursive: true });
      for (const handler of handlers.get("session_start") ?? []) handler({ type: "session_start", reason: "startup" }, ctxA);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const inboxA = join(root, "inbox", "session-SW-A");
      mkdirSync(inboxA, { recursive: true });
      writeFileSync(join(inboxA, "m1.json"), JSON.stringify(peerMessage("s1", "sender", "session-SW-A", "Hello A.")));
      await waitUntil(() => sentMessages.length === 1, "A message drains and is claimed");
      assert.equal(existsSync(join(inboxA, "m1.json.processing")), true, "A claim in-flight");
      // Switch to B without an agent_settled or shutdown for A.
      for (const handler of handlers.get("session_start") ?? []) handler({ type: "session_start", reason: "reload" }, ctxB);
      // The claim tracked for A is requeued synchronously at session start, not stranded.
      assert.equal(existsSync(join(inboxA, "m1.json.processing")), false, "A claim not stranded as .processing");
      assert.equal(existsSync(join(inboxA, "m1.json")), true, "A message requeued to A's inbox");
      // B registration ownership transfer still works.
      await waitUntil(() => existsSync(join(root, "sessions", "session-SW-B.json")), "B registration to appear");
      assert.equal(existsSync(join(root, "sessions", "session-SW-A.json")), false, "A owned registration removed after switch");
    } finally {
      for (const handler of handlers.get("session_shutdown") ?? []) handler({ type: "session_shutdown", reason: "quit" }, ctxB);
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("slow session bind does not redeliver a just-requeued message (bring latch)", async () => {
    const root = createTestDir();
    const sentMessages: Array<{ content: any; options?: any }> = [];
    const handlers = new Map<string, Array<(...args: any[]) => any>>();
    let getPeerCalls = 0;
    const api: any = {
      registerTool() {},
      on(name: string, handler: (...args: any[]) => any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
      sendUserMessage(content: any, options?: any) { sentMessages.push({ content, options }); },
    };
    registerTalkTools(api, {
      // First bind is immediate; the second (A->B) is deliberately slower than
      // one poll tick (POLL_MS = 250ms).
      async getCurrentPeer() {
        getPeerCalls++;
        if (getPeerCalls >= 2) await new Promise((resolve) => setTimeout(resolve, 320));
        return { paneId: "pane-bind", terminalId: "terminal-b", tabId: "tab-b", socketPath: "/tmp/herdr.sock", workspaceId: "workspace-1" };
      },
      getPeerStatus: async () => "idle",
      rootDir: () => root,
    });
    const ctxA = { cwd: "/work/a", sessionManager: { getSessionId: () => "session-BIND-A", getSessionFile: () => join(root, "transcripts", "session-BIND-A.jsonl") } };
    const ctxB = { cwd: "/work/b", sessionManager: { getSessionId: () => "session-BIND-B", getSessionFile: () => join(root, "transcripts", "session-BIND-B.jsonl") } };
    try {
      mkdirSync(join(root, "transcripts"), { recursive: true });
      for (const h of handlers.get("session_start") ?? []) h({ type: "session_start", reason: "startup" }, ctxA);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const inboxA = join(root, "inbox", "session-BIND-A");
      mkdirSync(inboxA, { recursive: true });
      writeFileSync(join(inboxA, "m1.json"), JSON.stringify(peerMessage("s1", "sender", "session-BIND-A", "Hello A.")));
      await waitUntil(() => sentMessages.length === 1, "A message drains and is claimed");
      assert.equal(existsSync(join(inboxA, "m1.json.processing")), true, "A claim in-flight");
      // Start the slow A->B bind. The claim is requeued synchronously, then
      // ensureRuntime blocks on getCurrentPeer (> one poll tick).
      for (const h of handlers.get("session_start") ?? []) h({ type: "session_start", reason: "reload" }, ctxB);
      assert.equal(existsSync(join(inboxA, "m1.json.processing")), false, "A claim requeued at bind start");
      assert.equal(existsSync(join(inboxA, "m1.json")), true, "A message queued");
      // Wait longer than one poll tick while the bind is still in flight: the
      // just-requeued message must NOT be redelivered into the old runtime.
      const before = sentMessages.length;
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.equal(sentMessages.length, before, "no redelivery while bind in progress");
      assert.equal(existsSync(join(inboxA, "m1.json")), true, "A message still queued during bind");
      // Bind completes; ownership transfers to B.
      await waitUntil(() => existsSync(join(root, "sessions", "session-BIND-B.json")), "B registration to appear");
      assert.equal(existsSync(join(root, "sessions", "session-BIND-A.json")), false, "A owned registration removed");
    } finally {
      for (const h of handlers.get("session_shutdown") ?? []) h({ type: "session_shutdown", reason: "quit" }, ctxB);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores agent_start and session_shutdown from a superseded session", async () => {
    const root = createTestDir();
    const sentMessages: Array<{ content: any; options?: any }> = [];
    const handlers = new Map<string, Array<(...args: any[]) => any>>();
    const api: any = {
      registerTool() {},
      on(name: string, handler: (...args: any[]) => any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
      sendUserMessage(content: any, options?: any) { sentMessages.push({ content, options }); },
    };
    registerTalkTools(api, {
      getCurrentPeer: async () => ({ paneId: "pane-stale", terminalId: "terminal-st", tabId: "tab-st", socketPath: "/tmp/herdr.sock", workspaceId: "workspace-1" }),
      getPeerStatus: async () => "idle",
      rootDir: () => root,
    });
    const ctxOld = { cwd: "/work/old", sessionManager: { getSessionId: () => "session-STALE-OLD", getSessionFile: () => join(root, "transcripts", "session-STALE-OLD.jsonl") } };
    const ctxNew = { cwd: "/work/new", sessionManager: { getSessionId: () => "session-STALE-NEW", getSessionFile: () => join(root, "transcripts", "session-STALE-NEW.jsonl") } };
    try {
      mkdirSync(join(root, "transcripts"), { recursive: true });
      for (const handler of handlers.get("session_start") ?? []) handler({ type: "session_start", reason: "startup" }, ctxOld);
      await waitUntil(() => existsSync(join(root, "sessions", "session-STALE-OLD.json")), "old registration to appear");
      for (const handler of handlers.get("session_start") ?? []) handler({ type: "session_start", reason: "reload" }, ctxNew);
      await waitUntil(() => existsSync(join(root, "sessions", "session-STALE-NEW.json")), "new registration to appear");
      // Late events carrying the superseded session's id must not touch the
      // live runtime: they belong to a lifecycle that no longer owns it.
      for (const handler of handlers.get("agent_start") ?? []) handler({ type: "agent_start" }, ctxOld);
      for (const handler of handlers.get("session_shutdown") ?? []) handler({ type: "session_shutdown", reason: "quit" }, ctxOld);
      assert.equal(existsSync(join(root, "sessions", "session-STALE-NEW.json")), true, "a stale shutdown must not remove the live registration");
      const inbox = join(root, "inbox", "session-STALE-NEW");
      mkdirSync(inbox, { recursive: true });
      writeFileSync(join(inbox, "m1.json"), JSON.stringify(peerMessage("s1", "sender", "session-STALE-NEW", "Still alive.")));
      await waitUntil(() => sentMessages.length === 1, "polling to survive a stale shutdown");
      assert.equal(sentMessages[0].options, undefined, "a stale agent_start must not mark the live runtime busy");
    } finally {
      for (const handler of handlers.get("session_shutdown") ?? []) handler({ type: "session_shutdown", reason: "quit" }, ctxNew);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores a stale agent_settled and keeps the live session's in-flight claim", async () => {
    const root = createTestDir();
    const sentMessages: Array<{ content: any; options?: any }> = [];
    const handlers = new Map<string, Array<(...args: any[]) => any>>();
    const api: any = {
      registerTool() {},
      on(name: string, handler: (...args: any[]) => any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
      sendUserMessage(content: any, options?: any) { sentMessages.push({ content, options }); },
    };
    registerTalkTools(api, {
      getCurrentPeer: async () => ({ paneId: "pane-stale2", terminalId: "terminal-st2", tabId: "tab-st2", socketPath: "/tmp/herdr.sock", workspaceId: "workspace-1" }),
      getPeerStatus: async () => "idle",
      rootDir: () => root,
    });
    const ctxOld = { cwd: "/work/old", sessionManager: { getSessionId: () => "session-SETTLE-OLD", getSessionFile: () => join(root, "transcripts", "session-SETTLE-OLD.jsonl") } };
    const ctxNew = { cwd: "/work/new", sessionManager: { getSessionId: () => "session-SETTLE-NEW", getSessionFile: () => join(root, "transcripts", "session-SETTLE-NEW.jsonl") } };
    try {
      mkdirSync(join(root, "transcripts"), { recursive: true });
      for (const handler of handlers.get("session_start") ?? []) handler({ type: "session_start", reason: "startup" }, ctxOld);
      await waitUntil(() => existsSync(join(root, "sessions", "session-SETTLE-OLD.json")), "old registration to appear");
      for (const handler of handlers.get("session_start") ?? []) handler({ type: "session_start", reason: "reload" }, ctxNew);
      await waitUntil(() => existsSync(join(root, "sessions", "session-SETTLE-NEW.json")), "new registration to appear");
      const inbox = join(root, "inbox", "session-SETTLE-NEW");
      mkdirSync(inbox, { recursive: true });
      writeFileSync(join(inbox, "m1.json"), JSON.stringify(peerMessage("s1", "sender", "session-SETTLE-NEW", "Claimed.")));
      await waitUntil(() => sentMessages.length === 1, "message to drain for the live session");
      const claim = join(inbox, "m1.json.processing");
      assert.equal(existsSync(claim), true, "claim in-flight for the live session");
      for (const handler of handlers.get("agent_start") ?? []) handler({ type: "agent_start" }, ctxNew);
      for (const handler of handlers.get("message_start") ?? []) {
        handler({ type: "message_start", message: { role: "user", content: sentMessages[0].content } }, ctxNew);
      }
      // A late settlement from the superseded session must neither consume nor
      // requeue the live session's acknowledged claim.
      for (const handler of handlers.get("agent_settled") ?? []) handler({ type: "agent_settled" }, ctxOld);
      assert.equal(existsSync(claim), true, "a stale agent_settled must not consume the live claim");
      assert.equal(existsSync(join(inbox, "m1.json")), false, "a stale agent_settled must not requeue the live claim");
      // The owning session's settlement still consumes the claim exactly once.
      for (const handler of handlers.get("agent_settled") ?? []) handler({ type: "agent_settled" }, ctxNew);
      assert.equal(existsSync(claim), false, "the owning session's settlement consumes the claim");
      assert.equal(existsSync(join(inbox, "m1.json")), false, "a consumed message is not requeued");
    } finally {
      for (const handler of handlers.get("session_shutdown") ?? []) handler({ type: "session_shutdown", reason: "quit" }, ctxNew);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
