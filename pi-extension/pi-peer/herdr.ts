import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

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
}

export type HerdrAgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

interface HerdrPane {
  pane_id: string;
  terminal_id: string;
  tab_id?: string;
  workspace_id?: string;
}

interface HerdrAgentRenameResult {
  agent?: { name?: string };
}

interface HerdrTabInfo {
  label: string;
  pane_count: number;
  custom_name?: string | null;
}

interface HerdrTabRenameResult {
  tab?: { label?: string };
}

interface HerdrResponse<T> {
  result?: T;
}

const HERDR_CLI_TIMEOUT_MS = 5_000;
const HERDR_AGENT_NAME_MAX_LENGTH = 32;
const HERDR_AGENT_FALLBACK_SUFFIX_LENGTH = 8;
const AUTO_TAB_LABEL_PATTERN = /^[1-9]\d*$/;

function trimHerdrNameSuffix(value: string): string {
  let end = value.length;
  while (end > 0 && (value[end - 1] === "-" || value[end - 1] === "_")) end--;
  return value.slice(0, end);
}

/** Convert a pi-peer display name to the lowercase name accepted by Herdr. */
export function herdrAgentNameFromPeerName(name: string): string {
  let normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .slice(0, HERDR_AGENT_NAME_MAX_LENGTH);
  normalized = trimHerdrNameSuffix(normalized);
  return normalized || "pi";
}

function normalizeAgentConfigDir(value: string): string {
  let normalized = value;
  const isWindowsShellPath = process.platform === "win32"
    && normalized.startsWith("/")
    && !normalized.startsWith("//")
    && !normalized.includes("\\");
  if (isWindowsShellPath) {
    const match = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(normalized);
    if (match) normalized = `${match[1].toUpperCase()}:\\${match[2]?.replaceAll("/", "\\") ?? ""}`;
  }
  if (normalized === "~") return homedir();
  if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) {
    return join(homedir(), normalized.slice(2));
  }
  if (normalized.startsWith("file://")) return fileURLToPath(normalized);
  return normalized;
}

/** Resolve the global agent config directory, respecting PI_CODING_AGENT_DIR. */
export function getAgentConfigDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR;
  return configured
    ? normalizeAgentConfigDir(configured)
    : join(homedir(), ".pi", "agent");
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

function herdrCliErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const stderr = (error as { stderr?: unknown }).stderr;
  if (typeof stderr !== "string") return undefined;
  try {
    const parsed = JSON.parse(stderr) as { error?: { code?: unknown } };
    return typeof parsed.error?.code === "string" ? parsed.error.code : undefined;
  } catch {
    return undefined;
  }
}

function herdrAgentFallbackName(name: string, peer: HerdrPeerContext): string {
  const suffix = createHash("sha256")
    .update(`${peer.workspaceId}\u0000${peer.paneId}\u0000${peer.terminalId}`)
    .digest("hex")
    .slice(0, HERDR_AGENT_FALLBACK_SUFFIX_LENGTH);
  const base = trimHerdrNameSuffix(
    name.slice(0, HERDR_AGENT_NAME_MAX_LENGTH - suffix.length - 1),
  ) || "pi";
  return `${base}-${suffix}`;
}

function herdrPaneFrom(value: unknown): HerdrPane {
  const candidate = value && typeof value === "object"
    ? value as { pane?: Partial<HerdrPane>; agent?: Partial<HerdrPane> }
    : {};
  const pane = candidate.pane ?? candidate.agent;
  if (typeof pane?.pane_id !== "string" || typeof pane.terminal_id !== "string") {
    throw new TypeError("Herdr response did not include pane_id and terminal_id");
  }
  return pane as HerdrPane;
}

function herdrTabFrom(value: unknown): HerdrTabInfo {
  const candidate = value && typeof value === "object"
    ? value as { tab?: Partial<HerdrTabInfo> }
    : {};
  const tab = candidate.tab;
  if (typeof tab?.label !== "string" || typeof tab.pane_count !== "number") {
    throw new TypeError("Herdr response did not include complete tab information");
  }
  return tab as HerdrTabInfo;
}

export function shouldMirrorPeerNameToSinglePaneTab(tab: {
  paneCount: number;
  label: string;
  customName?: string | null;
}): boolean {
  // Prefer an explicit ownership signal when a newer Herdr API provides it.
  if (tab.customName !== undefined) return tab.paneCount === 1 && tab.customName === null;
  // Current Herdr TabInfo omits custom_name; automatic labels are the current
  // positive decimal tab position (which can differ from stable `number` after
  // a tab is closed), so never compare the label with `number` here.
  return tab.paneCount === 1 && AUTO_TAB_LABEL_PATTERN.test(tab.label);
}

