import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import path from "node:path";

import {
  decodeHerdrJson,
  getAgentConfigDir,
  herdrRunAsync,
  HerdrUnavailableError,
  probePaneCountAsync,
} from "./herdr.ts";
import type { HerdrPeerContext } from "./herdr.ts";
import { readJson, writeAtomic } from "./storage.ts";

const execFileAsync = promisify(execFile);

/**
 * Paseo-provisioned peer integration.
 *
 * When pi runs as an agent spawned by the Paseo daemon, the process env only
 * carries `PASEO_AGENT_ID` + `PASEO_AGENT_CWD` — no `HERDR_*` variables (those
 * exist only in terminal sessions). This module provisions a Herdr workspace
 * that maps 1:1 to the agent's Paseo workspace so peer talk works unchanged.
 *
 * Resolution (fail-closed: every failure degrades to "peer talk disabled"
 * with a logged cause, never a pi startup crash):
 *  1. Paseo workspace id — read from the daemon's agent state file
 *     (`$PASEO_HOME/agents/<cwd-slug>/<agentId>.json`, the same record the
 *     daemon persists); falls back to `paseo inspect --json` (newer CLIs may
 *     expose the field). PASEO_AGENT_CWD is never used as an identity key:
 *     two `local` Paseo workspaces can share one checkout.
 *  2. Herdr workspace — `paseo-map.json` maps paseoWsId → herdrWsId; mapped
 *     workspaces are validated with `herdr workspace get` and recreated when
 *     gone. Herdr metadata tokens are reported best-effort but are NOT
 *     readable back via the CLI (display-only), so the map file is the only
 *     lookup. Orphaned paseo-tagged workspaces are GC'd in a later phase.
 *  3. A fresh tab (pane) is created in the workspace for this agent, the
 *     `HERDR_*` env is adopted so child processes inherit the context.
 */

const PASEO_CLI_TIMEOUT_MS = 5_000;

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
  /** paseoWsId → herdrWsId map file (injectable for tests). */
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
    const socketPath = resolveSocketPath(options.socketPath);
    const run = options.run ?? herdrRunAsync;
    const runPaseo = options.runPaseo ?? defaultPaseoRun;
    const ctx = { signal, run, runPaseo, socketPath, mapPath: options.mapPath, paseoHome: options.paseoHome };

    const paseoWsId = await resolvePaseoWorkspaceId(agentId, cwd, ctx);
    const ensured = await ensureHerdrWorkspace(paseoWsId, agentId, cwd, ctx);
    const pane = ensured.pane ?? await createWorkspacePane(ensured.workspaceId, agentId, cwd, ctx);
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
        (options.scheduleSweep ?? defaultScheduleSweep)(() => sweepOrphanedPaseoWorkspaces(signal, options));
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

function resolvePaseoWorkspaceId(
  agentId: string,
  cwd: string | undefined,
  ctx: { runPaseo: PaseoCliRun; paseoHome?: string; signal?: AbortSignal },
): Promise<string> {
  const fromState = readPaseoAgentStateWorkspaceId(agentId, cwd, ctx.paseoHome);
  if (fromState) return Promise.resolve(fromState);
  // The installed paseo CLI drops workspaceId from inspect output; parse it
  // anyway so a newer CLI (or server-side field addition) resolves cleanly.
  return ctx.runPaseo(["inspect", agentId, "--json"]).then((raw) => {
    const parsed = JSON.parse(raw) as { WorkspaceId?: unknown; workspaceId?: unknown };
    const wsId = parsed?.WorkspaceId ?? parsed?.workspaceId;
    if (typeof wsId === "string" && wsId) return wsId;
    throw new Error(`paseo inspect did not include a workspace id for agent ${agentId}`);
  });
}

