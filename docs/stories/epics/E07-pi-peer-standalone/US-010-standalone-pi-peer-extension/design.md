# Design — US-010 Standalone Pi-Peer Extension

## Domain Model

| Entity | Definition |
| --- | --- |
| `PeerRecord` | Registration for a live Pi session: `sessionId` (full id, internal identity), `name`, `cwd`, `workspaceId`, HerdR pane/terminal/tab, `registrationId`, `createdAt`. |
| `TalkRequest` | Versioned request envelope: `id`, `from`, `to`, `message`, `route` (visited session ids), `createdAt`. |
| `TalkResponse` | Versioned response envelope: `requestId`, `from`, `to`, `ok`, `message` or `error`, `createdAt`. |
| `TalkEvent` | Completed conversation event published by a session: `type` (user/assistant/toolCall/toolResult), `id`, `createdAt`, `message`. |
| `LatestPeerHistory` | Bounded per-peer history artifact: up to 10 `TalkEvent`s, rebuilt from the session's own current lineage. |
| `HerdrPeerContext` | Workspace identity resolved from HerdR pane env + CLI: `workspaceId`, `paneId`, `terminalId`, `tabId`, `socketPath`. |

Business rules:

- A session processes at most one inbox request at a time, in filename order,
  while idle.
- Requests to self are rejected; requests that would revisit a session already
  on the route are rejected (cycle protection).
- History is bounded (10 events) and never includes thinking; each peer
  rebuilds history from its own current-lineage session, and no session reads
  another peer's transcript.
- `PI_PEER_DISABLED=1` short-circuits the entrypoint before registration.
- Identity is dual-layer: the full `sessionId` is the internal identity for
  artifact paths, routes, inbox/reply addressing, and history source; the
  public peer id (`peer-<last 3 chars of session id>`) is a
  presentation-only alias derived by one central formatter and used in tool
  output and target resolution. Two live records with the same public id fail
  closed as ambiguous (never pick-first).

## Application Flow

- `session_start` → ensure runtime, write `sessions/<session-id>.json`,
  publish `latest/<session-id>.json` from the session's own lineage.
- Inbox drain (idle interval) → read `inbox/<peer-id>/*.json`, deliver via
  `sendMessage` with `customType: talk_request`, track as active request.
- `agent_start` → busy = true (self-tracked). `agent_end` → busy = false,
  republish history, and if an active request exists write
  `replies/<caller-session-id>/<request-id>.json` with the final assistant text.
- `talk_to` → resolve target, route-check, write request to target inbox,
  stream `queued`/`processing`, wait for response (soft timeout / abort).
- `talk_latest` → read target's `latest/<session-id>.json`, slice last N
  events, annotate in-progress turns.
- `talk_sessions` → list live records for the workspace, filter dead panes via
  HerdR status.
- `session_shutdown` → remove own registration, stop polling.

## Interface Contract

Tools (exactly three):

| Tool | Parameters | Errors |
| --- | --- | --- |
| `talk_sessions` | — | none |
| `talk_latest` | `target` (string, required), `count` (integer 1–10, default 1) | unknown/unresolvable target; no completed events |
| `talk_to` | `target` (string, required), `message` (string, required), `timeoutMs` (number, optional, clamped 1 000–3 600 000) | self-target; route cycle; target not live; timeout/abort; peer error |

Target resolution: public peer id (`peer-xxx`) or unique display name; raw
session ids and id prefixes are not targets; ambiguous public ids fail
closed.

## Data Model

```
<agent-dir>/pi-peer/talk/<workspace-id>/
├── sessions/<session-id>.json
├── latest/<session-id>.json
├── inbox/<peer-id>/<request-id>.json
└── replies/<caller-session-id>/<request-id>.json
```

- `<agent-dir>` = `PI_CODING_AGENT_DIR` or `~/.pi/agent`.
- All writes atomic (temp + rename); mailbox dir mode `0700`; keys sanitized
  via `safeKey`.
- No dual-read of the legacy `pi-roo/talk` namespace; cutover is a clean break
  and peers reload to re-register.

## UI / Platform Impact

- HerdR-only: `HERDR_ENV=1`, `HERDR_PANE_ID`, absolute `HERDR_SOCKET_PATH`.
- No slash commands, no message renderers, no widgets.
- `PI_PEER_DISABLED=1` for opt-out. OS-neutral; validated on macOS/Linux,
  Windows not validated.

## Observability

- Tool progress updates (`queued`/`processing`/`completed`) with request id and
  target.
- Publish/read history artifacts as the cross-session audit trail.
- Session record removal at shutdown; dead-pane exclusion on every status read.
- Harness: durable rows unavailable (CLI absent in this checkout); story
  `US-010` validation is the executable + doc proof.

## Alternatives Considered

1. Keep talk inside pi-roo — rejected (forces subagent/loop/advisor surface on
   every peer).
2. Dual-read old + new namespaces — rejected (migration surface, stale-artifact
   risk; lineage rebuild makes clean break safe).
3. Wholesale merge of the branch into pi-roo main — rejected (standalone
   package; separate lifecycle).
