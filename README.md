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
`(current)`). The public id is `peer-<last 3 chars of the session id>`
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
| `timeoutMs` | number | no | Soft timeout, clamped to 1 000–3 600 000 ms. Default 600 000 ms (10 min). |

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
  delivered when the receiver's own `agent_start`/`agent_end` busy state is
  idle; the target's HerdR status is shown for context. Progress updates
  (`queued`/`processing`) are streamed while waiting.
- **Abort & timeout.** Aborting a `talk_to` call withdraws a **queued** request
  only; an already-processing request is not interrupted. A soft timeout fires
  at `timeoutMs` (default 10 min); while HerdR still confirms the target is
  live, the wait continues up to a hard deadline of `max(timeoutMs, 10 min)`.
  If the target is no longer live, the call fails.
- **Route protection.** Requests carry a route of already-visited sessions;
  cycles are rejected before a request is delivered.
- **History.** Each session publishes a bounded history (max 10 events) rebuilt
  from its **own** current-lineage session (fail-closed: if no linkable entry
  exists, nothing is published — stale history is replaced with empty). Events
  are user, assistant text, tool call, and tool result. **Thinking is never
  published.** No session ever reads **another** peer's transcript —
  `talk_latest` reads only the published artifact.
- **Busy tracking.** Inbox delivery is gated by the receiver's `selfBusy`
  flag, set from its own `agent_start`/`agent_end` events. A peer's HerdR
  status is liveness/snapshot/progress information — it does not gate delivery.
- **Liveness.** Peer records are removed on `session_shutdown`; sessions whose
  HerdR pane is no longer alive are excluded from `talk_sessions` and delivery
  failures surface as errors.
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

Writes are atomic (temp file + rename); the mailbox directory is created with
`0700` permissions. The namespace is a clean break from the legacy
`pi-roo/talk` — see [Migrating from the pi-roo extension](#migrating-from-the-pi-roo-extension).

## Development

```sh
npm install
npm test              # 27 tests (3 suites)
npm run test:focused  # 24 tests, no integration
npm run test:integration  # 3 mocked two-peer lifecycle tests
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
