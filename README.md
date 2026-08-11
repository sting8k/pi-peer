# pi-peer

Peer-to-peer chat between Pi coding-agent sessions running in the same HerdR workspace. Two independently running sessions can find each other, read each other's recent history, and send each other messages.

It is symmetric, natural chat between equal agents — not RPC or task delegation to a subagent. There is no request/response correlation, no `timeoutMs`, no waiting, and no `<peer_pong>`. Three tools, nothing else.

## Features

- **`talk_to`** — send a message to another live session. Returns **delivery confirmation only**; a reply, if any, simply arrives later as a new `<peer_message>`.
- **`talk_sessions`** — list live peers, their status, and how many messages are queued for them.
- **`talk_latest`** — read a peer's most recent completed conversation events.
- **No daemon.** Peers coordinate through an atomic file mailbox in the agent directory.
- **Send-only semantics.** `talk_to` never blocks waiting for a response; the language of the conversation is handled by the agents replying with another `talk_to` in the opposite direction.
- **Never misses a message.** A busy receiver is steered mid-turn; an idle receiver is triggered with a fresh turn. A message that fails to inject is requeued, and orphaned claims are reclaimed on startup.
- **Private by default.** Thinking is never published, and no session ever reads another session's transcript.

## How it works

```
                     HerdR workspace
    ┌────────────────┐                    ┌────────────────┐
    │  Pi session A  │                    │  Pi session B  │
    │    peer-a1b    │                    │    peer-c3d    │
    └───────┬────────┘                    └───────▲────────┘
            │                                     │
            │ talk_to(target="peer-c3d")          │ arrives as a <peer_message>
            │   = enqueue + confirm               │   user message (idle trigger)
            ▼                                     │   or steer (busy)
    ┌───────────────────────────────────────────────────────┐
    │    <agent-dir>/pi-peer/talk/<workspace-id>/           │
    │    sessions/   inbox/                          latest/ │
    └───────────────────────────────────────────────────────┘
            ▲                                     │
            │  B replies with talk_to to          │  B's reply is a new
            │  peer-a1b — also idle-triggered     │  <peer_message>
            │  or steered                          ▼
            └────────────────────────────────────────────────
```

Each session registers itself, heartbeats every 10 s, and polls its own mailbox. There is no central process to run.

A message is delivered to an **idle** receiver as a normal user message (trigger behavior) and to a **busy** receiver as a steer (`deliverAs: "steer"`) straight into its running turn — regardless of who sent it. A reply is simply another `talk_to` in the opposite direction, so whichever side is idle gets triggered and whichever is busy gets steered. Nothing ever waits for a turn boundary to *lose* a message.

## Requirements

