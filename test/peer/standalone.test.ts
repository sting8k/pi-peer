import assert from "node:assert";
import { describe, it } from "node:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import piPeerExtension from "../../pi-extension/pi-peer/index.ts";
import { getTalkRootDir } from "../../pi-extension/pi-peer/herdr.ts";
import { DEAD_SESSION_SWEEP_MS, inboxDir, nowIso, publicPeerId, recordPath, repliesDir, sessionDir, sweepDeadSessions, waitersDir } from "../../pi-extension/pi-peer/protocol.ts";
import { safeKey } from "../../pi-extension/pi-peer/storage.ts";
import { registerTalkTools, sweepStaleArtifacts } from "../../pi-extension/pi-peer/service.ts";
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

  it("standalone self-tracks busy: session_start recovers after a missed agent_end", async () => {
    const root = createTestDir();
    const tools = new Map<string, any>();
    const sentMessages: any[] = [];
    const handlers = new Map<string, Array<(...args: any[]) => any>>();
    const sessionId = "session-standalone";
    const sessionFile = join(root, "transcripts", `${sessionId}.jsonl`);
    const ctx = { cwd: "/work/standalone", sessionManager: { getSessionId: () => sessionId, getSessionFile: () => sessionFile } };
    const api: any = {
      registerTool(tool: any) { tools.set(tool.name, tool); },
      on(name: string, handler: (...args: any[]) => any) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
      async sendUserMessage(content: any) {
        sentMessages.push(content);
      },
    };
    // No isBusy override: the standalone runtime must self-track via agent_start/agent_end.
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
      // Establish the runtime + polling interval.
      for (const handler of handlers.get("session_start") ?? []) handler({ type: "session_start", reason: "startup" }, ctx);
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Peer is busy: agent_start fired.
      for (const handler of handlers.get("agent_start") ?? []) handler({ type: "agent_start" }, ctx);
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Place an inbound request while busy.
      const inbox = join(root, "inbox", sessionId);
      mkdirSync(inbox, { recursive: true });
      const request = {
        version: 1, type: "request", id: "req-busy", from: "session-sender", to: sessionId,
        message: "Deliver only after agent_end.", route: ["session-sender"], createdAt: new Date().toISOString(),
      };
      writeFileSync(join(inbox, "req-busy.json"), JSON.stringify(request));

      // Polling must NOT claim/deliver while selfBusy is true.
      await new Promise((resolve) => setTimeout(resolve, 350));
      assert.equal(sentMessages.length, 0, "busy peer must not drain inbound requests");
      assert.equal(existsSync(join(inbox, "req-busy.json")), true, "request remains pending while busy");

      // Simulate a missed agent_end: session_start must clear stale selfBusy before rebind.
      for (const handler of handlers.get("session_start") ?? []) handler({ type: "session_start", reason: "resume" }, ctx);
      await new Promise((resolve) => setTimeout(resolve, 350));

      assert.equal(sentMessages.length, 1, "request delivered after session_start resets stale busy");
      assert.equal(typeof sentMessages[0], "string");
      assert.match(sentMessages[0], /<peer_message request_id=/);
      assert.match(sentMessages[0], /Deliver only after agent_end/);
      assert.equal(existsSync(join(inbox, "req-busy.json")), false, "request claimed after delivery");
    } finally {
      for (const handler of handlers.get("session_shutdown") ?? []) handler({ type: "session_shutdown", reason: "quit" }, ctx);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("agent_end only completes the matching peer request turn", async () => {
    const root = createTestDir();
    const sentMessages: string[] = [];
    const handlers = new Map<string, Array<(...args: any[]) => any>>();
    const sessionId = "session-correlate";
    const ctx = {
      cwd: "/work/correlate",
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
      async sendUserMessage(content: any) {
        sentMessages.push(content);
      },
    };
    registerTalkTools(api, {
      getCurrentPeer: async () => ({
        paneId: "pane-correlate", terminalId: "term-correlate", tabId: "tab-correlate",
        socketPath: "/tmp/herdr.sock", workspaceId: "workspace-1",
      }),
      getPeerStatus: async () => "idle" as const,
      rootDir: () => root,
      isBusy: () => false,
    });
    try {
      mkdirSync(join(root, "transcripts"), { recursive: true });
      for (const handler of handlers.get("session_start") ?? []) handler({ type: "session_start", reason: "startup" }, ctx);
      await waitUntil(() => existsSync(recordPath(root, sessionId)), "correlation session registration");
      const requestId = "req-correlated";
      const inbox = inboxDir(root, sessionId);
      mkdirSync(inbox, { recursive: true });
      writeFileSync(join(inbox, `${requestId}.json`), JSON.stringify({
        version: 1, type: "request", id: requestId, from: "session-sender", to: sessionId,
        message: "Answer only after the matching turn.", route: ["session-sender"], createdAt: nowIso(),
      }));
      await waitUntil(() => sentMessages.length === 1, "peer request delivery");
      const processing = join(inbox, `${requestId}.json.processing`);
      const reply = join(repliesDir(root, "session-sender"), `${requestId}.json`);
      assert.equal(existsSync(processing), true, "request is claimed while its turn runs");
      for (const handler of handlers.get("agent_end") ?? []) handler({ messages: [
        { role: "user", content: [{ type: "text", text: "An unrelated user turn" }] },
        { role: "assistant", content: [{ type: "text", text: "Wrong turn" }] },
      ] }, ctx);
      assert.equal(existsSync(reply), false, "unrelated turn must not answer the peer request");
      assert.equal(existsSync(processing), true, "unrelated turn must not release the claim");
      for (const handler of handlers.get("agent_end") ?? []) handler({ messages: [
        { role: "user", content: [{ type: "text", text: sentMessages[0] }] },
        { role: "assistant", content: [{ type: "text", text: "Matching answer" }] },
      ] }, ctx);
      await waitUntil(() => existsSync(reply), "matching peer reply");
      assert.equal(JSON.parse(readFileSync(reply, "utf8")).message, "Matching answer");
      assert.equal(existsSync(processing), false, "matching turn releases the claim");
    } finally {
      for (const handler of handlers.get("session_shutdown") ?? []) handler({ type: "session_shutdown", reason: "quit" }, ctx);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lost delivery watchdog fails an idle claim and releases the processing file", async () => {
    const root = createTestDir();
    const sentMessages: string[] = [];
    const handlers = new Map<string, Array<(...args: any[]) => any>>();
    const sessionId = "session-watchdog";
    const ctx = {
      cwd: "/work/watchdog",
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
      async sendUserMessage(content: any) {
        sentMessages.push(content);
      },
    };
    registerTalkTools(api, {
      getCurrentPeer: async () => ({
        paneId: "pane-watchdog", terminalId: "term-watchdog", tabId: "tab-watchdog",
        socketPath: "/tmp/herdr.sock", workspaceId: "workspace-1",
      }),
      getPeerStatus: async () => "idle" as const,
      rootDir: () => root,
      isBusy: () => false,
      activeRequestWatchdogTicks: 2,
    });
    try {
      mkdirSync(join(root, "transcripts"), { recursive: true });
      for (const handler of handlers.get("session_start") ?? []) handler({ type: "session_start", reason: "startup" }, ctx);
      await waitUntil(() => existsSync(recordPath(root, sessionId)), "watchdog session registration");
      const requestId = "req-watchdog";
      const inbox = inboxDir(root, sessionId);
      mkdirSync(inbox, { recursive: true });
      writeFileSync(join(inbox, `${requestId}.json`), JSON.stringify({
        version: 1, type: "request", id: requestId, from: "session-sender", to: sessionId,
        message: "This delivery will never start a turn.", route: ["session-sender"], createdAt: nowIso(),
      }));
      await waitUntil(() => sentMessages.length === 1, "watchdog request delivery");
      const processing = join(inbox, `${requestId}.json.processing`);
      const reply = join(repliesDir(root, "session-sender"), `${requestId}.json`);
      await waitUntil(() => existsSync(reply), "watchdog failure reply");
      const response = JSON.parse(readFileSync(reply, "utf8"));
      assert.equal(response.ok, false);
      assert.equal(response.error, "Peer did not start a turn for the request");
      assert.equal(existsSync(processing), false, "watchdog releases the processing claim");
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
        // The registered handler is intentionally void/fire-and-forget; callers
        // must waitUntil the filesystem condition they care about.
        for (const handler of handlers.get("session_start") ?? []) handler({ type: "session_start", reason: "test" }, ctx);
      },
      cleanup() {
        for (const handler of handlers.get("session_shutdown") ?? []) handler({ type: "session_shutdown", reason: "quit" }, ctxB);
        rmSync(root, { recursive: true, force: true });
      },
    };
  }

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

  it("sweepStaleArtifacts closes dead-target pending wakes with a failure pong and GCs orphans", async () => {
    const root = createTestDir();
    const sent: string[] = [];
    const pi = { sendUserMessage: async (content: any) => { sent.push(content); } } as any;
    const runtime = { root, record: { sessionId: "session-a" }, activeRequests: [] } as any;
    const now = nowIso();
    const recordFor = (sessionId: string, name: string) => JSON.stringify({
      schemaVersion: 1, sessionId, name, cwd: `/work/${name}`, workspaceId: "w",
      paneId: `pane-${name}`, terminalId: `term-${name}`, createdAt: now,
    });
    try {
      mkdirSync(sessionDir(root), { recursive: true });
      mkdirSync(waitersDir(root, "session-a"), { recursive: true });
      mkdirSync(repliesDir(root, "session-a"), { recursive: true });

      // (1) pending waiter whose target is DEAD (stale heartbeat) -> failure pong + removal.
      const w1 = "req_dead_target";
      writeFileSync(join(waitersDir(root, "session-a"), `${w1}.json`), JSON.stringify({
        version: 1, type: "waiter", requestId: w1, from: "session-a", to: "session-b",
        targetName: "beta", createdAt: now, timedOutAt: now,
      }));
      writeFileSync(recordPath(root, "session-b"), recordFor("session-b", "beta"));
      utimesSync(recordPath(root, "session-b"), new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));
      // Staleness already persisted past the grace window: the failure pong fires.
      const staleSince = new Map<string, number>([[w1, Date.now() - 120_000]]);

      // (2) pending waiter whose target is ALIVE, no reply yet -> kept for a later wake.
      const w2 = "req_alive_target";
      writeFileSync(join(waitersDir(root, "session-a"), `${w2}.json`), JSON.stringify({
        version: 1, type: "waiter", requestId: w2, from: "session-a", to: "session-c",
        targetName: "gamma", createdAt: now, timedOutAt: now,
      }));
      writeFileSync(recordPath(root, "session-c"), recordFor("session-c", "gamma"));

      // (3) un-timed waiter older than WAITER_TTL_MS -> orphaned wait, removed.
      const w3 = "req_orphan_wait";
      writeFileSync(join(waitersDir(root, "session-a"), `${w3}.json`), JSON.stringify({
        version: 1, type: "waiter", requestId: w3, from: "session-a", to: "session-d",
        createdAt: new Date(Date.now() - 100 * 60_000).toISOString(),
      }));

      // (4) reply without a waiter -> orphan, removed; reply WITH waiter -> kept.
      writeFileSync(join(repliesDir(root, "session-a"), "req_no_waiter.json"), JSON.stringify({
        version: 1, type: "response", requestId: "req_no_waiter", from: "session-x", to: "session-a",
        ok: true, message: "orphan", createdAt: now,
      }));
      writeFileSync(join(repliesDir(root, "session-a"), `${w2}.json`), JSON.stringify({
        version: 1, type: "response", requestId: w2, from: "session-c", to: "session-a",
        ok: true, message: "kept", createdAt: now,
      }));

      await sweepStaleArtifacts(pi, runtime, () => false, staleSince);
      // One user-message send per tick: the failure pong returned early, so the
      // orphan cleanup (w3 / reply orphans) runs on the following tick.
      await sweepStaleArtifacts(pi, runtime, () => false, staleSince);

      assert.equal(sent.length, 1, "exactly one failure pong");
      assert.match(sent[0], /<peer_pong request_id="req_dead_target"/);
      assert.match(sent[0], /ok="false"/);
      assert.match(sent[0], /never replied/);
      assert.equal(existsSync(join(waitersDir(root, "session-a"), `${w1}.json`)), false, "dead-target waiter removed");
      assert.equal(existsSync(join(waitersDir(root, "session-a"), `${w2}.json`)), true, "alive-target pending waiter kept");
      assert.equal(existsSync(join(waitersDir(root, "session-a"), `${w3}.json`)), false, "orphaned un-timed waiter removed");
      assert.equal(existsSync(join(repliesDir(root, "session-a"), "req_no_waiter.json")), false, "orphan reply removed");
      assert.equal(existsSync(join(repliesDir(root, "session-a"), `${w2}.json`)), true, "reply with waiter kept");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sweepStaleArtifacts grants suspension grace: a first stale observation never sends a failure pong", async () => {
    const root = createTestDir();
    const sent: string[] = [];
    const pi = { sendUserMessage: async (content: any) => { sent.push(content); } } as any;
    const runtime = { root, record: { sessionId: "session-a" }, activeRequests: [] } as any;
    const now = nowIso();
    try {
      mkdirSync(sessionDir(root), { recursive: true });
      mkdirSync(waitersDir(root, "session-a"), { recursive: true });
      const w = "req_just_woke";
      writeFileSync(join(waitersDir(root, "session-a"), `${w}.json`), JSON.stringify({
        version: 1, type: "waiter", requestId: w, from: "session-a", to: "session-b",
        targetName: "beta", createdAt: now, timedOutAt: now,
      }));
      writeFileSync(recordPath(root, "session-b"), JSON.stringify({
        schemaVersion: 1, sessionId: "session-b", name: "beta", cwd: "/work/beta",
        workspaceId: "w", paneId: "pane-beta", terminalId: "term-beta", createdAt: now,
      }));
      // Target looks stale right now (post-sleep), but the peer may heartbeat
      // within 250 ms: the sweep must wait the full grace window before ponging.
      utimesSync(recordPath(root, "session-b"), new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));
      await sweepStaleArtifacts(pi, runtime, () => false);
      assert.equal(sent.length, 0, "no failure pong during the grace window");
      assert.equal(existsSync(join(waitersDir(root, "session-a"), `${w}.json`)), true, "waiter kept during the grace window");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sweepStaleArtifacts failure pong steers when busy-own-work but withholds during a peer batch", async () => {
    const now = nowIso();
    const setup = (activeRequests: any[]) => {
      const root = createTestDir();
      const sent: Array<{ content: string; options?: any }> = [];
      const pi = { sendUserMessage: async (content: any, options?: any) => { sent.push({ content, options }); } } as any;
      const runtime = { root, record: { sessionId: "session-a" }, activeRequests } as any;
      mkdirSync(sessionDir(root), { recursive: true });
      mkdirSync(waitersDir(root, "session-a"), { recursive: true });
      const w = "req_dead_busy";
      writeFileSync(join(waitersDir(root, "session-a"), `${w}.json`), JSON.stringify({
        version: 1, type: "waiter", requestId: w, from: "session-a", to: "session-b",
        targetName: "beta", createdAt: now, timedOutAt: now,
      }));
      writeFileSync(recordPath(root, "session-b"), JSON.stringify({
        schemaVersion: 1, sessionId: "session-b", name: "beta", cwd: "/work/beta",
        workspaceId: "w", paneId: "pane-beta", terminalId: "term-beta", createdAt: now,
      }));
      // Dead target: staleness already past the grace window so the failure pong fires.
      utimesSync(recordPath(root, "session-b"), new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));
      const staleSince = new Map<string, number>([[w, Date.now() - 120_000]]);
      return { root, sent, pi, runtime, staleSince, w };
    };

    // Busy with the session's OWN work (no active batch) -> failure pong steered mid-turn.
    const busyCase = setup([]);
    try {
      await sweepStaleArtifacts(busyCase.pi, busyCase.runtime, () => true, busyCase.staleSince);
      assert.equal(busyCase.sent.length, 1, "failure pong sent while busy-own-work");
      assert.match(busyCase.sent[0].content, /<peer_pong request_id="req_dead_busy"/);
      assert.deepEqual(busyCase.sent[0].options, { deliverAs: "steer" }, "busy-own-work failure pong steered");
    } finally {
      rmSync(busyCase.root, { recursive: true, force: true });
    }

    // Active peer-request batch -> the failure pong must keep waiting.
    const batchCase = setup([{ id: "req-batch", from: "session-gamma" } as any]);
    try {
      await sweepStaleArtifacts(batchCase.pi, batchCase.runtime, () => true, batchCase.staleSince);
      assert.equal(batchCase.sent.length, 0, "failure pong withheld while a peer batch is active");
      assert.equal(existsSync(join(waitersDir(batchCase.root, "session-a"), `${batchCase.w}.json`)), true, "waiter kept while batch active");
    } finally {
      rmSync(batchCase.root, { recursive: true, force: true });
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
      mkdirSync(join(root, "replies", "session-dead"), { recursive: true });
      mkdirSync(join(root, "waiters", "session-dead"), { recursive: true });
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
      assert.equal(existsSync(join(root, "replies", "session-dead")), false, "dead replies removed");
      assert.equal(existsSync(join(root, "waiters", "session-dead")), false, "dead waiters removed");
      assert.equal(existsSync(recordPath(root, "session-live")), true, "live registration kept");
      assert.equal(existsSync(join(root, "latest", "session-live.json")), true, "live latest kept");
      assert.equal(existsSync(join(root, "inbox", "session-live", "req.json")), true, "live inbox kept");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects malformed inbox requests with an ok=false reply when addressing is recoverable", async () => {
    const root = createTestDir();
    const tools = new Map<string, any>();
    const sentMessages: any[] = [];
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
      await new Promise((resolve) => setTimeout(resolve, 20));

      const inbox = join(root, "inbox", sessionId);
      mkdirSync(inbox, { recursive: true });

      // Scenario 1: JSON parse fail but caller addressing recoverable via raw text.
      const badId = "req_bad_json_abc";
      writeFileSync(join(inbox, `${badId}.json`), `{\"from\": \"session-sender\", \"id\": \"${badId}\", \"to\": ${JSON.stringify(sessionId)}, ???malformed`);
      // Scenario 2: parseable but fails protocol validation (route cycle / missing fields).
      const badId2 = "req_bad_route_xyz";
      writeFileSync(join(inbox, `${badId2}.json`), JSON.stringify({
        version: 1, type: "request", id: badId2, from: "session-other", to: sessionId,
        message: "x", route: ["session-other", sessionId], createdAt: new Date().toISOString(),
      }));

      // Polling drains (idle) and must reject both instead of dropping silently.
      await new Promise((resolve) => setTimeout(resolve, 400));

      const reply1 = join(repliesDir(root, "session-sender"), `${safeKey(badId)}.json`);
      assert.ok(existsSync(reply1), "malformed JSON with raw addressing must receive an error reply");
      const r1 = JSON.parse(readFileSync(reply1, "utf8"));
      assert.equal(r1.ok, false);
      assert.match(r1.error, /Malformed request/);
      assert.equal(r1.requestId, badId);
      assert.equal(r1.from, sessionId, "reply from = responder session id");

      const reply2 = join(repliesDir(root, "session-other"), `${safeKey(badId2)}.json`);
      assert.ok(existsSync(reply2), "protocol-invalid request must receive an error reply");
      const r2 = JSON.parse(readFileSync(reply2, "utf8"));
      assert.equal(r2.ok, false);
      assert.match(r2.error, /Invalid request/);
      assert.equal(r2.requestId, badId2);

      assert.equal(existsSync(join(inbox, `${badId}.json`)), false, "malformed inbox file removed after rejection");
      assert.equal(existsSync(join(inbox, `${badId2}.json`)), false, "protocol-invalid inbox file removed after rejection");
      assert.equal(sentMessages.length, 0, "invalid requests are never delivered as peer_message");
    } finally {
      for (const handler of handlers.get("session_shutdown") ?? []) handler({ type: "session_shutdown", reason: "quit" }, ctx);
      rmSync(root, { recursive: true, force: true });
    }
  });

});
