# pi-peer

Peer-to-peer communication between Pi coding-agent sessions running in the same HerdR workspace. Two independently running sessions can find each other, read each other's recent history, and send each other requests.

It is not a subagent framework: no delegation, no agent roles, no loop workflows, no advisor surface. Three tools, nothing else.

## Features

- **`talk_to`** — send a request to another live session and get its answer back.
- **`talk_sessions`** — list live peers, their status, and how many requests are queued for them.
- **`talk_latest`** — read a peer's most recent completed conversation events.
- **No daemon.** Peers coordinate through an atomic file mailbox in the agent directory.
- **No blind waits.** A dead peer fails a call immediately; a slow peer returns a `pending` result and wakes you later.
- **Private by default.** Thinking is never published, and no session ever reads another session's transcript.

## How it works

```
                     HerdR workspace
    ┌────────────────┐                    ┌────────────────┐
    │  Pi session A  │                    │  Pi session B  │
    │    peer-a1b    │                    │    peer-c3d    │
    └───────┬────────┘                    └───────▲────────┘
            │                                     │
            │ 1. talk_to(target="peer-c3d")       │ 2. arrives as
            ▼                                     │    a user message
    ┌───────────────────────────────────────────────────────┐
    │    <agent-dir>/pi-peer/talk/<workspace-id>/           │
    │    sessions/   inbox/   replies/   waiters/   latest/ │
    └───────────────────────────────────────────────────────┘
            ▲                                     │
            │ 4. reply, or a <peer_pong> wake     │ 3. B answers
            │    when the deadline passed         ▼
            └─────────────────────────────────────┘
```

Each session registers itself, heartbeats every 10 s, and polls its own mailbox. There is no central process to run.

## Requirements

- [Pi coding agent](https://github.com/earendil-works/pi-coding-agent) running inside a HerdR pane.
- `HERDR_ENV=1`, `HERDR_PANE_ID`, and `HERDR_SOCKET_PATH` set for each session — these provide session identity and the workspace socket.
- Node 18+ for development.

## Install

```sh
pi install git:github.com/sting8k/pi-peer
```

Tools register automatically when a Pi session starts inside a HerdR pane. Set `PI_PEER_DISABLED=1` for sessions that must not appear as peers or receive requests, and `PI_CODING_AGENT_DIR` to override the agent directory (default `~/.pi/agent`).

Migrating from the pi-roo extension, which used to bundle these tools: set `features.talk=false` in your pi-roo config, install pi-peer, then reload every Pi session. The storage namespace changed (`pi-roo/talk` → `pi-peer/talk`), so the cutover is a clean break with no dual-read migration.

## Usage

Find out who is around, then ask one of them for a second opinion:

```text
tool: talk_sessions

peer-a1b  Milo   idle  (current)
peer-c3d  Coco   working  (2 queued)
peer-e5f  Luna   idle
```

```text
tool: talk_to target="peer-c3d" message="Review my auth refactor: does the session fixation fix hold?"
```

The request is queued immediately and delivered when `peer-c3d` goes idle, as a real user message in its session. Its answer comes back as the tool result.

## Tools

### `talk_sessions`

Lists live peers, one per line: `<public-id>  <name>  <status>`. The current session is marked `(current)`, and a peer with pending inbound requests shows `(N queued)`. Status is one of `idle | working | blocked | done | unknown`. Stale panes are excluded. No parameters.

A public id is `peer-` plus the last three characters of the session id; the full session id stays internal.

Each session receives a stable friendly name from a preset pet-name pool, unique within the workspace. Reloading keeps the same name. The footer shows `<Name> · <peer-id>`; peer-to-peer tools continue to target the public peer id.

### `talk_to`

Sends a request to another live session. Returns the peer's final response if it arrives within the wait; otherwise returns a non-error `pending` result and the reply arrives later as a `<peer_pong>`.

| Name | Type | Required | Notes |
| --- | --- | --- | --- |
| `target` | string | yes | Public peer id (`peer-xxx`) or unique display name. |
| `message` | string | yes | Non-empty request message. |
| `timeoutMs` | number | no | How long THIS session blocks waiting, clamped to 1 000–3 600 000 ms. Default 60 000 ms (1 min). Not a time budget for the peer: it keeps working past this and the reply is never lost. |

When `timeoutMs` passes while the target is still working, the call returns a non-error `pending` result telling you not to resend. The reply arrives later as a `<peer_pong>` user message that wakes your session.

### `talk_latest`

Fetches the N most recent **completed** conversation events published by a peer, oldest first.

| Name | Type | Required | Notes |
| --- | --- | --- | --- |
| `target` | string | yes | Public peer id (`peer-xxx`) or unique display name. |
| `count` | integer | no | 1–10, default 1. |

```text
tool: talk_latest target="peer-c3d" count=3
```

Each peer publishes its own bounded history (max 10 events: user, assistant text, tool calls, tool results). `talk_latest` reads only that published artifact — it never touches another session's transcript, and thinking is never published. In-progress turns are excluded and flagged in the output.

## Guarantees

- **Liveness decides.** Registrations, refreshed every 10 s, are the authoritative signal. A peer that shut down cleanly fails your call immediately; a crashed one fails it once its registration goes stale (about a minute) plus two confirming checks. Dead peers cannot be listed or targeted.
- **Requests never vanish silently.** Invalid or malformed requests get an `ok=false` reply so the caller stops waiting; aborting withdraws a queued request; a request already being processed is not interrupted.
- **Fair, serial delivery.** One request at a time per receiver, oldest first, delivered only while the receiver is idle. Request cycles (A → B → A) are rejected before delivery.
- **Exactly one answer.** An in-deadline reply consumes the pending waiter, so a late `<peer_pong>` wake never duplicates it.
- **Ambiguity fails closed.** Two peers sharing a public id resolve to an error, never to a guess.

For the full flow, invariants, and cleanup rules, see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Storage

Artifacts live under `<agent-dir>/pi-peer/talk/<workspace-id>/`:

| Path | Contents |
| --- | --- |
| `sessions/` | Peer registrations, refreshed by heartbeat. |
| `inbox/` | Queued requests per target session. |
| `replies/<caller-session-id>/` | Answers written by the responding peer. |
| `waiters/<caller-session-id>/` | Pending-wake trackers owned by the caller. |
| `latest/` | Each peer's published history. |

Writes are atomic (temp file plus rename) and the mailbox directory is created with `0700` permissions. Orphaned artifacts are swept on idle; artifacts of dead sessions are collected after a 24 h TTL.

## Development

```sh
npm install
npm test                  # 43 tests (3 suites)
npm run test:focused      # 36 unit tests
npm run test:integration  # 7 mocked two-peer lifecycle tests
npm run typecheck         # tsc --noEmit
```

- `pi-extension/pi-peer/` — shipped runtime: `index.ts` (entrypoint), `service.ts` (tool registration), `schemas.ts`, `herdr.ts` (workspace identity), `history.ts`, `protocol.ts` (request/reply envelopes), `storage.ts` (atomic persistence).
- `test/peer/` — unit tests. `test/integration/` — mocked two-peer lifecycle.
- `docs/` — architecture and decisions; see `docs/decisions/0011-standalone-pi-peer-extension.md` for the packaging decision.

Distribution is GitHub-only; the package is `private: true` and is not published to npm.

## Related Work

- [Pi coding agent](https://github.com/earendil-works/pi-coding-agent) — the host whose extension API this builds on.
- HerdR — the pane/workspace environment that provides session identity and peer discovery.

## License

MIT
