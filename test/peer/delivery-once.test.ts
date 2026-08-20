import { describe, it } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { registerTalkTools } from "../../pi-extension/pi-peer/service.ts";
import { inboxDir, recordPath, newMessageId } from "../../pi-extension/pi-peer/protocol.ts";

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const waitUntil = async (fn: () => boolean, label: string, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await wait(10); }
  return false;
};

// Faithful model of Pi: steering queue drained ONLY after the assistant stream
// + all tool calls complete (packages/agent/src/agent-loop.ts:258), then
// message_start emitted for the drained message (agent-loop.ts:184).
class FakePi {
  steeringQueue: string[] = [];
  modelSaw: string[] = [];
  handlers = new Map<string, Array<(...a: any[]) => any>>();
  constructor(public ctx: any) {}
  fire(n: string, ev: any) { for (const h of this.handlers.get(n) ?? []) h(ev, this.ctx); }
  api(): any {
    return {
      registerTool() {},
      on: (n: string, h: any) => { this.handlers.set(n, [...(this.handlers.get(n) ?? []), h]); },
      sendUserMessage: (content: string, options?: any) => {
        if (options?.deliverAs === "steer") this.steeringQueue.push(content);
        else { this.modelSaw.push(content); this.fire("agent_start", { type: "agent_start" });
               this.fire("message_start", { type: "message_start", message: { role: "user", content: [{ type: "text", text: content }] } }); }
      },
    };
  }
  async runTurn(toolCallMs: number) {
    await wait(toolCallMs);
    const next = this.steeringQueue.shift();   // one-at-a-time drain
    if (next !== undefined) {
      this.modelSaw.push(next);
      this.fire("message_start", { type: "message_start", message: { role: "user", content: [{ type: "text", text: next }] } });
    }
  }
}

const setup = (pi: FakePi, root: string) => {
  registerTalkTools(pi.api(), {
    getCurrentPeer: async () => ({ paneId: "p", terminalId: "t", tabId: "tb", socketPath: "/tmp/s.sock", workspaceId: "w1" }),
    getPeerStatus: async () => "idle" as const,
    rootDir: () => root, deliveryAckTimeoutMs: 300,
  });
};
const drop = (root: string, sessionId: string, text: string) => {
  const inbox = inboxDir(root, sessionId);
  mkdirSync(inbox, { recursive: true });
  writeFileSync(join(inbox, `m-${randomUUID()}.json`), JSON.stringify({
    version: 1, type: "peer_message", id: newMessageId(), from: "s2", fromName: "bob",
    to: sessionId, message: text, createdAt: new Date().toISOString(),
  }));
};

