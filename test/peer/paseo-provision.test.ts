import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { getCurrentHerdrPeerContextAsync, HerdrUnavailableError } from "../../pi-extension/pi-peer/herdr.ts";
import {
  paseoAgentDirName,
  provisionPaseoHerdrContextAsync,
  resetPaseoSweepFlagForTests,
  sweepOrphanedPaseoRooms,
} from "../../pi-extension/pi-peer/paseo.ts";
import { readJson } from "../../pi-extension/pi-peer/storage.ts";
import { restoreEnvVar } from "./helpers.ts";

const envSnapshot = new Map<string, string | undefined>(
  ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_SOCKET_PATH", "HERDR_WORKSPACE_ID", "PASEO_AGENT_ID", "PASEO_AGENT_CWD", "PASEO_HOME", "PI_CODING_AGENT_DIR"]
    .map((name) => [name, process.env[name]]),
);
after(() => {
  for (const [name, value] of envSnapshot) restoreEnvVar(name, value);
});

// Hermetic agent dir: every test-path default (paseo-map.json, talk roots,
// room freshness checks) resolves under this temp dir — the real agent
// config dir is never read or written by this suite.
const agentDir = mkdtempSync(join(tmpdir(), "pi-peer-agent-dir-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => {
  rmSync(agentDir, { recursive: true, force: true });
});

function clearHerdrEnv(): void {
  for (const name of envSnapshot.keys()) {
    // PI_CODING_AGENT_DIR keeps the hermetic agent dir for path defaults.
    if (name !== "PI_CODING_AGENT_DIR") delete process.env[name];
  }
}

function rootPane(workspaceId: string, paneId: string) {
  return { pane_id: paneId, terminal_id: `term-${paneId}`, tab_id: `${paneId.split(":")[0]}:t1`, workspace_id: workspaceId };
}

/**
 * Fake herdr CLI: workspace `wExisting`/rooms listed in `liveWs` alive, `wDead`
 * gone; create/tab-create return deterministic root panes. Records every call.
 */
function fakeHerdr(liveWs: string[], createdCounter: { n: number }) {
  const calls: Array<{ args: string[] }> = [];
  const run = async (args: string[]) => {
    calls.push({ args });
    const [cmd, sub, operand] = args;
    if (cmd === "workspace" && sub === "get") {
      if (!liveWs.includes(operand!)) throw new Error("workspace not found");
      return JSON.stringify({ result: { workspace: { workspace_id: operand } } });
    }
    if (cmd === "workspace" && sub === "create") {
      const wsId = `wNew${++createdCounter.n}`;
      liveWs.push(wsId); // a created room is alive
      return JSON.stringify({ result: { root_pane: rootPane(wsId, `${wsId}:p1`) } });
    }
    if (cmd === "tab" && sub === "create") {
      const wsId = args[args.indexOf("--workspace") + 1];
      return JSON.stringify({ result: { root_pane: rootPane(wsId, `${wsId}:p9`) } });
    }
    if (cmd === "pane" && sub === "run") return JSON.stringify({ result: { type: "ok" } });
    if (cmd === "tab" && sub === "get") {
      return JSON.stringify({ result: { tab: { pane_count: 2 } } });
    }
    if (cmd === "workspace" && sub === "report-metadata") return JSON.stringify({ result: { type: "ok" } });
    throw new Error(`unexpected herdr invocation: ${args.join(" ")}`);
  };
  return { run, calls, createdCounter };
}

/** Fake paseo `ls` (sweep) + agent state home (provenance read). */
function fakePaseo(agents: Array<{ id: string; cwd: string; status?: string }> = []) {
  const runPaseo = async (args: string[]) => {
    if (args[0] === "ls") {
      return JSON.stringify(agents.map((a) => ({ id: a.id, cwd: a.cwd, status: a.status ?? "idle" })));
    }
    throw new Error(`unexpected paseo invocation: ${args.join(" ")}`);
  };
  return { runPaseo };
}

