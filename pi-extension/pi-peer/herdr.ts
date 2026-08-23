import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import { safeKey } from "./storage.ts";

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

function decodeHerdrJson<T>(stdout: string, operation: string): T {
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
}

async function herdrRunAsync(
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
  const raw = await herdrRunAsync(["pane", "get", paneId], socketPath, options);
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
 * Establish the current peer's Herdr context. Requires Pi to run inside an
 * active Herdr pane (workspace identity originates from the pane metadata).
 */
export async function getCurrentHerdrPeerContextAsync(signal?: AbortSignal): Promise<HerdrPeerContext> {
  if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID) {
    throw new HerdrUnavailableError();
  }
  const socketPath = herdrSocketPath();
  const pane = await getHerdrPaneAsync(process.env.HERDR_PANE_ID, socketPath, { signal });
  if (!pane.workspace_id) throw new Error("Herdr pane get did not include workspace_id");
  // Tab metadata is cosmetic (label surface selection only): a failed or
  // malformed probe must degrade to `paneCount: undefined` (pane surface)
  // rather than fail the bind — identity comes from pane/workspace, not this.
  const paneCount = pane.tab_id ? await probePaneCountAsync(pane.tab_id, socketPath, { signal }) : undefined;
  return {
    paneId: process.env.HERDR_PANE_ID,
    terminalId: pane.terminal_id,
    tabId: pane.tab_id,
    socketPath,
    workspaceId: pane.workspace_id,
    paneCount,
  };
}

/**
 * Verify a peer's identity is unchanged and read its live agent status.
 * Throws if the pane moved to another workspace/tab/terminal.
 */
export async function getHerdrPeerStatusAsync(
  peer: HerdrPeerContext,
  signal?: AbortSignal,
): Promise<HerdrAgentStatus> {
  const current = await getHerdrPaneAsync(peer.paneId, peer.socketPath, { signal });
  if (current.workspace_id !== peer.workspaceId || current.tab_id !== peer.tabId || current.terminal_id !== peer.terminalId) {
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
 * bar is their only name surface). `herdr tab rename` has no --clear; an
 * empty label restores default rendering. Best-effort, swallow errors.
 */
export async function renameTabAsync(tabId: string, label: string, signal?: AbortSignal): Promise<void> {
  await herdrRunAsync(["tab", "rename", tabId, label], undefined, { signal });
}

export async function clearTabLabelAsync(tabId: string, signal?: AbortSignal): Promise<void> {
  await herdrRunAsync(["tab", "rename", tabId, ""], undefined, { signal });
}