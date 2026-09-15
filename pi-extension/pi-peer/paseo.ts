import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { basename, isAbsolute, join, win32 as pathWin32 } from "node:path";
import { readdirSync, statSync } from "node:fs";

import {
  canonicalDirKey,
  decodeHerdrJson,
  defaultPaseoMapPath,
  getTalkRootDir,
  herdrRunAsync,
  HerdrUnavailableError,
  probePaneCountAsync,
} from "./herdr.ts";
import type { HerdrPeerContext } from "./herdr.ts";
import { readJson, writeAtomic } from "./storage.ts";

const execFileAsync = promisify(execFile);

/**
 * Paseo-provisioned peer integration — one Herdr room per project DIRECTORY.
 *
 * When pi runs as an agent spawned by the Paseo daemon, the process env only
 * carries `PASEO_AGENT_ID` + `PASEO_AGENT_CWD` — no `HERDR_*` variables (those
 * exist only in terminal sessions). This module provisions a Herdr workspace
 * shared by every agent working in the same directory, so "same folder" is
 * "same room" across the herdr and paseo worlds:
 *
 *  1. Room key — the canonical `PASEO_AGENT_CWD` (NOT the paseo workspace id:
 *     paseo mints a fresh workspace per conversation, so workspace-keyed rooms
 *     would isolate two agents sharing one checkout — the opposite of the
 *     directory-room rule). The paseo workspace id is only reported as
 *     best-effort provenance metadata.
 *  2. Herdr room — `paseo-map.json` maps dir → herdrWsId; mapped rooms are
 *     validated with `herdr workspace get` and recreated when gone. Herdr-pane
 *     sessions in the same directory join the room through the bridge in
 *     herdr.ts (identity stays with their own pane's workspace).
 *  3. A fresh tab (pane) is created in the room for this agent, the `HERDR_*`
 *     env is adopted so child processes inherit the context.
 *
 * Fail-closed: every provisioning failure degrades to "peer talk disabled"
 * with a logged cause, never a pi startup crash.
 */

const PASEO_CLI_TIMEOUT_MS = 5_000;
/** A room with peer registrations this fresh is never swept. Laptops suspend
 * for minutes at a time; heartbeats are 10s, staleness is 60s. */
const FRESH_ROOM_ACTIVITY_MS = 5 * 60_000;

/** Same call shape as herdr's internal runner, so probes accept it directly. */
export type HerdrCliRun = (
  args: string[],
  socketPath?: string,
  options?: { signal?: AbortSignal; timeoutMs?: number },
) => Promise<string>;

export type PaseoCliRun = (args: string[]) => Promise<string>;

export interface PaseoProvisionOptions {
  signal?: AbortSignal;
  /** Herdr CLI runner (injectable for tests). */
  run?: HerdrCliRun;
  /** Paseo CLI runner (injectable for tests). */
  runPaseo?: PaseoCliRun;
  /** Paseo daemon home (injectable for tests; default $PASEO_HOME ?? ~/.paseo). */
  paseoHome?: string;
  /** dir → herdrWsId map file (injectable for tests). */
  mapPath?: string;
  /** Herdr socket (injectable for tests; default HERDR_SOCKET_PATH ?? ~/.config/herdr/herdr.sock). */
  socketPath?: string;
  /** Sweep scheduler (injectable for tests; default fire-and-forget). */
  scheduleSweep?: (sweep: () => Promise<void>) => void;
}

interface PaseoHerdrPane {
  pane_id: string;
  terminal_id: string;
  tab_id?: string;
  workspace_id?: string;
}

