import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { readJson, safeKey, writeAtomic } from "./storage.ts";

/**
 * Cross-peer history (history v2) for the standalone pi-peer runtime.
 *
 * A peer owns its `latest/<session-id>.json` file: a bounded, oldest-first
 * list of completed conversation events (user / assistant text / tool call /
 * tool result; `thinking` is intentionally never published). `talk_latest`
 * reads this artifact only — never the peer's raw transcript.
 *
 * This module owns the "own current-lineage rebuild" for the standalone
 * runtime, so pi-peer stays source-independent of any host agent.
 */

export const HISTORY_LIMIT = 10;
export const TALK_EVENT_TYPES = ["user", "assistant", "toolCall", "toolResult"] as const;

/** A single completed conversation event a peer publishes for cross-peer reads. */
export interface TalkEvent {
  type: "user" | "assistant" | "toolCall" | "toolResult";
  /** Stable identity per event (entry id + block index) within the rebuilt history. */
  id: string;
  createdAt: string;
  message: string;
}

/**
 * Bounded, oldest-first history of completed conversation events a peer owns.
 * This is the only cross-peer artifact for `talk_latest`; the caller does not
 * read the peer's transcript directly.
 */
export interface LatestPeerHistory {
  version: 2;
  type: "latest";
  sessionId: string;
  events: TalkEvent[];
  updatedAt: string;
}

/** Minimal session entry shape used only for lineage rebuild and event extraction. */
interface SessionEntry {
  type: string;
  id: string;
  parentId?: string;
  [key: string]: unknown;
}

interface MessageEntry extends SessionEntry {
  type: "message";
  message: {
    role: "user" | "assistant" | "toolResult";
    content?: unknown;
    stopReason?: string;
  };
}

/** Runtime context needed to publish history for a peer. */
export interface HistoryRuntime {
  root: string;
  record: { sessionId: string };
}

function latestPath(root: string, sessionId: string): string {
  return join(root, "latest", `${safeKey(sessionId)}.json`);
}

function nowIso(): string {
  return new Date().toISOString();
}

export function isTalkEvent(value: any): value is TalkEvent {
  return !!value
    && typeof value.type === "string"
    && (TALK_EVENT_TYPES as readonly string[]).includes(value.type)
    && typeof value.id === "string"
    && typeof value.createdAt === "string"
    && typeof value.message === "string";
}

export function isLatestPeerHistory(value: any): value is LatestPeerHistory {
  return value?.version === 2
    && value.type === "latest"
    && typeof value.sessionId === "string"
    && Array.isArray(value.events)
    && value.events.every(isTalkEvent)
    && typeof value.updatedAt === "string";
}

export function toIsoTimestamp(value: unknown): string {
  if (typeof value === "string" && value) return value;
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  return nowIso();
}

/** Join text blocks of a message's content (string or array of blocks). */
function contentText(content: any): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string" && block.text.trim())
    .map((block) => block.text.trim())
    .join("\n")
    .trim();
}

/** Compact single-line rendering of a flat tool call block (`{type,id,name,arguments}`). */
function formatToolCall(toolCall: any): string {
  const name = typeof toolCall?.name === "string" ? toolCall.name : "tool";
  const args = toolCall?.arguments !== undefined ? toolCall.arguments : toolCall?.input;
  let input: string;
  try {
    input = typeof args === "string" ? args : JSON.stringify(args ?? {});
  } catch {
    input = String(args ?? {});
  }
  return `${name}(${input})`;
}

/**
 * Extract completed conversation events from one message object.
 *
 * Handles the official content block shapes: `text` and flat `toolCall`
 * blocks. `thinking` blocks are intentionally not published. `requireStopReason`
 * filters assistant messages that are still streaming or otherwise incomplete
 * (no terminal stopReason) when reading durable session entries; aborted
 * assistant messages are always excluded. Timestamps are normalized to ISO.
 */
