import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { getCurrentHerdrPeerContextAsync, HerdrUnavailableError } from "../../pi-extension/pi-peer/herdr.ts";
import {
  paseoAgentDirName,
  provisionPaseoHerdrContextAsync,
  resetPaseoSweepFlagForTests,
  sweepOrphanedPaseoWorkspaces,
} from "../../pi-extension/pi-peer/paseo.ts";
import { readJson } from "../../pi-extension/pi-peer/storage.ts";
import { restoreEnvVar } from "./helpers.ts";

const envSnapshot = new Map<string, string | undefined>(
  ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_SOCKET_PATH", "HERDR_WORKSPACE_ID", "PASEO_AGENT_ID", "PASEO_AGENT_CWD", "PASEO_HOME"]
    .map((name) => [name, process.env[name]]),
);
after(() => {
  for (const [name, value] of envSnapshot) restoreEnvVar(name, value);
});

function clearHerdrEnv(): void {
  for (const name of envSnapshot.keys()) delete process.env[name];
}

function rootPane(workspaceId: string, paneId: string) {
  return { pane_id: paneId, terminal_id: `term-${paneId}`, tab_id: `${paneId.split(":")[0]}:t1`, workspace_id: workspaceId };
}

interface CliCall { args: string[] }

/**
 * Fake herdr CLI: workspace `wA` alive, `wDead` gone; create/tab-create return
 * deterministic root panes. Records every invocation for assertions.
 */
function fakeHerdr(createdWsCounter: { n: number }) {
  const calls: CliCall[] = [];
  const run = async (args: string[]) => {
    calls.push({ args });
    const [cmd, sub, operand] = args;
    if (cmd === "workspace" && sub === "get") {
      if (operand === "wDead") throw new Error("workspace not found");
      return JSON.stringify({ result: { workspace: { workspace_id: operand, label: "title" } } });
    }
    if (cmd === "workspace" && sub === "create") {
      const wsId = `wNew${++createdWsCounter.n}`;
      return JSON.stringify({ result: { root_pane: rootPane(wsId, `${wsId}:p1`) } });
    }
    if (cmd === "tab" && sub === "create") {
      const wsId = args[args.indexOf("--workspace") + 1];
      return JSON.stringify({ result: { root_pane: rootPane(wsId, `${wsId}:p9`) } });
    }
    if (cmd === "tab" && sub === "get") {
      return JSON.stringify({ result: { tab: { pane_count: 2 } } });
    }
    if (cmd === "workspace" && sub === "report-metadata") return JSON.stringify({ result: { type: "ok" } });
    throw new Error(`unexpected herdr invocation: ${args.join(" ")}`);
  };
  return { run, calls };
}

