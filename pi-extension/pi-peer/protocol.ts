import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

import { readJson, safeKey, writeAtomic } from "./storage.ts";
import type { HerdrAgentStatus, HerdrPeerContext } from "./herdr.ts";

/**
 * Peer-talk wire protocol (protocol v1) and mailbox operations for the
 * standalone pi-peer runtime.
 *
 * Invariants of the peer-talk protocol:
 *  - HerdR-only, workspace identity verified on every status read,
 *  - atomic mailbox writes (`writeAtomic`) with queued -> `.processing` state,
 *  - route cycle rejection via `resolveTarget`/`routeForRequest`,
 *  - abort semantics via AbortSignal propagation through every wait.
 *
 * This module is source-independent: no dependency on any host agent extension.
 */

export interface PeerRecord {
  schemaVersion: 1;
  sessionId: string;
  name: string;
  cwd: string;
  workspaceId: string;
  paneId: string;
  terminalId: string;
  tabId?: string;
  registrationId?: string;
  createdAt: string;
}

export interface TalkRequest {
  version: 1;
  type: "request";
  id: string;
  from: string;
  to: string;
  message: string;
  route: string[];
  createdAt: string;
}

export interface TalkResponse {
  version: 1;
  type: "response";
  requestId: string;
  from: string;
  to: string;
  ok: boolean;
  message?: string;
  error?: string;
  createdAt: string;
}

export type TalkProgressState = "queued" | "processing";
export type TalkProgressDetails = {
  source: "talk_to";
  requestId: string;
  target: string;
  targetStatus: HerdrAgentStatus;
  state: TalkProgressState;
};

export const POLL_MS = 250;
export const STATUS_POLL_MS = 5_000;
export const DEFAULT_TIMEOUT_MS = 600_000;

/**
 * Derive the public peer id from a full session id: `peer-<last 3 chars>`.
 *
 * The full session id stays the internal identity (artifact paths, routes,
 * inbox/reply addressing, history source); this is the only user-facing
 * formatter. A session id shorter than 3 characters yields the whole id as
 * the suffix (`peer-a`, `peer-ab`); an empty input fails closed (records
 * guarantee non-empty session ids).
 */
