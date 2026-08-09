# Product Overview — pi-peer

**pi-peer** is a standalone Pi coding-agent extension that enables peer-to-peer
communication between independently running Pi sessions inside a HerdR
workspace.

It ships exactly three tools — `talk_sessions`, `talk_latest`, and `talk_to` —
and nothing else: no delegation, no agent roles, no loop workflows, no advisor,
no slash commands, no widgets. The product contract is defined here, in
`README.md`, and in `docs/TEST_MATRIX.md`; the runtime lives in
`pi-extension/pi-peer/`.

## User-Facing Model

```
┌──────────────────────────┐          ┌──────────────────────────┐
│ Pi session A (pane 1)    │          │ Pi session B (pane 2)    │
│  talk_to / talk_latest / │  mailbox │  talk_to / talk_latest / │
│  talk_sessions           │ ◄──────► │  talk_sessions           │
│  pi-peer/talk/<ws>       │  +history│  pi-peer/talk/<ws>       │
└──────────────────────────┘          └──────────────────────────┘
                shared HerdR workspace (HERDR_SOCKET_PATH)
```

## Tools

| Tool | Purpose | Parameters |
| --- | --- | --- |
| `talk_sessions` | List live peers in the current HerdR workspace. | none |
| `talk_latest` | Read the N most recent **completed** events a peer published. | `target` (required), `count` (1–10, default 1) |
| `talk_to` | Send a request to a peer; return its final response, or a `pending` result whose reply arrives later via wake. | `target` (required), `message` (required), `timeoutMs` (optional) |

Resolution: public peer id (`peer-xxx`, from `talk_sessions`) or unique
display name; raw full session ids and id prefixes are not targets. Two live
records with the same public id fail closed as ambiguous. Talking to the
current session is rejected. The full session id stays the internal identity
for artifact paths, routes, inbox/reply addressing, and history correlation;
the public id is a presentation-only alias derived by one central formatter.

## Semantics

- **Queueing.** A request is queued in the target's inbox immediately and is
  delivered when the receiver is idle (its own `agent_start`/`agent_end` busy
  state); the target's HerdR status is shown for context. Progress updates
  (`queued`/`processing`) are streamed.
- **Abort & timeout.** Abort withdraws a queued request only
  (already-processing work is not interrupted). The wait ends after the exact
  `timeoutMs` (default 1 min, clamped 1 000–3 600 000 ms); a live target that
  has not replied by then yields a non-error `pending` result and the reply
  arrives later via wake.
- **History.** Bounded (max 10 events) per-peer history of **completed**
  events: user, assistant text, tool call, tool result. Thinking is never
  published; each peer rebuilds history from its own current-lineage session
  (fail-closed: no linkable entry means nothing is published — stale history is
  replaced with empty), and no session reads another peer's transcript.
- **Route protection.** Requests carry a route of visited sessions; cycles are
  rejected before delivery.
- **Liveness.** Registration records are removed at `session_shutdown`; dead
  panes are excluded and delivery failures surface as errors.
- **Opt-out.** `PI_PEER_DISABLED=1` prevents registration entirely.

## Runtime Requirements

| Requirement | Value |
| --- | --- |
| Pi | `@earendil-works/pi-coding-agent` extension API (peer dependency). |
| HerdR | Active pane per session: `HERDR_ENV=1`, `HERDR_PANE_ID`, absolute `HERDR_SOCKET_PATH`. |
| Agent dir | `PI_CODING_AGENT_DIR` or `~/.pi/agent`; storage under `pi-peer/talk/<workspace-id>/`. |
| Opt-out | `PI_PEER_DISABLED=1`. |

## Validation

See `docs/TEST_MATRIX.md` for the matrix. Current executable proof:

- `npm test` — 22 tests, 3 suites (unit + lifecycle).
- `npm run test:focused` — 19 unit tests.
- `npm run test:integration` — 3 mocked two-peer lifecycle tests.
- `npm run typecheck` — clean.

Live new-namespace HerdR cutover passed (story `US-010`): two live Pi panes in
one workspace discovered each other and exchanged a `talk_to` request/reply
(marker `PI_PEER_3WAY_OK`), with reverse discovery/read passes and history
artifacts (version 2, thinking never published). Package metadata
(author/repository) is unchanged until release (documented debt).
