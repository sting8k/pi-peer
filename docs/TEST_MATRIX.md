# Test Matrix

This matrix is the validation contract for the standalone **pi-peer**
extension. The product is peer-to-peer Pi chat over a HerdR workspace; the only
shipped surface is the three talk tools. Everything here is executable from the
repo root.

Status values: `implemented` | `partial` | `planned` | `removed`.

| Surface | Contract | Unit | Integration | E2E | Platform | Status | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Peer session chat | `talk_to`, `talk_sessions`, `talk_latest` register exactly three tools with no commands/renderers/widgets; atomic durable mailbox (at-least-once, `.processing` claims, requeue on failed injection, startup reclaim of orphans); send-only `talk_to` (enqueue + delivery confirmation, no `timeoutMs`, no waiting, no response dependency); inbound `<peer_message>` with display name + public peer id only (never the full session id or internal message id); idle receiver triggered, busy receiver steered (`deliverAs: "steer"`) regardless of sender; one message per poll tick, FIFO; reverse `talk_to` wakes idle / steers busy; no `agent_end` auto-reply, no waiter/reply/`peer_pong` artifacts; missing/dead/ambiguous target fails loudly before enqueue; bounded (10) thinking-free history rebuilt (fail-closed) from the session's own lineage; public peer id `peer-<last 3 chars>` in all user-facing output, with target resolution accepting the public id or a unique display name only (raw session ids and id prefixes are not targets; ambiguous public ids fail closed); storage under `<agent-dir>/pi-peer/talk/<workspace-id>/` with full session ids as internal keys; clean shutdown (registration removed, no fabricated reply); `PI_PEER_DISABLED=1` opt-out. | yes | yes | no | implemented | implemented | `npm test` 51/51 pass (3 suites); `npm run test:focused` 45/45 pass; `npm run test:integration` 6/6 pass; `npm run typecheck` clean. Acceptance coverage: schema accepts `target`+`message` and rejects `timeoutMs`; `talk_to` returns promptly with confirmation and no response dependency; idle receiver triggered; busy receiver steered by messages from any peer; two+ queued messages preserve FIFO and one-per-tick; reverse `talk_to` wakes idle A and steers busy A; `agent_end` emits no automatic reply; no `peer_pong`/waiter/response artifacts; failed injection requeued and startup reclaims `.processing`; dead/ambiguous target error clear; `talk_latest` shows both sides coherently; clean shutdown. |

## Current Validation Commands

| Command | Scope | Notes |
| --- | --- | --- |
| `npm test` | Unit + lifecycle | Runs `test/peer/*.test.ts` and `test/integration/*.test.ts` via `tsx --test`. |
| `npm run test:focused` | Unit only | `test/peer/*.test.ts` (entrypoint, protocol, history, storage). |
| `npm run test:integration` | Two-peer lifecycle | `test/integration/*.test.ts` — mocked two-session async chat: send/confirm, idle trigger, busy steer from any peer, FIFO one-per-tick, reverse talk_to, dead-target failure, history. |
| `npm run typecheck` | Types | `tsc --noEmit`. |
| `npm pack --dry-run` | Package surface | Confirms the tarball ships only runtime sources plus npm auto-included package metadata/README/LICENSE; no tests or Harness docs. |

## Platform Matrix

| Platform | Status | Notes |
| --- | --- | --- |
| macOS/Linux (tsx, node) | implemented | Covered by unit/integration suites. |
| HerdR workspace (live panes) | partial | Discovery/registration and the storage namespace were validated live in the earlier RPC-era cutover; the async chat semantics (send-only `talk_to`, idle trigger, busy steer, reverse-talk reply) are automated-proof only. |
| Windows | not validated | Harness CLI exists for Windows; peer runtime is env-driven and expected to be OS-neutral. |
