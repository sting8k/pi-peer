import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import { readJson, safeKey } from "./storage.ts";

const execFileAsync = promisify(execFile);

/**
 * Herdr-only peer integration for the standalone pi-peer runtime.
 *
 * This module owns the two things a peer needs from the host mux:
 *  - the current peer's Herdr context (workspace identity), and
 *  - live status of other peers (workspace identity verification).
 *
 * It deliberately stays source-independent of any host agent or mux runtime.
 */

export interface HerdrPeerContext {
  paneId: string;
  terminalId: string;
  tabId?: string;
  socketPath: string;
  workspaceId: string;
  /** Talk-room namespace override. Defaults to the workspace. Provisioned
   * directory rooms (paseo.ts) share one talk root per project directory;
   * a herdr-pane session in that directory joins the same room when one
   * already exists — identity (labels, status) stays with its own pane. */
  roomId?: string;
  /** Panes in the owning tab, read at bind time. 1 means the tab bar is the
   * only visible name surface; >1 means pane labels are visible. */
  paneCount?: number;
}

export type HerdrAgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

interface HerdrPane {
  pane_id: string;
  terminal_id: string;
  tab_id?: string;
  workspace_id?: string;
  cwd?: string;
}

interface HerdrResponse<T> {
  result?: T;
}

const HERDR_CLI_TIMEOUT_MS = 5_000;

/**
 * Expected condition: Pi is not running inside a Herdr pane, so the peer
 * runtime is simply unavailable (tools fail with a clear message; bind logs
 * one quiet line instead of a stack trace).
 */
export class HerdrUnavailableError extends Error {
  constructor(message = "Peer talk requires Pi to run inside an active Herdr pane") {
    super(message);
    this.name = "HerdrUnavailableError";
  }
}

/** Resolve the global agent config directory, respecting PI_CODING_AGENT_DIR. */
export function getAgentConfigDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

/**
 * Namespace for peer-talk storage: `<agent dir>/pi-peer/talk/<workspace-id>`.
 * Isolates pi-peer artifacts from any other extension namespace.
 */
export function getTalkRootDir(workspaceId: string): string {
  // Sanitize at the owner seam so no caller can introduce a path traversal.
  return join(getAgentConfigDir(), "pi-peer", "talk", safeKey(workspaceId));
}

function herdrSocketPath(): string {
  const socketPath = process.env.HERDR_SOCKET_PATH;
  if (!socketPath || !isAbsolute(socketPath)) {
    throw new Error("Herdr backend requires an absolute HERDR_SOCKET_PATH");
  }
  return socketPath;
}

