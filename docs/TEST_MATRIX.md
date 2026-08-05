# Test Matrix

This matrix is the validation contract for the standalone **pi-peer**
extension. The product is peer-to-peer Pi communication over a HerdR workspace;
the only shipped surface is the three talk tools. Everything here is
executable from the repo root.

Status values: `implemented` | `partial` | `planned` | `removed`.

| Surface | Contract | Unit | Integration | E2E | Platform | Status | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Peer session talk | `talk_to`, `talk_sessions`, `talk_latest` register exactly three tools with no commands/renderers/widgets; atomic mailbox request/reply, busy queueing, abort/timeout, route-cycle rejection; bounded (10) thinking-free history rebuilt (fail-closed) from the session's own lineage; public peer id `peer-<last 3 chars>` in all user-facing output, with target resolution accepting the public id or a unique display name only (raw session ids and id prefixes are not targets; ambiguous public ids fail closed); storage under `<agent-dir>/pi-peer/talk/<workspace-id>/` with full session ids as internal keys; `PI_PEER_DISABLED=1` opt-out. | yes | yes | yes | implemented | implemented | `npm test` 27/27 pass (3 suites); `npm run test:focused` 24/24 pass; `npm run test:integration` 3/3 pass; `npm run typecheck` clean; `npm pack --dry-run` = 10 files (7 runtime sources + package.json/README/LICENSE, npm auto-included; no tests or Harness docs). Live HerdR cutover passed (slice 7, pre-dating the public-id format): two live Pi panes in one workspace discovered each other (`talk_sessions` = 2 peers), `talk_to` round-trip completed with `PI_PEER_3WAY_OK` marker, reverse `talk_sessions`/`talk_latest` reads passed (10 events, oldest-first, labels assistant/toolCall/toolResult, no thinking), and post-response history was 6 events in order with the peer idle; filesystem artifacts confirm 2 session records + 2 latest artifacts, history version 2, event counts 10 and 6, thinking events 0. Public-id live verification (slice 9) passed after both peers reloaded on the slice-8 commit: `talk_sessions` returned exactly two distinct public IDs in `peer-<last3>` format with correct current markers; `talk_latest`/`talk_to` resolved by public id (marker `PUBLIC_PEER_ID_LIVE_OK`, oldest-first, no thinking); inbound `peer_message` exposed `peer_id` equal to the sender's public id while keeping the full session id internal; a raw full-session-id target was rejected with `Peer session not found`; session registration filenames remain keyed by full internal session IDs. Collision behavior remains automated-test proven only. |

## Current Validation Commands

| Command | Scope | Notes |
| --- | --- | --- |
| `npm test` | Unit + lifecycle | Runs `test/peer/*.test.ts` and `test/integration/*.test.ts` via `tsx --test`. |
| `npm run test:focused` | Unit only | `test/peer/*.test.ts` (entrypoint, protocol, history, storage). |
| `npm run test:integration` | Two-peer lifecycle | `test/integration/*.test.ts` — mocked two-session request/reply, busy queueing, history. |
| `npm run typecheck` | Types | `tsc --noEmit`. |
| `npm pack --dry-run` | Package surface | Confirms the tarball ships only runtime sources plus npm auto-included package metadata/README/LICENSE; no tests or Harness docs. |

## Platform Matrix

| Platform | Status | Notes |
| --- | --- | --- |
| macOS/Linux (tsx, node) | implemented | Covered by unit/integration suites. |
| HerdR workspace (live panes) | implemented | Live cutover in the `pi-peer/talk` namespace passed: two live Pi panes in one workspace discovered each other, exchanged a `talk_to` request/reply (marker `PI_PEER_3WAY_OK`), and read each other's bounded histories (version 2; 10 and 6 events; thinking never published). Abort/session-switch/fail-closed remain automated-proof only. |
| Windows | not validated | Harness CLI exists for Windows; peer runtime is env-driven and expected to be OS-neutral. |
