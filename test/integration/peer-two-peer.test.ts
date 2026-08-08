import assert from "node:assert";
import { describe, it } from "node:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { registerTalkTools } from "../../pi-extension/pi-peer/service.ts";
import { inboxDir, recordPath, repliesDir, waitersDir } from "../../pi-extension/pi-peer/protocol.ts";
import { createTestDir } from "../peer/helpers.ts";

function waitUntil(predicate: () => boolean, message: string, timeoutMs = 3_000): Promise<void> {
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

describe("peer two-peer lifecycle", () => {
  it("delivers a blocking request and captures the peer agent_end response", async () => {
    const root = createTestDir();
    const peerStatuses = new Map<string, "idle" | "working" | "blocked" | "done" | "unknown">();
    const createPeer = (sessionId: string, cwd: string, paneId: string, reply?: string, busy: () => boolean = () => false) => {
      const tools = new Map<string, any>();
      const sentMessages: any[] = [];
      const handlers = new Map<string, Array<(...args: any[]) => any>>();
      const sessionFile = join(root, "transcripts", `${sessionId}.jsonl`);
      const ctx = { cwd, sessionManager: { getSessionId: () => sessionId, getSessionFile: () => sessionFile } };
      const api: any = {
        registerTool(tool: any) { tools.set(tool.name, tool); },
        on(name: string, handler: (...args: any[]) => any) {
          handlers.set(name, [...(handlers.get(name) ?? []), handler]);
        },
        async sendUserMessage(content: any) {
          sentMessages.push(content);
          assert.equal(typeof content, "string");
          if (reply) {
            setTimeout(() => {
              for (const handler of handlers.get("agent_end") ?? []) {
                handler({ messages: [{ role: "assistant", content: [{ type: "text", text: reply }] }] }, ctx);
              }
            }, 300);
          }
        },
      };
      registerTalkTools(api, {
        getCurrentPeer: async () => ({
          paneId,
          terminalId: `terminal-${paneId}`,
          tabId: `tab-${paneId}`,
          socketPath: "/tmp/herdr.sock",
          workspaceId: "workspace-1",
        }),
        getPeerStatus: async (peer) => peerStatuses.get(peer.paneId) ?? "idle",
        rootDir: () => root,
        isBusy: busy,
      });
      return { api, ctx, tools, handlers, sentMessages };
    };

    const sender = createPeer("session-alpha", "/work/alpha", "pane-alpha");
    let receiverBusy = true;
    const receiver = createPeer("session-beta", "/work/beta", "pane-beta", "Beta review", () => receiverBusy);
    try {
      mkdirSync(join(root, "transcripts"), { recursive: true });
      writeFileSync(receiver.ctx.sessionManager.getSessionFile(), [
        { type: "session", id: "root-beta" },
        {
          type: "message", id: "completed-beta", parentId: "root-beta",
          message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Resumed latest" }] },
        },
        {
          type: "message", id: "partial-beta", parentId: "completed-beta",
          message: { role: "assistant", stopReason: "aborted", content: [{ type: "text", text: "Partial" }] },
        },
      ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
      for (const peer of [sender, receiver]) {
        for (const handler of peer.handlers.get("session_start") ?? []) {
          handler({ type: "session_start", reason: "startup" }, peer.ctx);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      const senderName = JSON.parse(readFileSync(recordPath(root, "session-alpha"), "utf8")).name;
      const receiverName = JSON.parse(readFileSync(recordPath(root, "session-beta"), "utf8")).name;
      const resumedLatest = await sender.tools.get("talk_latest").execute(
        "latest-resumed", { target: "peer-eta" }, undefined, undefined, sender.ctx,
      );
      assert.match(resumedLatest.content[0].text, /Peer status: idle[\s\S]*Resumed latest$/);
      assert.equal(resumedLatest.details.peerStatus, "idle");
      assert.equal(resumedLatest.details.currentTurnInProgress, false);
      const listResult = await sender.tools.get("talk_sessions").execute("list-1", {}, undefined, undefined, sender.ctx);
      assert.match(listResult.content[0].text, /peer-/);
      assert.match(listResult.content[0].text, new RegExp(`peer-pha\\s+${senderName}\\s+idle\\s+\\(current\\)`));
      assert.match(listResult.content[0].text, new RegExp(`peer-eta\\s+${receiverName}\\s+idle`));

      // Queue depth: peer-eta has 1 queued + 1 in-flight (.json.processing); current session has none.
      const etaInbox = inboxDir(root, "session-beta");
      mkdirSync(etaInbox, { recursive: true });
      for (let i = 0; i < 2; i++) {
        writeFileSync(join(etaInbox, `req_q_${i}.json`), JSON.stringify({
          version: 1, type: "request", id: `req_q_${i}`, from: "session-alpha", to: "session-elsewhere",
          message: "q", route: ["session-alpha"], createdAt: new Date().toISOString(),
        }));
      }
      renameSync(join(etaInbox, "req_q_1.json"), join(etaInbox, "req_q_1.json.processing"));
      const queuedList = await sender.tools.get("talk_sessions").execute("list-queued", {}, undefined, undefined, sender.ctx);
      assert.match(queuedList.content[0].text, new RegExp(`peer-eta\\s+${receiverName}\\s+idle\\s+\\(2 queued\\)`));
      assert.match(queuedList.content[0].text, new RegExp(`peer-pha\\s+${senderName}\\s+idle\\s+\\(current\\)`));
      assert.doesNotMatch(queuedList.content[0].text, new RegExp(`peer-pha\\s+${senderName}\\s+idle\\s+\\(current\\)\\s+\\(\\d+ queued\\)`));

      const senderRecordPath = join(root, "sessions", "session-alpha.json");
      rmSync(senderRecordPath, { force: true });
      assert.equal(existsSync(senderRecordPath), false, "simulate an older reload cleanup removing the current record");
      await new Promise((resolve) => setTimeout(resolve, 350));
      assert.ok(existsSync(senderRecordPath), "poll loop should restore the missing registration without a tool call");
      const healedList = await sender.tools.get("talk_sessions").execute("list-heal", {}, undefined, undefined, sender.ctx);
      assert.match(healedList.content[0].text, new RegExp(`${senderName}\\s+idle\\s+\\(current\\)`));

      peerStatuses.set("pane-beta", "working");
      const abortController = new AbortController();
      const abortUpdates: any[] = [];
      const aborted = sender.tools.get("talk_to").execute(
        "talk-abort",
        { target: "peer-eta", message: "Do not deliver after abort.", timeoutMs: 50 },
        abortController.signal,
        (update: any) => abortUpdates.push(update),
        sender.ctx,
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      abortController.abort();
      await assert.rejects(aborted, /Aborted/);
      assert.deepEqual(abortUpdates.map((update) => update.details.state), ["queued"]);
      assert.match(abortUpdates[0].content[0].text, new RegExp(`Queued for ${receiverName} \\(peer-eta\\); target status: working`));
      receiverBusy = false;
      peerStatuses.set("pane-beta", "idle");
      await new Promise((resolve) => setTimeout(resolve, 350));
      assert.equal(receiver.sentMessages.length, 0, "aborted queued request must not reach the target later");
      receiverBusy = true;
      peerStatuses.set("pane-beta", "working");

      const progressUpdates: any[] = [];
      const pending = sender.tools.get("talk_to").execute(
        "talk-1",
        { target: "peer-eta", message: "Review Alpha's answer.", timeoutMs: 2_000 },
        undefined,
        (update: any) => progressUpdates.push(update),
        sender.ctx,
      );
      await new Promise((resolve) => setTimeout(resolve, 350));
      assert.equal(receiver.sentMessages.length, 0, "live busy peer should outlast the soft timeout and keep the request queued");
      assert.deepEqual(progressUpdates.map((update) => update.details.state), ["queued"]);
      receiverBusy = false;
      peerStatuses.set("pane-beta", "idle");
      const result = await pending;
      assert.equal(result.content[0].text, "Beta review");
      assert.equal(result.details.target, "peer-eta");
      assert.equal(result.details.state, "completed");
      assert.deepEqual(progressUpdates.map((update) => update.details.state), ["queued", "processing"]);
      assert.match(progressUpdates[1].content[0].text, new RegExp(`${receiverName} \\(peer-eta\\) accepted the request and is processing it`));

      // Entries are persisted before agent_end; append the turn then fire the event.
      writeFileSync(receiver.ctx.sessionManager.getSessionFile(), JSON.stringify({
        type: "message",
        id: "standalone-beta",
        parentId: "completed-beta",
        timestamp: new Date().toISOString(),
        message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Standalone latest" }] }
      }) + "\n", { flag: "a" });
      for (const handler of receiver.handlers.get("agent_end") ?? []) {
        handler({ messages: [{ role: "assistant", content: [{ type: "text", text: "Standalone latest" }] }] }, receiver.ctx);
      }
      peerStatuses.set("pane-beta", "working");
      const latest = await sender.tools.get("talk_latest").execute(
        "latest-1", { target: "peer-eta" }, undefined, undefined, sender.ctx,
      );
      assert.match(latest.content[0].text, /Peer status: working/);
      assert.match(latest.content[0].text, /Snapshot note: this excludes the peer's in-progress turn/);
      assert.match(latest.content[0].text, /Standalone latest$/);
      assert.equal(latest.details.target, "peer-eta");
      assert.equal(latest.details.peerStatus, "working");
      assert.equal(latest.details.currentTurnInProgress, true);
      assert.ok(latest.details.createdAt);
    } finally {
      for (const peer of [sender, receiver]) {
        for (const handler of peer.handlers.get("session_shutdown") ?? []) {
          handler({ type: "session_shutdown", reason: "quit" }, peer.ctx);
        }
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("validates count and returns the N most recent completed events oldest-first", async () => {
    const root = createTestDir();
    const peerStatuses = new Map<string, "idle" | "working" | "blocked" | "done" | "unknown">();
    const createPeer = (sessionId: string, paneId: string) => {
      const tools = new Map<string, any>();
      const handlers = new Map<string, Array<(...args: any[]) => any>>();
      const sessionFile = join(root, "transcripts", `${sessionId}.jsonl`);
      const ctx = { cwd: `/work/${paneId}`, sessionManager: { getSessionId: () => sessionId, getSessionFile: () => sessionFile } };
      const api: any = {
        registerTool(tool: any) { tools.set(tool.name, tool); },
        on(name: string, handler: (...args: any[]) => any) {
          handlers.set(name, [...(handlers.get(name) ?? []), handler]);
        },
        async sendUserMessage() {},
      };
      registerTalkTools(api, {
        getCurrentPeer: async () => ({
          paneId, terminalId: `terminal-${paneId}`, tabId: `tab-${paneId}`,
          socketPath: "/tmp/herdr.sock", workspaceId: "workspace-1",
        }),
        getPeerStatus: async (peer) => peerStatuses.get(peer.paneId) ?? "idle",
        rootDir: () => root,
        isBusy: () => false,
      });
      return { api, ctx, tools, handlers };
    };

    const sender = createPeer("session-alpha", "pane-alpha");
    const receiver = createPeer("session-beta", "pane-beta");
    try {
      mkdirSync(join(root, "transcripts"), { recursive: true });
      writeFileSync(receiver.ctx.sessionManager.getSessionFile(), [
        { type: "session", id: "root-beta" },
        { type: "message", id: "u1", parentId: "root-beta", timestamp: "2024-01-01T00:00:01.000Z", message: { role: "user", content: "First user" } },
        { type: "message", id: "a1", parentId: "u1", timestamp: "2024-01-01T00:00:02.000Z", message: { role: "assistant", stopReason: "stop", content: [{ type: "thinking", thinking: "Think 1" }, { type: "text", text: "Answer 1" }] } },
        { type: "message", id: "u2", parentId: "a1", timestamp: "2024-01-01T00:00:03.000Z", message: { role: "user", content: "Second user" } },
        { type: "message", id: "a2", parentId: "u2", timestamp: "2024-01-01T00:00:04.000Z", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "call_1", name: "read_file", arguments: { path: "/x" } }, { type: "text", text: "Answer 2" }] } },
      ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
      for (const peer of [sender, receiver]) {
        for (const handler of peer.handlers.get("session_start") ?? []) handler({ type: "session_start", reason: "startup" }, peer.ctx);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));

      const tool = sender.tools.get("talk_latest");
      await assert.rejects(tool.execute("c0", { target: "peer-eta", count: 0 }, undefined, undefined, sender.ctx), /count must be an integer between 1 and 10/);
      await assert.rejects(tool.execute("c11", { target: "peer-eta", count: 11 }, undefined, undefined, sender.ctx), /count must be an integer between 1 and 10/);
      await assert.rejects(tool.execute("cNaN", { target: "peer-eta", count: 1.5 }, undefined, undefined, sender.ctx), /count must be an integer between 1 and 10/);

      await assert.rejects(tool.execute("cRawId", { target: "session-beta" }, undefined, undefined, sender.ctx), /Peer session not found/, "raw full session id is rejected as a target");
      await assert.rejects(tool.execute("cRawPrefix", { target: "session-be" }, undefined, undefined, sender.ctx), /Peer session not found/, "session id prefix is rejected as a target");

      const one = await tool.execute("c1", { target: "peer-eta" }, undefined, undefined, sender.ctx);
      assert.equal(one.details.count, 1, "count omitted defaults to 1");
      assert.match(one.content[0].text, /Answer 2$/);

      const two = await tool.execute("c2", { target: "peer-eta", count: 2 }, undefined, undefined, sender.ctx);
      assert.equal(two.details.count, 2);
      assert.deepEqual(two.details.events.map((e: any) => e.type), ["toolCall", "assistant"]);
      assert.match(two.content[0].text, /\[toolCall\] read_file\(/);
      assert.match(two.content[0].text, /\[assistant\] Answer 2/);

      const all = await tool.execute("c10", { target: "peer-eta", count: 10 }, undefined, undefined, sender.ctx);
      assert.deepEqual(all.details.events.map((e: any) => e.type), ["user", "assistant", "user", "toolCall", "assistant"]);
    } finally {
      for (const peer of [sender, receiver]) {
        for (const handler of peer.handlers.get("session_shutdown") ?? []) handler({ type: "session_shutdown", reason: "quit" }, peer.ctx);
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("captures a real-shaped run and resumes without duplicates", async () => {
    const root = createTestDir();
    const peerStatuses = new Map<string, "idle" | "working" | "blocked" | "done" | "unknown">();
    const createPeer = (sessionId: string, paneId: string) => {
      const tools = new Map<string, any>();
      const handlers = new Map<string, Array<(...args: any[]) => any>>();
      const sessionFile = join(root, "transcripts", `${sessionId}.jsonl`);
      const ctx = { cwd: `/work/${paneId}`, sessionManager: { getSessionId: () => sessionId, getSessionFile: () => sessionFile } };
      const api: any = {
        registerTool(tool: any) { tools.set(tool.name, tool); },
        on(name: string, handler: (...args: any[]) => any) {
          handlers.set(name, [...(handlers.get(name) ?? []), handler]);
        },
        async sendUserMessage() {},
      };
      registerTalkTools(api, {
        getCurrentPeer: async () => ({
          paneId, terminalId: `terminal-${paneId}`, tabId: `tab-${paneId}`,
          socketPath: "/tmp/herdr.sock", workspaceId: "workspace-1",
        }),
        getPeerStatus: async (peer) => peerStatuses.get(peer.paneId) ?? "idle",
        rootDir: () => root,
        isBusy: () => false,
      });
      return { api, ctx, tools, handlers };
    };

    const sender = createPeer("session-alpha", "pane-alpha");
    const receiver = createPeer("session-beta", "pane-beta");
    try {
      mkdirSync(join(root, "transcripts"), { recursive: true });
      writeFileSync(receiver.ctx.sessionManager.getSessionFile(), [
        { type: "session", id: "root-beta" },
        { type: "message", id: "u1", parentId: "root-beta", timestamp: "2024-01-01T00:00:01.000Z", message: { role: "user", content: "List files" } },
        { type: "message", id: "a1", parentId: "u1", timestamp: "2024-01-01T00:00:02.000Z", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "thinking", thinking: "I'll use read_file." }, { type: "toolCall", id: "call_1", name: "read_file", arguments: { path: "/x" } }] } },
        { type: "message", id: "tr1", parentId: "a1", timestamp: "2024-01-01T00:00:03.000Z", message: { role: "toolResult", toolCallId: "call_1", toolName: "read_file", content: [{ type: "text", text: "file contents" }] } },
        { type: "message", id: "a2", parentId: "tr1", timestamp: "2024-01-01T00:00:04.000Z", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Here is the file." }] } },
      ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
      for (const peer of [sender, receiver]) {
        for (const handler of peer.handlers.get("session_start") ?? []) handler({ type: "session_start", reason: "startup" }, peer.ctx);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));

      const tool = sender.tools.get("talk_latest");
      const all = await tool.execute("c10", { target: "peer-eta", count: 10 }, undefined, undefined, sender.ctx);
      assert.deepEqual(all.details.events.map((e: any) => e.type), ["user", "toolCall", "toolResult", "assistant"]);
      assert.doesNotMatch(all.content[0].text, /thinking/);
      assert.match(all.content[0].text, /\[toolCall\] read_file\(/);
      assert.match(all.content[0].text, /\[toolResult\] file contents/);

      // agent_end persists a new turn to the file first, then rebuilds; no duplicates
      writeFileSync(receiver.ctx.sessionManager.getSessionFile(), JSON.stringify({
        type: "message", id: "u3", parentId: "a2", timestamp: "2024-01-01T00:00:05.000Z",
        message: { role: "user", content: "Thanks" },
      }) + "\n", { flag: "a" });
      writeFileSync(receiver.ctx.sessionManager.getSessionFile(), JSON.stringify({
        type: "message", id: "a3", parentId: "u3", timestamp: "2024-01-01T00:00:06.000Z",
        message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Anytime" }] },
      }) + "\n", { flag: "a" });
      for (const handler of receiver.handlers.get("agent_end") ?? []) handler({ messages: [{ role: "assistant", content: [{ type: "text", text: "Anytime" }] }] }, receiver.ctx);
      await new Promise((resolve) => setTimeout(resolve, 20));

      const afterEnd = await tool.execute("c10", { target: "peer-eta", count: 10 }, undefined, undefined, sender.ctx);
      assert.deepEqual(afterEnd.details.events.map((e: any) => e.type), ["user", "toolCall", "toolResult", "assistant", "user", "assistant"]);
      assert.equal(afterEnd.details.events.length, 6, "no duplicates after agent_end");

      // resume (session_start) also rebuilds without duplicates
      for (const handler of receiver.handlers.get("session_start") ?? []) handler({ type: "session_start", reason: "resume" }, receiver.ctx);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const resumed = await tool.execute("c10", { target: "peer-eta", count: 10 }, undefined, undefined, sender.ctx);
      assert.equal(resumed.details.events.length, 6, "no duplicates after resume");
      assert.deepEqual(resumed.details.events.map((e: any) => e.type), ["user", "toolCall", "toolResult", "assistant", "user", "assistant"]);
    } finally {
      for (const peer of [sender, receiver]) {
        for (const handler of peer.handlers.get("session_shutdown") ?? []) handler({ type: "session_shutdown", reason: "quit" }, peer.ctx);
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns a direct result when the peer replies in-deadline and never wakes the sender", async () => {
    const root = createTestDir();
    const peerStatuses = new Map<string, "idle" | "working" | "blocked" | "done" | "unknown">();
    const createPeer = (sessionId: string, cwd: string, paneId: string, reply?: string, busy: () => boolean = () => false) => {
      const tools = new Map<string, any>();
      const sentMessages: any[] = [];
      const handlers = new Map<string, Array<(...args: any[]) => any>>();
      const sessionFile = join(root, "transcripts", `${sessionId}.jsonl`);
      const ctx = { cwd, sessionManager: { getSessionId: () => sessionId, getSessionFile: () => sessionFile } };
      const api: any = {
        registerTool(tool: any) { tools.set(tool.name, tool); },
        on(name: string, handler: (...args: any[]) => any) {
          handlers.set(name, [...(handlers.get(name) ?? []), handler]);
        },
        async sendUserMessage(content: any) {
          sentMessages.push(content);
          assert.equal(typeof content, "string");
          if (content.startsWith("<peer_message") && reply) {
            setTimeout(() => {
              for (const handler of handlers.get("agent_end") ?? []) {
                handler({ messages: [{ role: "assistant", content: [{ type: "text", text: reply }] }] }, ctx);
              }
            }, 300);
          }
        },
      };
      registerTalkTools(api, {
        getCurrentPeer: async () => ({
          paneId, terminalId: `terminal-${paneId}`, tabId: `tab-${paneId}`,
          socketPath: "/tmp/herdr.sock", workspaceId: "workspace-1",
        }),
        getPeerStatus: async (peer) => peerStatuses.get(peer.paneId) ?? "idle",
        rootDir: () => root,
        isBusy: busy,
      });
      return { api, ctx, tools, handlers, sentMessages };
    };

    const sender = createPeer("session-alpha", "/work/alpha", "pane-alpha");
    const receiver = createPeer("session-beta", "/work/beta", "pane-beta", "Fast reply");
    try {
      for (const peer of [sender, receiver]) {
        for (const handler of peer.handlers.get("session_start") ?? []) handler({ type: "session_start", reason: "startup" }, peer.ctx);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));

      const result = await sender.tools.get("talk_to").execute(
        "talk-fast", { target: "peer-eta", message: "Fast?", timeoutMs: 2_000 },
        undefined, undefined, sender.ctx,
      );
      assert.equal(result.details.state, "completed");
      assert.equal(result.content[0].text, "Fast reply");
      assert.ok(result.details.requestId, "completed result carries the request id");
      const requestId: string = result.details.requestId;
      // In-deadline reply: waiter + reply files are consumed, no wake pong.
      await new Promise((resolve) => setTimeout(resolve, 600));
      const pongs = sender.sentMessages.filter((m: string) => m.startsWith("<peer_pong"));
      assert.equal(pongs.length, 0, "no wake pong after a direct completed reply");
      const replyFile = join(repliesDir(root, "session-alpha"), `${requestId}.json`);
      assert.equal(existsSync(replyFile), false, "reply consumed by the direct wait");
      const waiterFile = join(waitersDir(root, "session-alpha"), `${requestId}.json`);
      assert.equal(existsSync(waiterFile), false, "waiter consumed by the direct wait");
    } finally {
      for (const peer of [sender, receiver]) {
        for (const handler of peer.handlers.get("session_shutdown") ?? []) handler({ type: "session_shutdown", reason: "quit" }, peer.ctx);
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("timeout returns pending non-error and later wakes the sender with one <peer_pong>", async () => {
    const root = createTestDir();
    const peerStatuses = new Map<string, "idle" | "working" | "blocked" | "done" | "unknown">();
    const createPeer = (sessionId: string, cwd: string, paneId: string, busy: () => boolean = () => false) => {
      const tools = new Map<string, any>();
      const sentMessages: any[] = [];
      const handlers = new Map<string, Array<(...args: any[]) => any>>();
      const sessionFile = join(root, "transcripts", `${sessionId}.jsonl`);
      const ctx = { cwd, sessionManager: { getSessionId: () => sessionId, getSessionFile: () => sessionFile } };
      const api: any = {
        registerTool(tool: any) { tools.set(tool.name, tool); },
        on(name: string, handler: (...args: any[]) => any) {
          handlers.set(name, [...(handlers.get(name) ?? []), handler]);
        },
        async sendUserMessage(content: any) {
          sentMessages.push(content);
          assert.equal(typeof content, "string");
        },
      };
      registerTalkTools(api, {
        getCurrentPeer: async () => ({
          paneId, terminalId: `terminal-${paneId}`, tabId: `tab-${paneId}`,
          socketPath: "/tmp/herdr.sock", workspaceId: "workspace-1",
        }),
        getPeerStatus: async (peer) => peerStatuses.get(peer.paneId) ?? "idle",
        rootDir: () => root,
        isBusy: busy,
      });
      return { api, ctx, tools, handlers, sentMessages };
    };

    const sender = createPeer("session-alpha", "/work/alpha", "pane-alpha");
    const receiver = createPeer("session-beta", "/work/beta", "pane-beta", () => true);
    try {
      for (const peer of [sender, receiver]) {
        for (const handler of peer.handlers.get("session_start") ?? []) handler({ type: "session_start", reason: "startup" }, peer.ctx);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));

      peerStatuses.set("pane-beta", "working");
      const result = await sender.tools.get("talk_to").execute(
        "talk-slow", { target: "peer-eta", message: "Long task?", timeoutMs: 50 },
        undefined, undefined, sender.ctx,
      );
      // timeoutMs 50 clamps to the 1 s minimum; that exact deadline passes with
      // the target alive -> pending, non-error.
      assert.equal(result.details.state, "pending");
      assert.match(result.content[0].text, /do not resend/i);
      assert.match(result.content[0].text, /still processing/i);
      assert.equal(sender.sentMessages.length, 0, "sender itself sent no messages (pending is not a send)");

      const waiterFile = join(waitersDir(root, "session-alpha"), `${result.details.requestId}.json`);
      assert.ok(existsSync(waiterFile), "waiter remains after pending timeout");

      // Receiver finishes later: agent_end writes the reply into caller's replies dir.
      const replyDir = repliesDir(root, "session-alpha");
      mkdirSync(replyDir, { recursive: true });
      writeFileSync(join(replyDir, `${result.details.requestId}.json`), JSON.stringify({
        version: 1, type: "response", requestId: result.details.requestId,
        from: "session-beta", to: "session-alpha", ok: true, message: "Slow success", createdAt: new Date().toISOString(),
      }));

      // Sender poll wakes once with a <peer_pong> containing the reply text.
      await waitUntil(() => sender.sentMessages.some((m: string) => m.startsWith("<peer_pong")), "sender wake pong");
      const pongs = sender.sentMessages.filter((m: string) => m.startsWith("<peer_pong"));
      assert.equal(pongs.length, 1, "exactly one wake pong");
      assert.match(pongs[0], /request_id="[^"]+"/);
      assert.match(pongs[0], /from_session="session-beta"/);
      assert.match(pongs[0], /ok="true"/);
      assert.match(pongs[0], /Slow success/);
      assert.equal(existsSync(waiterFile), false, "waiter cleaned after successful wake");
      assert.equal(existsSync(join(replyDir, `${result.details.requestId}.json`)), false, "reply cleaned after successful wake");
    } finally {
      for (const peer of [sender, receiver]) {
        for (const handler of peer.handlers.get("session_shutdown") ?? []) handler({ type: "session_shutdown", reason: "quit" }, peer.ctx);
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("abort removes waiter + queued request and never wakes later", async () => {
    const root = createTestDir();
    const peerStatuses = new Map<string, "idle" | "working" | "blocked" | "done" | "unknown">();
    const createPeer = (sessionId: string, paneId: string) => {
      const tools = new Map<string, any>();
      const sentMessages: any[] = [];
      const handlers = new Map<string, Array<(...args: any[]) => any>>();
      const sessionFile = join(root, "transcripts", `${sessionId}.jsonl`);
      const ctx = { cwd: `/work/${paneId}`, sessionManager: { getSessionId: () => sessionId, getSessionFile: () => sessionFile } };
      const api: any = {
        registerTool(tool: any) { tools.set(tool.name, tool); },
        on(name: string, handler: (...args: any[]) => any) {
          handlers.set(name, [...(handlers.get(name) ?? []), handler]);
        },
        async sendUserMessage(content: any) {
          sentMessages.push(content);
          assert.equal(typeof content, "string");
        },
      };
      registerTalkTools(api, {
        getCurrentPeer: async () => ({
          paneId, terminalId: `terminal-${paneId}`, tabId: `tab-${paneId}`,
          socketPath: "/tmp/herdr.sock", workspaceId: "workspace-1",
        }),
        getPeerStatus: async (peer) => peerStatuses.get(peer.paneId) ?? "idle",
        rootDir: () => root,
        isBusy: () => false,
      });
      return { api, ctx, tools, handlers, sentMessages };
    };

    const sender = createPeer("session-alpha", "pane-alpha");
    const receiver = createPeer("session-beta", "pane-beta");
    try {
      for (const peer of [sender, receiver]) {
        for (const handler of peer.handlers.get("session_start") ?? []) handler({ type: "session_start", reason: "startup" }, peer.ctx);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));

      peerStatuses.set("pane-beta", "working");
      const abortController = new AbortController();
      const aborted = sender.tools.get("talk_to").execute(
        "talk-abort", { target: "peer-eta", message: "Cancel me.", timeoutMs: 50 },
        abortController.signal, undefined, sender.ctx,
      );
      // Capture the request id from the inbox BEFORE abort, since abort removes
      // the file (and the waiter) and we need it to assert cleanup + no wake.
      const inbox = join(root, "inbox", "session-beta");
      await waitUntil(() => existsSync(inbox) && readdirSync(inbox).some((f: string) => f.endsWith(".json")), "queued request to appear");
      const reqId = readdirSync(inbox).find((f: string) => f.endsWith(".json"))!.replace(/\.json$/, "");
      await new Promise((resolve) => setTimeout(resolve, 10));
      abortController.abort();
      await assert.rejects(aborted, /Aborted/);

      const waiterDir = waitersDir(root, "session-alpha");
      await waitUntil(() => !existsSync(join(waiterDir, `${reqId}.json`)), "waiter removed on abort");
      assert.equal(existsSync(join(inbox, `${reqId}.json`)), false, "queued request removed on abort");
      assert.equal(existsSync(join(waiterDir, `${reqId}.json`)), false, "waiter removed on abort");

      // Receiver later finishes; write a stray reply for the aborted id.
      const replyDir = repliesDir(root, "session-alpha");
      mkdirSync(replyDir, { recursive: true });
      writeFileSync(join(replyDir, `${reqId}.json`), JSON.stringify({
        version: 1, type: "response", requestId: reqId,
        from: "session-beta", to: "session-alpha", ok: true, message: "Late reply", createdAt: new Date().toISOString(),
      }));
      await new Promise((resolve) => setTimeout(resolve, 600));
      const pongs = sender.sentMessages.filter((m: string) => m.startsWith("<peer_pong"));
      assert.equal(pongs.length, 0, "no wake for an aborted request");
    } finally {
      for (const peer of [sender, receiver]) {
        for (const handler of peer.handlers.get("session_shutdown") ?? []) handler({ type: "session_shutdown", reason: "quit" }, peer.ctx);
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("session_shutdown answers an in-flight request with an error reply and drops the .processing claim", async () => {
    const root = createTestDir();
    const peerStatuses = new Map<string, "idle" | "working" | "blocked" | "done" | "unknown">();
    const createPeer = (sessionId: string, cwd: string, paneId: string) => {
      const tools = new Map<string, any>();
      const sentMessages: any[] = [];
      const handlers = new Map<string, Array<(...args: any[]) => any>>();
      const sessionFile = join(root, "transcripts", `${sessionId}.jsonl`);
      const ctx = { cwd, sessionManager: { getSessionId: () => sessionId, getSessionFile: () => sessionFile } };
      const api: any = {
        registerTool(tool: any) { tools.set(tool.name, tool); },
        on(name: string, handler: (...args: any[]) => any) {
          handlers.set(name, [...(handlers.get(name) ?? []), handler]);
        },
        async sendUserMessage(content: any) {
          sentMessages.push(content);
          assert.equal(typeof content, "string");
        },
      };
      registerTalkTools(api, {
        getCurrentPeer: async () => ({
          paneId,
          terminalId: `terminal-${paneId}`,
          tabId: `tab-${paneId}`,
          socketPath: "/tmp/herdr.sock",
          workspaceId: "workspace-1",
        }),
        getPeerStatus: async (peer) => peerStatuses.get(peer.paneId) ?? "idle",
        rootDir: () => root,
        isBusy: () => false,
        hardDeadlineMs: 2000,
      });
      return { api, ctx, tools, handlers, sentMessages };
    };

    const sender = createPeer("session-alpha", "/work/alpha", "pane-alpha");
    const receiver = createPeer("session-beta", "/work/beta", "pane-beta");
    try {
      for (const peer of [sender, receiver]) {
        for (const handler of peer.handlers.get("session_start") ?? []) handler({ type: "session_start", reason: "startup" }, peer.ctx);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));

      const pending = sender.tools.get("talk_to").execute(
        "talk-shutdown", { target: "peer-eta", message: "Answer before I leave.", timeoutMs: 3_000 },
        undefined, undefined, sender.ctx,
      );
      // Receiver is idle, so its poll tick claims the request (.processing).
      const inbox = inboxDir(root, "session-beta");
      await waitUntil(() => existsSync(inbox) && readdirSync(inbox).some((f: string) => f.endsWith(".processing")), "request claimed by receiver");
      const reqId = readdirSync(inbox).find((f: string) => f.endsWith(".processing"))!.replace(/\.json\.processing$/, "");
      assert.ok(existsSync(join(inbox, `${reqId}.json.processing`)), "request is processing");

      // Receiver shuts down mid-request: it must answer with a terminal error
      // reply and release the .processing claim instead of abandoning the caller.
      for (const handler of receiver.handlers.get("session_shutdown") ?? []) handler({ type: "session_shutdown", reason: "quit" }, receiver.ctx);

      const replyDir = repliesDir(root, "session-alpha");
      await waitUntil(() => existsSync(join(replyDir, `${reqId}.json`)), "error reply written for in-flight request");
      const reply = JSON.parse(readFileSync(join(replyDir, `${reqId}.json`), "utf8"));
      assert.equal(reply.ok, false);
      assert.match(reply.error, /shut down before finishing/);
      assert.equal(existsSync(join(inbox, `${reqId}.json.processing`)), false, ".processing claim released on shutdown");
      await assert.rejects(pending, /shut down before finishing/);
    } finally {
      for (const peer of [sender, receiver]) {
        for (const handler of peer.handlers.get("session_shutdown") ?? []) handler({ type: "session_shutdown", reason: "quit" }, peer.ctx);
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});
