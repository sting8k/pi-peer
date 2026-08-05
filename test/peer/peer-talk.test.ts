import assert from "node:assert";
import { describe, it } from "node:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  extractAssistantText,
  isTalkRequest,
  isTalkResponse,
  isPeerRecord,
  publicPeerId,
  recordPath,
  removeOwnedRecord,
  requestMessage,
  requeueProcessing,
  resolveTarget,
  routeForRequest,
  type PeerRecord,
  type TalkRequest,
} from "../../pi-extension/pi-peer/protocol.ts";
import {
  entriesToTalkEvents,
  extractEventsFromMessage,
  getCurrentLineageEntries,
  isLatestPeerHistory,
  isTalkEvent,
  publishHistory,
  publishHistoryFromOwnSession,
  readHistory,
} from "../../pi-extension/pi-peer/history.ts";
import { createTestDir } from "./helpers.ts";

describe("peer session talk", () => {
  it("validates versioned envelopes and extracts final assistant text", () => {
    assert.equal(isTalkRequest({
      version: 1,
      type: "request",
      id: "req-1",
      from: "session-a",
      to: "session-b",
      message: "Review this.",
      route: ["session-a"],
      createdAt: new Date().toISOString(),
    }), true);
    assert.equal(isTalkRequest({ version: 2, type: "request" }), false);
    assert.equal(isTalkResponse({
      version: 1,
      type: "response",
      requestId: "req-1",
      from: "session-b",
      to: "session-a",
      ok: true,
      message: "Peer reply",
      createdAt: new Date().toISOString(),
    }), true);
    assert.equal(extractAssistantText([
      { role: "assistant", stopReason: "aborted", content: [{ type: "text", text: "Partial" }] },
      { role: "assistant", content: [{ type: "text", text: "Peer reply" }] },
    ]), "Peer reply");
    const prompt = requestMessage({
      version: 1, type: "request", id: "req-1", from: "session-a", to: "session-b",
      message: "Review", route: ["session-a"], createdAt: "now",
    }, "api&review");
    assert.match(prompt, /from="api&amp;review"/);
  });

  it("rejects envelopes with empty identities", () => {
    const baseRequest = {
      version: 1, type: "request", id: "req-1", from: "session-a", to: "session-b",
      message: "Review this.", route: ["session-a"], createdAt: new Date().toISOString(),
    };
    assert.equal(isTalkRequest(baseRequest), true);
    assert.equal(isTalkRequest({ ...baseRequest, id: "" }), false, "empty request id rejected");
    assert.equal(isTalkRequest({ ...baseRequest, from: "" }), false, "empty from rejected");
    assert.equal(isTalkRequest({ ...baseRequest, to: "" }), false, "empty to rejected");
    assert.equal(isTalkRequest({ ...baseRequest, route: ["session-a", ""] }), false, "empty route member rejected");
    assert.equal(isTalkRequest({ ...baseRequest, route: [""] }), false, "fully empty route rejected");

    const baseResponse = {
      version: 1, type: "response", requestId: "req-1", from: "session-b", to: "session-a",
      ok: true, message: "Peer reply", createdAt: new Date().toISOString(),
    };
    assert.equal(isTalkResponse(baseResponse), true);
    assert.equal(isTalkResponse({ ...baseResponse, requestId: "" }), false, "empty requestId rejected");
    assert.equal(isTalkResponse({ ...baseResponse, from: "" }), false, "empty from rejected");
    assert.equal(isTalkResponse({ ...baseResponse, to: "" }), false, "empty to rejected");
  });

  it("derives public peer ids and defines behavior for short ids", () => {
    assert.equal(publicPeerId("session-alpha"), "peer-pha");
    assert.equal(publicPeerId("session-beta"), "peer-eta");
    assert.equal(publicPeerId("019f-1111-2222-3333-44444444abcd"), "peer-bcd");
    // ids shorter than 3 chars use the whole id as the suffix
    assert.equal(publicPeerId("ab"), "peer-ab");
    assert.equal(publicPeerId("a"), "peer-a");
    // empty input fails closed rather than producing an invalid `peer-`
    assert.throws(() => publicPeerId(""), /non-empty session id/);
  });

  it("rejects records with an empty session id", () => {
    assert.equal(isPeerRecord({
      schemaVersion: 1, sessionId: "", name: "alpha", cwd: "/work/alpha",
      workspaceId: "workspace-1", paneId: "pane-alpha", terminalId: "terminal-alpha", createdAt: "now",
    }), false, "empty session id is not a valid record");
  });

  it("resolves public peer ids and unique display names while rejecting raw ids and prefixes", () => {
    const records: PeerRecord[] = [
      { sessionId: "alpha-111", name: "api", cwd: "/api", workspaceId: "ws", paneId: "p1", terminalId: "t1", schemaVersion: 1, createdAt: "now" },
      { sessionId: "beta-222", name: "web", cwd: "/web", workspaceId: "ws", paneId: "p2", terminalId: "t2", schemaVersion: 1, createdAt: "now" },
      { sessionId: "beta-333", name: "web", cwd: "/web-2", workspaceId: "ws", paneId: "p3", terminalId: "t3", schemaVersion: 1, createdAt: "now" },
    ];
    assert.equal(resolveTarget(records, "peer-111").sessionId, "alpha-111", "public peer id resolves");
    assert.equal(resolveTarget(records, "peer-333").sessionId, "beta-333");
    assert.equal(resolveTarget(records, "api").sessionId, "alpha-111", "unique display name resolves");
    assert.throws(() => resolveTarget(records, "alpha-111"), /not found/, "raw full session id is not a target");
    assert.throws(() => resolveTarget(records, "beta-222"), /not found/, "raw full session id is not a target");
    assert.throws(() => resolveTarget(records, "alpha"), /not found/, "session id prefix is not a target");
    assert.throws(() => resolveTarget(records, "beta"), /not found/, "session id prefix is not a target");
    assert.throws(() => resolveTarget(records, "web"), /ambiguous/, "duplicate display name is ambiguous");
  });

  it("fails closed when two live records share the same public peer id", () => {
    const records: PeerRecord[] = [
      { sessionId: "alpha-aaa-111", name: "a", cwd: "/a", workspaceId: "ws", paneId: "p1", terminalId: "t1", schemaVersion: 1, createdAt: "now" },
      { sessionId: "beta-bbb-111", name: "b", cwd: "/b", workspaceId: "ws", paneId: "p2", terminalId: "t2", schemaVersion: 1, createdAt: "now" },
    ];
    assert.equal(publicPeerId(records[0].sessionId), publicPeerId(records[1].sessionId));
    assert.throws(() => resolveTarget(records, "peer-111"), /ambiguous/, "colliding public ids fail closed");
    assert.equal(resolveTarget(records, "a").sessionId, "alpha-aaa-111", "unique display name still resolves");
    assert.equal(resolveTarget(records, "b").sessionId, "beta-bbb-111");
    assert.throws(() => resolveTarget(records, "alpha-aaa-111"), /not found/, "raw full session id is not a target");
    assert.throws(() => resolveTarget(records, "beta-bbb-111"), /not found/, "raw full session id is not a target");
  });

  it("keeps full session ids as internal identity in routes, artifacts, and envelopes", () => {
    const runtime = {
      record: { sessionId: "session-b" },
      activeRequest: { route: ["session-a"] },
    } as unknown as { record: PeerRecord; activeRequest: TalkRequest | null };
    assert.deepEqual(routeForRequest(runtime), ["session-a", "session-b"], "routes use full session ids");
    assert.equal(recordPath("/root", "session-a"), join("/root", "sessions", "session-a.json"), "artifact paths use full session ids");
    const prompt = requestMessage({
      version: 1, type: "request", id: "req-1", from: "session-a", to: "session-b",
      message: "Review", route: ["session-a"], createdAt: "now",
    }, "alpha");
    assert.match(prompt, /from_session="session-a"/, "envelope correlation keeps the full session id");
    assert.match(prompt, /from="alpha"/, "display name remains the public-facing sender label");
    assert.match(prompt, /peer_id="peer-n-a"/, "public peer id attribute is derived centrally");
  });

  it("propagates route ancestry and requeues claimed requests on startup", () => {
    const root = createTestDir();
    try {
      const runtime = {
        record: { sessionId: "session-b" },
        activeRequest: { route: ["session-a"] },
      } as unknown as { record: PeerRecord; activeRequest: TalkRequest | null };
      assert.deepEqual(routeForRequest(runtime), ["session-a", "session-b"]);
      const inbox = join(root, "inbox", "session-b");
      mkdirSync(inbox, { recursive: true });
      writeFileSync(join(inbox, "req-1.json.processing"), "{}");
      requeueProcessing(root, "session-b");
      assert.ok(existsSync(join(inbox, "req-1.json")));
      assert.equal(existsSync(join(inbox, "req-1.json.processing")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not let an older runtime remove a newer registration", () => {
    const root = createTestDir();
    const base: PeerRecord = {
      schemaVersion: 1, sessionId: "session-a", name: "alpha", cwd: "/work/alpha",
      workspaceId: "workspace-1", paneId: "pane-alpha", terminalId: "terminal-alpha", createdAt: "now",
    };
    const oldRecord = { ...base, registrationId: "registration-old" };
    const newRecord = { ...base, registrationId: "registration-new" };
    const path = join(root, "sessions", "session-a.json");
    try {
      mkdirSync(join(root, "sessions"), { recursive: true });
      writeFileSync(path, JSON.stringify(newRecord));
      removeOwnedRecord(root, oldRecord);
      assert.ok(existsSync(path), "old runtime cleanup must preserve the newer registration");
      removeOwnedRecord(root, newRecord);
      assert.equal(existsSync(path), false, "owning runtime cleanup should remove its registration");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("extracts text/toolCall/toolResult from real Pi shapes, skips thinking, and excludes aborted/streaming content", () => {
    const events = extractEventsFromMessage({
      role: "assistant",
      id: "msg-1",
      timestamp: 1738440000000,
      stopReason: "toolUse",
      content: [
        { type: "thinking", thinking: "Should not be published." },
        { type: "text", text: "Here is my answer." },
        { type: "toolCall", id: "call_1", name: "read_file", arguments: { path: "/a" } },
      ],
    }, { requireStopReason: true });
    assert.deepEqual(events.map((e) => e.type), ["assistant", "toolCall"], "thinking blocks are skipped");
    assert.equal(events[0].message, "Here is my answer.");
    assert.match(events[1].message, /read_file\(/);
    assert.match(events[1].message, /"path":"\/a"/);
    assert.equal(new Set(events.map((e) => e.id)).size, 2, "each published block gets a unique event id");
    // numeric Unix-ms message timestamps normalize to ISO
    assert.equal(events[0].createdAt, new Date(1738440000000).toISOString());

    // a message with only thinking blocks publishes nothing and consumes no capacity
    assert.deepEqual(
      extractEventsFromMessage({ role: "assistant", id: "msg-0", stopReason: "stop", content: [{ type: "thinking", thinking: "hidden" }] }, { requireStopReason: true }),
      [],
      "thinking-only content yields no events",
    );

    const userFromString = extractEventsFromMessage({ role: "user", content: "Hello" }, { requireStopReason: true });
    assert.deepEqual(userFromString.map((e) => e.type), ["user"]);
    assert.equal(userFromString[0].message, "Hello");

    const toolResult = extractEventsFromMessage({ role: "toolResult", content: [{ type: "text", text: "ok" }], timestamp: 1738440000001 }, { requireStopReason: true });
    assert.deepEqual(toolResult.map((e) => e.type), ["toolResult"]);
    assert.equal(toolResult[0].createdAt, new Date(1738440000001).toISOString());

    assert.deepEqual(
      extractEventsFromMessage({ role: "assistant", stopReason: "aborted", content: [{ type: "text", text: "Partial" }] }, { requireStopReason: true }),
      [],
      "aborted assistant messages are excluded",
    );
    assert.deepEqual(
      extractEventsFromMessage({ role: "assistant", content: [{ type: "text", text: "Streaming" }] }, { requireStopReason: true }),
      [],
      "streaming assistant messages (no terminal stopReason) are excluded from durable backfill",
    );
  });

  it("excludes infrastructure entries and streaming entries from durable backfill", () => {
    const entries: any[] = [
      { type: "session", id: "root" },
      { type: "branch_summary", id: "summary" },
      { type: "message", id: "u1", parentId: "root", timestamp: "2024-01-01T00:00:01.000Z", message: { role: "user", content: "A question" } },
      { type: "message", id: "a1", parentId: "u1", timestamp: "2024-01-01T00:00:02.000Z", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "An answer" }] } },
      { type: "message", id: "a2", parentId: "a1", timestamp: "2024-01-01T00:00:03.000Z", message: { role: "assistant", content: [{ type: "text", text: "Still streaming" }] } },
    ];
    const events = entriesToTalkEvents(entries);
    assert.deepEqual(events.map((e) => e.type), ["user", "assistant"]);
    assert.deepEqual(events.map((e) => e.message), ["A question", "An answer"]);
    assert.equal(events[0].createdAt, "2024-01-01T00:00:01.000Z", "durable entry timestamps are preserved");
  });

  it("publishes a bounded oldest-first history and replaces fully on rebuild", () => {
    const root = createTestDir();
    try {
      const runtime = { record: { sessionId: "session-a" }, root } as any;
      const mk = (type: any, i: number) => ({ type, id: `m${i}#0`, createdAt: `t${String(i).padStart(2, "0")}`, message: `event-${i}` });
      const events = Array.from({ length: 12 }, (_, i) => mk("assistant", i));
      publishHistory(runtime, events);
      const history = readHistory(root, "session-a");
      assert.equal(history.events.length, 10, "history must be bounded to 10");
      assert.equal(history.events[0].message, "event-2");
      assert.equal(history.events[9].message, "event-11");
      assert.equal(history.events[0].createdAt < history.events[9].createdAt, true, "stored oldest-first");
      // a rebuild replaces fully, retaining no stale events
      publishHistory(runtime, [mk("assistant", 100), mk("assistant", 101)]);
      assert.deepEqual(readHistory(root, "session-a").events.map((e) => e.message), ["event-100", "event-101"]);
      // an empty rebuild clears stale history
      publishHistory(runtime, []);
      assert.deepEqual(readHistory(root, "session-a").events, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("current lineage rebuild selects the newest id-bearing branch and excludes obsolete branches", () => {
    const entries: any[] = [
      { type: "session", id: "root" },
      { type: "message", id: "u1", parentId: "root", timestamp: "2024-01-01T00:00:01.000Z", message: { role: "user", content: "First question" } },
      { type: "message", id: "a1", parentId: "u1", timestamp: "2024-01-01T00:00:02.000Z", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "First answer" }] } },
      // obsolete branch: superseded messages that must never be published
      { type: "message", id: "u2", parentId: "a1", timestamp: "2024-01-01T00:00:03.000Z", message: { role: "user", content: "Stale question" } },
      { type: "message", id: "a2", parentId: "u2", timestamp: "2024-01-01T00:00:04.000Z", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Stale answer" }] } },
      // newest branch from a1
      { type: "message", id: "u3", parentId: "a1", timestamp: "2024-01-01T00:00:05.000Z", message: { role: "user", content: "Follow-up" } },
      { type: "message", id: "a3", parentId: "u3", timestamp: "2024-01-01T00:00:06.000Z", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Follow-up answer" }] } },
      // trailing infra entry without a usable id: ignored for lineage selection
      { type: "branch_close" },
    ];
    const lineage = getCurrentLineageEntries(entries);
    assert.deepEqual(lineage.map((e) => e.id), ["root", "u1", "a1", "u3", "a3"], "trailing non-id entry is ignored; newest id-bearing branch wins");
    assert.equal(lineage.some((e) => e.id === "u2" || e.id === "a2"), false, "obsolete branch excluded from lineage");

    // The published latest/ artifact (the talk_latest source) must also be
    // current-branch-only: rebuild from the real session file on disk.
    const root = createTestDir();
    try {
      const sessionId = "session-branch";
      const sessionFile = join(root, "transcripts", `${sessionId}.jsonl`);
      mkdirSync(join(root, "transcripts"), { recursive: true });
      writeFileSync(sessionFile, entries.map((e) => JSON.stringify(e)).join("\n"));
      publishHistoryFromOwnSession(
        { record: { sessionId }, root } as any,
        { sessionManager: { getSessionFile: () => sessionFile } },
      );
      const published = readHistory(root, sessionId).events;
      assert.deepEqual(
        published.map((e) => e.message),
        ["First question", "First answer", "Follow-up", "Follow-up answer"],
        "published history is current branch only",
      );
      assert.equal(
        published.some((e) => e.message === "Stale question" || e.message === "Stale answer"),
        false,
        "stale branch text never reaches the latest/ artifact",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("current lineage rebuild fails closed: no id-bearing entry publishes nothing", () => {
    const entries: any[] = [
      { type: "message", message: { role: "user", content: "No id" } },
      { type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "No id answer" }] } },
    ];
    assert.deepEqual(getCurrentLineageEntries(entries), [], "no linkable entry -> empty lineage, never all entries");

    const root = createTestDir();
    try {
      const runtime = { record: { sessionId: "session-a" }, root } as any;
      // stale history from a previous rebuild must be replaced, not retained
      publishHistory(runtime, [{ type: "assistant", id: "m1#0", createdAt: "t", message: "stale from another branch" }]);
      assert.equal(readHistory(root, "session-a").events.length, 1);
      const sessionFile = join(root, "transcripts", "session-a.jsonl");
      mkdirSync(join(root, "transcripts"), { recursive: true });
      writeFileSync(sessionFile, entries.map((e) => JSON.stringify(e)).join("\n"));
      publishHistoryFromOwnSession(runtime, { sessionManager: { getSessionFile: () => sessionFile } });
      assert.deepEqual(readHistory(root, "session-a").events, [], "empty lineage replaces stale history");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("current lineage rebuild keeps the existing happy path when the final entry is id-bearing", () => {
    const entries: any[] = [
      { type: "session", id: "root" },
      { type: "message", id: "u1", parentId: "root", timestamp: "t1", message: { role: "user", content: "Hi" } },
      { type: "message", id: "a1", parentId: "u1", timestamp: "t2", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Hello" }] } },
    ];
    const lineage = getCurrentLineageEntries(entries);
    assert.deepEqual(lineage.map((e) => e.id), ["root", "u1", "a1"], "leaf id at end keeps the full current lineage");
    assert.deepEqual(entriesToTalkEvents(lineage).map((e) => e.message), ["Hi", "Hello"]);
  });

  it("rejects stale v1 artifacts with thinking so no stale thinking appears before the next rebuild", () => {
    const root = createTestDir();
    try {
      const runtime = { record: { sessionId: "session-a" }, root } as any;
      const staleEvent = { type: "thinking", id: "m#0", createdAt: "t", message: "hidden" };
      // a stale version-1 artifact containing a thinking event is rejected on validation
      assert.equal(isTalkEvent(staleEvent), false, "thinking is no longer a valid published event type");
      assert.equal(
        isLatestPeerHistory({ version: 1, type: "latest", sessionId: "session-a", events: [staleEvent], updatedAt: "t" }),
        false,
        "version-1 artifacts are rejected",
      );
      // write the stale artifact to disk and confirm readHistory yields an empty history (no stale thinking)
      mkdirSync(join(root, "latest"), { recursive: true });
      writeFileSync(join(root, "latest", "session-a.json"), JSON.stringify({ version: 1, type: "latest", sessionId: "session-a", events: [staleEvent], updatedAt: "t" }));
      assert.deepEqual(readHistory(root, "session-a").events, [], "stale thinking must not surface before the publisher rebuilds");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

});
