# Architecture

This document describes the architecture of the standalone **pi-peer**
extension: a peer-to-peer chat runtime for Pi sessions running inside
a Herdr workspace. It supersedes the earlier pi-roo subagent/loop architecture
and the prior request/response (RPC) peer-talk protocol.

## Runtime Shape

The shipped runtime is a single package under `pi-extension/pi-peer/`:

| File | Responsibility |
| --- | --- |
| `index.ts` | Standalone entrypoint; reads `PI_PEER_DISABLED`, registers exactly three tools (`talk_sessions`, `talk_latest`, `talk_to`). |
| `service.ts` | Tool registration, session/busy lifecycle, inbox drain + message injection. |
| `schemas.ts` | TypeBox parameter schemas for the three tools. |
| `herdr.ts` | Herdr workspace identity (`HERDR_ENV`, `HERDR_PANE_ID`, absolute `HERDR_SOCKET_PATH`), peer status/liveness, talk root directory. |
| `history.ts` | Bounded event history (max 10 events, no thinking), current-lineage rebuild, publish/read. |
| `protocol.ts` | `PeerRecord` / `PeerMessage` envelopes, atomic mailbox paths, `publicPeerId` (single user-facing id formatter: `peer-<last 3 chars of session id>`), and the inbound `<peer_message>` renderer. |
| `storage.ts` | Atomic JSON persistence (`safeKey`, write-temp-then-rename). |

The package registers **no** slash commands, no message renderers, and no
widgets. There is no delegation, no agent configuration, no loop executor, and
no mux spawning anywhere in the runtime.

## Product Boundaries

| Boundary | Where | Notes |
| --- | --- | --- |
| Entrypoint | `pi-extension/pi-peer/index.ts` | `PI_PEER_DISABLED=1` returns before registration. |
| Tool contracts | `pi-extension/pi-peer/schemas.ts` | `talk_sessions` (none), `talk_latest` (`target`, `count` 1–10), `talk_to` (`target`, `message` only — no `timeoutMs`). |
| Runtime | `pi-extension/pi-peer/service.ts` | Registration, lifecycle hooks, busy tracking, inbox dispatch. |
| History | `pi-extension/pi-peer/history.ts` | v2: max 10 events, current-lineage rebuild, no thinking. |
| Protocol | `pi-extension/pi-peer/protocol.ts` | v1 chat envelopes, atomic mailbox paths, inbound renderer. |
| Storage | `<agent-dir>/pi-peer/talk/<workspace-id>/` | `sessions/`, `latest/`, `inbox/`. |
| Workspace identity | `pi-extension/pi-peer/herdr.ts` | Herdr pane env + socket; verified on every liveness read. |
| Tests | `test/peer/`, `test/integration/` | Unit + mocked two-peer lifecycle. |
| Harness | `docs/`, `harness.db` | Generic Harness process; product docs describe only pi-peer. |

## Peer Chat Flow

```
session_start ──► reset selfBusy + ensureRuntime: write sessions/<session-id>.json
                      │  requeue orphaned inbox/*.json.processing
                      │  publish latest/<session-id>.json (current lineage)
agent_start ──────────► busy = true
   │  (inbox drain on idle interval)
   ▼
inbox/<peer-id>/*.json ──► sendUserMessage(<peer_message>, deliverAs: "steer" if busy)
   │  idle: plain user message (trigger); busy: steer — regardless of sender
agent_end ──► busy = false; publish latest/<session-id>.json (no automatic reply)
   │
talk_to caller: resolve live target → writeAtomic(inbox/<peer-id>/<msg-id>.json)
   └─ returns delivery confirmation immediately; never waits for a response
session_shutdown ──► remove sessions/<session-id>.json, stop polling
```

There is no response/wake path: a reply is simply another `talk_to` from the
peer, which enqueues a message into the original sender's inbox and is
delivered by *that* peer's own drain (idle trigger or busy steer). No waiter,
no reply file, no `<peer_pong>`.

### Invariants

- A session may inject **one** inbox message per poll tick. Within a runtime,
  messages are injected in per-runtime creation (filename) order. Message ids
  carry a base36 creation timestamp prefix; across processes, messages sharing
  a timestamp have deterministic filename order but no claimed global enqueue
  order.
- `selfBusy` resets synchronously at `session_start`, so a missed `agent_end`
  cannot permanently block inbox delivery.
