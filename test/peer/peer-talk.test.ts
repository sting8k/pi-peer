import assert from "node:assert";
import { describe, it } from "node:test";
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Value } from "@sinclair/typebox/value";

import { TalkLatestParams, TalkSessionsParams, TalkToParams } from "../../pi-extension/pi-peer/schemas.ts";
import {
  inboxDir,
  isPeerMessage,
  isPeerRecord,
  newMessageId,
  nowIso,
  PEER_NAME_POOL,
  peerMessageTag,
  pickPeerName,
  publicPeerId,
  recordPath,
  removeOwnedRecord,
  requeueProcessing,
  resolveTarget,
  sessionDir,
  type PeerMessage,
  type PeerRecord,
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

describe("peer talk protocol", () => {
  it("validates the peer-message envelope and rejects empty identities", () => {
    const base: PeerMessage = {
      version: 1, type: "peer_message", id: "msg-1", from: "session-a",
      fromName: "alpha", to: "session-b", message: "Hello", createdAt: new Date().toISOString(),
    };
    assert.equal(isPeerMessage(base), true);
    assert.equal(isPeerMessage({ ...base, version: 2 }), false, "version mismatch rejected");
    assert.equal(isPeerMessage({ ...base, type: "request" }), false, "wrong type rejected");
    assert.equal(isPeerMessage({ ...base, id: "" }), false, "empty id rejected");
    assert.equal(isPeerMessage({ ...base, from: "" }), false, "empty from rejected");
    assert.equal(isPeerMessage({ ...base, to: "" }), false, "empty to rejected");
    assert.equal(isPeerMessage({ ...base, fromName: "" }), false, "empty display name rejected");
  });

  it("renders an inbound <peer_message> with name and public peer id only", () => {
    const tag = peerMessageTag({
      version: 1, type: "peer_message", id: "msg-internal-1",
      from: "session-alpha-123", fromName: "Mochi", to: "session-beta-456",
      message: "Review the auth refactor.", createdAt: nowIso(),
    });
    assert.match(tag, /<peer_message from="Mochi" peer_id="peer-123">/);
    assert.match(tag, /talk_to\("peer-123", "\.\.\."\)/, "reply instruction uses the public peer id");
    assert.match(tag, /Review the auth refactor\./);
    assert.doesNotMatch(tag, /session-alpha-123/, "full session id is never exposed");
    assert.doesNotMatch(tag, /msg-internal-1/, "internal message id is never exposed");
    assert.doesNotMatch(tag, /from_session/, "no from_session attribute");
    assert.doesNotMatch(tag, /request_id/, "no request correlation attribute");
    assert.doesNotMatch(tag, /amends/, "no amendment/steer attribute");
    assert.doesNotMatch(tag, /peer_pong/, "no peer_pong naming");
  });

  it("escapes attribute values in the rendered tag", () => {
    const tag = peerMessageTag({
      version: 1, type: "peer_message", id: "msg-2",
      from: "session-x", fromName: "api&review", to: "session-y",
      message: "hi", createdAt: nowIso(),
    });
    assert.match(tag, /from="api&amp;review"/);
  });

  it("prefixes message ids so filename sort follows enqueue time", () => {
    const originalNow = Date.now;
    let currentTime = 1_700_000_000_000;
    try {
      Date.now = () => currentTime;
      const first = newMessageId();
      currentTime = 2_500_000_000_000;
      const second = newMessageId();
      const firstTimestamp = first.split("_")[1];
      const secondTimestamp = second.split("_")[1];
      assert.match(first, /^msg_[0-9a-z]+_[0-9a-f-]{36}$/);
      assert.match(second, /^msg_[0-9a-z]+_[0-9a-f-]{36}$/);
      assert.equal(firstTimestamp.length, secondTimestamp.length, "timestamp prefixes retain a sortable width");
      assert.deepEqual([second, first].sort(), [first, second], "filename order keeps older messages first");
    } finally {
      Date.now = originalNow;
    }
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

  it("picks a deterministic name for the same session and taken set", () => {
    const taken = new Set<string>(["Milo", "Luna"]);
    const first = pickPeerName("session-friendly", taken);
    assert.equal(pickPeerName("session-friendly", taken), first);
  });

  it("uses the next name in rotation when the first name is taken", () => {
    const sessionId = "session-next";
    const first = pickPeerName(sessionId, new Set());
    const firstIndex = PEER_NAME_POOL.indexOf(first as (typeof PEER_NAME_POOL)[number]);
    const next = PEER_NAME_POOL[(firstIndex + 1) % PEER_NAME_POOL.length];
    assert.equal(pickPeerName(sessionId, new Set([first])), next);
  });

  it("wraps around the end of the name pool", () => {
    let sessionId = "session-wrap";
    while (PEER_NAME_POOL.indexOf(pickPeerName(sessionId, new Set()) as (typeof PEER_NAME_POOL)[number]) === 0) {
      sessionId += "-x";
    }
    const first = pickPeerName(sessionId, new Set());
    const startIndex = PEER_NAME_POOL.indexOf(first as (typeof PEER_NAME_POOL)[number]);
    const taken = new Set<string>(PEER_NAME_POOL.slice(startIndex));
    assert.ok(startIndex > 0);
    assert.equal(pickPeerName(sessionId, taken), PEER_NAME_POOL[0]);
  });

  it("adds a numeric suffix after all pool names are taken", () => {
    const sessionId = "session-suffix";
    const first = pickPeerName(sessionId, new Set());
    const startIndex = PEER_NAME_POOL.indexOf(first as (typeof PEER_NAME_POOL)[number]);
    assert.equal(
      pickPeerName(sessionId, new Set<string>(PEER_NAME_POOL)),
      `${PEER_NAME_POOL[startIndex]}-2`,
    );
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

  it("requeues claimed .processing messages on startup", () => {
    const root = createTestDir();
    try {
      const inbox = join(root, "inbox", "session-b");
      mkdirSync(inbox, { recursive: true });
      writeFileSync(join(inbox, "msg-1.json.processing"), "{}");
      requeueProcessing(root, "session-b");
      assert.ok(existsSync(join(inbox, "msg-1.json")));
      assert.equal(existsSync(join(inbox, "msg-1.json.processing")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("drops a pre-existing queued twin when requeueing a claim", () => {
    const root = createTestDir();
    try {
      const inbox = join(root, "inbox", "session-b");
      mkdirSync(inbox, { recursive: true });
      writeFileSync(join(inbox, "msg-1.json"), "{}");
      writeFileSync(join(inbox, "msg-1.json.processing"), "{}");
      requeueProcessing(root, "session-b");
      assert.ok(existsSync(join(inbox, "msg-1.json")));
      assert.equal(existsSync(join(inbox, "msg-1.json.processing")), false);
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

  it("talk_to schema accepts target+message and does not declare timeoutMs", () => {
    assert.equal(Value.Check(TalkToParams, { target: "peer-abc", message: "Hello" }), true, "target+message is valid");
    assert.equal(Value.Check(TalkToParams, { target: "peer-abc", message: "" }), false, "empty message is invalid");
    assert.equal(Value.Check(TalkToParams, { target: "", message: "Hello" }), false, "empty target is invalid");
    assert.equal(Value.Check(TalkToParams, { message: "Hello" }), false, "missing target is invalid");
    assert.equal(Value.Check(TalkToParams, { target: "peer-abc" }), false, "missing message is invalid");
    assert.equal("timeoutMs" in TalkToParams.properties, false, "timeoutMs is removed from the talk_to schema");
    assert.equal(Value.Check(TalkSessionsParams, {}), true, "talk_sessions takes no parameters");
    assert.equal(Value.Check(TalkLatestParams, { target: "peer-abc", count: 3 }), true, "talk_latest accepts target and count");
    assert.equal(Value.Check(TalkLatestParams, { target: "peer-abc", count: 11 }), false, "talk_latest count 11 is invalid");
  });
});