export function getHerdrBinaryPath(): string {
  return process.env.HERDR_BIN_PATH || "herdr";
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
  const { stdout } = await execFileAsync(getHerdrBinaryPath(), args, {
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

async function getHerdrTabAsync(
  tabId: string,
  socketPath: string,
  options: HerdrRunAsyncOptions = {},
): Promise<HerdrTabInfo> {
  const raw = await herdrRunAsync(["tab", "get", tabId], socketPath, options);
  return herdrTabFrom(decodeHerdrJson(raw, "tab get"));
}

function herdrAgentStatusFrom(pane: HerdrPane): HerdrAgentStatus {
  const status = (pane as HerdrPane & { agent_status?: string }).agent_status;
  return status === "idle" || status === "working" || status === "blocked" || status === "done"
    ? status
    : "unknown";
}

/**
 * Establish the current peer's Herdr context. Requires Pi to run inside an
 * active Herdr pane (workspace identity originates from the pane metadata).
 */
export async function getCurrentHerdrPeerContextAsync(signal?: AbortSignal): Promise<HerdrPeerContext> {
  if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID) {
    throw new Error("Peer talk requires Pi to run inside an active Herdr pane");
  }
  const socketPath = herdrSocketPath();
  const pane = await getHerdrPaneAsync(process.env.HERDR_PANE_ID, socketPath, { signal });
  if (!pane.workspace_id) throw new Error("Herdr pane get did not include workspace_id");
  return {
    paneId: process.env.HERDR_PANE_ID,
    terminalId: pane.terminal_id,
    tabId: pane.tab_id,
    socketPath,
    workspaceId: pane.workspace_id,
  };
}

async function renameHerdrAgentAsync(
  peer: HerdrPeerContext,
  requestedName: string,
  signal?: AbortSignal,
): Promise<string> {
  const raw = await herdrRunAsync(
    ["agent", "rename", peer.paneId, requestedName],
    peer.socketPath,
    { signal },
  );
  const result = decodeHerdrJson<HerdrAgentRenameResult>(raw, "agent rename");
  if (result?.agent?.name !== requestedName) {
    throw new Error(`Herdr agent rename did not apply name ${requestedName}`);
  }
  return requestedName;
}

async function renameHerdrAgentWithFallbackAsync(
  peer: HerdrPeerContext,
  requestedName: string,
  signal?: AbortSignal,
): Promise<string> {
  try {
    return await renameHerdrAgentAsync(peer, requestedName, signal);
  } catch (error) {
    if (herdrCliErrorCode(error) !== "agent_name_taken") throw error;
    return renameHerdrAgentAsync(peer, herdrAgentFallbackName(requestedName, peer), signal);
  }
}

async function renameSinglePaneTabAsync(
  peer: HerdrPeerContext,
  name: string,
  signal?: AbortSignal,
): Promise<void> {
  // A pane can move after session_start. Resolve the tab from the pane at the
  // point of rename so a cached tab id cannot rename an unrelated tab.
  const currentPane = await getHerdrPaneAsync(peer.paneId, peer.socketPath, { signal });
  if (currentPane.workspace_id !== peer.workspaceId) {
    throw new Error("Herdr pane workspace changed before tab rename");
  }
  if (currentPane.terminal_id !== peer.terminalId) {
    throw new Error("Herdr pane terminal changed before tab rename");
  }
  const tabId = currentPane.tab_id;
  if (!tabId) return;
  const tab = await getHerdrTabAsync(tabId, peer.socketPath, { signal });
  if (!shouldMirrorPeerNameToSinglePaneTab({
    paneCount: tab.pane_count,
    label: tab.label,
    customName: tab.custom_name,
  })) return;

  const raw = await herdrRunAsync(
    ["tab", "rename", tabId, name],
    peer.socketPath,
    { signal },
  );
  const result = decodeHerdrJson<HerdrTabRenameResult>(raw, "tab rename");
  if (result?.tab?.label !== name) {
    throw new Error(`Herdr tab rename did not apply label ${name}`);
  }
}

/** Keep the current Pi's Herdr agent and auto-named single-pane tab readable. */
export async function syncCurrentHerdrIdentityAsync(
  peer: HerdrPeerContext,
  name: string,
  signal?: AbortSignal,
): Promise<void> {
  const requestedName = herdrAgentNameFromPeerName(name);
  let appliedName = requestedName;
  let agentError: unknown;

  try {
    appliedName = await renameHerdrAgentWithFallbackAsync(peer, requestedName, signal);
  } catch (error) {
    agentError = error;
  }

  // Mirror the tab only once the agent panel accepted the name; otherwise the
  // tab would advertise a name the agent never took.
  if (!agentError) {
    try {
      await renameSinglePaneTabAsync(peer, appliedName, signal);
    } catch (error) {
      console.error("pi-peer Herdr single-pane tab rename failed", error);
    }
  }

  if (agentError) throw agentError;
}

export function herdrPeerIdentityMatches(
  peer: Pick<HerdrPeerContext, "workspaceId" | "terminalId">,
  current: Pick<HerdrPane, "workspace_id" | "terminal_id" | "tab_id">,
): boolean {
  // A pane may move between tabs without becoming a different peer. Workspace
  // and terminal identity remain stable; tab identity is refreshed for labels.
  return current.workspace_id === peer.workspaceId
    && current.terminal_id === peer.terminalId;
}

/**
 * Verify a peer's identity is unchanged and read its live agent status.
 * A pane move within the same workspace/terminal remains live; moves across
 * workspaces or terminals are treated as a different peer.
 */
export async function getHerdrPeerStatusAsync(
  peer: HerdrPeerContext,
  signal?: AbortSignal,
): Promise<HerdrAgentStatus> {
  const current = await getHerdrPaneAsync(peer.paneId, peer.socketPath, { signal });
  if (!herdrPeerIdentityMatches(peer, current)) {
    throw new Error("Herdr peer identity changed");
  }
  return herdrAgentStatusFrom(current);
}
