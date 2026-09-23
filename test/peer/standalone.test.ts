import assert from "node:assert";
import { describe, it } from "node:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import piPeerExtension from "../../pi-extension/pi-peer/index.ts";
import { getHerdrPeerStatusAsync, getTalkRootDir, HerdrUnavailableError, probePaneCountAsync, probeWorkspaceNameAsync } from "../../pi-extension/pi-peer/herdr.ts";
import { DEAD_SESSION_SWEEP_MS, inboxDir, nowIso, peerMessageTag, publicPeerId, recordPath, sessionDir, sweepDeadSessions } from "../../pi-extension/pi-peer/protocol.ts";
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

// Pane/tab-label CLI calls are always injected in tests: the default impl
// spawns the real `herdr` binary against a fake socket context. The default
// surface probe degrades to undefined (no migration ever fires).
const noopPaneLabelDeps = {
  renamePane: async () => {},
  clearPaneLabel: async () => {},
  renameTab: async () => {},
  probePaneCount: async () => undefined as number | undefined,
  probeWorkspaceName: async () => undefined as string | undefined,
};

describe("pi-peer outside Herdr", () => {
  it("bind failure logs one quiet line, no stack; unexpected errors keep the stack", async () => {
    const captured: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { captured.push(args); };
    const restore = () => { console.error = originalError; };
    try {
      const root = createTestDir();
      const handlers = new Map<string, Array<(...args: any[]) => any>>();
      const ctx: any = {
        cwd: "/work/outside",
        sessionManager: {
          getSessionId: () => "session-outside",
          getSessionFile: () => join(root, "transcripts", "session-outside.jsonl"),
        },
      };
      const api: any = {
        registerTool() {},
        on(name: string, handler: (...args: any[]) => any) {
          handlers.set(name, [...(handlers.get(name) ?? []), handler]);
        },
        async sendUserMessage() {}
      };
      registerTalkTools(api, {
        getCurrentPeer: async () => { throw new HerdrUnavailableError(); },
        getPeerStatus: async () => "idle",
        rootDir: () => root,
      });
      for (const handler of handlers.get("session_start") ?? []) handler({ type: "session_start", reason: "startup" }, ctx);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(captured.length, 1, "exactly one log line outside Herdr");
      assert.equal(typeof captured[0][0], "string", "quiet line is a string, not an error object");
      assert.doesNotMatch(String(captured[0][0]), /\n/, "no stack trace");

      // Unexpected bind errors keep the full error object for debugging.
      captured.length = 0;
      const handlers2 = new Map<string, Array<(...args: any[]) => any>>();
      const api2: any = {
        registerTool() {},
        on(name: string, handler: (...args: any[]) => any) {
          handlers2.set(name, [...(handlers2.get(name) ?? []), handler]);
        },
        async sendUserMessage() {}
      };
      registerTalkTools(api2, {
        getCurrentPeer: async () => { throw new Error("socket exploded"); },
        getPeerStatus: async () => "idle",
        rootDir: () => root,
      });
      for (const handler of handlers2.get("session_start") ?? []) handler({ type: "session_start", reason: "startup" }, ctx);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(captured.length, 1);
      assert.match(String(captured[0][0]), /bind failed/);
      assert.ok(captured[0][1] instanceof Error, "unexpected errors keep the error object");
      rmSync(root, { recursive: true, force: true });
    } finally {
      restore();
    }
  });

});

describe("herdr paneCount probe", () => {
  it("degrades to undefined on CLI failure, malformed JSON, or missing field", async () => {
    const run = async () => { throw new Error("socket dead"); };
    assert.equal(await probePaneCountAsync("t1", "/tmp/s.sock", { run }), undefined, "CLI error never rejects");
    assert.equal(await probePaneCountAsync("t1", "/tmp/s.sock", { run: async () => "not json{{{" }), undefined, "malformed JSON degrades");
    assert.equal(await probePaneCountAsync("t1", "/tmp/s.sock", { run: async () => JSON.stringify({ result: { tab: {} } }) }), undefined, "missing pane_count degrades");
  });

  it("returns the tab pane_count on a healthy probe", async () => {
    const run = async () => JSON.stringify({ result: { tab: { pane_count: 2 } } });
    assert.equal(await probePaneCountAsync("t1", "/tmp/s.sock", { run }), 2);
  });
});


