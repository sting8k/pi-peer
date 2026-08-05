import assert from "node:assert";
import { describe, it } from "node:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { registerTalkTools } from "../../pi-extension/pi-peer/service.ts";
import { createTestDir } from "../peer/helpers.ts";

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
        async sendMessage(message: any, options: any) {
          sentMessages.push(message);
          assert.equal(message.customType, "talk_request");
          assert.equal(options.triggerTurn, true);
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
      const resumedLatest = await sender.tools.get("talk_latest").execute(
        "latest-resumed", { target: "peer-eta" }, undefined, undefined, sender.ctx,
      );
      assert.match(resumedLatest.content[0].text, /Peer status: idle[\s\S]*Resumed latest$/);
      assert.equal(resumedLatest.details.peerStatus, "idle");
      assert.equal(resumedLatest.details.currentTurnInProgress, false);
      const listResult = await sender.tools.get("talk_sessions").execute("list-1", {}, undefined, undefined, sender.ctx);
      assert.match(listResult.content[0].text, /peer-/);
      assert.match(listResult.content[0].text, /peer-pha  alpha  idle  \(current\)/);
      assert.match(listResult.content[0].text, /peer-eta  beta  idle/);

      const senderRecordPath = join(root, "sessions", "session-alpha.json");
      rmSync(senderRecordPath, { force: true });
      assert.equal(existsSync(senderRecordPath), false, "simulate an older reload cleanup removing the current record");
      await new Promise((resolve) => setTimeout(resolve, 350));
      assert.ok(existsSync(senderRecordPath), "poll loop should restore the missing registration without a tool call");
      const healedList = await sender.tools.get("talk_sessions").execute("list-heal", {}, undefined, undefined, sender.ctx);
      assert.match(healedList.content[0].text, /alpha\s+idle\s+\(current\)/);

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
      assert.match(abortUpdates[0].content[0].text, /Queued for beta \(peer-eta\); target status: working/);
      receiverBusy = false;
      peerStatuses.set("pane-beta", "idle");
      await new Promise((resolve) => setTimeout(resolve, 350));
      assert.equal(receiver.sentMessages.length, 0, "aborted queued request must not reach the target later");
      receiverBusy = true;
      peerStatuses.set("pane-beta", "working");

      const progressUpdates: any[] = [];
      const pending = sender.tools.get("talk_to").execute(
        "talk-1",
        { target: "peer-eta", message: "Review Alpha's answer.", timeoutMs: 50 },
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
      assert.match(progressUpdates[1].content[0].text, /beta \(peer-eta\) accepted the request and is processing it/);

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
        async sendMessage() {},
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
        async sendMessage() {},
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
});