export async function provisionPaseoHerdrContextAsync(
  signal?: AbortSignal,
  options: PaseoProvisionOptions = {},
): Promise<HerdrPeerContext> {
  try {
    const agentId = process.env.PASEO_AGENT_ID;
    if (!agentId) throw new Error("PASEO_AGENT_ID is not set");
    const cwd = process.env.PASEO_AGENT_CWD;
    if (!cwd) throw new Error("PASEO_AGENT_CWD is not set");
    const socketPath = resolveSocketPath(options.socketPath);
    const run = options.run ?? herdrRunAsync;
    const runPaseo = options.runPaseo ?? defaultPaseoRun;
    const ctx = { signal, run, runPaseo, socketPath, mapPath: options.mapPath, paseoHome: options.paseoHome };

    const ensured = await ensureDirectoryRoom(cwd, ctx);
    const pane = ensured.pane ?? await createRoomPane(ensured.workspaceId, agentId, cwd, ctx);
    if (!pane.workspace_id) throw new Error("herdr pane create did not include workspace_id");
    adoptHerdrEnv(pane, socketPath);
    // Live-view pane: attach to this agent's paseo stream in the room tab so
    // the herdr UI shows the real session (best-effort — a plain shell pane
    // stays fine when this fails; the tty buffers input until the shell is up).
    await ctx.run(["pane", "run", pane.pane_id, `paseo attach ${agentId}`], ctx.socketPath, { signal }).catch(() => {});
    const paneCount = pane.tab_id
      ? await probePaneCountAsync(pane.tab_id, socketPath, { signal, run })
      : undefined;
    // Opportunistic GC: once per process, fire-and-forget so it never delays
    // the agent's own startup; failures are swallowed inside the sweep.
    if (!sweepScheduled) {
      sweepScheduled = true;
      try {
        (options.scheduleSweep ?? defaultScheduleSweep)(() => sweepOrphanedPaseoRooms(signal, options));
      } catch {
        // Scheduling is best-effort; the provisioning result stands either way.
      }
    }
    return {
      paneId: pane.pane_id,
      terminalId: pane.terminal_id,
      tabId: pane.tab_id,
      socketPath,
      workspaceId: pane.workspace_id,
      roomId: pane.workspace_id,
      paneCount,
    };
  } catch (error) {
    if (error instanceof HerdrUnavailableError) throw error;
    console.error(
      `pi-peer: paseo provisioning failed — ${error instanceof Error ? error.message : String(error)}`,
    );
    throw new HerdrUnavailableError("Paseo provisioning failed; peer talk disabled");
  }
}

/** Once-per-process guard: ensureRuntime re-binds on session restarts; the
 * sweep must not re-run (and re-list workspaces) on every bind. */
let sweepScheduled = false;

/** Test-only: the once-per-process sweep flag is module-global. */
export function resetPaseoSweepFlagForTests(): void {
  sweepScheduled = false;
}

function defaultScheduleSweep(sweep: () => Promise<void>): void {
  void sweep().catch(() => {});
}

async function ensureDirectoryRoom(
  cwd: string,
  ctx: { run: HerdrCliRun; socketPath: string; mapPath?: string; paseoHome?: string; signal?: AbortSignal },
): Promise<{ workspaceId: string; pane: PaseoHerdrPane | null }> {
  const mapPath = ctx.mapPath ?? defaultPaseoMapPath();
  const dirKey = canonicalDirKey(cwd);
  const map = readJson(mapPath) ?? {};
  const mapped = map[dirKey];
  if (typeof mapped === "string" && mapped) {
    try {
      await ctx.run(["workspace", "get", mapped], ctx.socketPath, { signal: ctx.signal });
      // Fresh pane per agent session: agents sharing the directory share the
      // room, each gets its own tab.
      return { workspaceId: mapped, pane: null };
    } catch {
      // Mapped room is gone (closed/GC'd) — fall through and recreate.
    }
  }
  const raw = await ctx.run(
    ["workspace", "create", "--cwd", cwd, "--label", roomLabel(cwd)],
    ctx.socketPath,
    { signal: ctx.signal },
  );
  const created = decodeHerdrJson<{ root_pane?: PaseoHerdrPane }>(raw, "workspace create");
  if (!created?.root_pane?.pane_id || !created.root_pane.terminal_id) {
    throw new Error("herdr workspace create did not include a root pane");
  }
  const herdrWsId = created.root_pane.workspace_id ?? created.root_pane.pane_id.split(":")[0];
  saveMapEntry(mapPath, dirKey, herdrWsId);
  // Display-only provenance tag (the herdr CLI cannot read metadata back; for
  // the Herdr UI and humans only). The paseo workspace id is a nice-to-have:
  // the room is keyed by directory, not by the per-conversation workspace.
  const paseoWsId = readPaseoAgentStateWorkspaceId(process.env.PASEO_AGENT_ID!, cwd, ctx.paseoHome);
  if (paseoWsId) {
    await ctx.run(
      ["workspace", "report-metadata", herdrWsId, "--source", "pi-peer", "--token", `paseo_workspace_id=${paseoWsId}`],
      ctx.socketPath,
      { signal: ctx.signal },
    ).catch(() => {});
  }
  return { workspaceId: herdrWsId, pane: created.root_pane };
}