describe("herdr workspaceName probe", () => {
  it("extracts the workspace label; degrades to undefined on any failure", async () => {
    const run = async () => JSON.stringify({ result: { workspace: { label: "pi-peer" } } });
    assert.equal(await probeWorkspaceNameAsync("w35", "/tmp/s.sock", { run }), "pi-peer", "label extracted (result is unwrapped by decodeHerdrJson)");
    assert.equal(await probeWorkspaceNameAsync("w35", "/tmp/s.sock", { run: async () => "{bad" }), undefined, "malformed JSON degrades");
    const throwing = async () => { throw new Error("socket dead"); };
    assert.equal(await probeWorkspaceNameAsync("w35", "/tmp/s.sock", { run: throwing }), undefined, "CLI error never rejects");
    const emptyLabel = async () => JSON.stringify({ result: { workspace: { label: "" } } });
    assert.equal(await probeWorkspaceNameAsync("w35", "/tmp/s.sock", { run: emptyLabel }), undefined, "empty label degrades to undefined");
  });
});
describe("herdr peer status identity", () => {
  it("a same-workspace tab move is not an identity change (pane+terminal+workspace are)", async () => {
    // `herdr pane move <pane> --tab <tab>` keeps pane_id + terminal_id and
    // only changes tab_id — the peer must stay live (regression: tab_id was
    // once part of the identity check and made moved peers vanish).
    const peer = {
      paneId: "w7:p1",
      terminalId: "term-1",
      tabId: "w7:t1",
      socketPath: "/tmp/s.sock",
      workspaceId: "w7",
    };
    const movedTab = async (args: string[]) => {
      assert.deepEqual(args.slice(0, 2), ["pane", "get"]);
      return JSON.stringify({ result: { pane: { pane_id: "w7:p1", terminal_id: "term-1", tab_id: "w7:t2", workspace_id: "w7", agent_status: "working" } } });
    };
    assert.equal(await getHerdrPeerStatusAsync(peer, undefined, { run: movedTab as any }), "working");

    // Workspace/terminal moves still fail closed.
    const movedWorkspace = async () => JSON.stringify({ result: { pane: { pane_id: "w7:p1", terminal_id: "term-1", tab_id: "w8:t1", workspace_id: "w8" } } });
    await assert.rejects(getHerdrPeerStatusAsync(peer, undefined, { run: movedWorkspace as any }), /identity changed/);
  });
});

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
      assert.equal(slashTraversal.startsWith(base + "/"), true, "must stay inside the namespace");
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
      async sendUserMessage(content: any, options?: any) {
        sentMessages.push({ content, options });
      },
    };
    // No isBusy override: the standalone runtime must self-track via agent_start/agent_end.
    registerTalkTools(api, { ...noopPaneLabelDeps,
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
      // F2: the claim is kept in-flight (at-least-once) until the turn completes.
      assert.equal(existsSync(join(inbox, "msg-busy.json.processing")), true, "claim kept until agent_end (F2)");
      // QUEUE UX: an in-flight `.processing` claim is not counted as queued.
      const sessionsInFlight = await tools.get("talk_sessions").execute("s", {}, undefined, undefined, ctx);
      assert.doesNotMatch(sessionsInFlight.content[0].text, /\([0-9]+ queued\)/, "in-flight claim is not counted as queued");

      // Peer goes idle: agent_end fires; a later message is a fresh user turn.
      for (const handler of handlers.get("agent_end") ?? []) handler({ messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] }, ctx);
      await new Promise((resolve) => setTimeout(resolve, 20));
      // F2: agent_end consumes the in-flight claim for the steered message.
      assert.equal(existsSync(join(inbox, "msg-busy.json.processing")), false, "claim consumed at agent_end");
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

  it("agent_end emits no automatic reply and never creates waiter/reply artifacts", async () => {
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
      async sendUserMessage(content: any, options?: any) {
        sentMessages.push({ content, options });
      },
    };
    registerTalkTools(api, { ...noopPaneLabelDeps,
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

      // agent_end produces no automatic reply and no peer_pong/waiter/replies.
      for (const handler of handlers.get("agent_end") ?? []) {
        handler({ messages: [{ role: "assistant", content: [{ type: "text", text: "My own answer" }] }] }, ctx);
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
      async sendUserMessage(content: any) {
        injectAttempts++;
        if (injectAttempts === 1) throw new Error("simulated injection failure");
        sentMessages.push(content);
      },
    };
    registerTalkTools(api, { ...noopPaneLabelDeps,
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
      async sendUserMessage() {},
    };
    registerTalkTools(api, { ...noopPaneLabelDeps,
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

  it("session_start labels the pane with the peer display name; cached path does not re-rename", async () => {
    const root = createTestDir();
    const handlers = new Map<string, Array<(...args: any[]) => any>>();
    const tools = new Map<string, any>();
    const renames: Array<{ paneId: string; label: string }> = [];
    const clears: string[] = [];
    const sessionId = "session-rename";
    const ctx: any = {
      cwd: "/work/rename",
      sessionManager: {
        getSessionId: () => sessionId,
        getSessionFile: () => join(root, "transcripts", `${sessionId}.jsonl`),
      },
    };
    const api: any = {
      registerTool(tool: any) { tools.set(tool.name, tool); },
      on(name: string, handler: (...args: any[]) => any) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
      async sendUserMessage() {}
    };
    registerTalkTools(api, { ...noopPaneLabelDeps,
      getCurrentPeer: async () => ({
        paneId: "pane-rename", terminalId: "terminal-rn", tabId: "tab-rn",
        socketPath: "/tmp/herdr.sock", workspaceId: "workspace-1",
      }),
      getPeerStatus: async () => "idle",
      renamePane: async (paneId: string, label: string) => { renames.push({ paneId, label }); },
      clearPaneLabel: async (paneId: string) => { clears.push(paneId); },
      rootDir: () => root,
    });
    try {
      // Cold shutdown before any bind: no runtime, so no clear must fire.
      for (const handler of handlers.get("session_shutdown") ?? []) handler({ type: "session_shutdown", reason: "quit" }, ctx);
      assert.equal(clears.length, 0, "shutdown without a bound runtime does not clear");

      for (const handler of handlers.get("session_start") ?? []) handler({ type: "session_start", reason: "startup" }, ctx);
      await waitUntil(() => renames.length === 1, "pane rename on bind");
      const record = JSON.parse(readFileSync(recordPath(root, sessionId), "utf8"));
      assert.deepEqual(renames, [{ paneId: "pane-rename", label: record.name }]);

      // Cached fast-path: a tool call on the same session must not re-rename
      // (a manual pane rename mid-session is never fought over).
      await tools.get("talk_sessions").execute("s", {}, undefined, undefined, ctx);
      assert.equal(renames.length, 1, "cached runtime does not re-rename the pane");

      // Shutdown clears the pane label so a dead pane stops advertising the name.
      for (const handler of handlers.get("session_shutdown") ?? []) handler({ type: "session_shutdown", reason: "quit" }, ctx);
      await waitUntil(() => clears.length === 1, "pane label cleared on shutdown");
      assert.deepEqual(clears, ["pane-rename"]);
    } finally {
      for (const handler of handlers.get("session_shutdown") ?? []) handler({ type: "session_shutdown", reason: "quit" }, ctx);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("pane-label ops are serialized: switch renames and shutdown clear keep lifecycle order", async () => {
    const root = createTestDir();
    const handlers = new Map<string, Array<(...args: any[]) => any>>();
    const ops: string[] = [];
    const pending: Array<() => void> = [];
    const defer = (tag: string) => new Promise<void>((resolve) => { ops.push(tag); pending.push(resolve); });
    let currentSessionId = "session-slow-a";
    const ctx: any = {
      cwd: "/work/slow-rename",
      sessionManager: {
        getSessionId: () => currentSessionId,
        getSessionFile: () => join(root, "transcripts", `${currentSessionId}.jsonl`),
      },
    };
    const api: any = {
      registerTool() {},
      on(name: string, handler: (...args: any[]) => any) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
      async sendUserMessage() {}
    };
    registerTalkTools(api, {
      getCurrentPeer: async () => ({
        paneId: "pane-slow", terminalId: "terminal-slow", tabId: "tab-slow",
        socketPath: "/tmp/herdr.sock", workspaceId: "workspace-1",
      }),
      getPeerStatus: async () => "idle",
      renamePane: async (_paneId: string, label: string) => { await defer(`rename:${label}`); },
      clearPaneLabel: async (paneId: string) => { await defer(`clear:${paneId}`); },
      rootDir: () => root,
    });
    const fire = (name: string, event: any = { type: name }) => {
      for (const handler of handlers.get(name) ?? []) handler(event, ctx);
    };
    try {
      // Bind A: rename A starts and stays pending (deferred).
      fire("session_start");
      await new Promise((resolve) => setTimeout(resolve, 20));
      const nameA = JSON.parse(readFileSync(recordPath(root, "session-slow-a"), "utf8")).name;
      assert.deepEqual(ops, [`rename:${nameA}`], "bind A renames once");

      // Switch to session B: rename B is queued behind the pending rename A.
      currentSessionId = "session-slow-b";
      fire("session_start");
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(ops.length, 1, "rename B waits for the slow rename A");
      // Read B's record now: shutdown below removes the owned registration.
      const nameB = JSON.parse(readFileSync(recordPath(root, "session-slow-b"), "utf8")).name;

      // Shutdown: clear is queued behind rename B, not called early.
      fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(ops.length, 1, "clear waits for the queued renames");

      // Resolve in order: A completes -> B fires -> resolve B -> clear fires.
      pending[0](); // rename A settles
      await waitUntil(() => ops.length === 2, "rename B fires after rename A settles");
      assert.equal(ops[1], `rename:${nameB}`);
      pending[1](); // rename B settles
      await waitUntil(() => ops.length === 3, "clear fires after rename B settles");
      assert.equal(ops[2], "clear:pane-slow");
    } finally {
      fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a bind that crosses shutdown never commits a runtime, registration, or pane rename", async () => {
    const root = createTestDir();
    const handlers = new Map<string, Array<(...args: any[]) => any>>();
    const tools = new Map<string, any>();
    const ops: string[] = [];
    const statusCalls: Array<[string, string | undefined]> = [];
    const sessionId = "session-zombie";
    const ctx: any = {
      cwd: "/work/zombie",
      sessionManager: {
        getSessionId: () => sessionId,
        getSessionFile: () => join(root, "transcripts", `${sessionId}.jsonl`),
      },
      ui: { setStatus: (key: string, text?: string) => { statusCalls.push([key, text]); } },
    };
    const api: any = {
      registerTool(tool: any) { tools.set(tool.name, tool); },
      on(name: string, handler: (...args: any[]) => any) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
      async sendUserMessage() {}
    };
    let resolvePeer: (value: any) => void = () => {};
    registerTalkTools(api, {
      getCurrentPeer: () => new Promise((resolve) => { resolvePeer = resolve; }),
      getPeerStatus: async () => "idle",
      renamePane: async (_paneId: string, label: string) => { ops.push(`rename:${label}`); },
      clearPaneLabel: async (paneId: string) => { ops.push(`clear:${paneId}`); },
      rootDir: () => root,
    });
    const fire = (name: string, event: any = { type: name }) => {
      for (const handler of handlers.get(name) ?? []) handler(event, ctx);
    };
    try {
      // Bind starts and stays pending inside getCurrentPeer.
      fire("session_start");
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Shutdown lands while the bind is still awaiting its peer context.
      fire("session_shutdown", { type: "session_shutdown", reason: "quit" });

      // The bind resolves after shutdown: it must not commit anything.
      resolvePeer({
        paneId: "pane-zombie", terminalId: "terminal-z", tabId: "tab-z",
        socketPath: "/tmp/herdr.sock", workspaceId: "workspace-1",
      });
      await new Promise((resolve) => setTimeout(resolve, 20));

      assert.equal(ops.length, 0, "no pane rename or clear for a dead bind");
      assert.equal(existsSync(recordPath(root, sessionId)), false, "no registration resurrected");
      assert.deepEqual(statusCalls, [["pi-peer", undefined]], "no peer status published");

      // (A tool call after shutdown is impossible in a real host: tools die
      // with the session. The generation guard covers the bind-pending window.)
    } finally {
      fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("single-pane session labels the tab, not the pane; shutdown restores the workspace label", async () => {
    const root = createTestDir();
    const handlers = new Map<string, Array<(...args: any[]) => any>>();
    const ops: string[] = [];
    const sessionId = "session-tab";
    const ctx: any = {
      cwd: "/work/tab-label",
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
      async sendUserMessage() {}
    };
    registerTalkTools(api, {
      getCurrentPeer: async () => ({
        paneId: "pane-tab", terminalId: "terminal-tab", tabId: "tab-lone",
        socketPath: "/tmp/herdr.sock", workspaceId: "workspace-1", paneCount: 1,
      }),
      getPeerStatus: async () => "idle",
      renamePane: async (paneId: string, label: string) => { ops.push(`pane:${paneId}:${label}`); },
      clearPaneLabel: async (paneId: string) => { ops.push(`pane-clear:${paneId}`); },
      renameTab: async (tabId: string, label: string) => { ops.push(`tab:${tabId}:${label}`); },
      rootDir: () => root,
    });
    const fire = (name: string, event: any = { type: name }) => {
      for (const handler of handlers.get(name) ?? []) handler(event, ctx);
    };
    try {
      fire("session_start");
      await waitUntil(() => ops.length === 1, "tab rename on single-pane bind");
      const record = JSON.parse(readFileSync(recordPath(root, sessionId), "utf8"));
      assert.deepEqual(ops, [`tab:tab-lone:${record.name}`], "labels the tab, never the pane");

      fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
      await waitUntil(() => ops.length === 2, "tab clear on shutdown");
      assert.deepEqual(ops[1], "tab:tab-lone:workspace-1", "tab restored to the workspace name");
    } finally {
      fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rebind after a split moves the label: tab cleared, pane renamed", async () => {
    const root = createTestDir();
    const handlers = new Map<string, Array<(...args: any[]) => any>>();
    const ops: string[] = [];
    let currentSessionId = "session-split-1";
    let paneCount = 1;
    const ctx: any = {
      cwd: "/work/split",
      sessionManager: {
        getSessionId: () => currentSessionId,
        getSessionFile: () => join(root, "transcripts", `${currentSessionId}.jsonl`),
      },
    };
    const api: any = {
      registerTool() {},
      on(name: string, handler: (...args: any[]) => any) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
      async sendUserMessage() {}
    };
    registerTalkTools(api, {
      getCurrentPeer: async () => ({
        paneId: "pane-split", terminalId: "terminal-split", tabId: "tab-split",
        socketPath: "/tmp/herdr.sock", workspaceId: "workspace-1", paneCount,
      }),
      getPeerStatus: async () => "idle",
      renamePane: async (paneId: string, label: string) => { ops.push(`pane:${paneId}:${label}`); },
      clearPaneLabel: async (paneId: string) => { ops.push(`pane-clear:${paneId}`); },
      renameTab: async (tabId: string, label: string) => { ops.push(`tab:${tabId}:${label}`); },
      rootDir: () => root,
    });
    const fire = (name: string, event: any = { type: name }) => {
      for (const handler of handlers.get(name) ?? []) handler(event, ctx);
    };
    try {
      // First bind: single pane -> tab labeled.
      fire("session_start");
      await waitUntil(() => ops.length === 1, "tab rename on first bind");
      assert.match(ops[0], /^tab:tab-split:/);

      // A pane is split; the next bind (session switch) sees paneCount 2.
      paneCount = 2;
      currentSessionId = "session-split-2";
      fire("session_start");
      await waitUntil(() => ops.length === 3, "stale tab cleared and pane renamed on rebind");
      assert.equal(ops[1], "tab:tab-split:workspace-1", "stale tab label restored to the workspace name");
      const secondName = JSON.parse(readFileSync(recordPath(root, "session-split-2"), "utf8")).name;
      assert.equal(ops[2], `pane:pane-split:${secondName}`, "pane is now the visible surface");

      fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
      await waitUntil(() => ops.length === 4, "pane clear on shutdown");
      assert.equal(ops[3], "pane-clear:pane-split");
    } finally {
      fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
      rmSync(root, { recursive: true, force: true });
    }
  });


  it("heartbeat migrates the label when a split lands between binds (tab -> pane)", async () => {
    const root = createTestDir();
    const handlers = new Map<string, Array<(...args: any[]) => any>>();
    const ops: string[] = [];
    let paneCount = 1;
    const sessionId = "session-mig";
    const ctx: any = {
      cwd: "/work/migrate",
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
      async sendUserMessage() {}
    };
    registerTalkTools(api, {
      getCurrentPeer: async () => ({
        paneId: "pane-mig", terminalId: "terminal-mig", tabId: "tab-mig",
        socketPath: "/tmp/herdr.sock", workspaceId: "workspace-1", paneCount,
      }),
      getPeerStatus: async () => "idle",
      renamePane: async (paneId: string, label: string) => { ops.push(`pane:${paneId}:${label}`); },
      clearPaneLabel: async (paneId: string) => { ops.push(`pane-clear:${paneId}`); },
      renameTab: async (tabId: string, label: string) => { ops.push(`tab:${tabId}:${label}`); },
      probePaneCount: async () => paneCount,
      surfaceCheckMs: 20,
      rootDir: () => root,
    });
    const fire = (name: string, event: any = { type: name }) => {
      for (const handler of handlers.get(name) ?? []) handler(event, ctx);
    };
    try {
      // Single-pane bind: the tab is the visible surface.
      fire("session_start");
      await waitUntil(() => ops.length === 1, "tab rename on bind");
      assert.match(ops[0], /^tab:tab-mig:/);
      const name = ops[0].split(":")[2];

      // A split lands; the heartbeat probe now sees 2 panes.
      paneCount = 2;
      await waitUntil(() => ops.length === 3, "migrates tab label to pane");
      assert.equal(ops[1], "tab:tab-mig:workspace-1", "stale tab label restored to the workspace name");
      assert.equal(ops[2], `pane:pane-mig:${name}`, "pane takes the name");

      fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
      await waitUntil(() => ops.length === 4, "pane clear on shutdown");
      assert.equal(ops[3], "pane-clear:pane-mig");
    } finally {
      fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("heartbeat migrates back when panes close (pane -> tab)", async () => {
    const root = createTestDir();
    const handlers = new Map<string, Array<(...args: any[]) => any>>();
    const ops: string[] = [];
    let paneCount = 2;
    const sessionId = "session-mig-back";
    const ctx: any = {
      cwd: "/work/migrate-back",
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
      async sendUserMessage() {}
    };
    registerTalkTools(api, {
      getCurrentPeer: async () => ({
        paneId: "pane-mb", terminalId: "terminal-mb", tabId: "tab-mb",
        socketPath: "/tmp/herdr.sock", workspaceId: "workspace-1", paneCount,
      }),
      getPeerStatus: async () => "idle",
      renamePane: async (paneId: string, label: string) => { ops.push(`pane:${paneId}:${label}`); },
      clearPaneLabel: async (paneId: string) => { ops.push(`pane-clear:${paneId}`); },
      renameTab: async (tabId: string, label: string) => { ops.push(`tab:${tabId}:${label}`); },
      probePaneCount: async () => paneCount,
      surfaceCheckMs: 20,
      rootDir: () => root,
    });
    const fire = (name: string, event: any = { type: name }) => {
      for (const handler of handlers.get(name) ?? []) handler(event, ctx);
    };
    try {
      // Split bind: the pane is the visible surface.
      fire("session_start");
      await waitUntil(() => ops.length === 1, "pane rename on bind");
      assert.match(ops[0], /^pane:pane-mb:/);
      const name = ops[0].split(":")[2];

      // Panes close back to one; the probe sees 1 again.
      paneCount = 1;
      await waitUntil(() => ops.length === 3, "migrates pane label back to tab");
      assert.equal(ops[1], "pane-clear:pane-mb", "pane label cleared");
      assert.equal(ops[2], `tab:tab-mb:${name}`, "tab takes the name back");

      fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
      await waitUntil(() => ops.length === 4, "tab clear on shutdown");
      assert.equal(ops[3], "tab:tab-mb:workspace-1", "tab restored to the workspace name");
    } finally {
      fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("bind transition releases a stale surface with the OWNING workspace, not the new one", async () => {
    const root = createTestDir();
    const handlers = new Map<string, Array<(...args: any[]) => any>>();
    const ops: string[] = [];
    let sessionId = "session-ws-a";
    let workspaceId = "ws-a";
    let tabId = "tab-a";
    const ctx: any = {
      cwd: "/work/ws-ownership",
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
      async sendUserMessage() {}
    };
    registerTalkTools(api, {
      getCurrentPeer: async () => ({
        paneId: "pane-ws", terminalId: "terminal-ws", tabId,
        socketPath: "/tmp/herdr.sock", workspaceId, paneCount: 1,
      }),
      getPeerStatus: async () => "idle",
      renamePane: async (paneId: string, label: string) => { ops.push(`pane:${paneId}:${label}`); },
      clearPaneLabel: async (paneId: string) => { ops.push(`pane-clear:${paneId}`); },
      renameTab: async (id: string, label: string) => { ops.push(`tab:${id}:${label}`); },
      probeWorkspaceName: async (wsId: string) => (wsId === "ws-a" ? "Alpha" : "Beta"),
      rootDir: () => root,
    });
    const fire = (name: string, event: any = { type: name }) => {
      for (const handler of handlers.get(name) ?? []) handler(event, ctx);
    };
    try {
      // Bind A: single pane in workspace ws-a -> labels tab-a.
      fire("session_start");
      await waitUntil(() => ops.length === 1, "tab rename on bind A");
      assert.match(ops[0], /^tab:tab-a:/);

      // Switch to session B that lives in a DIFFERENT workspace and tab.
      sessionId = "session-ws-b";
      workspaceId = "ws-b";
      tabId = "tab-b";
      fire("session_start");
      await waitUntil(() => ops.length === 3, "stale tab released, new tab labeled");
      assert.equal(ops[1], "tab:tab-a:Alpha", "stale tab restored to its own workspace NAME");
      assert.match(ops[2], /^tab:tab-b:/, "new tab labeled with peer B name");

      fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
      await waitUntil(() => ops.length === 4, "shutdown releases tab-b");
      assert.equal(ops[3], "tab:tab-b:Beta");
    } finally {
      fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
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
      async sendUserMessage() {},
    };
    registerTalkTools(api, { ...noopPaneLabelDeps,
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
      async sendUserMessage() {},
    };
    registerTalkTools(api, { ...noopPaneLabelDeps,
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
      async sendUserMessage(content: any) { sentMessages.push(content); },
    };
    registerTalkTools(api, { ...noopPaneLabelDeps,
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
      for (const handler of handlers.get("agent_end") ?? []) handler({ type: "agent_end" }, ctx);
      assert.equal(existsSync(join(inbox, "msg-orphan.json.processing")), false, "claim consumed at agent_end");
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
      // Registration B is written before A's owned record is removed, so B's
      // existence implies the ownership transfer has already run.
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
      async sendUserMessage(content: any) { sentMessages.push(content); },
    };
    registerTalkTools(api, { ...noopPaneLabelDeps,
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
      async sendUserMessage(content: any) { sentMessages.push(content); },
    };
    registerTalkTools(api, { ...noopPaneLabelDeps,
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
      async sendUserMessage(content: any, options?: any) { sentMessages.push({ content, options }); },
    };
    registerTalkTools(api, { ...noopPaneLabelDeps,
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
      // F1: the triggered turn is pending (agent_start not yet seen); m2 must NOT drain.
      await new Promise((resolve) => setTimeout(resolve, 40));
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

  it("keeps a fresh-trigger claim in-flight until agent_start/agent_end (F2)", async () => {
    const root = createTestDir();
    const sentMessages: Array<{ content: any; options?: any }> = [];
    const handlers = new Map<string, Array<(...args: any[]) => any>>();
    const sessionId = "session-f2a";
    const ctx = { cwd: "/work/f2a", sessionManager: { getSessionId: () => sessionId, getSessionFile: () => join(root, "transcripts", `${sessionId}.jsonl`) } };
    const api: any = {
      registerTool() {},
      on(name: string, handler: (...args: any[]) => any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
      async sendUserMessage(content: any, options?: any) { sentMessages.push({ content, options }); },
    };
    registerTalkTools(api, { ...noopPaneLabelDeps,
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
      // No agent_start: the claim must persist across several poll ticks.
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(existsSync(claim), true, "claim still in-flight with a delayed agent_start");
    } finally {
      // Shutdown without agent_end leaves the unconsumed claim recoverable on disk.
      for (const handler of handlers.get("session_shutdown") ?? []) handler({ type: "session_shutdown", reason: "quit" }, ctx);
      assert.equal(existsSync(claim), true, "unconsumed claim left on disk after shutdown");
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requeues an orphaned claim on session rebind when agent_end was missed (F2)", async () => {
    const root = createTestDir();
    const sentMessages: Array<{ content: any; options?: any }> = [];
    const handlers = new Map<string, Array<(...args: any[]) => any>>();
    const sessionId = "session-f2d";
    const ctx = { cwd: "/work/f2d", sessionManager: { getSessionId: () => sessionId, getSessionFile: () => join(root, "transcripts", `${sessionId}.jsonl`) } };
    const api: any = {
      registerTool() {},
      on(name: string, handler: (...args: any[]) => any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
      async sendUserMessage(content: any, options?: any) { sentMessages.push({ content, options }); },
    };
    registerTalkTools(api, { ...noopPaneLabelDeps,
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
      // Miss agent_end: session shuts down and rebinds.
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
  it("restart drops an orphaned claim already in the transcript and requeues the rest", async () => {
    const root = createTestDir();
    const sentMessages: string[] = [];
    const handlers = new Map<string, Array<(...args: any[]) => any>>();
    const sessionId = "session-resume";
    const sessionFile = join(root, "transcripts", `${sessionId}.jsonl`);
    const ctx = { cwd: "/work/resume", sessionManager: { getSessionId: () => sessionId, getSessionFile: () => sessionFile } };
    const api: any = {
      registerTool() {},
      on(name: string, handler: (...args: any[]) => any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
      async sendUserMessage(content: any) { sentMessages.push(content); },
    };
    registerTalkTools(api, { ...noopPaneLabelDeps,
      getCurrentPeer: async () => ({ paneId: "pane-resume", terminalId: "term-resume", tabId: "tab-resume", socketPath: "/tmp/herdr.sock", workspaceId: "workspace-1" }),
      getPeerStatus: async () => "idle",
      rootDir: () => root,
    });
    try {
      // Previous process was killed mid-turn: two claims left as `.processing`,
      // but only the first had entered the turn (persisted in the transcript).
      const delivered = peerMessage("s1", "sender", sessionId, "Already seen.", "m1");
      const pending = peerMessage("s1", "sender", sessionId, "Not seen yet.", "m2");
      const inbox = inboxDir(root, sessionId);
      mkdirSync(inbox, { recursive: true });
      mkdirSync(join(root, "transcripts"), { recursive: true });
      writeFileSync(join(inbox, "m1.json.processing"), JSON.stringify(delivered));
      writeFileSync(join(inbox, "m2.json.processing"), JSON.stringify(pending));
      writeFileSync(sessionFile, `${JSON.stringify({ type: "message", id: "e1", message: { role: "user", content: [{ type: "text", text: peerMessageTag(delivered as any) }] } })}\n`);
      for (const handler of handlers.get("session_start") ?? []) handler({ type: "session_start", reason: "resume" }, ctx);
      await waitUntil(() => sentMessages.length === 1, "undelivered claim redelivered");
      assert.match(sentMessages[0], /Not seen yet\./);
      assert.equal(existsSync(join(inbox, "m1.json.processing")) || existsSync(join(inbox, "m1.json")), false, "delivered claim consumed, not replayed");
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(sentMessages.length, 1, "no duplicate delivery");
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
      async sendUserMessage(content: any, options?: any) { sentMessages.push({ content, options }); },
    };
    registerTalkTools(api, { ...noopPaneLabelDeps,
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
      // Switch to B without an agent_end or shutdown for A.
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
      async sendUserMessage(content: any, options?: any) { sentMessages.push({ content, options }); },
    };
    registerTalkTools(api, { ...noopPaneLabelDeps,
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
});
