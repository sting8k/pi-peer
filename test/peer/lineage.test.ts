import assert from "node:assert";
import { describe, it } from "node:test";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { canSee, pickPeerName, recordPath, type PeerRecord } from "../../pi-extension/pi-peer/protocol.ts";
import { registerTalkTools } from "../../pi-extension/pi-peer/service.ts";
import { createTestDir } from "./helpers.ts";

const noopPaneLabelDeps = {
  renamePane: async () => {},
  clearPaneLabel: async () => {},
  renameTab: async () => {},
  probePaneCount: async () => undefined as number | undefined,
  probeWorkspaceName: async () => undefined as string | undefined,
};

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

/** A bound peer in its own room root, seeing `roots` for cross-room lookup. */
async function startPeer(root: string, roots: string[], sessionId: string, cwd: string) {
  const tools = new Map<string, any>();
  const received: string[] = [];
  const handlers = new Map<string, Array<(...args: any[]) => any>>();
  const ctx = { cwd, sessionManager: { getSessionId: () => sessionId, getSessionFile: () => join(root, `${sessionId}.jsonl`) } };
  const api: any = {
    registerTool(tool: any) { tools.set(tool.name, tool); },
    on(name: string, handler: (...args: any[]) => any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    async sendUserMessage(content: any) { received.push(String(content)); },
  };
  registerTalkTools(api, { ...noopPaneLabelDeps,
    getCurrentPeer: async () => ({ paneId: `pane-${sessionId}`, terminalId: `t-${sessionId}`, tabId: "tab", socketPath: "/tmp/herdr.sock", workspaceId: root }),
    getPeerStatus: async () => "idle",
    rootDir: () => root,
    talkRoots: () => roots,
  });
  for (const handler of handlers.get("session_start") ?? []) handler({ type: "session_start", reason: "startup" }, ctx);
  await settle();
  return {
    received,
    sessions: async () => (await tools.get("talk_sessions").execute("s", {}, undefined, undefined, ctx)).content[0].text as string,
    talkTo: (target: string, message: string) => tools.get("talk_to").execute("t", { target, message }, undefined, undefined, ctx),
    stop: () => { for (const handler of handlers.get("session_shutdown") ?? []) handler({ type: "session_shutdown", reason: "quit" }, ctx); },
  };
}

function seedRecord(root: string, sessionId: string, name: string, cwd: string, ageMs = 0) {
  const record: PeerRecord = { schemaVersion: 1, sessionId, name, cwd, workspaceId: "w", paneId: "p", terminalId: "t", createdAt: new Date().toISOString() };
  const path = recordPath(root, sessionId);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(record));
  if (ageMs) {
    const old = (Date.now() - ageMs) / 1000;
    utimesSync(path, old, old);
  }
}

describe("lineage visibility (canSee)", () => {
  const home = "/home/u";
  const at = (root: string, cwd: string) => ({ root, cwd });

  it("same room always sees; parent and child see each other at any depth", () => {
    assert.equal(canSee(at("r1", "/a"), at("r1", "/b"), home), true);
    assert.equal(canSee(at("r1", "/home/u/proj"), at("r2", "/home/u/proj/a"), home), true);
    assert.equal(canSee(at("r2", "/home/u/proj/a"), at("r1", "/home/u/proj"), home), true);
    assert.equal(canSee(at("r3", "/home/u/proj/a/b/c"), at("r1", "/home/u/proj"), home), true, "grandchild sees ancestor");
  });

  it("siblings and prefix-lookalikes do not see each other", () => {
    assert.equal(canSee(at("r1", "/home/u/proj/a"), at("r2", "/home/u/proj/b"), home), false);
    assert.equal(canSee(at("r1", "/home/u/proj"), at("r2", "/home/u/project"), home), false);
  });

  it("$HOME and its ancestors never count as a parent", () => {
    assert.equal(canSee(at("r1", "/home/u"), at("r2", "/home/u/proj"), home), false);
    assert.equal(canSee(at("r2", "/home/u/proj"), at("r1", "/home/u/"), home), false);
    assert.equal(canSee(at("r1", "/"), at("r2", "/home/u/proj"), home), false);
    assert.equal(canSee(at("r1", "/home"), at("r2", "/home/u/proj"), home), false);
  });

  it("compares realpaths when they resolve", () => {
    const dir = createTestDir();
    try {
      mkdirSync(join(dir, "proj", "a"), { recursive: true });
      assert.equal(canSee(at("r1", join(dir, "proj") + "/"), at("r2", join(dir, "proj", "a")), "/nonexistent-home"), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("lineage visibility (tools)", () => {
  it("parent and child in different rooms list and message each other; siblings do not", async () => {
    const dir = createTestDir();
    const [rootP, rootA, rootB] = ["room-p", "room-a", "room-b"].map((name) => join(dir, name));
    const roots = [rootP, rootA, rootB];
    const parent = await startPeer(rootP, roots, "session-parent-ppp", "/work/proj");
    const childA = await startPeer(rootA, roots, "session-child-aaa", "/work/proj/a");
    const childB = await startPeer(rootB, roots, "session-child-bbb", "/work/proj/b");
    try {
      const fromParent = await parent.sessions();
      assert.match(fromParent, /peer-aaa/);
      assert.match(fromParent, /peer-bbb/);
      const fromA = await childA.sessions();
      assert.match(fromA, /peer-ppp/);
      assert.doesNotMatch(fromA, /peer-bbb/, "sibling is not visible");

      await assert.rejects(childA.talkTo("peer-bbb", "hi sibling"), /not found.*sibling/);
      await childA.talkTo("peer-ppp", "hi parent");
      // The parent only polls the inbox in its own room, so delivery proves the
      // message was written to the receiver's root, not the sender's.
      const started = Date.now();
      while (!parent.received.some((m) => m.includes("hi parent")) && Date.now() - started < 2_000) await settle();
      assert.match(parent.received.join("\n"), /hi parent/, "delivered via the receiver's room inbox");
    } finally {
      for (const peer of [parent, childA, childB]) peer.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("names avoid live peers in any room and reuse names of dead records", async () => {
    const dir = createTestDir();
    const [rootMe, rootOther] = [join(dir, "me"), join(dir, "other")];
    const sessionId = "session-naming-xyz";
    const preferred = pickPeerName(sessionId, new Set());
    let me: Awaited<ReturnType<typeof startPeer>> | undefined;
    try {
      seedRecord(rootOther, "session-live-elsewhere", preferred, "/unrelated");
      me = await startPeer(rootMe, [rootMe, rootOther], sessionId, "/work/me");
      assert.doesNotMatch(await me.sessions(), new RegExp(`peer-xyz  ${preferred} `), "live name in another room is not reused");
      me.stop();

      rmSync(rootMe, { recursive: true, force: true });
      seedRecord(rootOther, "session-live-elsewhere", preferred, "/unrelated", 120_000);
      me = await startPeer(rootMe, [rootMe, rootOther], sessionId, "/work/me");
      assert.match(await me.sessions(), new RegExp(`peer-xyz  ${preferred} `), "dead record's name is reused");
    } finally {
      me?.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
