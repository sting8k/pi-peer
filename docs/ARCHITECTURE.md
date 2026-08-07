# Architecture

This document describes the architecture of the standalone **pi-peer**
extension: a peer-to-peer communication runtime for Pi sessions running inside
a HerdR workspace. It supersedes the earlier pi-roo subagent/loop architecture.

## Runtime Shape

The shipped runtime is a single package under `pi-extension/pi-peer/`:

| File | Responsibility |
| --- | --- |
| `index.ts` | Standalone entrypoint; reads `PI_PEER_DISABLED`, registers exactly three tools (`talk_sessions`, `talk_latest`, `talk_to`). |
| `service.ts` | Tool registration, session/busy lifecycle, inbox drain, request dispatch, response capture. |
| `schemas.ts` | TypeBox parameter schemas for the three tools. |
| `herdr.ts` | HerdR workspace identity (`HERDR_ENV`, `HERDR_PANE_ID`, absolute `HERDR_SOCKET_PATH`), peer status/liveness, talk root directory. |
| `history.ts` | Bounded event history (max 10 events, no thinking), current-lineage rebuild, publish/read. |
| `protocol.ts` | `PeerRecord` / `TalkRequest` / `TalkResponse` envelopes, route construction and envelope validation, atomic mailbox paths, abort semantics, `waitForResponse`, `publicPeerId` (single user-facing id formatter: `peer-<last 3 chars of session id>`). Route-cycle rejection is enforced at service execution. |
| `storage.ts` | Atomic JSON persistence (`safeKey`, write-temp-then-rename). |

The package registers **no** slash commands, no message renderers, and no
widgets. There is no delegation, no agent configuration, no loop executor, and
no mux spawning anywhere in the runtime.

## Product Boundaries

| Boundary | Where | Notes |
| --- | --- | --- |
| Entrypoint | `pi-extension/pi-peer/index.ts` | `PI_PEER_DISABLED=1` returns before registration. |
| Tool contracts | `pi-extension/pi-peer/schemas.ts` | `talk_sessions` (none), `talk_latest` (`target`, `count` 1–10), `talk_to` (`target`, `message`, `timeoutMs`). |
| Runtime | `pi-extension/pi-peer/service.ts` | Registration, lifecycle hooks, busy tracking, inbox dispatch, route-cycle rejection. |
| History | `pi-extension/pi-peer/history.ts` | v2: max 10 events, current-lineage rebuild, no thinking. |
| Protocol | `pi-extension/pi-peer/protocol.ts` | v1 envelopes, route construction/envelope validation, atomic mailbox paths. |
| Storage | `<agent-dir>/pi-peer/talk/<workspace-id>/` | `sessions/`, `latest/`, `inbox/`, `replies/`. |
| Workspace identity | `pi-extension/pi-peer/herdr.ts` | HerdR pane env + socket; verified on every liveness read. |
| Tests | `test/peer/`, `test/integration/` | Unit + mocked two-peer lifecycle. |
| Harness | `docs/`, `harness.db` | Generic Harness process; product docs describe only pi-peer. |

## Peer Talk Flow

```
session_start ──► reset selfBusy + ensureRuntime: write sessions/<session-id>.json
                      │  publish latest/<session-id>.json (current lineage)
agent_start ──────────► busy = true
   │  (inbox drain on idle interval)
   ▼
inbox/<peer-id>/*.json ──► agent_start/user turn ──► sendUserMessage(peer_message)
   │  agent_end ──► busy = false
   │              ├─ publish latest/<session-id>.json
   │              └─ write replies/<caller-session-id>/<request-id>.json (final assistant text)
   ▼
talk_to caller: waitForResponseOrPending(replies/<caller-session-id>/<request-id>.json)
   ├─ reply in deadline ──► completed, consume reply + waiter (no wake)
   └─ hard deadline, target alive ──► pending, keep waiter
        │  (idle poll: wakePendingPongs)
        ▼
   waiters/<caller-session-id>/*.json + replies/… ──► sendUserMessage(peer_pong) ──► consume reply + waiter
session_shutdown ──► remove sessions/<session-id>.json, stop polling
```

### Invariants

