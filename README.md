# pi-peer

Standalone peer-to-peer Pi communication over a HerdR workspace.

`pi-peer` is a small, standalone Pi coding-agent extension. It registers exactly
three tools — `talk_to`, `talk_sessions`, and `talk_latest` — that let two
independently running Pi sessions in the same HerdR workspace exchange
blocking requests, list each other, and read each other's bounded conversation
history. It is not a subagent framework: no delegation, no agent roles, no loop
workflows, no advisor surface.

## Why standalone

- **One purpose.** Only peer communication. Everything else (delegation, agent
  config, mux spawning, advisor) lives in separate products, not here.
- **Source independence.** The runtime has no imports from any host
  subagent/loop/advisor module. It talks to the world through the Pi extension
  API and the HerdR environment.
- **Small surface.** Three tools, no slash commands, no message renderers, no
  widgets. What you see is what ships.
- **Clean namespace.** History and mailboxes live under
  `<agent-dir>/pi-peer/talk/` — separate from any other product's storage, so a
  cutover never mixes old and new artifacts.

## Requirements

- [Pi coding agent](https://github.com/earendil-works/pi-coding-agent) with
  HerdR.
- An active HerdR pane for each Pi session (`HERDR_ENV=1`, `HERDR_PANE_ID`
  set, and `HERDR_SOCKET_PATH` pointing at the workspace socket).
- Node 18+ for development.

### Environment variables

| Variable | Meaning |
| --- | --- |
| `PI_PEER_DISABLED=1` | Opt-out: the extension entrypoint returns before registering any tool. |
| `HERDR_ENV`, `HERDR_PANE_ID` | Required: session identity and pane ownership come from these. |
| `HERDR_SOCKET_PATH` | Required, absolute path to the HerdR workspace socket. |
| `PI_CODING_AGENT_DIR` | Optional: overrides the agent directory (default `~/.pi/agent`). |

## Install

Install from GitHub:

```sh
pi install git:github.com/sting8k/pi-peer
```

`pi-peer` registers its tools when a Pi session starts inside a HerdR pane.

### Migrating from the pi-roo extension

If you already run the pi-roo extension (which used to bundle the `talk`
tools):

1. Disable the old talk tools before installing pi-peer:
   `features.talk=false` in your pi-roo config.
2. Install `pi-peer` and **reload all Pi sessions**.

The storage namespace changed (`pi-roo/talk` → `pi-peer/talk`), so the cutover
is a clean break: every peer must reload to re-register in the new namespace.
There is no dual-read migration.

## Tools

Exactly three tools are registered.

### `talk_sessions`

List live Pi peer sessions in the current HerdR workspace.

Parameters: none.

```text
tool: talk_sessions
```

Returns one line per live peer:
`<public-id>  <name>  <status>` (the current session is marked
`(current)`). When a peer has queued inbound requests (files still
present in its inbox), the line also shows `(N queued)` — e.g.
`peer-123  pi-roo  working  (2 queued)`. A peer with an empty inbox
stays in the plain format. The public id is `peer-<last 3 chars of the
session id>`
(e.g. `peer-123`) — the full session id stays internal. Status is one of
`idle | working | blocked | done | unknown`.
Stale panes (no live HerdR process) are excluded.

### `talk_latest`

Fetch the N most recent **completed** conversation events published by another
live peer. Default `count` is 1, max 10.

Parameters:

| Name | Type | Required | Notes |
| --- | --- | --- | --- |
| `target` | string | yes | Public peer id (`peer-xxx`, from `talk_sessions`) or unique display name. |
| `count` | integer | no | 1–10, default 1. |

```text
tool: talk_latest target="peer-123" count=3
```

Events are returned oldest-first. The output includes the peer's name/status and
a snapshot note when the peer's current turn is in progress
("excludes the peer's in-progress turn"). No session reads another peer's
transcript: each peer publishes history rebuilt from its own current-lineage
session, and `talk_latest` reads only that published artifact.

### `talk_to`

Send a blocking request to another live Pi session and return its final
response.

Parameters:

| Name | Type | Required | Notes |
| --- | --- | --- | --- |
| `target` | string | yes | Public peer id (`peer-xxx`, from `talk_sessions`) or unique display name. |
| `message` | string | yes | Non-empty request message. |
| `timeoutMs` | number | no | Soft timeout, clamped to 1 000–3 600 000 ms. Default 600 000 ms (10 min). When it passes with the target still alive, the call returns a non-error `pending` result and the reply arrives later via wake. |

```text
tool: talk_to target="peer-123" message="What is your independent take on the design?"
```

## Semantics

- **Resolution.** A target is a public peer id (`peer-xxx`) or a unique
  display name. Raw full session ids and id prefixes are not targets. Two
  live records with the same public id fail closed as ambiguous (never
  resolved by pick-first). Talking to the current session is rejected.
- **Peer identity.** The full session id is the internal identity used for
  artifact paths, routes, inbox/reply addressing, and history correlation.
  The public id (`peer-<last 3 chars>`) is a presentation-only alias derived
  by one central formatter; it is what `talk_sessions` returns and what
  examples lead with.
- **Queueing.** A request is queued in the target's inbox immediately and is
  delivered in filename order when the receiver's own `agent_start`/`agent_end`
  busy state is idle; request ids prefix their creation time so older requests
  are served first. The target's HerdR status is shown for context. Progress
  updates (`queued`/`processing`) are streamed while waiting.
- **Turn correlation.** When `agent_end` exposes the user prompt, the receiver
  writes a reply only if its `<peer_message>` carries the exact `request_id`;
  hosts that expose only assistant/error messages retain the compatibility
  fallback, bounded by a consecutive-idle claim watchdog (~30s).
- **Abort & timeout.** Aborting a `talk_to` call withdraws a **queued** request
  only; an already-processing request is not interrupted. The call waits until
  the exact `timeoutMs` deadline (default 10 min) and then returns a non-error
  `pending` result if the target is still alive/processing. The target's
  registration is the authoritative liveness signal: every live session
  heartbeats it (refresh every 10 s), and a missing or stale registration
  (peer shutdown or crash) fails the call immediately and withdraws the queued
  request and the waiter — no blind wait, no false pending wake.
- **Pending wake (default-on).** Every `talk_to` writes a waiter for the
  request. When the hard deadline passes while the target is **still alive /
  processing**, the call returns a **non-error `pending` result** telling the
  caller not to resend: the reply is delivered later as a real user message
  `<peer_pong ...>` that wakes the caller's session automatically. An
  in-deadline reply is returned directly and consumes the waiter — no
  duplicate wake. Abort removes both the queued request and the waiter, so no
  wake ever fires for a cancelled call.
- **Cleanup (GC).** The idle poll sweeps this session's own artifacts: a
  pending waiter whose target has died is closed with a `<peer_pong ok="false">`
  failure wake (the wake promise is kept even when the news is bad); an
  un-timed waiter older than 90 min is an orphaned wait and is removed; a
  reply without its waiter is an orphan and is removed. Session shutdown drops
  the session's own waiters and replies (so a pending "do not resend" promise
  does not survive a quit-then-restart); dead sessions' full artifact sets are
  collected cross-session after a 24 h TTL plus one 5 min re-observation grace.