function fakePaseo(opts: { stateWorkspaceId?: string; inspectWorkspaceId?: string; fail?: boolean } = {}) {
  const runPaseo = async (args: string[]) => {
    if (opts.fail) throw new Error("paseo daemon unreachable");
    if (args[0] === "inspect") {
      if (opts.inspectWorkspaceId) {
        return JSON.stringify(opts.stateWorkspaceId
          ? { Id: "agent-1", WorkspaceId: opts.inspectWorkspaceId }
          : { Id: "agent-1", workspaceId: opts.inspectWorkspaceId });
      }
      throw new Error("unexpected paseo inspect");
    }
    if (args[0] === "workspace" && args[1] === "ls") {
      return JSON.stringify([{ workspaceId: "wks_A", name: "Paseo ws title" }]);
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
  const createdWs = { n: 0 };
  const herdr = fakeHerdr(createdWs);
  return {
    home,
    mapPath,
    herdr,
    createdWs,
    cleanup: () => {
      rmSync(home, { recursive: true, force: true });
      rmSync(join(mapPath, ".."), { recursive: true, force: true });
    },
  };
}

describe("paseo provisioning", () => {
  it("resolves the paseo ws from the agent state file, creates + maps a herdr ws", async () => {
    const s = provisionSetup();
    try {
      clearHerdrEnv();
      process.env.PASEO_AGENT_ID = "agent-1";
      process.env.PASEO_AGENT_CWD = "/work/checkout";
      process.env.PASEO_HOME = s.home;
      writeAgentState(s.home, "/work/checkout", "agent-1", "wks_A");
      const paseo = fakePaseo();

      const ctx = await provisionPaseoHerdrContextAsync(undefined, {
        run: s.herdr.run as any,
        runPaseo: paseo.runPaseo,
        scheduleSweep: () => {}, // sweep interference would race these assertions
        mapPath: s.mapPath,
      });

      assert.equal(ctx.workspaceId, "wNew1", "fresh herdr ws created for the paseo ws");
      assert.equal(ctx.paneId, "wNew1:p1");
      assert.equal(ctx.terminalId, "term-wNew1:p1");
      assert.equal(ctx.paneCount, 2, "pane count probed through the injected runner");
      // Map persisted; env adopted for child processes.
      assert.equal(readJson(s.mapPath)?.wks_A, "wNew1");
      assert.equal(process.env.HERDR_ENV, "1");
      assert.equal(process.env.HERDR_PANE_ID, "wNew1:p1");
      assert.equal(process.env.HERDR_WORKSPACE_ID, "wNew1");
      assert.ok(process.env.HERDR_SOCKET_PATH?.startsWith("/"), "socket path adopted");
      // Workspace label came from the paseo workspace title.
      const create = s.herdr.calls.find((c) => c.args[1] === "create");
      assert.ok(create!.args.includes("Paseo ws title"));
    } finally {
      s.cleanup();
    }
  });

  it("falls back to paseo inspect when the state file is missing (forward-compat)", async () => {
    const s = provisionSetup();
    try {
      clearHerdrEnv();
      process.env.PASEO_AGENT_ID = "agent-1";
      process.env.PASEO_AGENT_CWD = "/work/checkout";
      process.env.PASEO_HOME = s.home;
      const paseo = fakePaseo({ inspectWorkspaceId: "wks_B" });

      const ctx = await provisionPaseoHerdrContextAsync(undefined, {
        run: s.herdr.run as any,
        runPaseo: paseo.runPaseo,
        scheduleSweep: () => {}, // sweep interference would race these assertions
        mapPath: s.mapPath,
      });
      assert.equal(ctx.workspaceId, "wNew1");
      assert.equal(readJson(s.mapPath)?.wks_B, "wNew1");
    } finally {
      s.cleanup();
    }
  });

  it("reuses the mapped herdr workspace for a second agent in the same paseo ws", async () => {
    const s = provisionSetup();
    try {
      clearHerdrEnv();
      process.env.PASEO_AGENT_ID = "agent-2";
      process.env.PASEO_AGENT_CWD = "/work/checkout";
      process.env.PASEO_HOME = s.home;
      writeAgentState(s.home, "/work/checkout", "agent-2", "wks_A");
      writeFileSync(s.mapPath, JSON.stringify({ wks_A: "wExisting" }));
      const paseo = fakePaseo();

      const ctx = await provisionPaseoHerdrContextAsync(undefined, {
        run: s.herdr.run as any,
        runPaseo: paseo.runPaseo,
        scheduleSweep: () => {}, // sweep interference would race these assertions
        mapPath: s.mapPath,
      });

      assert.equal(ctx.workspaceId, "wExisting", "mapped herdr ws reused");
      assert.equal(s.createdWs.n, 0, "no workspace create");
      assert.equal(ctx.paneId, "wExisting:p9", "fresh tab (pane) in the shared workspace");
      assert.ok(s.herdr.calls.some((c) => c.args[1] === "create" && c.args[0] === "tab"), "second agent gets its own tab");
    } finally {
      s.cleanup();
    }
  });

  it("keeps distinct paseo workspaces isolated in distinct herdr workspaces", async () => {
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

      assert.notEqual(ctxA.workspaceId, ctxB.workspaceId, "paseo ws isolation maps to herdr ws isolation");
    } finally {
      s.cleanup();
    }
  });

  it("recreates the herdr workspace when the mapped one is dead", async () => {
    const s = provisionSetup();
    try {
      clearHerdrEnv();
      process.env.PASEO_AGENT_ID = "agent-1";
      process.env.PASEO_AGENT_CWD = "/work/checkout";
      process.env.PASEO_HOME = s.home;
      writeAgentState(s.home, "/work/checkout", "agent-1", "wks_A");
      writeFileSync(s.mapPath, JSON.stringify({ wks_A: "wDead" }));
      const paseo = fakePaseo();

      const ctx = await provisionPaseoHerdrContextAsync(undefined, {
        run: s.herdr.run as any,
        runPaseo: paseo.runPaseo,
        scheduleSweep: () => {}, // sweep interference would race these assertions
        mapPath: s.mapPath,
      });

      assert.equal(ctx.workspaceId, "wNew1", "dead mapping replaced by a fresh ws");
      assert.equal(readJson(s.mapPath)?.wks_A, "wNew1", "map healed");
    } finally {
      s.cleanup();
    }
  });

  it("fails closed (HerdrUnavailableError) when the paseo CLI is unreachable", async () => {
    const s = provisionSetup();
    try {
      clearHerdrEnv();
      process.env.PASEO_AGENT_ID = "agent-1";
      process.env.PASEO_AGENT_CWD = "/work/checkout";
      process.env.PASEO_HOME = s.home;
      const paseo = fakePaseo({ fail: true });

      await assert.rejects(
        provisionPaseoHerdrContextAsync(undefined, { run: s.herdr.run as any, runPaseo: paseo.runPaseo, mapPath: s.mapPath }),
        HerdrUnavailableError,
        "any provisioning failure degrades to peer-talk disabled",
      );
    } finally {
      s.cleanup();
    }
  });
});

describe("paseo provisioning on windows-style cwds", () => {
  it("derives the paseo agent dir exactly like the daemon for drive-letter cwds", async () => {
    const s = provisionSetup();
    try {
      clearHerdrEnv();
      process.env.PASEO_AGENT_ID = "agent-win";
      process.env.PASEO_AGENT_CWD = "C:\\Users\\bean\\proj";
      process.env.PASEO_HOME = s.home;
      // State file stored under the daemon's own win32-derived slug.
      writeAgentState(s.home, "C:\\Users\\bean\\proj", "agent-win", "wks_WIN");
      const paseo = fakePaseo();

      const ctx = await provisionPaseoHerdrContextAsync(undefined, {
        run: s.herdr.run as any,
        runPaseo: paseo.runPaseo,
        scheduleSweep: () => {}, // sweep interference would race these assertions
        mapPath: s.mapPath,
      });

      assert.equal(ctx.workspaceId, "wNew1", "drive-letter cwd resolves via C-Users-bean-proj slug (colon stripped)");
      assert.equal(readJson(s.mapPath)?.wks_WIN, "wNew1");
    } finally {
      s.cleanup();
    }
  });

  it("derives the paseo agent dir for UNC cwds", async () => {
    const s = provisionSetup();
    try {
      clearHerdrEnv();
      process.env.PASEO_AGENT_ID = "agent-unc";
      process.env.PASEO_AGENT_CWD = "\\\\server\\share\\x";
      process.env.PASEO_HOME = s.home;
      writeAgentState(s.home, "\\\\server\\share\\x", "agent-unc", "wks_UNC");
      const paseo = fakePaseo();

      const ctx = await provisionPaseoHerdrContextAsync(undefined, {
        run: s.herdr.run as any,
        runPaseo: paseo.runPaseo,
        scheduleSweep: () => {}, // sweep interference would race these assertions
        mapPath: s.mapPath,
      });

      assert.equal(ctx.workspaceId, "wNew1", "UNC cwd resolves via server-share-x slug");
      assert.equal(readJson(s.mapPath)?.wks_UNC, "wNew1");
    } finally {
      s.cleanup();
    }
  });
});

describe("paseo orphan sweep (phase-2 GC)", () => {
  /** Fake herdr with explicit live/dead workspaces; records every close. */
  function sweepHerdr(liveHerdrWs: string[], closes: string[], deadHerdr = false) {
    const calls: string[][] = [];
    const run = async (args: string[]) => {
      calls.push(args);
      const [cmd, sub, operand] = args;
      if (cmd === "workspace" && sub === "get") {
        if (deadHerdr || !liveHerdrWs.includes(operand!)) throw new Error("workspace not found");
        return JSON.stringify({ result: { workspace: { workspace_id: operand } } });
      }
      if (cmd === "workspace" && sub === "close") {
        closes.push(operand!);
        return JSON.stringify({ result: { type: "ok" } });
      }
      throw new Error(`unexpected herdr invocation: ${args.join(" ")}`);
    };
    return { run, calls };
  }

  function sweepPaseo(liveIds: string[], opts: { fail?: boolean; malformed?: boolean } = {}) {
    const calls: string[][] = [];
    const runPaseo = async (args: string[]) => {
      calls.push(args);
      if (opts.fail) throw new Error("paseo daemon unreachable");
      if (opts.malformed) return "not json{{{";
      return JSON.stringify(liveIds.map((id) => ({ workspaceId: id })));
    };
    return { runPaseo, calls };
  }

  it("closes the herdr ws and removes the entry when the paseo ws is dead", async () => {
    const mapPath = join(mkdtempSync(join(tmpdir(), "pi-peer-sweep-")), "paseo-map.json");
    writeFileSync(mapPath, JSON.stringify({ wks_DEAD: "wOrphan", wks_ALIVE: "wLive" }));
    const closes: string[] = [];
    const herdr = sweepHerdr(["wOrphan", "wLive"], closes);
    const paseo = sweepPaseo(["wks_ALIVE"]);

    await sweepOrphanedPaseoWorkspaces(undefined, { run: herdr.run as any, runPaseo: paseo.runPaseo, mapPath });

    assert.deepEqual(closes, ["wOrphan"], "only the orphaned ws is closed");
    assert.deepEqual(readJson(mapPath), { wks_ALIVE: "wLive" }, "dead entry removed, live entry kept");
    rmSync(join(mapPath, ".."), { recursive: true, force: true });
  });

  it("removes the entry without closing when the herdr ws is dead too", async () => {
    const mapPath = join(mkdtempSync(join(tmpdir(), "pi-peer-sweep-")), "paseo-map.json");
    writeFileSync(mapPath, JSON.stringify({ wks_DEAD: "wDead" }));
    const closes: string[] = [];
    const herdr = sweepHerdr([], closes, true);
    const paseo = sweepPaseo([]);

    await sweepOrphanedPaseoWorkspaces(undefined, { run: herdr.run as any, runPaseo: paseo.runPaseo, mapPath });

    assert.deepEqual(closes, [], "no close on an already-dead ws");
    assert.deepEqual(readJson(mapPath), {}, "stale entry dropped");
    rmSync(join(mapPath, ".."), { recursive: true, force: true });
  });

  it("never touches entries whose paseo ws is alive (incl. the running agent's own ws)", async () => {
    const mapPath = join(mkdtempSync(join(tmpdir(), "pi-peer-sweep-")), "paseo-map.json");
    writeFileSync(mapPath, JSON.stringify({ wks_SELF: "wSelf" }));
    const closes: string[] = [];
    const herdr = sweepHerdr(["wSelf"], closes);
    const paseo = sweepPaseo(["wks_SELF"]);

    await sweepOrphanedPaseoWorkspaces(undefined, { run: herdr.run as any, runPaseo: paseo.runPaseo, mapPath });

    assert.deepEqual(closes, [], "own/alive ws never closed");
    assert.ok(!herdr.calls.some((c) => c[1] === "get"), "not even probed");
    assert.deepEqual(readJson(mapPath), { wks_SELF: "wSelf" });
    rmSync(join(mapPath, ".."), { recursive: true, force: true });
  });

  it("aborts without touching the map when the paseo listing fails or is malformed", async () => {
    for (const opts of [{ fail: true }, { malformed: true }]) {
      const mapPath = join(mkdtempSync(join(tmpdir(), "pi-peer-sweep-")), "paseo-map.json");
      writeFileSync(mapPath, JSON.stringify({ wks_DEAD: "wOrphan" }));
      const closes: string[] = [];
      const herdr = sweepHerdr([], closes);
      const paseo = sweepPaseo([], opts);

      await sweepOrphanedPaseoWorkspaces(undefined, { run: herdr.run as any, runPaseo: paseo.runPaseo, mapPath });

      assert.deepEqual(closes, [], "fail-closed: no GC on uncertain data");
      assert.deepEqual(readJson(mapPath), { wks_DEAD: "wOrphan" }, "map intact");
      assert.equal(herdr.calls.length, 0, "no herdr calls at all");
      rmSync(join(mapPath, ".."), { recursive: true, force: true });
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
      await scheduled[0](); // the scheduled sweep itself must be safe to run
    } finally {
      s.cleanup();
    }
  });
});

describe("herdr context resolver chain", () => {
  it("empty env → disabled (regression)", async () => {
    clearHerdrEnv();
    await assert.rejects(getCurrentHerdrPeerContextAsync(), HerdrUnavailableError);
  });

  it("full HERDR_* env → legacy pane path, unchanged", async () => {
    clearHerdrEnv();
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "w7:p1";
    process.env.HERDR_SOCKET_PATH = "/tmp/fake.sock";
    const run = async (args: string[]) => {
      assert.deepEqual(args.slice(0, 2), ["pane", "get"]);
      return JSON.stringify({ result: { pane: { pane_id: "w7:p1", terminal_id: "term-1", tab_id: "w7:t1", workspace_id: "w7" } } });
    };
    const ctx = await getCurrentHerdrPeerContextAsync(undefined, { run: run as any });
    assert.equal(ctx.workspaceId, "w7");
    assert.equal(ctx.paneId, "w7:p1");
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