async function createRoomPane(
  workspaceId: string,
  agentId: string,
  cwd: string,
  ctx: { run: HerdrCliRun; socketPath: string; signal?: AbortSignal },
): Promise<PaseoHerdrPane> {
  const raw = await ctx.run(
    ["tab", "create", "--workspace", workspaceId, "--cwd", cwd, "--label", `paseo-${shortId(agentId)}`],
    ctx.socketPath,
    { signal: ctx.signal },
  );
  const created = decodeHerdrJson<{ root_pane?: PaseoHerdrPane }>(raw, "tab create");
  if (!created?.root_pane?.pane_id || !created.root_pane.terminal_id) {
    throw new Error("herdr tab create did not include a pane");
  }
  return created.root_pane;
}

function roomLabel(cwd: string): string {
  return basename(cwd) || "paseo-room";
}

function readPaseoAgentStateWorkspaceId(
  agentId: string,
  cwd: string,
  paseoHome: string | undefined,
): string | null {
  const home = paseoHome ?? process.env.PASEO_HOME ?? join(homedir(), ".paseo");
  const record = readJson(join(home, "agents", paseoAgentDirName(cwd), `${agentId}.json`));
  const wsId = record?.workspaceId;
  return typeof wsId === "string" && wsId ? wsId : null;
}

/**
 * Directory name the Paseo daemon derives from an agent cwd — an exact
 * mirror of `projectDirNameFromCwd` in paseo's agent-storage (win32 parse
 * handles drive letters, UNC roots, and Unix roots on all platforms;
 * `[:\\/]+` collapses to "-", dash edges strip, root-only → "root").
 * "C:\\Users\\bean\\proj" → "C-Users-bean-proj", "\\\\server\\share\\x" →
 * "server-share-x", "/a/b/c" → "a-b-c".
 */
export function paseoAgentDirName(cwd: string): string {
  const { root } = pathWin32.parse(cwd);
  const withoutRoot = cwd.slice(root.length).replace(/[\\/]+$/, "");
  const sanitizedRoot = root.replace(/[:\\/]+/g, "-").replace(/^-+|-+$/g, "");
  const prefix = sanitizedRoot ? sanitizedRoot + "-" : "";
  if (!withoutRoot) return sanitizedRoot || "root";
  return prefix + withoutRoot.replace(/[\\/]+/g, "-");
}

/**
 * Close directory rooms no live Paseo agent works in anymore. Map-driven:
 * the map file is both the record of what pi-peer provisioned and the GC
 * scan list. Membership comes from the two authoritative listings
 * (`paseo ls`, `herdr workspace list`) — absence from a list is the only
 * "dead" signal, so no transient CLI failure can be misread as "gone".
 * A room with fresh peer registrations is never swept (someone still uses
 * it — e.g. herdr-pane peers bridged into it). Legacy workspace-keyed map
 * entries (v2.3.x) can never match a live agent cwd and are cleaned up
 * here once their rooms go quiet. Fail-closed: a failed listing aborts the
 * sweep without touching the map; a failed close keeps the entry.
 */
export async function sweepOrphanedPaseoRooms(
  signal?: AbortSignal,
  options: PaseoProvisionOptions = {},
): Promise<void> {
  try {
    const mapPath = options.mapPath ?? defaultPaseoMapPath();
    const map = readJson(mapPath);
    if (!map || typeof map !== "object") return;
    const entries = Object.entries(map).filter(([, wsId]) => typeof wsId === "string" && wsId);
    if (entries.length === 0) return;

    const run = options.run ?? herdrRunAsync;
    const runPaseo = options.runPaseo ?? defaultPaseoRun;
    const socketPath = resolveSocketPath(options.socketPath);
    // A missing/broken listing is "unknown", not "all dead" — abort, keep map.
    const liveAgentDirs = livePaseoAgentDirs(await runPaseo(["ls", "--json"]), homedir());
    const liveHerdrWsIds = parseHerdrWorkspaceIds(await run(["workspace", "list"], socketPath, { signal }));

    for (const [dirKey, herdrWsId] of entries) {
      if (liveAgentDirs.has(dirKey)) continue;
      if (liveHerdrWsIds.has(herdrWsId as string)) {
        if (roomHasFreshActivity(herdrWsId as string)) continue;
        try {
          await run(["workspace", "close", herdrWsId as string], socketPath, { signal });
        } catch {
          // Close failed (herdr busy?) — keep the entry so a later sweep retries.
          continue;
        }
      }
      // Absent from the herdr listing = confirmed dead; entry is stale either way.
      const fresh = readJson(mapPath) ?? {};
      delete fresh[dirKey];
      writeAtomic(mapPath, fresh);
    }
  } catch {
    // Opportunistic GC: never surfaces, never fails the provisioning above.
  }
}