function writeAgentState(paseoHome: string, agentCwd: string, agentId: string, workspaceId: string) {
  const dir = join(paseoHome, "agents", paseoAgentDirName(agentCwd));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${agentId}.json`), JSON.stringify({ id: agentId, cwd: agentCwd, workspaceId }));
}

function provisionSetup() {
  const home = mkdtempSync(join(tmpdir(), "pi-peer-paseo-home-"));
  const mapPath = join(mkdtempSync(join(tmpdir(), "pi-peer-paseo-map-")), "paseo-map.json");
  const herdr = fakeHerdr(["wExisting"], { n: 0 });
  return {
    home,
    mapPath,
    herdr,
    cleanup: () => {
      rmSync(home, { recursive: true, force: true });
      rmSync(join(mapPath, ".."), { recursive: true, force: true });
    },
  };
}

describe("paseo provisioning (directory rooms)", () => {
  it("creates a room keyed by cwd, labeled with the folder name, and adopts the env", async () => {
    const s = provisionSetup();
    try {
      clearHerdrEnv();
      process.env.PASEO_AGENT_ID = "agent-1";
      process.env.PASEO_AGENT_CWD = "/work/checkout";
      process.env.PASEO_HOME = s.home;
      writeAgentState(s.home, "/work/checkout", "agent-1", "wks_provenance");
      const paseo = fakePaseo();

      const ctx = await provisionPaseoHerdrContextAsync(undefined, {
        run: s.herdr.run as any,
        runPaseo: paseo.runPaseo,
        mapPath: s.mapPath,
        scheduleSweep: () => {},
      });

      assert.equal(ctx.workspaceId, "wNew1");
      assert.equal(ctx.roomId, "wNew1", "provisioned agents: room is the workspace");
      assert.equal(ctx.paneId, "wNew1:p1");
      assert.equal(ctx.paneCount, 2);
      assert.equal(readJson(s.mapPath)?.["/work/checkout"], "wNew1", "map keyed by canonical dir");
      assert.equal(process.env.HERDR_ENV, "1");
      assert.equal(process.env.HERDR_PANE_ID, "wNew1:p1");
      assert.equal(process.env.HERDR_WORKSPACE_ID, "wNew1");
      const create = s.herdr.calls.find((c) => c.args[1] === "create" && c.args[0] === "workspace");
      assert.ok(create!.args.includes("checkout"), "room labeled with the folder name");
      const meta = s.herdr.calls.find((c) => c.args[1] === "report-metadata");
      assert.ok(meta!.args.some((a) => String(a).startsWith("paseo_workspace_id=wks_provenance")), "provenance tag from the state file");
      const liveView = s.herdr.calls.find((c) => c.args[1] === "run");
      assert.deepEqual(liveView!.args.slice(2), ["wNew1:p1", "paseo attach agent-1"], "pane shows the agent session (live view)");
    } finally {
      s.cleanup();
    }
  });

  it("two paseo agents in the same dir share one room (same folder = same room)", async () => {
    const s = provisionSetup();
    try {
      clearHerdrEnv();
      process.env.PASEO_HOME = s.home;
      process.env.PASEO_AGENT_CWD = "/work/checkout";
      const paseo = fakePaseo();
      const deps = { run: s.herdr.run as any, runPaseo: paseo.runPaseo, mapPath: s.mapPath, scheduleSweep: () => {} };

      process.env.PASEO_AGENT_ID = "agent-1";
      writeAgentState(s.home, "/work/checkout", "agent-1", "wks_A");
      const ctxA = await provisionPaseoHerdrContextAsync(undefined, deps);

      process.env.PASEO_AGENT_ID = "agent-2";
      writeAgentState(s.home, "/work/checkout", "agent-2", "wks_B");
      const ctxB = await provisionPaseoHerdrContextAsync(undefined, deps);

      assert.equal(ctxA.workspaceId, ctxB.workspaceId, "same dir reuses the room regardless of paseo workspace");
      assert.equal(ctxB.paneId, ctxB.workspaceId + ":p9", "second agent gets its own tab in the shared room");
      assert.equal(s.herdr.createdCounter.n, 1, "exactly one room workspace");
      const liveViewB = s.herdr.calls.filter((c) => c.args[1] === "run").at(-1);
      assert.deepEqual(liveViewB!.args.slice(2), [ctxB.paneId, "paseo attach agent-2"], "each agent's session shows in its own pane");
    } finally {
      s.cleanup();
    }
  });

  it("different dirs get different rooms", async () => {
    const s = provisionSetup();
    try {
      clearHerdrEnv();
      process.env.PASEO_HOME = s.home;
      const paseo = fakePaseo();
      const deps = { run: s.herdr.run as any, runPaseo: paseo.runPaseo, mapPath: s.mapPath, scheduleSweep: () => {} };

      process.env.PASEO_AGENT_ID = "agent-1";
      process.env.PASEO_AGENT_CWD = "/work/alpha";
      writeAgentState(s.home, "/work/alpha", "agent-1", "wks_A");
      const ctxA = await provisionPaseoHerdrContextAsync(undefined, deps);

      process.env.PASEO_AGENT_CWD = "/work/beta";
      writeAgentState(s.home, "/work/beta", "agent-1", "wks_B");
      const ctxB = await provisionPaseoHerdrContextAsync(undefined, deps);

      assert.notEqual(ctxA.workspaceId, ctxB.workspaceId);
    } finally {
      s.cleanup();
    }
  });

  it("trailing slashes canonicalize to the same room key", async () => {
    const s = provisionSetup();
    try {
      clearHerdrEnv();
      process.env.PASEO_HOME = s.home;
      const paseo = fakePaseo();
      const deps = { run: s.herdr.run as any, runPaseo: paseo.runPaseo, mapPath: s.mapPath, scheduleSweep: () => {} };

      process.env.PASEO_AGENT_ID = "agent-1";
      process.env.PASEO_AGENT_CWD = "/work/checkout";
      writeAgentState(s.home, "/work/checkout", "agent-1", "wks_A");
      const ctxA = await provisionPaseoHerdrContextAsync(undefined, deps);

      process.env.PASEO_AGENT_CWD = "/work/checkout/";
      const ctxB = await provisionPaseoHerdrContextAsync(undefined, deps);

      assert.equal(ctxA.workspaceId, ctxB.workspaceId);
      assert.equal(s.herdr.createdCounter.n, 1);
    } finally {
      s.cleanup();
    }
  });

  it("recreates the room when the mapped workspace is dead", async () => {
    const s = provisionSetup();
    try {
      clearHerdrEnv();
      process.env.PASEO_AGENT_ID = "agent-1";
      process.env.PASEO_AGENT_CWD = "/work/checkout";
      process.env.PASEO_HOME = s.home;
      writeAgentState(s.home, "/work/checkout", "agent-1", "wks_A");
      writeFileSync(s.mapPath, JSON.stringify({ "/work/checkout": "wDead" }));
      const paseo = fakePaseo();

      const ctx = await provisionPaseoHerdrContextAsync(undefined, {
        run: s.herdr.run as any,
        runPaseo: paseo.runPaseo,
        mapPath: s.mapPath,
        scheduleSweep: () => {},
      });

      assert.equal(ctx.workspaceId, "wNew1", "dead mapping replaced by a fresh room");
      assert.equal(readJson(s.mapPath)?.["/work/checkout"], "wNew1", "map healed");
    } finally {
      s.cleanup();
    }
  });

  it("fails closed (HerdrUnavailableError) when the herdr CLI is unreachable", async () => {
    const s = provisionSetup();
    try {
      clearHerdrEnv();
      process.env.PASEO_AGENT_ID = "agent-1";
      process.env.PASEO_AGENT_CWD = "/work/checkout";
      const failing = async () => { throw new Error("socket dead"); };

      await assert.rejects(
        provisionPaseoHerdrContextAsync(undefined, { run: failing, mapPath: s.mapPath, scheduleSweep: () => {} }),
        HerdrUnavailableError,
        "any provisioning failure degrades to peer-talk disabled",
      );
    } finally {
      s.cleanup();
    }
  });

  it("derives the paseo agent dir exactly like the daemon on windows-style cwds", async () => {
    const s = provisionSetup();
    try {
      clearHerdrEnv();
      process.env.PASEO_AGENT_ID = "agent-win";
      process.env.PASEO_AGENT_CWD = "C:\\Users\\bean\\proj";
      process.env.PASEO_HOME = s.home;
      writeAgentState(s.home, "C:\\Users\\bean\\proj", "agent-win", "wks_WIN");
      const paseo = fakePaseo();

      const ctx = await provisionPaseoHerdrContextAsync(undefined, {
        run: s.herdr.run as any,
        runPaseo: paseo.runPaseo,
        mapPath: s.mapPath,
        scheduleSweep: () => {},
      });

      assert.equal(ctx.workspaceId, "wNew1", "drive-letter cwd resolves (state slug C-Users-bean-proj)");
    } finally {
      s.cleanup();
    }
  });

  it("schedules the sweep once per process across repeated provisions", async () => {
    resetPaseoSweepFlagForTests();
    const s = provisionSetup();
    try {
      clearHerdrEnv();
      process.env.PASEO_AGENT_ID = "agent-1";
      process.env.PASEO_AGENT_CWD = "/work/checkout";
      process.env.PASEO_HOME = s.home;
      writeAgentState(s.home, "/work/checkout", "agent-1", "wks_A");
      const paseo = fakePaseo();
      const scheduled: Array<() => Promise<void>> = [];
      const deps = {
        run: s.herdr.run as any,
        runPaseo: paseo.runPaseo,
        mapPath: s.mapPath,
        scheduleSweep: (sweep: () => Promise<void>) => { scheduled.push(sweep); },
      };

      await provisionPaseoHerdrContextAsync(undefined, deps);
      await provisionPaseoHerdrContextAsync(undefined, deps);

      assert.equal(scheduled.length, 1, "exactly one sweep per process");
      await scheduled[0]();
    } finally {
      s.cleanup();
    }
  });
});

describe("paseo orphan sweep (directory rooms)", () => {
  function sweepHerdr(liveWs: string[], closes: string[], opts: { listFail?: boolean; closeFail?: boolean } = {}) {
    const calls: string[][] = [];
    const run = async (args: string[]) => {
      calls.push(args);
      const [cmd, sub, operand] = args;
      if (cmd === "workspace" && sub === "list") {
        if (opts.listFail) throw new Error("socket hiccup");
        return JSON.stringify({ result: { type: "workspace_list", workspaces: liveWs.map((id) => ({ workspace_id: id })) } });
      }
      if (cmd === "workspace" && sub === "close") {
        if (opts.closeFail) throw new Error("herdr busy");
        closes.push(operand!);
        return JSON.stringify({ result: { type: "ok" } });
      }
      throw new Error(`unexpected herdr invocation: ${args.join(" ")}`);
    };
    return { run, calls };
  }

  function sweepPaseo(agents: Array<{ id: string; cwd: string; status?: string }>, opts: { fail?: boolean; malformed?: boolean } = {}) {
    const calls: string[][] = [];
    const runPaseo = async (args: string[]) => {
      calls.push(args);
      if (opts.fail) throw new Error("paseo daemon unreachable");
      if (opts.malformed) return "not json{{{";
      return JSON.stringify(agents.map((a) => ({ id: a.id, cwd: a.cwd, status: a.status ?? "idle" })));
    };
    return { runPaseo, calls };
  }

  it("closes the room and drops the entry when no live paseo agent works in the dir", async () => {
    const mapPath = join(mkdtempSync(join(tmpdir(), "pi-peer-sweep-")), "paseo-map.json");
    const busyKey = join(homedir(), "work", "busy");
    writeFileSync(mapPath, JSON.stringify({ "/work/gone": "wOrphan", [busyKey]: "wLive" }));
    const closes: string[] = [];
    const herdr = sweepHerdr(["wOrphan", "wLive"], closes);
    const paseo = sweepPaseo([{ id: "a1", cwd: "~/work/busy" }]);

    await sweepOrphanedPaseoRooms(undefined, { run: herdr.run as any, runPaseo: paseo.runPaseo, mapPath });

    assert.deepEqual(closes, ["wOrphan"], "only the orphaned room is closed");
    assert.deepEqual(readJson(mapPath), { [busyKey]: "wLive" }, "orphan entry dropped; live dir kept (~ expanded)");
    rmSync(join(mapPath, ".."), { recursive: true, force: true });
  });

  it("removes the entry without closing when absent from the herdr listing", async () => {
    const mapPath = join(mkdtempSync(join(tmpdir(), "pi-peer-sweep-")), "paseo-map.json");
    writeFileSync(mapPath, JSON.stringify({ "/work/gone": "wGone" }));
    const closes: string[] = [];
    const herdr = sweepHerdr([], closes);
    const paseo = sweepPaseo([]);

    await sweepOrphanedPaseoRooms(undefined, { run: herdr.run as any, runPaseo: paseo.runPaseo, mapPath });

    assert.deepEqual(closes, [], "no close on an already-dead room");
    assert.deepEqual(readJson(mapPath), {}, "stale entry dropped");
    rmSync(join(mapPath, ".."), { recursive: true, force: true });
  });

  it("keeps the entry for a later sweep when the close fails", async () => {
    const mapPath = join(mkdtempSync(join(tmpdir(), "pi-peer-sweep-")), "paseo-map.json");
    writeFileSync(mapPath, JSON.stringify({ "/work/gone": "wStuck" }));
    const closes: string[] = [];
    const herdr = sweepHerdr(["wStuck"], closes, { closeFail: true });
    const paseo = sweepPaseo([]);

    await sweepOrphanedPaseoRooms(undefined, { run: herdr.run as any, runPaseo: paseo.runPaseo, mapPath });

    assert.deepEqual(readJson(mapPath), { "/work/gone": "wStuck" }, "close failure keeps the entry (retry later)");
    rmSync(join(mapPath, ".."), { recursive: true, force: true });
  });

  it("never sweeps a room that still has fresh peer registrations (bridged panes)", async () => {
    const mapPath = join(mkdtempSync(join(tmpdir(), "pi-peer-sweep-")), "paseo-map.json");
    writeFileSync(mapPath, JSON.stringify({ "/work/gone": "wBusy" }));
    // Room wBusy still has a fresh registration (heartbeat mtime now) — under
    // the hermetic agent dir the default talk root resolves.
    const roomRoot = join(agentDir, "pi-peer", "talk", "wBusy", "sessions");
    mkdirSync(roomRoot, { recursive: true });
    const recordFile = join(roomRoot, "session-live.json");
    writeFileSync(recordFile, "{}");
    utimesSync(recordFile, new Date(), new Date());
    const closes: string[] = [];
    const herdr = sweepHerdr(["wBusy"], closes);
    const paseo = sweepPaseo([]);

    try {
      await sweepOrphanedPaseoRooms(undefined, { run: herdr.run as any, runPaseo: paseo.runPaseo, mapPath });

      assert.deepEqual(closes, [], "fresh registrations block the sweep");
      assert.deepEqual(readJson(mapPath), { "/work/gone": "wBusy" }, "entry kept for retry");
    } finally {
      rmSync(join(mapPath, ".."), { recursive: true, force: true });
      rmSync(join(agentDir, "pi-peer", "talk", "wBusy"), { recursive: true, force: true });
    }
  });

  it("cleans legacy v2.3.x workspace-keyed entries once their rooms are quiet", async () => {
    const mapPath = join(mkdtempSync(join(tmpdir(), "pi-peer-sweep-")), "paseo-map.json");
    writeFileSync(mapPath, JSON.stringify({ wks_oldroom: "wLegacy" }));
    const closes: string[] = [];
    const herdr = sweepHerdr(["wLegacy"], closes);
    const paseo = sweepPaseo([{ id: "a1", cwd: "~/work/other" }]);

    await sweepOrphanedPaseoRooms(undefined, { run: herdr.run as any, runPaseo: paseo.runPaseo, mapPath });

    assert.deepEqual(closes, ["wLegacy"], "legacy key never matches a live agent cwd");
    assert.deepEqual(readJson(mapPath), {}, "legacy entry dropped");
    rmSync(join(mapPath, ".."), { recursive: true, force: true });
  });

  it("aborts without touching the map when either listing fails or is malformed", async () => {
    const cases = [
      { paseo: { fail: true }, herdr: {} },
      { paseo: { malformed: true }, herdr: {} },
      { paseo: {}, herdr: { listFail: true } },
    ];
    for (const c of cases) {
      const mapPath = join(mkdtempSync(join(tmpdir(), "pi-peer-sweep-")), "paseo-map.json");
      writeFileSync(mapPath, JSON.stringify({ "/work/gone": "wOrphan" }));
      const closes: string[] = [];
      const herdr = sweepHerdr(["wOrphan"], closes, c.herdr);
      const paseo = sweepPaseo([], c.paseo);

      await sweepOrphanedPaseoRooms(undefined, { run: herdr.run as any, runPaseo: paseo.runPaseo, mapPath });

      assert.deepEqual(closes, [], "fail-closed: no GC on uncertain data");
      assert.deepEqual(readJson(mapPath), { "/work/gone": "wOrphan" }, "map intact");
      assert.ok(!herdr.calls.some((args) => args[1] === "close"), "no close calls at all");
      rmSync(join(mapPath, ".."), { recursive: true, force: true });
    }
  });
});

describe("herdr context resolver chain", () => {
  it("empty env → disabled (regression)", async () => {
    clearHerdrEnv();
    await assert.rejects(getCurrentHerdrPeerContextAsync(), HerdrUnavailableError);
  });

  it("full HERDR_* env → legacy pane path with directory-room bridge", async () => {
    const mapPath = join(agentDir, "pi-peer", "paseo-map.json");
    try {
      clearHerdrEnv();
      process.env.HERDR_ENV = "1";
      process.env.HERDR_PANE_ID = "w7:p1";
      process.env.HERDR_SOCKET_PATH = "/tmp/fake.sock";
      // Room provisioned for the pane's directory → the pane session joins it.
      writeFileSync(mapPath, JSON.stringify({ "/work/checkout": "wRoom" }));
      const run = async (args: string[]) => {
        assert.deepEqual(args.slice(0, 2), ["pane", "get"]);
        return JSON.stringify({ result: { pane: { pane_id: "w7:p1", terminal_id: "term-1", tab_id: "w7:t1", workspace_id: "w7", cwd: "/work/checkout" } } });
      };
      const ctx = await getCurrentHerdrPeerContextAsync(undefined, { run: run as any });
      assert.equal(ctx.workspaceId, "w7", "identity stays with the pane's workspace");
      assert.equal(ctx.roomId, "wRoom", "talk room bridges to the directory room");

      // No room for the directory → classic workspace-scoped behavior.
      writeFileSync(mapPath, JSON.stringify({ "/work/other": "wRoom" }));
      const ctx2 = await getCurrentHerdrPeerContextAsync(undefined, { run: run as any });
      assert.equal(ctx2.roomId, undefined, "no provisioned room → room defaults to the workspace");
      assert.equal(ctx2.workspaceId, "w7");
    } finally {
      // mapPath lives under the shared hermetic agentDir; nothing to remove.
    }
  });

  it("PASEO_AGENT_ID only → paseo provisioning branch", async () => {
    clearHerdrEnv();
    process.env.PASEO_AGENT_ID = "agent-1";
    let provisioned = false;
    const ctx = await getCurrentHerdrPeerContextAsync(undefined, {
      provisionPaseo: async () => {
        provisioned = true;
        return { paneId: "wN:p1", terminalId: "term-1", socketPath: "/tmp/s.sock", workspaceId: "wN" };
      },
    });
    assert.equal(provisioned, true);
    assert.equal(ctx.workspaceId, "wN");
  });
});