- [Pi coding agent](https://github.com/earendil-works/pi-coding-agent) running inside a HerdR pane.
- `HERDR_ENV=1`, `HERDR_PANE_ID`, and `HERDR_SOCKET_PATH` set for each session — these provide session identity and the workspace socket.
- Node 18+ for development.

## Install

```sh
pi install npm:@sting8k/pi-peer
```

Or from GitHub:

```sh
pi install git:github.com/sting8k/pi-peer
```

Tools register automatically when a Pi session starts inside a HerdR pane. Set `PI_PEER_DISABLED=1` for sessions that must not appear as peers or receive requests, and `PI_CODING_AGENT_DIR` to override the agent directory (default `~/.pi/agent`).

Migrating from the pi-roo extension, which used to bundle these tools: set `features.talk=false` in your pi-roo config, install pi-peer, then reload every Pi session. The storage namespace changed (`pi-roo/talk` → `pi-peer/talk`), so the cutover is a clean break with no dual-read migration.

## Usage

Find out who is around, then send one of them a message:

```text
tool: talk_sessions

peer-a1b  Milo   idle  (current)
peer-c3d  Coco   working  (2 queued)
peer-e5f  Luna   idle
```

```text
tool: talk_to target="peer-c3d" message="Review my auth refactor: does the session fixation fix hold?"
```

`talk_to` returns a delivery confirmation immediately — the message is queued atomically and delivered as a `<peer_message>` in `peer-c3d`'s session: it triggers a fresh turn when the peer is idle, or steers into its running turn when it is busy. `peer-c3d` can reply with `talk_to(target="peer-a1b", "...")`, which wakes or steers you back the same way.

## Tools

### `talk_sessions`

Lists live peers, one per line: `<public-id>  <name>  <status>`. The current session is marked `(current)`, and a peer with pending inbound messages shows `(N queued)`. Status is one of `idle | working | blocked | done | unknown`. Stale panes are excluded. No parameters.

A public id is `peer-` plus the last three characters of the session id; the full session id stays internal.

Each session receives a stable friendly name from a preset pet-name pool, unique within the workspace. Reloading keeps the same name. The footer shows `<Name> · <peer-id>`; peer-to-peer tools continue to target the public peer id.

### `talk_to`

Sends a message to another live session and returns **delivery confirmation only**. A peer's later reply arrives as a new `<peer_message>` user message that wakes (idle) or steers (busy) you. Do not reply merely to acknowledge unless useful.

| Name | Type | Required | Notes |
| --- | --- | --- | --- |
| `target` | string | yes | Public peer id (`peer-xxx`) or unique display name. |
| `message` | string | yes | Non-empty message text. |

There is no `timeoutMs` and no waiting: the call returns as soon as the message is durably enqueued. Because a reply is just another `talk_to` in the opposite direction, there is no `talk_reply`, no `replyTo`, no conversation id, and no request/response correlation — the agents' own turns give the conversation its structure.

### `talk_latest`

Fetches the N most recent **completed** conversation events published by a peer, oldest first.

| Name | Type | Required | Notes |
| --- | --- | --- | --- |
| `target` | string | yes | Public peer id (`peer-xxx`) or unique display name. |
| `count` | integer | no | 1–10, default 1. |

```text
tool: talk_latest target="peer-c3d" count=3
```

Each peer publishes its own bounded history (max 10 events: user, assistant text, tool calls, tool results). Inbound `<peer_message>`s appear as `user` events and `talk_to` send confirmations as `toolResult` events, so an exchange reads coherently on both sides. `talk_latest` reads only that published artifact — it never touches another session's transcript, and thinking is never published. In-progress turns are excluded and flagged in the output.

## Guarantees

- **Liveness decides delivery.** Registrations, refreshed every 10 s, are the authoritative signal. A peer that shut down cleanly fails your `talk_to` immediately; a crashed one fails it once its registration goes stale (about a minute) plus two confirming checks. Dead peers cannot be listed or targeted.
- **Durable, at-least-once mailbox.** Every message is written atomically (temp file + rename) and claimed via a `.processing` rename before injection. The claim is held through the turn (consumed at `agent_end`), not just until the host accepts the injection. A failed injection is requeued, and orphaned `.processing` claims are reclaimed on reload/rebind and at startup, so a host-accepted-but-unconsumed message is recoverable (at-least-once). This is a host-lifecycle guarantee, not proof the model consumed the message.
- **Fair, serial delivery.** One message per poll tick, injected in per-runtime
  creation (filename) order — oldest first within a runtime. Across processes,
  messages sharing a creation timestamp have a deterministic filename order,
  but no global cross-process enqueue order is claimed. An idle receiver gets a
  fresh user turn; until `agent_start` engages it, no further plain turn is
  opened (an idle-burst latch), so a burst steers into the engaged turn rather
  than overlapping. A busy receiver is steered — regardless of sender. No
  same-caller restriction, no batch, no route/cycle machinery.
- **A reply is another `talk_to`.** No `agent_end` auto-reply, no `<peer_pong>`, no waiter, no response file. The conversation is carried by plain `<peer_message>` inbound messages.
- **Ambiguity fails closed.** Two peers sharing a public id resolve to an error, never to a guess.

For the full flow, invariants, and cleanup rules, see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Storage

Artifacts live under `<agent-dir>/pi-peer/talk/<workspace-id>/`:

| Path | Contents |
| --- | --- |
| `sessions/` | Peer registrations, refreshed by heartbeat. |
| `inbox/` | Queued chat messages per target session. |
| `latest/` | Each peer's published history. |

Writes are atomic (temp file plus rename) and the mailbox directory is created with `0700` permissions. Artifacts of dead sessions are collected after a 24 h TTL.

## Development

```sh
npm install
npm test                  # 52 tests (3 suites)
npm run test:focused      # 46 unit tests
npm run test:integration  # 6 mocked two-peer lifecycle tests
npm run typecheck         # tsc --noEmit
```

- `pi-extension/pi-peer/` — shipped runtime: `index.ts` (entrypoint), `service.ts` (tool registration), `schemas.ts`, `herdr.ts` (workspace identity), `history.ts`, `protocol.ts` (chat envelopes), `storage.ts` (atomic persistence).
- `test/peer/` — unit tests. `test/integration/` — mocked two-peer lifecycle.
- `docs/` — architecture and decisions; see `docs/decisions/0011-standalone-pi-peer-extension.md` for the packaging decision.

Distribution is GitHub-only; the package is `private: true` and is not published to npm.

## Related Work

- [Pi coding agent](https://github.com/earendil-works/pi-coding-agent) — the host whose extension API this builds on.
- HerdR — the pane/workspace environment that provides session identity and peer discovery.

## License

MIT
