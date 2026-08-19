# Test Matrix

This matrix is the validation contract for the standalone **pi-peer**
extension. The product is peer-to-peer Pi chat over a Herdr workspace; the only
shipped surface is the three talk tools. Everything here is executable from the
repo root.

Status values: `implemented` | `partial` | `planned` | `removed`.

| Surface | Contract | Unit | Integration | E2E | Platform | Status | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Peer session chat | `talk_to`, `talk_sessions`, `talk_latest` register exactly three tools with no commands/renderers/widgets; atomic durable mailbox (at-least-once, `.processing` claims, requeue only on synchronous injection failure, never redelivering into a live host, startup reclaim of orphans); send-only `talk_to` (enqueue + delivery confirmation, no `timeoutMs`, no waiting, no response dependency); inbound `<peer_message>` with display name + public peer id only (never the full session id or internal message id); idle receiver triggered, busy receiver steered (`deliverAs: "steer"`) regardless of sender; one message per poll tick, per-runtime creation (filename) order; reverse `talk_to` wakes idle / steers busy; no `agent_end`/`agent_settled` auto-reply, no waiter/reply/`peer_pong` artifacts; missing/dead/ambiguous target fails loudly before enqueue; `talk_to` and `talk_latest` refuse to target the current session (by public peer id or display name) and enqueue nothing; lifecycle events carrying a superseded session id (`agent_start`, `message_start`, `agent_settled`, `session_shutdown`) never touch the live runtime; bounded (10) thinking-free history rebuilt (fail-closed) from the session's own lineage; public peer id `peer-<last 3 chars>` in all user-facing output, with target resolution accepting the public id or a unique display name only (raw session ids and id prefixes are not targets; ambiguous public ids fail closed); storage under `<agent-dir>/pi-peer/talk/<workspace-id>/` with full session ids as internal keys; clean shutdown (registration removed, no fabricated reply); `PI_PEER_DISABLED=1` opt-out; stable peer names are mirrored to the Herdr agent panel in Herdr sessions and to an automatic single-pane tab label; multi-pane and non-numeric custom tab labels are preserved, while numeric custom labels are an API limitation. | yes | yes | partial | partial | implemented | `npm test` 71/71 pass (4 suites); `npm run test:focused` 64/64 pass; `npm run test:integration` 7/7 pass; `npm run typecheck` clean. Acceptance coverage: schema accepts `target`+`message` and rejects `timeoutMs`; `talk_to` returns promptly with confirmation and no response dependency; idle receiver triggered; busy receiver steered by messages from any peer; two+ queued messages are injected one-per-tick in per-runtime creation order; reverse `talk_to` wakes idle A and steers busy A; `agent_end`/`agent_settled` emits no automatic reply; no `peer_pong`/waiter/response artifacts; synchronous injection failure requeued, while an unacknowledged injection is retained (not redelivered) and startup reclaims `.processing`; dead/ambiguous target error clear; `talk_latest` shows both sides coherently; clean shutdown; Herdr panel-name normalization, single-pane tab mirroring, and session-start identity wiring. Live Windows Herdr coverage: single-pane Pi startup mirrors both agent and tab labels; a multi-pane tab mirrors agent labels without overwriting the custom tab label. Exactly-once-per-host-copy coverage models the host's real steering semantics (queue drained only after the assistant stream and every tool call, one-at-a-time): a steered message outliving the turn-start timeout, a steer accepted just before `agent_settled`, and an `input` handler rewriting the injected text each assert a single delivery; all three fail against a build that requeues unacknowledged claims. A turn started for a later message commits only its own claim: a claim whose turn-start latch already expired stays on disk for `session_start` recovery instead of being consumed by that turn's `agent_settled`. An inbound body carrying a literal `peer_message` delimiter is defanged before rendering, so a sender cannot close the tag early and forge a second block with a `from`/`peer_id` it does not own. Negative-evidence windows (F1 latch, F2 claim lifetime) wait longer than one poll tick (`POLL_MS`), so a missing latch or an early claim consumption is observable rather than hidden behind a tick that has not fired. |

## Current Validation Commands

| Command | Scope | Notes |
| --- | --- | --- |
| `npm test` | Unit + lifecycle | Runs `test/peer/*.test.ts` and `test/integration/*.test.ts` via `tsx --test`. |
| `npm run test:focused` | Unit only | `test/peer/*.test.ts` (entrypoint, protocol, history, storage). |
| `npm run test:integration` | Two-peer lifecycle | `test/integration/*.test.ts` — mocked two-session async chat: send/confirm, idle trigger, busy steer from any peer, one-per-tick in creation order, reverse talk_to, dead-target failure, history. |
| `npm run typecheck` | Types | `tsc --noEmit`. |
| `npm pack --dry-run` | Package surface | Confirms the tarball ships only runtime sources plus npm auto-included package metadata/README/LICENSE; no tests or Harness docs. |

## Platform Matrix

| Platform | Status | Notes |
| --- | --- | --- |
| macOS/Linux (tsx, node) | partial | The suites are platform-neutral, but this validation run executed on Windows; live POSIX Herdr runtime coverage remains unverified. |
| Herdr workspace (live panes) | partial | Discovery/registration and the storage namespace were validated live in the earlier RPC-era cutover; the async chat semantics (send-only `talk_to`, idle trigger, busy steer, reverse-talk reply) are automated-proof only. |
| Windows | partial | Live Herdr pane startup and agent/tab identity sync were validated on Windows; full peer-chat E2E still remains automated-only. |