/** Live (running/idle) agent directories from the paseo listing; `~` in the
 * display cwd expands back to home. Throws on anything unexpected so the
 * sweep aborts instead of misreading "unparseable" as "nobody is alive". */
function livePaseoAgentDirs(raw: string, home: string): Set<string> {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error("unexpected paseo agent listing");
  const dirs = new Set<string>();
  for (const agent of parsed) {
    const record = agent && typeof agent === "object" ? agent as { status?: unknown; cwd?: unknown } : {};
    if (record.status !== "running" && record.status !== "idle") continue;
    if (typeof record.cwd !== "string" || !record.cwd) continue;
    const absolute = record.cwd.startsWith("~") ? join(home, record.cwd.slice(1)) : record.cwd;
    dirs.add(canonicalDirKey(absolute));
  }
  return dirs;
}

/** Same fail-closed contract for the herdr workspace listing. */
function parseHerdrWorkspaceIds(raw: string): Set<string> {
  const decoded = decodeHerdrJson<{ type?: unknown; workspaces?: unknown }>(raw, "workspace list");
  if (!decoded || decoded.type !== "workspace_list" || !Array.isArray(decoded.workspaces)) {
    throw new Error("unexpected herdr workspace listing");
  }
  const ids = new Set<string>();
  for (const ws of decoded.workspaces) {
    if (ws && typeof ws === "object" && typeof (ws as { workspace_id?: unknown }).workspace_id === "string") {
      ids.add((ws as { workspace_id: string }).workspace_id);
    }
  }
  return ids;
}

/** Any peer registration heartbeat this fresh means the room is still in use. */
function roomHasFreshActivity(herdrWsId: string): boolean {
  try {
    const sessions = join(getTalkRootDir(herdrWsId), "sessions");
    for (const name of readdirSync(sessions)) {
      if (!name.endsWith(".json")) continue;
      if (Date.now() - statSync(join(sessions, name)).mtimeMs <= FRESH_ROOM_ACTIVITY_MS) return true;
    }
  } catch {
    // No sessions dir (never used or already gone) — not fresh.
  }
  return false;
}

/**
 * Adopt the provisioned context into the process env so child processes
 * (and the legacy HERDR_* code paths) see a bound Herdr session.
 */
function adoptHerdrEnv(pane: PaseoHerdrPane, socketPath: string): void {
  process.env.HERDR_ENV = "1";
  process.env.HERDR_PANE_ID = pane.pane_id;
  if (pane.tab_id) process.env.HERDR_TAB_ID = pane.tab_id;
  if (pane.workspace_id) process.env.HERDR_WORKSPACE_ID = pane.workspace_id;
  if (!process.env.HERDR_SOCKET_PATH) process.env.HERDR_SOCKET_PATH = socketPath;
}

function saveMapEntry(mapPath: string, dirKey: string, herdrWsId: string): void {
  // Merge over the freshest file contents: a concurrent provisioning of
  // another agent in the same directory must not be clobbered.
  const map = readJson(mapPath) ?? {};
  map[dirKey] = herdrWsId;
  writeAtomic(mapPath, map);
}

function resolveSocketPath(explicit?: string): string {
  if (explicit) return explicit;
  const env = process.env.HERDR_SOCKET_PATH;
  if (env && isAbsolute(env)) return env;
  return join(homedir(), ".config", "herdr", "herdr.sock");
}

async function defaultPaseoRun(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("paseo", args, {
    encoding: "utf8",
    timeout: PASEO_CLI_TIMEOUT_MS,
  });
  return stdout;
}

function shortId(id: string): string {
  return id.slice(0, 7);
}