- **Invalid requests are rejected, not dropped.** An inbox request that fails
  validation (malformed JSON, missing fields, route cycle, wrong receiver) is
  answered with an `ok=false` reply written to the caller's `replies/` dir as
  long as the caller session id is recoverable, so the caller's waiter is
  closed immediately instead of stranding until GC. Only a request with no
  recoverable addressing is removed without a reply.
- **Route protection.** Requests carry a route of already-visited sessions;
  cycles are rejected before a request is delivered.
- **History.** Each session publishes a bounded history (max 10 events) rebuilt
  from its **own** current-lineage session (fail-closed: if no linkable entry
  exists, nothing is published — stale history is replaced with empty). Events
  are user, assistant text, tool call, and tool result. **Thinking is never
  published.** No session ever reads **another** peer's transcript —
  `talk_latest` reads only the published artifact.
- **Busy tracking.** Inbox delivery is gated by the receiver's `selfBusy`
  flag, set from its own `agent_start`/`agent_end` events and reset at
  `session_start` so a missed end event cannot permanently block delivery. A
  peer's HerdR status is liveness/snapshot/progress information — it does not gate delivery.
- **Liveness.** Every live session heartbeats its registration (touch every
  10 s). A missing registration (shutdown) fails a `talk_to` immediately; a
  stale one (crash) fails it after two consecutive checks (~10 s). Sessions
  with a stale registration are excluded from `talk_sessions` and cannot be
  targeted. Delivery is fire-and-forget: a host-side delivery failure leaves
  the request claimed and surfaces through liveness rather than an error
  reply.
- **Opt-out.** Set `PI_PEER_DISABLED=1` for sessions that must not appear as
  peers or receive requests.

## Storage

Peer artifacts live under `<agent-dir>/pi-peer/talk/<workspace-id>/`, where
`<agent-dir>` is `PI_CODING_AGENT_DIR` or `~/.pi/agent`:

| Path | Contents |
| --- | --- |
| `sessions/` | Peer registration records (one JSON file per session). |
| `latest/` | Latest published history per peer (one JSON file per session). |
| `inbox/` | Queued requests per target session. |
| `replies/<caller-session-id>/` | Responses written by the answering peer, one file per request id. |
| `waiters/<caller-session-id>/` | Caller-owned pending wake trackers, one file per request id (written for every `talk_to`; consumed on direct reply, abort, or after a `<peer_pong>` wake). |

Writes are atomic (temp file + rename); the mailbox directory is created with
`0700` permissions. The namespace is a clean break from the legacy
`pi-roo/talk` — see [Migrating from the pi-roo extension](#migrating-from-the-pi-roo-extension).

## Development

```sh
npm install
npm test              # 31 tests (3 suites)
npm run test:focused  # 24 tests, no integration
npm run test:integration  # 6 mocked two-peer lifecycle tests
npm run typecheck     # tsc --noEmit
```

Layout:

- `pi-extension/pi-peer/` — the shipped runtime (`index.ts` entrypoint,
  `service.ts` registration, `schemas.ts`, `herdr.ts` workspace identity,
  `history.ts` bounded history, `protocol.ts` request/reply envelopes,
  `storage.ts` atomic persistence).
- `test/peer/` — unit tests (entrypoint, protocol, history, storage).
- `test/integration/` — mocked two-peer lifecycle (request/reply, busy
  queueing, history).

Documentation lives in `docs/` (see `docs/README.md`); decisions are recorded
in `docs/decisions/` (see `0011-standalone-pi-peer-extension.md` for the
packaging decision).

## Package metadata note

`name` is `pi-peer`, `version` is `1.0.0`, and `author` is `sting8k`. The
package targets the public repository `github.com/sting8k/pi-peer`
(`repository`/`homepage`/`bugs` set accordingly) and is `private: true`:
distribution is GitHub-only, with npm publishing out of scope.

## License

MIT
