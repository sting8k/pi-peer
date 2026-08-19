# Product Overview — pi-peer

**pi-peer** is a standalone Pi coding-agent extension that enables peer-to-peer
chat between independently running Pi sessions inside a Herdr workspace. It is
symmetric, natural chat between equal agents — not RPC or task delegation to a
subagent.

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
                shared Herdr workspace (HERDR_SOCKET_PATH)
```

Each session keeps a stable friendly peer name. The Pi footer shows that name
with its public peer id, and the Herdr agent panel uses the lowercase name so
multiple Pi panes are easy to distinguish. If the current tab contains only
that pane and still has its automatic number label, the tab is mirrored to the
same name. Herdr currently exposes numeric custom labels the same way as automatic labels, so a manually named numeric-only tab cannot be distinguished and may be mirrored. Herdr name conflicts receive a deterministic short suffix.

## Tools

| Tool | Purpose | Parameters |
| --- | --- | --- |
| `talk_sessions` | List live peers in the current Herdr workspace. | none |
| `talk_latest` | Read the N most recent **completed** events a peer published. | `target` (required), `count` (1–10, default 1) |
| `talk_to` | Send a chat message to a peer; returns **delivery confirmation only**. | `target` (required), `message` (required) |

Resolution: public peer id (`peer-xxx`, from `talk_sessions`) or unique
display name; raw full session ids and id prefixes are not targets. Two live
records with the same public id fail closed as ambiguous. Talking to the
current session is rejected. The full session id stays the internal identity
for artifact paths, inbox addressing, and history correlation; the public id
is a presentation-only alias derived by one central formatter.

## Semantics

- **Send-only `talk_to`.** A message is durably enqueued in the target's inbox
  and `talk_to` returns delivery confirmation immediately. It never waits for a
  response. There is no `timeoutMs`, no `talk_reply`, no `replyTo`, no
  conversation id, and no request/response correlation.
- **Inbound delivery.** A message arrives as a `<peer_message>` user message. An
  **idle** receiver is triggered with a fresh turn; a **busy** receiver is
  steered into its running turn (`deliverAs: "steer"`) — regardless of who sent
  it (no same-caller restriction). One message is delivered per poll tick.
  Delivery is sequential: within a runtime, messages are injected in their
  per-runtime creation (filename) order, oldest first. Across processes,
  messages sharing a creation timestamp have a deterministic filename order,
  but no global enqueue order is claimed.
- **Reply.** A reply is simply another `talk_to` in the opposite direction,
  which wakes (idle) or steers (busy) the original sender the same way. Pi's
  fire-and-forget `sendUserMessage` is acknowledged by `message_start`; claims
  are consumed only at `agent_settled`. Durability is recoverable at-least-once:
  a synchronously failed injection is requeued immediately, while an
  unacknowledged one keeps its claim rather than being handed back to a host
  that may still hold it. Orphaned `.processing` claims are reclaimed on
  reload/rebind and at startup, so a host-accepted-but-unconsumed message is
  recoverable through the host turn — not proof the model consumed it.
- **No RPC state machine.** There is no automatic `agent_end`/`agent_settled` reply, no waiter,
  no response file, and no `<peer_pong>`. The conversation is carried by plain
  inbound messages; the agents' own turns give it structure.
- **History.** Bounded (max 10 events) per-peer history of **completed**
  events: user, assistant text, tool call, tool result. Thinking is never
  published; each peer rebuilds history from its own current-lineage session
  (fail-closed: no linkable entry means nothing is published — stale history is
  replaced with empty), and no session reads another peer's transcript. Inbound
  `<peer_message>`s appear as `user` events and `talk_to` confirmations as
  `toolResult` events, so an exchange reads coherently on both sides.
- **Liveness.** Registration records are removed at `session_shutdown`; dead
  panes are excluded, and a `talk_to` to a missing/dead/ambiguous target fails
  loudly before any enqueue.
- **Opt-out.** `PI_PEER_DISABLED=1` prevents registration entirely.

## Runtime Requirements

| Requirement | Value |
| --- | --- |
| Pi | `@earendil-works/pi` / `@earendil-works/pi-coding-agent` extension API, `>=0.84.2` (peer dependency). |
| Herdr | Active pane per session: `HERDR_ENV=1`, `HERDR_PANE_ID`, absolute `HERDR_SOCKET_PATH`. |
| Agent dir | `PI_CODING_AGENT_DIR` or `~/.pi/agent`; storage under `pi-peer/talk/<workspace-id>/`. |
| Opt-out | `PI_PEER_DISABLED=1`. |

## Validation

The executable proof is `npm test` (64 tests, 3 suites), `npm run test:focused`
(58 unit/lifecycle tests), `npm run test:integration` (6 mocked two-peer lifecycle tests),
and `npm run typecheck` (clean). See `docs/TEST_MATRIX.md` for the acceptance
matrix.