export function publicPeerId(sessionId: string): string {
  if (!sessionId) throw new Error("publicPeerId requires a non-empty session id");
  return `peer-${sessionId.slice(-3)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function sessionDir(root: string): string {
  return join(root, "sessions");
}

export function inboxDir(root: string, sessionId: string): string {
  return join(root, "inbox", safeKey(sessionId));
}

export function repliesDir(root: string, sessionId: string): string {
  return join(root, "replies", safeKey(sessionId));
}

export function recordPath(root: string, sessionId: string): string {
  return join(sessionDir(root), `${safeKey(sessionId)}.json`);
}

export function isPeerRecord(value: any): value is PeerRecord {
  return value?.schemaVersion === 1
    && typeof value.sessionId === "string"
    && value.sessionId.length > 0
    && typeof value.name === "string"
    && typeof value.cwd === "string"
    && typeof value.workspaceId === "string"
    && typeof value.paneId === "string"
    && typeof value.terminalId === "string"
    && (value.tabId === undefined || typeof value.tabId === "string")
    && (value.registrationId === undefined || typeof value.registrationId === "string")
    && typeof value.createdAt === "string";
}

export function isTalkRequest(value: any): value is TalkRequest {
  return value?.version === 1
    && value.type === "request"
    && typeof value.id === "string"
    && value.id.length > 0
    && typeof value.from === "string"
    && value.from.length > 0
    && typeof value.to === "string"
    && value.to.length > 0
    && typeof value.message === "string"
    && typeof value.createdAt === "string"
    && Array.isArray(value.route)
    && value.route.length > 0
    && value.route.every((entry: unknown) => typeof entry === "string" && entry.length > 0)
    && value.route.at(-1) === value.from
    && new Set(value.route).size === value.route.length;
}

export function isTalkResponse(value: any): value is TalkResponse {
  return value?.version === 1
    && value.type === "response"
    && typeof value.requestId === "string"
    && value.requestId.length > 0
    && typeof value.from === "string"
    && value.from.length > 0
    && typeof value.to === "string"
    && value.to.length > 0
    && typeof value.ok === "boolean"
    && typeof value.createdAt === "string"
    && (value.ok ? typeof value.message === "string" : typeof value.error === "string");
}

export function ensureRecord(root: string, record: PeerRecord): void {
  const path = recordPath(root, record.sessionId);
  if (!existsSync(path)) writeAtomic(path, record);
}

export function removeOwnedRecord(root: string, record: PeerRecord): void {
  if (!record.registrationId) return;
  const path = recordPath(root, record.sessionId);
  const current = readJson(path);
  if (isPeerRecord(current) && current.registrationId === record.registrationId) {
    rmSync(path, { force: true });
  }
}

export function loadRecords(root: string): PeerRecord[] {
  if (!existsSync(sessionDir(root))) return [];
  return readdirSync(sessionDir(root))
    .filter((name) => name.endsWith(".json"))
    .map((name) => readJson(join(sessionDir(root), name)))
    .filter(isPeerRecord);
}

export function extractAssistantText(messages: any[] | undefined): string | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "assistant" || message.stopReason === "aborted") continue;
    const blocks = Array.isArray(message.content) ? message.content : [];
    const text = blocks
      .filter((block: any) => block?.type === "text" && typeof block.text === "string")
      .map((block: any) => block.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return null;
}

export function resolveTarget(records: PeerRecord[], target: string): PeerRecord {
  const publicMatches = records.filter((record) => publicPeerId(record.sessionId) === target);
  if (publicMatches.length === 1) return publicMatches[0];
  if (publicMatches.length > 1) throw new Error(`Peer id is ambiguous: ${target}`);
  const exactName = records.filter((record) => record.name === target);
  if (exactName.length === 1) return exactName[0];
  if (exactName.length > 1) throw new Error(`Peer name is ambiguous: ${target}`);
  throw new Error(`Peer session not found: ${target}`);
}

export function routeForRequest(runtime: { activeRequest: TalkRequest | null; record: PeerRecord }): string[] {
  return runtime.activeRequest
    ? [...runtime.activeRequest.route, runtime.record.sessionId]
    : [runtime.record.sessionId];
}

export function requeueProcessing(root: string, sessionId: string): void {
  const dir = inboxDir(root, sessionId);
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir).filter((entry) => entry.endsWith(".processing"))) {
    const processing = join(dir, name);
    const pending = join(dir, name.slice(0, -".processing".length));
    if (existsSync(pending)) rmSync(processing, { force: true });
    else renameSync(processing, pending);
  }
}

export async function waitForDelay(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Aborted"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function waitForResponse(
  root: string,
  request: TalkRequest,
  timeoutMs: number,
  peer: HerdrPeerContext,
  getStatus: (peerContext: HerdrPeerContext, signal?: AbortSignal) => Promise<HerdrAgentStatus>,
  signal?: AbortSignal,
  onState?: (state: TalkProgressState) => void,
): Promise<TalkResponse> {
  const path = join(repliesDir(root, request.from), `${request.id}.json`);
  const pendingPath = join(inboxDir(root, request.to), `${request.id}.json`);
  const processingPath = `${pendingPath}.processing`;
  const softDeadline = Date.now() + timeoutMs;
  const hardDeadline = Date.now() + Math.max(timeoutMs, DEFAULT_TIMEOUT_MS);
  let statusCheckAt = softDeadline;
  let reportedProcessing = false;
  try {
    while (Date.now() <= hardDeadline) {
      if (signal?.aborted) throw new Error("Aborted");
      if (!reportedProcessing && existsSync(processingPath)) {
        reportedProcessing = true;
        onState?.("processing");
      }
      const value = readJson(path);
      if (
        isTalkResponse(value)
        && value.requestId === request.id
        && value.from === request.to
        && value.to === request.from
      ) {
        if (!reportedProcessing) {
          reportedProcessing = true;
          onState?.("processing");
        }
        rmSync(path, { force: true });
        return value;
      }
      const now = Date.now();
      if (now >= statusCheckAt) {
        try {
          await getStatus(peer, signal);
        } catch {
          if (signal?.aborted) throw new Error("Aborted");
          break;
        }
        statusCheckAt = now + STATUS_POLL_MS;
      }
      await waitForDelay(POLL_MS, signal);
    }
    throw new Error(`Peer ${publicPeerId(request.to)} did not reply before timeout`);
  } catch (error) {
    rmSync(pendingPath, { force: true });
    throw error;
  }
}

export async function liveRecords(
  root: string,
  workspaceId: string,
  socketPath: string,
  getStatus: (peerContext: HerdrPeerContext, signal?: AbortSignal) => Promise<HerdrAgentStatus>,
  signal?: AbortSignal,
): Promise<Array<{ record: PeerRecord; status: HerdrAgentStatus }>> {
  const result: Array<{ record: PeerRecord; status: HerdrAgentStatus }> = [];
  for (const record of loadRecords(root)) {
    if (record.workspaceId !== workspaceId) continue;
    try {
      const status = await getStatus({
        paneId: record.paneId,
        terminalId: record.terminalId,
        tabId: record.tabId,
        socketPath,
        workspaceId,
      }, signal);
      result.push({ record, status });
    } catch {
      // A stale or moved HerdR pane is not a live peer.
    }
  }
  return result;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function requestMessage(request: TalkRequest, fromName: string): string {
  return [
    `<peer_message request_id="${escapeAttribute(request.id)}" from="${escapeAttribute(fromName)}" from_session="${escapeAttribute(request.from)}" peer_id="${escapeAttribute(publicPeerId(request.from))}">`,
    "Another Pi session is asking for your independent response.",
    "Respond normally. Your final assistant response will be returned to the sender automatically.",
    "",
    request.message,
    "</peer_message>",
  ].join("\n");
}

/** Build a request id for a new talk_to request. */
export function newRequestId(): string {
  return `req_${randomUUID()}`;
}