function readPaseoAgentStateWorkspaceId(
  agentId: string,
  cwd: string | undefined,
  paseoHome: string | undefined,
): string | null {
  if (!cwd) return null;
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
 * "C:\\Users\\bean\\proj" → "C-Users-bean-proj", "//server/share/x" →
 * "server-share-x", "/a/b/c" → "a-b-c".
 */
export function paseoAgentDirName(cwd: string): string {
  const { root } = path.win32.parse(cwd);
  const withoutRoot = cwd.slice(root.length).replace(/[\\/]+$/, "");
  const sanitizedRoot = root.replace(/[:\\/]+/g, "-").replace(/^-+|-+$/g, "");
  const prefix = sanitizedRoot ? sanitizedRoot + "-" : "";
  if (!withoutRoot) return sanitizedRoot || "root";
  return prefix + withoutRoot.replace(/[\\/]+/g, "-");
}

async function ensureHerdrWorkspace(
  paseoWsId: string,
  agentId: string,
  cwd: string | undefined,
  ctx: { run: HerdrCliRun; runPaseo: PaseoCliRun; socketPath: string; mapPath?: string; signal?: AbortSignal },
): Promise<{ workspaceId: string; pane: PaseoHerdrPane | null }> {
  const mapPath = ctx.mapPath ?? defaultMapPath();
  const map = readJson(mapPath) ?? {};
  const mapped = map[paseoWsId];
  if (typeof mapped === "string" && mapped) {
    try {
      await ctx.run(["workspace", "get", mapped], ctx.socketPath, { signal: ctx.signal });
      // Fresh pane per agent session: agents sharing a Paseo workspace share
      // the Herdr workspace, each gets its own tab.
      return { workspaceId: mapped, pane: null };
    } catch {
      // Mapped workspace is gone (closed/ GC'd) — fall through and recreate.
    }
  }
  const label = (await resolvePaseoWorkspaceTitle(paseoWsId, ctx)) ?? `paseo-${shortId(paseoWsId)}`;
  const raw = await ctx.run(
    ["workspace", "create", "--cwd", cwd ?? process.cwd(), "--label", label],
    ctx.socketPath,
    { signal: ctx.signal },
  );
  const created = decodeHerdrJson<{ root_pane?: PaseoHerdrPane }>(raw, "workspace create");
  if (!created?.root_pane?.pane_id || !created.root_pane.terminal_id) {
    throw new Error("herdr workspace create did not include a root pane");
  }
  const herdrWsId = created.root_pane.workspace_id ?? created.root_pane.pane_id.split(":")[0];
  saveMapEntry(mapPath, paseoWsId, herdrWsId);
  // Display-only provenance tag: the herdr CLI cannot read metadata back
  // (workspace get/list omit tokens), so this is for the Herdr UI and a
  // later GC phase — the map file above stays the only lookup.
  await ctx.run(["workspace", "report-metadata", herdrWsId, "--source", "pi-peer", "--token", `paseo_workspace_id=${paseoWsId}`], ctx.socketPath, { signal: ctx.signal }).catch(() => {});
  return { workspaceId: herdrWsId, pane: created.root_pane };
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

/**
 * Close Herdr workspaces whose Paseo workspace no longer exists. Map-driven:
 * herdr metadata tokens are write-only (not readable back), so the map file
 * is both the record of what pi-peer provisioned and the GC scan list — it
 * can therefore only ever touch workspaces pi-peer itself provisioned.
 * Membership comes from the two authoritative listings (paseo workspace ls,
 * herdr workspace list) — absence from a list is the only "dead" signal, so
 * no transient CLI failure can ever be misread as a workspace being gone.
 * Fail-closed: a failed listing aborts the sweep without touching the map;
 * a failed close keeps the entry for a later sweep; anything else is
 * swallowed (the sweep is opportunistic).
 */
export async function sweepOrphanedPaseoWorkspaces(
  signal?: AbortSignal,
  options: PaseoProvisionOptions = {},
): Promise<void> {
  try {
    const mapPath = options.mapPath ?? defaultMapPath();
    const map = readJson(mapPath);
    if (!map || typeof map !== "object") return;
    const entries = Object.entries(map).filter(([, wsId]) => typeof wsId === "string" && wsId);
    if (entries.length === 0) return;

    const run = options.run ?? herdrRunAsync;
    const runPaseo = options.runPaseo ?? defaultPaseoRun;
    const socketPath = resolveSocketPath(options.socketPath);
    // A missing/broken listing is "unknown", not "all dead" — abort, keep map.
    const livePaseoWsIds = parsePaseoWorkspaceIds(await runPaseo(["workspace", "ls", "--json"]));
    const liveHerdrWsIds = parseHerdrWorkspaceIds(await run(["workspace", "list"], socketPath, { signal }));

    for (const [paseoWsId, herdrWsId] of entries) {
      if (livePaseoWsIds.has(paseoWsId)) continue;
      if (liveHerdrWsIds.has(herdrWsId as string)) {
        try {
          await run(["workspace", "close", herdrWsId as string], socketPath, { signal });
        } catch {
          // Close failed (herdr busy?) — keep the entry so a later sweep retries.
          continue;
        }
      }
      // Absent from the herdr listing = confirmed dead; entry is stale either way.
      const fresh = readJson(mapPath) ?? {};
      delete fresh[paseoWsId];
      writeAtomic(mapPath, fresh);
    }
  } catch {
    // Opportunistic GC: never surfaces, never fails the provisioning above.
  }
}

/** Parses the paseo workspace listing; throws on anything unexpected so the
 * sweep aborts instead of misreading "unparseable" as "nothing is live". */
function parsePaseoWorkspaceIds(raw: string): Set<string> {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error("unexpected paseo workspace listing");
  const ids = new Set<string>();
  for (const ws of parsed) {
    if (ws && typeof ws === "object" && typeof (ws as { workspaceId?: unknown }).workspaceId === "string") {
      ids.add((ws as { workspaceId: string }).workspaceId);
    }
  }
  return ids;
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

async function createWorkspacePane(
  workspaceId: string,
  agentId: string,
  cwd: string | undefined,
  ctx: { run: HerdrCliRun; socketPath: string; signal?: AbortSignal },
): Promise<PaseoHerdrPane> {
  const raw = await ctx.run(
    ["tab", "create", "--workspace", workspaceId, "--cwd", cwd ?? process.cwd(), "--label", `paseo-${shortId(agentId)}`],
    ctx.socketPath,
    { signal: ctx.signal },
  );
  const created = decodeHerdrJson<{ root_pane?: PaseoHerdrPane }>(raw, "tab create");
  if (!created?.root_pane?.pane_id || !created.root_pane.terminal_id) {
    throw new Error("herdr tab create did not include a pane");
  }
  return created.root_pane;
}

/** Best-effort display title of a Paseo workspace; degrades to null. */
async function resolvePaseoWorkspaceTitle(
  paseoWsId: string,
  ctx: { runPaseo: PaseoCliRun; signal?: AbortSignal },
): Promise<string | null> {
  try {
    const raw = await ctx.runPaseo(["workspace", "ls", "--json"]);
    const list = JSON.parse(raw) as Array<{ workspaceId?: unknown; name?: unknown; displayName?: unknown }>;
    const match = Array.isArray(list) ? list.find((ws) => ws?.workspaceId === paseoWsId) : undefined;
    const title = match?.name ?? match?.displayName;
    return typeof title === "string" && title.trim() ? title : null;
  } catch {
    return null;
  }
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

function saveMapEntry(mapPath: string, paseoWsId: string, herdrWsId: string): void {
  // Merge over the freshest file contents: a concurrent provisioning of
  // another agent in the same Paseo workspace must not be clobbered. (Two
  // simultaneous creations can still race; the loser's workspace is
  // orphaned and swept by the later phase-2 GC.)
  const map = readJson(mapPath) ?? {};
  map[paseoWsId] = herdrWsId;
  writeAtomic(mapPath, map);
}

function defaultMapPath(): string {
  return join(getAgentConfigDir(), "pi-peer", "paseo-map.json");
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
