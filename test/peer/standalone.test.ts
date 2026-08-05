import assert from "node:assert";
import { describe, it } from "node:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import piPeerExtension from "../../pi-extension/pi-peer/index.ts";
import { getTalkRootDir } from "../../pi-extension/pi-peer/herdr.ts";
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

  it("standalone self-tracks busy: agent_start blocks delivery until agent_end", async () => {
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
      async sendMessage(message: any, options: any) {
        sentMessages.push({ message, options });
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

      // agent_end clears the busy flag; the interval may now drain.
      for (const handler of handlers.get("agent_end") ?? []) handler({ messages: [{ role: "assistant", content: [{ type: "text", text: "Done" }] }] }, ctx);
      await new Promise((resolve) => setTimeout(resolve, 350));

      assert.equal(sentMessages.length, 1, "request delivered after agent_end clears busy");
      assert.equal(sentMessages[0].message.customType, "talk_request");
      assert.match(sentMessages[0].message.content, /Deliver only after agent_end/);
      assert.equal(existsSync(join(inbox, "req-busy.json")), false, "request claimed after delivery");
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
      async sendMessage() {},
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
});