- A session may process **one** inbox request at a time; requests are consumed
  in filename order while the peer is idle. Request ids carry a base36 creation
  timestamp prefix so this order follows enqueue time.
- `selfBusy` resets synchronously at `session_start`, so a missed `agent_end` cannot permanently block inbox delivery.
- `agent_end` correlates the completed turn to the claimed request's
  `<peer_message request_id="…">` when the host exposes a user message;
  assistant-only/error events use the compatibility fallback, bounded by a
  consecutive-idle claim watchdog (~30s).
- A request is never delivered to its own session, and never routed through a
  session it has already visited (route cycles rejected).
- History is **bounded** (10 events) and **thinking-free**; it is rebuilt from
  the session's own current lineage at `session_start` and `agent_end`, so ids
  are stable and nothing duplicates. Lineage selection is fail-closed: if no
  linkable entry exists, an empty history is published (stale history is
  cleared), never a cross-branch guess.
- No session reads **another** peer's transcript: each peer publishes history
  rebuilt from its own current-lineage session, and `talk_latest` reads only
  the published `latest/<session-id>.json` artifact.
- Registration records are removed at `session_shutdown`; panes that are no
  longer alive on the HerdR socket are excluded from discovery and cause
  delivery failures rather than silent drops. Invalid/malformed inbox requests
  are rejected with an `ok=false` reply whenever the caller's session id is
  recoverable, so a caller's waiter is closed instead of stranded.
- Identity is dual-layer: the **full session id** is the internal identity
  (artifact paths, routes, inbox/reply addressing, history source), while the
  **public peer id** (`peer-<last 3 chars>`) is a presentation-only alias used
  in tool output and target resolution. One central formatter owns the
  mapping; two live records with the same public id fail closed as ambiguous
  (never pick-first).
- Writes are atomic (temp file + rename) and the mailbox directory is created
  with mode `0700`.
- Every `talk_to` writes a caller-owned **waiter** before the inbox write.
  An in-deadline reply or an abort consumes the waiter immediately; a hard
  deadline with a live target keeps it (marked `timedOutAt`) so the caller can
  be woken later. The idle poll delivers exactly one `<peer_pong>` user message
  per pending reply and only then consumes the reply + waiter; a failed send
  leaves both files for retry (host delivery is fire-and-forget, so the retry
  path is only reachable when the runtime itself is no longer active).

## Storage Layout

```
<agent-dir>/pi-peer/talk/<workspace-id>/
├── sessions/<session-id>.json        # registration
├── latest/<session-id>.json          # bounded event history
├── inbox/<peer-id>/<request-id>.json # queued requests
├── replies/<caller-session-id>/<request-id>.json  # responses
└── waiters/<caller-session-id>/<request-id>.json  # pending wake trackers
```

`<agent-dir>` is `PI_CODING_AGENT_DIR` or `~/.pi/agent`. Workspace ids and peer
ids are sanitized with `safeKey`. Artifact paths always use the **full session
id** — the public peer id is only a display/resolution alias and never a
storage key. The namespace is a clean break from the
legacy `pi-roo/talk`; there is no dual-read migration.

## HerdR Requirement

The extension is HerdR-only:

- Each Pi session must run inside an active HerdR pane (`HERDR_ENV=1`,
  `HERDR_PANE_ID` set).
- `HERDR_SOCKET_PATH` must be an absolute path to the workspace socket.
- Workspace identity is derived from the pane's HerdR metadata and verified
  with the CLI on each status read, so records for dead panes are never
  presented as live peers.

## Removed Surfaces

The following surfaces from the old pi-roo extension are intentionally absent:
`call_agents`, `show_report`, `subagents_list`, `subagent_resume`, agent mode
commands (`/code`, `/reviewer`, `/scout`, `/orchestrator`, `/plan`), loop
workflows, the running-subagent widget, mux spawning (cmux/tmux/zellij/WezTerm),
and the persistent advisor subsystem. Related decisions (`0007`,
`0008`) and stories were retired with the pi-roo product; peer decisions
`0009`/`0010` remain, with packaging/eligibility/storage portions superseded by
`0011-standalone-pi-peer-extension.md`.