- An **idle** receiver gets the message as a normal user message (trigger
  behavior); a **busy** receiver gets it steered into its running turn via
  `deliverAs: "steer"` — regardless of who sent it. There is no same-caller or
  batch-root restriction.
- A message is never delivered to its own session (resolved targets exclude
  the current session). There is no route/cycle machinery because there is no
  request/response propagation.
- Every message is written **durably** via `writeAtomic` (temp file + rename)
  and claimed by an atomic `.processing` rename before injection. The claim is
  held through the host turn (consumed at `agent_end`). If injection fails the
  claim is requeued; orphaned `.processing` files are reclaimed on reload/rebind
  and at startup, so a host-accepted-but-unconsumed message is recoverable
  (at-least-once). An orphaned claim whose rendered `<peer_message>` is already
  persisted as a user message in the session transcript (e.g. the process was
  killed mid-turn, then resumed) is consumed instead of requeued, so resume
  never replays it. This is a host-lifecycle guarantee, not proof the model
  consumed the message.
- `agent_end` produces **no automatic reply** — a reply is a separate `talk_to`
  the agent chooses to send. No `<peer_pong>`, no response generation.
- History is **bounded** (10 events) and **thinking-free**; it is rebuilt from
  the session's own current lineage at `session_start` and `agent_end`, so ids
  are stable and nothing duplicates. Lineage selection is fail-closed: if no
  linkable entry exists, an empty history is published (stale history is
  cleared), never a cross-branch guess. Inbound `<peer_message>`s surface as
  `user` events and `talk_to` confirmations as `toolResult` events.
- No session reads **another** peer's transcript: each peer publishes history
  rebuilt from its own current-lineage session, and `talk_latest` reads only
  the published `latest/<session-id>.json` artifact.
- Registration records are removed at `session_shutdown`; panes that are no
  longer alive on the Herdr socket are excluded from discovery, and a `talk_to`
  to a missing/dead/ambiguous target fails loudly **before** any enqueue.
- Identity is dual-layer: the **full session id** is the internal identity
  (artifact paths, inbox addressing, history source), while the **public peer
  id** (`peer-<last 3 chars>`) is a presentation-only alias used in tool output,
  target resolution, and the inbound `<peer_message>` tag. One central formatter
  owns the mapping; two live records with the same public id fail closed as
  ambiguous (never pick-first). The inbound tag exposes only the display name
  and public peer id — never the full session id or the internal message id.
- Writes are atomic (temp file + rename) and the mailbox directory is created
  with mode `0700`.

## Storage Layout

```
<agent-dir>/pi-peer/talk/<workspace-id>/
├── sessions/<session-id>.json        # registration
├── latest/<session-id>.json          # bounded event history
└── inbox/<peer-id>/<msg-id>.json     # queued chat messages
```

`<agent-dir>` is `PI_CODING_AGENT_DIR` or `~/.pi/agent`. Workspace ids and peer
ids are sanitized with `safeKey`. Artifact paths always use the **full session
id** — the public peer id is only a display/resolution alias and never a
storage key. The namespace is a clean break from the
legacy `pi-roo/talk`; there is no dual-read migration.

## Herdr Requirement

The extension is Herdr-only:

- Each Pi session must run inside an active Herdr pane (`HERDR_ENV=1`,
  `HERDR_PANE_ID` set).
- `HERDR_SOCKET_PATH` must be an absolute path to the workspace socket.
- Workspace identity is derived from the pane's Herdr metadata and verified
  with the CLI on each status read, so records for dead panes are never
  presented as live peers.

## Removed Surfaces

The following surfaces are intentionally absent: the pi-roo subagent/loop
surfaces (`call_agents`, `show_report`, `subagents_list`, `subagent_resume`,
agent mode commands, loop workflows, mux spawning, the advisor subsystem) **and
the RPC request/response machinery of the earlier peer-talk protocol** — the
active request batch/root and same-caller amendments, automatic `agent_end`
reply, `correlatePeerRequestTurn` / `extractAssistantText` / response
generation, the `waiters/` and `replies/` directories, `wakePendingPongs`,
`<peer_pong>` formatting, the active-request watchdog, `timeoutMs` and all
waiting/status-poll knobs, route/cycle machinery, and shutdown terminal
responses. The result is one symmetric send primitive (`talk_to`), normal
inbound `<peer_message>`s, and no response bookkeeping.
