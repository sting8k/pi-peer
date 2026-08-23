# US-009 Peer Pi Session Talk

## Status

implemented

## Lane

normal

## Product Contract

Pi sessions running in the same Herdr workspace can discover one another and exchange blocking request/reply messages through a small filesystem mailbox protocol. Sessions are peers: the pi-peer extension does not create, own, restart, or inspect another session's transcript.

## Relevant Product Docs

- `README.md`
- `docs/product/overview.md`
- `docs/ARCHITECTURE.md`
- `docs/TEST_MATRIX.md`

## Acceptance Criteria

- `talk_sessions` lists live peer Pi sessions in the current Herdr workspace by public peer id (`peer-xxx`) and display name.
- `talk_latest({ target, count? })` returns the most recent completed conversation events (user messages, assistant text, tool calls, tool results; thinking is never published) ordered oldest-first, with peer status, warning when it excludes an in-progress turn, without the caller reading the target's transcript. `count` defaults to 1, min 1, max 10; out-of-range or non-integer values are rejected.
- On startup/resume and on `agent_end`, a peer rebuilds its bounded history of up to 10 completed conversation events from its own current lineage (entries are persisted before the end event), so event ids are stable and there is no duplicate risk.
- `talk_to({ target, message, timeoutMs? })` resolves a public peer id or unique display name and blocks until the target returns its final assistant response.
- A busy target queues inbound requests and processes one at a time when idle; `talk_to` emits `queued` and `processing` tool updates as the envelope advances.
- Requests and responses use versioned atomic JSON envelopes correlated by request id.
- A route carried through nested calls rejects calls back to an ancestor session.
- Timeout and abort withdraw a request while it remains queued, but do not interrupt an already-started target turn, retry, spawn, restart, or read another session's transcript.
- Sessions started with `PI_PEER_DISABLED=1` do not join the peer registry.
- The advisor tools, profile, lifecycle, and public documentation are retired.

## Design Notes

- Tools: `talk_sessions`, `talk_latest`, `talk_to`.
- `talk_latest` reads the peer's bounded history artifact (`talk/<workspace-id>/latest/<session-id>.json`), never the transcript; the publisher owns the history (bounded to 10 events, rebuilt from its own durable current lineage on startup/resume and on `agent_end`).
- Scope: current Herdr workspace only.
- Storage: `<agent-dir>/pi-peer/talk/<workspace-id>/{sessions,latest,inbox,replies}` (agent-dir = `PI_CODING_AGENT_DIR` or `~/.pi/agent`; clean break from the legacy `pi-roo/talk` namespace, see decision `0011`).
- Registry liveness: verify the registered Herdr pane at list/send time; no heartbeat.
- Delivery: receiver extension polls its inbox while idle, injects one visible custom message, and captures the final assistant output from `agent_end`.
- Recovery: startup requeues the current session's claimed `.processing` request.
- Non-goals: broker, acknowledgements, retries, in-flight turn cancellation, priority, full transcript access, auto-spawn/restart, distributed deadlock detection.

## Validation

| Layer | Expected proof |
| --- | --- |
| Unit | Envelope validation, target resolution, route cycle protection, atomic mailbox claim/requeue, progress updates, snapshot labeling, reply extraction, `count` validation, event extraction for real event types (thinking skipped), bounded-history truncation, empty-lineage clear, stale v1-artifact rejection, resume without duplicates. |
| Integration | Tool registration and mocked two-session queued/processing/request/reply lifecycle. |
| E2E | Not required for implementation; live Herdr smoke **passed** in slice 7 (see `US-010` validation). |
| Platform | Herdr workspace/pane identity and live status verification. |
| Release | `npm test`; `npm run test:integration`. |

## Harness Delta

- Added accepted decision `0009-peer-session-talk.md`, superseding decision 0008, and `0010-peer-talk-history-count.md`.
- Retired the advisor row and added peer talk proof in the human-readable matrix.
- Standalone cutover (2026-08-05): added `0011-standalone-pi-peer-extension.md` (supersedes packaging/eligibility/storage portions of 0009/0010), retired the pi-roo subagent docs/stories/decisions, and added high-risk story `US-010` tracking the extraction (see `docs/stories/epics/E07-pi-peer-standalone/`).
- The required `scripts/bin/harness-cli` binary is absent from this checkout, so durable intake, story proof, decision, backlog, and trace rows could not be recorded.

## Evidence

- `npm test`: 27/27 pass (3 suites) — entrypoint registration, envelope validation, target resolution, route cycle protection, atomic mailbox claim/requeue, busy queue, session-switch registration ownership transfer, fail-closed current-lineage rebuild (trailing non-id entry ignored, obsolete branches excluded, empty lineage clears stale history), mocked two-session request/reply, `count` validation, event extraction for real event types (user, assistant text, tool call, tool result) with thinking skipped, bounded-history truncation, empty-lineage clear, stale v1-artifact rejection, and resume without duplicates.
- `npm run test:focused`: 24/24 pass (unit only).
- `npm run test:integration`: 3/3 pass (mocked two-session lifecycle; live Herdr cases skipped because no backend was available).
- `npm run typecheck`: clean.
- `npm pack --dry-run`: 10 files (7 runtime sources + package.json/README/LICENSE, npm auto-included; no tests or Harness docs).
- `git diff --check`: pass.
- Live two-session Herdr smoke in the new `pi-peer/talk` namespace: **passed**
  (slice 7, see `US-010` validation). Two live Pi panes in one workspace
  discovered each other (`talk_sessions` = 2 peers), exchanged a `talk_to`
  request/reply (marker `PI_PEER_3WAY_OK`), and read bounded version-2
  histories (10 and 6 events) with no thinking events published. Abort/
  session-switch/fail-closed remain automated-proof only.
- Public-id live verification (slice 9) **passed** after both peers reloaded on
  the slice-8 commit: `talk_sessions` returned exactly two distinct public IDs
  in `peer-<last3>` format with correct current markers; `talk_latest`/`talk_to`
  resolved by public id (marker `PUBLIC_PEER_ID_LIVE_OK`, oldest-first, no
  thinking); inbound `peer_message` exposed `peer_id` equal to the sender's
  public id while keeping the full session id internal; a live raw
  full-session-id target was rejected with `Peer session not found`; session
  registration filenames remain keyed by full internal session IDs. Collision
  behavior remains automated-test proven only.