describe("regression: duplicate delivery", () => {
  it("BUG#1 long tool call: steered message reaches the model exactly once", async () => {
    const root = join(tmpdir(), "r-" + randomUUID()); mkdirSync(root, { recursive: true });
    const sessionId = "s-steer";
    const ctx = { cwd: "/w", sessionManager: { getSessionId: () => sessionId, getSessionFile: () => join(root, "t.jsonl") } };
    const pi = new FakePi(ctx); setup(pi, root);
    try {
      pi.fire("session_start", { type: "session_start" });
      await waitUntil(() => existsSync(recordPath(root, sessionId)), "reg");
      pi.fire("agent_start", { type: "agent_start" });      // busy: long turn
      const turn = pi.runTurn(900);                          // 900ms >> 300ms deadline
      drop(root, sessionId, "deploy the branch");
      await waitUntil(() => pi.steeringQueue.length >= 1, "steered");
      const dup = await waitUntil(() => pi.steeringQueue.length >= 2, "duplicate?", 1200);
      assert.equal(dup, false, "must NOT queue a second copy while the host holds the first");
      await turn; await pi.runTurn(20);
      pi.fire("agent_settled", { type: "agent_settled" });
      assert.equal(pi.modelSaw.length, 1, `model saw it ${pi.modelSaw.length}x`);
    } finally { pi.fire("session_shutdown", { type: "session_shutdown" }); rmSync(root, { recursive: true, force: true }); }
  });

  it("BUG#1b steer queued right before settle is not duplicated", async () => {
    const root = join(tmpdir(), "r-" + randomUUID()); mkdirSync(root, { recursive: true });
    const sessionId = "s-race";
    const ctx = { cwd: "/w", sessionManager: { getSessionId: () => sessionId, getSessionFile: () => join(root, "t.jsonl") } };
    const pi = new FakePi(ctx); setup(pi, root);
    try {
      pi.fire("session_start", { type: "session_start" });
      await waitUntil(() => existsSync(recordPath(root, sessionId)), "reg");
      pi.fire("agent_start", { type: "agent_start" });
      drop(root, sessionId, "late message");
      await waitUntil(() => pi.steeringQueue.length === 1, "steered");
      // Host settles before draining its steering queue (abort / post-drain race).
      pi.fire("agent_settled", { type: "agent_settled" });
      await wait(500);
      assert.equal(pi.steeringQueue.length, 1, "host still holds exactly one copy");
      await pi.runTurn(10);   // next run drains it
      assert.equal(pi.modelSaw.length, 1, `model saw it ${pi.modelSaw.length}x`);
    } finally { pi.fire("session_shutdown", { type: "session_shutdown" }); rmSync(root, { recursive: true, force: true }); }
  });

  it("BUG#5 input handler rewrites the text: no infinite redelivery", async () => {
    const root = join(tmpdir(), "r-" + randomUUID()); mkdirSync(root, { recursive: true });
    const sessionId = "s-transform";
    const ctx = { cwd: "/w", sessionManager: { getSessionId: () => sessionId, getSessionFile: () => join(root, "t.jsonl") } };
    const pi = new FakePi(ctx);
    // Another extension transforms input, so message_start never matches what
    // pi-peer injected. Count EVERY injection, steered or not.
    const injections: string[] = [];
    const api = pi.api();
    api.sendUserMessage = (content: string, options?: any) => {
      injections.push(content);
      const rewritten = `[rewritten] ${content}`;
      if (options?.deliverAs === "steer") pi.steeringQueue.push(rewritten);
      else {
        pi.modelSaw.push(rewritten);
        pi.fire("agent_start", { type: "agent_start" });
        pi.fire("message_start", { type: "message_start", message: { role: "user", content: [{ type: "text", text: rewritten }] } });
      }
    };
    registerTalkTools(api, {
      getCurrentPeer: async () => ({ paneId: "p", terminalId: "t", tabId: "tb", socketPath: "/tmp/s.sock", workspaceId: "w1" }),
      getPeerStatus: async () => "idle" as const, rootDir: () => root, deliveryAckTimeoutMs: 300,
    });
    try {
      pi.fire("session_start", { type: "session_start" });
      await waitUntil(() => existsSync(recordPath(root, sessionId)), "reg");
      drop(root, sessionId, "hello");
      await waitUntil(() => injections.length >= 1, "delivered");
      await wait(1200);   // 4x the deadline: pre-fix this loops forever
      assert.equal(injections.length, 1, `injected ${injections.length}x despite the transform`);
    } finally { pi.fire("session_shutdown", { type: "session_shutdown" }); rmSync(root, { recursive: true, force: true }); }
  });

  it("BUG#6 agent_start after the turn-start deadline commits the claim exactly once", async () => {
    const root = join(tmpdir(), "r-" + randomUUID()); mkdirSync(root, { recursive: true });
    const sessionId = "s-late-start";
    const handlers = new Map<string, Array<(...a: any[]) => any>>();
    const sentMessages: string[] = [];
    const ctx = { cwd: "/w", sessionManager: { getSessionId: () => sessionId, getSessionFile: () => join(root, "t.jsonl") } };
    const fire = (n: string, ev: any) => { for (const h of handlers.get(n) ?? []) h(ev, ctx); };
    const api: any = {
      registerTool() {},
      on: (n: string, h: any) => { handlers.set(n, [...(handlers.get(n) ?? []), h]); },
      // No auto agent_start here (unlike FakePi): the host is slow to engage
      // the turn, which is exactly the gap this test drives through.
      sendUserMessage: (content: string) => { sentMessages.push(content); },
    };
    registerTalkTools(api, {
      getCurrentPeer: async () => ({ paneId: "p", terminalId: "t", tabId: "tb", socketPath: "/tmp/s.sock", workspaceId: "w1" }),
      getPeerStatus: async () => "idle" as const,
      rootDir: () => root, deliveryAckTimeoutMs: 5,
    });
    try {
      fire("session_start", { type: "session_start" });
      await waitUntil(() => existsSync(recordPath(root, sessionId)), "reg");
      drop(root, sessionId, "compaction delayed this turn");
      await waitUntil(() => sentMessages.length === 1, "claimed and injected");
      const inbox = inboxDir(root, sessionId);
      const name = readdirSync(inbox).find((f: string) => f.endsWith(".processing"));
      const processingPath = join(inbox, name!);
      assert.equal(existsSync(processingPath), true, "claim taken before the deadline");

      // Past the 5ms deadline: expireTurnStartLatch marks the claim expired but
      // leaves it pending (ADR 0013) rather than requeueing it.
      await wait(200);
      assert.equal(existsSync(processingPath), true, "expired claim is still pending, not requeued");
      assert.equal(existsSync(processingPath.replace(/\.processing$/, "")), false, "expired claim did not reappear as a queued .json");

      // agent_start finally arrives (the documented compaction case): the
      // expired claim must be adopted as this turn's trigger, not skipped.
      fire("agent_start", { type: "agent_start" });
      fire("agent_settled", { type: "agent_settled" });
      assert.equal(existsSync(processingPath), false, "claim committed exactly once, not leaked to disk");
      assert.equal(existsSync(processingPath.replace(/\.processing$/, "")), false, "no .json twin recreated by session_start requeue");
    } finally { fire("session_shutdown", { type: "session_shutdown" }); rmSync(root, { recursive: true, force: true }); }
  });

  it("an expired claim with no following agent_start still survives for session_start", async () => {
    const root = join(tmpdir(), "r-" + randomUUID()); mkdirSync(root, { recursive: true });
    const sessionId = "s-never-started";
    const handlers = new Map<string, Array<(...a: any[]) => any>>();
    const sentMessages: string[] = [];
    const ctx = { cwd: "/w", sessionManager: { getSessionId: () => sessionId, getSessionFile: () => join(root, "t.jsonl") } };
    const fire = (n: string, ev: any) => { for (const h of handlers.get(n) ?? []) h(ev, ctx); };
    const api: any = {
      registerTool() {},
      on: (n: string, h: any) => { handlers.set(n, [...(handlers.get(n) ?? []), h]); },
      sendUserMessage: (content: string) => { sentMessages.push(content); },
    };
    registerTalkTools(api, {
      getCurrentPeer: async () => ({ paneId: "p", terminalId: "t", tabId: "tb", socketPath: "/tmp/s.sock", workspaceId: "w1" }),
      getPeerStatus: async () => "idle" as const,
      rootDir: () => root, deliveryAckTimeoutMs: 5,
    });
    try {
      fire("session_start", { type: "session_start" });
      await waitUntil(() => existsSync(recordPath(root, sessionId)), "reg");
      drop(root, sessionId, "host never engages this one");
      await waitUntil(() => sentMessages.length === 1, "claimed and injected");
      const inbox = inboxDir(root, sessionId);
      const name = readdirSync(inbox).find((f: string) => f.endsWith(".processing"));
      const processingPath = join(inbox, name!);

      // No agent_start ever arrives — the host abandoned the turn entirely.
      await wait(200);
      fire("agent_settled", { type: "agent_settled" });
      assert.equal(existsSync(processingPath), true, "claim must survive for session_start recovery (ADR 0013)");
      assert.equal(sentMessages.length, 1, "no duplicate redelivery");
    } finally { fire("session_shutdown", { type: "session_shutdown" }); rmSync(root, { recursive: true, force: true }); }
  });
});