export function decodeHerdrJson<T>(stdout: string, operation: string): T {
  try {
    const parsed = JSON.parse(stdout) as T | HerdrResponse<T>;
    if (parsed && typeof parsed === "object" && "result" in parsed) {
      return (parsed as HerdrResponse<T>).result as T;
    }
    return parsed as T;
  } catch (error) {
    throw new Error(
      `Herdr ${operation} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function herdrPaneFrom(value: unknown): HerdrPane {
  const candidate = value && typeof value === "object"
    ? value as { pane?: Partial<HerdrPane>; agent?: Partial<HerdrPane> }
    : {};
  const pane = candidate.pane ?? candidate.agent;
  if (typeof pane?.pane_id !== "string" || typeof pane.terminal_id !== "string") {
    throw new Error("Herdr response did not include pane_id and terminal_id");
  }
  return pane as HerdrPane;
}

interface HerdrRunAsyncOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Injectable runner seam (tests pass fakes through probe/context calls). */
  run?: typeof herdrRunAsync;
}

export async function herdrRunAsync(
  args: string[],
  socketPath = herdrSocketPath(),
  options: HerdrRunAsyncOptions = {},
): Promise<string> {
  const { stdout } = await execFileAsync("herdr", args, {
    encoding: "utf8",
    env: { ...process.env, HERDR_SOCKET_PATH: socketPath },
    signal: options.signal,
    timeout: options.timeoutMs ?? HERDR_CLI_TIMEOUT_MS,
  });
  return stdout;
}

async function getHerdrPaneAsync(
  paneId: string,
  socketPath: string,
  options: HerdrRunAsyncOptions = {},
): Promise<HerdrPane> {
  const run = options.run ?? herdrRunAsync;
  const raw = await run(["pane", "get", paneId], socketPath, options);
  return herdrPaneFrom(decodeHerdrJson(raw, "pane get"));
}

function herdrAgentStatusFrom(pane: HerdrPane): HerdrAgentStatus {
  const status = (pane as HerdrPane & { agent_status?: string }).agent_status;
  return status === "idle" || status === "working" || status === "blocked" || status === "done"
    ? status
    : "unknown";
}

/**
 * Best-effort pane count of the owning tab (label surface selection only).
 * Any failure — CLI error, timeout, malformed JSON, missing field — degrades
 * to `undefined` (callers fall back to the pane surface); it must NEVER fail
 * the peer bind. Injectable `run` for unit tests.
 */
export async function probePaneCountAsync(
  tabId: string,
  socketPath: string,
  options?: { signal?: AbortSignal; run?: typeof herdrRunAsync },
): Promise<number | undefined> {
  try {
    const run = options?.run ?? herdrRunAsync;
    const raw = await run(["tab", "get", tabId], socketPath, { signal: options?.signal });
    const tab = decodeHerdrJson<{ tab?: { pane_count?: number } }>(raw, "tab get");
    const count = tab?.tab?.pane_count;
    return typeof count === "number" ? count : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Best-effort display name of a workspace (what a released tab should show).
 * Degrades to undefined on any failure; callers fall back to the workspace id.
 */
export async function probeWorkspaceNameAsync(
  workspaceId: string,
  socketPath: string,
  options?: { signal?: AbortSignal; run?: typeof herdrRunAsync },
): Promise<string | undefined> {
  try {
    const run = options?.run ?? herdrRunAsync;
    const raw = await run(["workspace", "get", workspaceId], socketPath, { signal: options?.signal });
    const decoded = decodeHerdrJson<{ workspace?: { label?: string } }>(raw, "workspace get");
    const label = decoded?.workspace?.label;
    return typeof label === "string" && label.trim() ? label : undefined;
  } catch {
    return undefined;
  }
}

/** Shared paseo-room map (paseo.ts provisions, this module bridges): keys are
 * canonical directory paths, values `{ room, panes }` entries (schema v2). */
export function defaultPaseoMapPath(): string {
  return join(getAgentConfigDir(), "pi-peer", "paseo-map.json");
}

/** Canonical map key for a directory (trailing slashes collapse; root stays "/"). */
export function canonicalDirKey(cwd: string): string {
  return cwd.replace(/\/+$/, "") || "/";
}

/** Herdr-pane bridge: the room of this directory, when one is provisioned.
 * Reads both map shapes: schema v2 `{ room, panes }` and the legacy flat
 * "dir → wsId" value (normalized away on the next provision write). */
export function lookupDirectoryRoom(
  cwd: string | undefined,
  mapPath = defaultPaseoMapPath(),
): string | undefined {
  if (!cwd) return undefined;
  const entry = readJson(mapPath)?.[canonicalDirKey(cwd)];
  const room = entry && typeof entry === "object" ? (entry as { room?: unknown }).room : entry;
  return typeof room === "string" && room ? room : undefined;
}

export interface HerdrContextResolveOptions {
  /** Injectable herdr CLI runner for the legacy pane path (tests). */
  run?: typeof herdrRunAsync;
  /** Injectable paseo provisioning step (tests); defaults to ./paseo.ts. */
  provisionPaseo?: (signal?: AbortSignal) => Promise<HerdrPeerContext>;
}

/**
 * Establish the current peer's Herdr context. Resolver chain:
 *  1. `HERDR_ENV=1` + `HERDR_PANE_ID` — bound by a Herdr pane (unchanged).
 *  2. `PASEO_AGENT_ID` — agent spawned by the Paseo daemon (no HERDR_* env);
 *     provisions a Herdr workspace 1:1 with its Paseo workspace (./paseo.ts).
 *  3. Otherwise the peer runtime is simply unavailable.
 */
export async function getCurrentHerdrPeerContextAsync(
  signal?: AbortSignal,
  options: HerdrContextResolveOptions = {},
): Promise<HerdrPeerContext> {
  if (process.env.HERDR_ENV === "1" && process.env.HERDR_PANE_ID) {
    const socketPath = herdrSocketPath();
    const pane = await getHerdrPaneAsync(process.env.HERDR_PANE_ID, socketPath, { signal, run: options.run });
    if (!pane.workspace_id) throw new Error("Herdr pane get did not include workspace_id");
    // Tab metadata is cosmetic (label surface selection only): a failed or
    // malformed probe must degrade to `paneCount: undefined` (pane surface)
    // rather than fail the bind — identity comes from pane/workspace, not this.
    const paneCount = pane.tab_id
      ? await probePaneCountAsync(pane.tab_id, socketPath, { signal, run: options.run })
      : undefined;
    return {
      paneId: process.env.HERDR_PANE_ID,
      terminalId: pane.terminal_id,
      tabId: pane.tab_id,
      socketPath,
      workspaceId: pane.workspace_id,
      // Directory-room bridge: if a paseo-provisioned room already exists for
      // this pane's directory, join its talk root so pane sessions and
      // paseo-spawned agents in the same folder see each other. Identity
      // (label surface, status checks) stays with the pane's own workspace;
      // no room is ever provisioned from this branch.
      roomId: lookupDirectoryRoom(pane.cwd),
      paneCount,
    };
  }
  if (process.env.PASEO_AGENT_ID) {
    if (options.provisionPaseo) return options.provisionPaseo(signal);
    // Dynamic import: paseo.ts statically depends on this module, so the
    // chain must not create a static module cycle.
    const { provisionPaseoHerdrContextAsync } = await import("./paseo.ts");
    return provisionPaseoHerdrContextAsync(signal);
  }
  throw new HerdrUnavailableError();
}

/**
 * Verify a peer's identity is unchanged and read its live agent status.
 * Identity = pane + workspace + terminal; throws if the pane moved to
 * another workspace or terminal. Tab is NOT identity: `herdr pane move`
 * within a workspace keeps pane_id/terminal_id and only changes tab_id,
 * so a tab change must not fail liveness (the record's tabId is cosmetic).
 */
export async function getHerdrPeerStatusAsync(
  peer: HerdrPeerContext,
  signal?: AbortSignal,
  options: HerdrRunAsyncOptions = {},
): Promise<HerdrAgentStatus> {
  const current = await getHerdrPaneAsync(peer.paneId, peer.socketPath, { signal, run: options.run });
  if (current.workspace_id !== peer.workspaceId || current.terminal_id !== peer.terminalId) {
    throw new Error("Herdr peer identity changed");
  }
  return herdrAgentStatusFrom(current);
}

/**
 * Label a pane with a display name (cosmetic, best-effort).
 * `herdr pane rename` sets the pane `label` field without touching the
 * terminal's own title escape sequences. Errors must be swallowed by callers.
 */
export async function renamePaneAsync(paneId: string, label: string, signal?: AbortSignal): Promise<void> {
  await herdrRunAsync(["pane", "rename", paneId, label], undefined, { signal });
}

/**
 * Remove a pane's display label (cosmetic, best-effort). Used on shutdown so
 * a dead pane does not keep advertising a peer name. Errors must be swallowed.
 */
export async function clearPaneLabelAsync(paneId: string, signal?: AbortSignal): Promise<void> {
  await herdrRunAsync(["pane", "rename", paneId, "--clear"], undefined, { signal });
}

/**
 * Label a tab (single-pane sessions have no visible pane labels; the tab
 * bar is their only name surface). `herdr tab rename` has no --clear and
 * an empty label renders as a blank tab — to release a tab, rename it to
 * the workspace name instead (see service.ts). Best-effort, swallow errors.
 */
export async function renameTabAsync(tabId: string, label: string, signal?: AbortSignal): Promise<void> {
  await herdrRunAsync(["tab", "rename", tabId, label], undefined, { signal });
}
