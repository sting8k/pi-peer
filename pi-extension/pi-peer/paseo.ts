import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { basename, isAbsolute, join, win32 as pathWin32 } from "node:path";
import { readdirSync, realpathSync, statSync } from "node:fs";

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
 *  2. Herdr room — `paseo-map.json` maps dir → { room: herdrWsId, panes,
 *     owned }; mapped rooms are validated with `herdr workspace get`. On a
 *     miss (or a dead room) a workspace the user already opened for the same
 *     directory is ADOPTED (`pane list` cwd match, owned:false) before a new
 *     one is created (owned:true) — one dir must not become two sidebar
 *     entries. Herdr-pane sessions in the same directory join the room
 *     through the bridge in herdr.ts (identity stays with their own pane's
 *     workspace).
 *  3. A tab (pane) is created in the room for this agent and the `HERDR_*`
 *     env is adopted so child processes inherit the context. The pane is
 *     recorded per paseo agentId in the map and REUSED on reload/restart:
 *     same agent → same pane → same peer id, so identity survives reloads and
 *     no duplicate tabs pile up. A recorded pane that died (or strayed to
 *     another room) falls back to a fresh tab.
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
    // Pane reuse: a brand-new room's root pane is this agent's pane; else the
    // pane recorded for this agent is adopted when still alive in the room;
    // otherwise a fresh tab is created. Every non-reused pane is recorded so
    // the next reload binds back to the same pane (same peer id).
    const reused = ensured.pane ? null : await reuseRoomPane(ensured.workspaceId, agentId, cwd, ctx);
    const pane = reused ?? ensured.pane ?? await createRoomPane(ensured.workspaceId, agentId, cwd, ctx);
    if (!reused) {
      savePaneEntry(
        ctx.mapPath ?? defaultPaseoMapPath(),
        canonicalDirKey(cwd),
        ensured.workspaceId,
        agentId,
        pane.pane_id,
        ensured.owned,
      );
    }
    if (!pane.workspace_id) throw new Error("herdr pane create did not include workspace_id");
    adoptHerdrEnv(pane, socketPath);
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
): Promise<{ workspaceId: string; pane: PaseoHerdrPane | null; owned: boolean }> {
  const mapPath = ctx.mapPath ?? defaultPaseoMapPath();
  const dirKey = canonicalDirKey(cwd);
  const map = readJson(mapPath) ?? {};
  const mapped = map[dirKey];
  // Schema v2 entries carry { room, panes, owned }; legacy flat values are the room itself.
  const mappedRoom = mapped && typeof mapped === "object" ? (mapped as { room?: unknown }).room : mapped;
  if (typeof mappedRoom === "string" && mappedRoom) {
    try {
      await ctx.run(["workspace", "get", mappedRoom], ctx.socketPath, { signal: ctx.signal });
      // Fresh pane per agent session: agents sharing the directory share the
      // room, each gets its own tab.
      const mappedOwned = mapped && typeof mapped === "object" ? (mapped as { owned?: unknown }).owned : undefined;
      return { workspaceId: mappedRoom, pane: null, owned: mappedOwned !== false };
    } catch {
      // Mapped room is gone (closed/GC'd) — fall through to adopt/recreate.
    }
  }
  // Adopt-before-create: a workspace the user already opened for this
  // directory IS the room — one dir must not become two sidebar entries.
  const adopted = await adoptWorkspaceForDir(cwd, ctx);
  if (adopted) {
    saveMapEntry(mapPath, dirKey, adopted, false);
    return { workspaceId: adopted, pane: null, owned: false };
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
  saveMapEntry(mapPath, dirKey, herdrWsId, true);
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
  return { workspaceId: herdrWsId, pane: created.root_pane, owned: true };
}

/**
 * Adopt-before-create: if the user already has a Herdr workspace with a pane
 * in this directory, that workspace IS the room (one dir = one sidebar
 * entry). `pane list` is the only listing carrying cwd — workspace get/list
 * carry none — so the whole listing is filtered here; the FIRST matching
 * pane's workspace wins. Best-effort: any failure or malformed output
 * returns null and the caller creates a room as before; adoption never
 * fails provisioning.
 */
async function adoptWorkspaceForDir(
  cwd: string,
  ctx: { run: HerdrCliRun; socketPath: string; signal?: AbortSignal },
): Promise<string | null> {
  let panes: unknown;
  try {
    const raw = await ctx.run(["pane", "list"], ctx.socketPath, { signal: ctx.signal });
    const decoded = decodeHerdrJson<{ type?: unknown; panes?: unknown }>(raw, "pane list");
    if (decoded?.type !== "pane_list") return null;
    panes = decoded.panes;
  } catch {
    return null;
  }
  if (!Array.isArray(panes)) return null;
  for (const pane of panes) {
    const record = pane && typeof pane === "object" ? pane as { cwd?: unknown; workspace_id?: unknown } : {};
    if (typeof record.workspace_id !== "string" || !record.workspace_id) continue;
    if (typeof record.cwd !== "string" || !record.cwd) continue;
    if (sameDirectory(record.cwd, cwd)) return record.workspace_id;
  }
  return null;
}

/**
 * Directory equality across symlinks: herdr reports resolved cwds (e.g.
 * /tmp → /private/tmp) so both sides go through realpathSync; a realpath
 * failure falls back to the canonical string compare.
 */
function sameDirectory(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return canonicalDirKey(a) === canonicalDirKey(b);
  }
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

/**
 * Pane reuse: the pane recorded for this paseo agent in the room map, when it
 * is still alive in the room. `herdr pane get` failing (dead pane) or the pane
 * living in another workspace (strayed/re-created room) both return null so
 * the caller falls through to a fresh tab — never an identity mismatch.
 */
async function reuseRoomPane(
  workspaceId: string,
  agentId: string,
  cwd: string,
  ctx: { run: HerdrCliRun; socketPath: string; mapPath?: string; signal?: AbortSignal },
): Promise<PaseoHerdrPane | null> {
  const mapPath = ctx.mapPath ?? defaultPaseoMapPath();
  const paneId = loadPaseoMap(mapPath)[canonicalDirKey(cwd)]?.panes[agentId];
  if (!paneId) return null;
  let pane: PaseoHerdrPane | undefined;
  try {
    const raw = await ctx.run(["pane", "get", paneId], ctx.socketPath, { signal: ctx.signal });
    pane = decodeHerdrJson<{ pane?: PaseoHerdrPane }>(raw, "pane get")?.pane;
  } catch {
    return null; // pane gone — fall through to a fresh tab
  }
  if (!pane?.pane_id || !pane.terminal_id) return null;
  if (pane.workspace_id !== workspaceId) return null; // alive but in another room
  return pane;
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
 * it — e.g. herdr-pane peers bridged into it). For dirs that stay live, the
 * per-agent pane records are pruned: an agent fully gone from the paseo
 * listing has its pane closed (best-effort) and its entry dropped; a
 * closed-but-still-listed agent keeps its pane (resumable). Legacy
 * workspace-keyed map entries (v2.3.x) can never match a live agent cwd and
 * are cleaned up here once their rooms go quiet. Fail-closed: a failed
 * listing aborts the sweep without touching the map; a failed room close
 * keeps the entry.
 */
export async function sweepOrphanedPaseoRooms(
  signal?: AbortSignal,
  options: PaseoProvisionOptions = {},
): Promise<void> {
  try {
    const mapPath = options.mapPath ?? defaultPaseoMapPath();
    const map = loadPaseoMap(mapPath);
    const entries = Object.entries(map);
    if (entries.length === 0) return;

    const run = options.run ?? herdrRunAsync;
    const runPaseo = options.runPaseo ?? defaultPaseoRun;
    const socketPath = resolveSocketPath(options.socketPath);
    // A missing/broken listing is "unknown", not "all dead" — abort, keep map.
    const { liveDirs, listedAgentsByDir } = parsePaseoListing(await runPaseo(["ls", "--json"]), homedir());
    const liveHerdrWsIds = parseHerdrWorkspaceIds(await run(["workspace", "list"], socketPath, { signal }));

    const droppedDirs = new Set<string>();
    const prunedPanes = new Map<string, string[]>();
    for (const [dirKey, entry] of entries) {
      if (!liveDirs.has(dirKey)) {
        if (entry.owned) {
          if (liveHerdrWsIds.has(entry.room)) {
            if (roomHasFreshActivity(entry.room)) continue;
            try {
              await run(["workspace", "close", entry.room], socketPath, { signal });
            } catch {
              // Close failed (herdr busy?) — keep the entry so a later sweep retries.
              continue;
            }
          }
        } else {
          // Adopted room = the user's workspace: never `workspace close` it.
          // Retire only the panes pi-peer tracked for this dir (best-effort),
          // then drop the entry — the user's room stays untouched.
          for (const paneId of Object.values(entry.panes)) {
            try {
              await run(["pane", "close", paneId], socketPath, { signal });
            } catch {
              // Best-effort: the entry is dropped regardless.
            }
          }
        }
        // Absent from the herdr listing = confirmed dead; entry is stale either way.
        droppedDirs.add(dirKey);
        continue;
      }
      // Dir still alive: prune panes of agents fully gone from the paseo
      // listing — closed-but-still-listed agents keep their pane (resumable).
      const listed = listedAgentsByDir.get(dirKey);
      for (const [agentId, paneId] of Object.entries(entry.panes)) {
        if (listed?.has(agentId)) continue;
        try {
          await run(["pane", "close", paneId], socketPath, { signal });
        } catch {
          // Best-effort: the stale pane record goes regardless.
        }
        const removed = prunedPanes.get(dirKey) ?? [];
        removed.push(agentId);
        prunedPanes.set(dirKey, removed);
      }
    }
    if (droppedDirs.size === 0 && prunedPanes.size === 0) return;
    // Re-merge over the freshest file: a concurrent provisioning between the
    // listing and this write must not be clobbered.
    const fresh = loadPaseoMap(mapPath);
    for (const dirKey of droppedDirs) delete fresh[dirKey];
    for (const [dirKey, agentIds] of prunedPanes) {
      for (const agentId of agentIds) delete fresh[dirKey]?.panes[agentId];
    }
    writeAtomic(mapPath, fresh);
  } catch {
    // Opportunistic GC: never surfaces, never fails the provisioning above.
  }
}

/** Agent listing from the paseo daemon: the directories with live
 * (running/idle) agents, plus — for every listed agent regardless of status —
 * the agent ids seen in its directory (pane pruning needs "removed entirely"
 * vs "closed but listed"). `~` in the display cwd expands back to home.
 * Throws on anything unexpected so the sweep aborts instead of misreading
 * "unparseable" as "nobody is alive". */
function parsePaseoListing(raw: string, home: string): {
  liveDirs: Set<string>;
  listedAgentsByDir: Map<string, Set<string>>;
} {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error("unexpected paseo agent listing");
  const liveDirs = new Set<string>();
  const listedAgentsByDir = new Map<string, Set<string>>();
  for (const agent of parsed) {
    const record = agent && typeof agent === "object"
      ? agent as { id?: unknown; status?: unknown; cwd?: unknown }
      : {};
    if (typeof record.cwd !== "string" || !record.cwd) continue;
    const absolute = record.cwd.startsWith("~") ? join(home, record.cwd.slice(1)) : record.cwd;
    const dirKey = canonicalDirKey(absolute);
    if (typeof record.id === "string" && record.id) {
      const listed = listedAgentsByDir.get(dirKey) ?? new Set<string>();
      listed.add(record.id);
      listedAgentsByDir.set(dirKey, listed);
    }
    if (record.status !== "running" && record.status !== "idle") continue;
    liveDirs.add(dirKey);
  }
  return { liveDirs, listedAgentsByDir };
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

/** Map entry schema v2: the room's herdr workspace + the pane recorded per
 * paseo agentId (identity across reloads) + whether pi-peer owns the room.
 * `owned:false` marks an adopted user workspace — the sweep retires its
 * tracked panes but never `workspace close`s the room itself. Missing/legacy
 * → true: every room written before this field was pi-peer-created. */
interface PaseoMapEntry {
  room: string;
  panes: Record<string, string>;
  owned: boolean;
}

/** Load the dir map, normalizing legacy flat "dir → wsId" values to schema v2
 * in place. Legacy `wks_*` workspace-keyed entries normalize to entry shape
 * too — they never match a live agent cwd, so the sweep cleans them as before. */
function loadPaseoMap(mapPath: string): Record<string, PaseoMapEntry> {
  const map = readJson(mapPath) ?? {};
  for (const [key, value] of Object.entries(map)) {
    if (typeof value === "string" && value) map[key] = { room: value, panes: {}, owned: true };
    else if (value && typeof value === "object") {
      // Entries predating `owned` were all pi-peer-created rooms.
      const entry = value as PaseoMapEntry;
      if (entry.owned !== false) entry.owned = true;
    }
  }
  return map as Record<string, PaseoMapEntry>;
}

function saveMapEntry(mapPath: string, dirKey: string, herdrWsId: string, owned: boolean): void {
  // Merge over the freshest file contents: a concurrent provisioning of
  // another agent in the same directory must not be clobbered.
  const map = loadPaseoMap(mapPath);
  // A recreated room invalidates its old panes' identity — start panes empty.
  map[dirKey] = { room: herdrWsId, panes: {}, owned };
  writeAtomic(mapPath, map);
}

/** Record the pane a paseo agent owns in its room, preserving the panes and
 * the owned flag of the directory's entry (fresh read + merge, like
 * saveMapEntry). `owned` — the room's provenance from ensureDirectoryRoom —
 * is only used when the current entry tracks a different room (e.g. a
 * concurrent provisioning rewrote it). */
function savePaneEntry(
  mapPath: string,
  dirKey: string,
  herdrWsId: string,
  agentId: string,
  paneId: string,
  owned: boolean,
): void {
  const map = loadPaseoMap(mapPath);
  const entry = map[dirKey];
  const sameRoom = entry && entry.room === herdrWsId ? entry : undefined;
  map[dirKey] = {
    room: herdrWsId,
    panes: { ...sameRoom?.panes, [agentId]: paneId },
    owned: sameRoom?.owned ?? owned,
  };
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