export function extractEventsFromMessage(message: any, opts: { requireStopReason: boolean }): TalkEvent[] {
  const role = message?.role;
  const entryId = typeof message?.id === "string" && message.id ? message.id : "";
  const createdAt = toIsoTimestamp(message?.timestamp);
  const content = message?.content;
  const events: TalkEvent[] = [];
  let blockIndex = 0;
  // Unique per event (entry id + block index) so multiple blocks of one message
  // remain distinct in the published history.
  const push = (type: TalkEvent["type"], text: string) => {
    events.push({
      type,
      id: entryId ? `${entryId}#${blockIndex}` : `${randomUUID()}`,
      createdAt,
      message: text,
    });
    blockIndex++;
  };

  if (role === "user") {
    const text = contentText(content);
    if (text) push("user", text);
  } else if (role === "assistant") {
    if (message.stopReason === "aborted") return [];
    if (opts.requireStopReason && typeof message.stopReason !== "string") return [];
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
          push("assistant", block.text.trim());
        } else if (block?.type === "toolCall") {
          push("toolCall", formatToolCall(block));
        }
      }
    }
  } else if (role === "toolResult") {
    const text = contentText(content);
    if (text) push("toolResult", text);
  }
  return events;
}

/** Extract events from durable session entries (infrastructure/streaming excluded). */
export function entriesToTalkEvents(entries: SessionEntry[]): TalkEvent[] {
  const events: TalkEvent[] = [];
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const msg = (entry as MessageEntry).message;
    // Durable entries carry the ISO entry timestamp; prefer it for stable ordering.
    events.push(...extractEventsFromMessage({ ...msg, id: entry.id, timestamp: entry.timestamp }, { requireStopReason: true }));
  }
  return events;
}

/**
 * Own current-lineage rebuild: filter flat session entries down to the lineage
 * of the most recent leaf entry (stable ids, no duplicate risk on resume).
 *
 * Fail-closed selection: the leaf is the newest entry with a usable id that is
 * present in the id map. Trailing entries without a usable id are ignored for
 * lineage selection. If no linkable/id-bearing entry exists, an empty lineage
 * is returned (never all entries), so an obsolete branch can never be
 * published. The parentId walk stops safely on a missing id or a cycle.
 */
export function getCurrentLineageEntries<T extends SessionEntry>(entries: T[]): T[] {
  const entriesById = new Map<string, T>();
  for (const entry of entries) {
    if (typeof entry.id === "string" && entry.id.trim()) {
      entriesById.set(entry.id, entry);
    }
  }

  // Newest entry with a usable id present in the map is the lineage leaf.
  let leaf: T | undefined;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (typeof entry?.id === "string" && entry.id.trim() && entriesById.has(entry.id)) {
      leaf = entry;
      break;
    }
  }
  // No linkable entry: fail closed rather than guess across branches.
  if (!leaf) return [];

  const lineageIds = new Set<string>();
  let currentId: unknown = leaf.id;
  while (typeof currentId === "string" && currentId && !lineageIds.has(currentId)) {
    const entry = entriesById.get(currentId);
    if (!entry) break;
    lineageIds.add(currentId);
    currentId = entry.parentId;
  }
  return entries.filter((entry) => lineageIds.has(entry.id));
}

/** Read all durable entries appended to a session file. */
export function getNewEntries(sessionFile: string, afterLine: number): SessionEntry[] {
  const raw = readFileSync(sessionFile, "utf8");
  const lines = raw.split("\n").filter((line) => line.trim());
  return lines.slice(afterLine).map((line) => JSON.parse(line) as SessionEntry);
}

export function readHistory(root: string, sessionId: string): LatestPeerHistory {
  const value = readJson(latestPath(root, sessionId));
  if (isLatestPeerHistory(value) && value.sessionId === sessionId) return value;
  return { version: 2, type: "latest", sessionId, events: [], updatedAt: "" };
}

/** Persist the bounded, oldest-first history atomically (always replaces). */
export function publishHistory(runtime: HistoryRuntime, events: TalkEvent[]): void {
  const path = latestPath(runtime.root, runtime.record.sessionId);
  writeAtomic(path, {
    version: 2,
    type: "latest",
    sessionId: runtime.record.sessionId,
    events: events.slice(-HISTORY_LIMIT),
    updatedAt: nowIso(),
  } satisfies LatestPeerHistory);
}

/**
 * Rebuild the bounded history from the peer's own current lineage on
 * startup/resume and on `agent_end` (entries are persisted before the end
 * event), so ids are stable and there is no duplicate risk. Always replaces,
 * so an empty current lineage clears a stale history.
 */
export function publishHistoryFromOwnSession(runtime: HistoryRuntime, ctx: any): void {
  const sessionFile = ctx.sessionManager?.getSessionFile?.();
  if (typeof sessionFile !== "string" || !sessionFile) return;
  try {
    const entries = getCurrentLineageEntries(getNewEntries(sessionFile, 0));
    const events = entriesToTalkEvents(entries);
    publishHistory(runtime, events);
  } catch {
    // A missing or incomplete local session file must not block peer registration.
  }
}
