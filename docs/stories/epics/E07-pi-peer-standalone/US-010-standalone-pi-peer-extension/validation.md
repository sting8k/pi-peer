# Validation — US-010 Standalone Pi-Peer Extension

## Proof Strategy

The extraction is done when: (1) the standalone runtime and package pass the
full executable suite, (2) `npm pack --dry-run` ships only the runtime
surface, (3) docs describe only pi-peer with no broken links/paths, and
(4) no unrelated files changed. The live new-namespace Herdr cutover is
**done** (slice 7, two live Pi panes in one workspace; evidence below).
Harness CLI is absent in this checkout, so **durable rows are unavailable**;
this story's validation is the executable proof, the live cutover evidence,
and the doc audit below.

## Test Plan

| Layer | Cases |
| --- | --- |
| Unit | Entrypoint registers exactly the 3 talk tools, no commands/renderers; protocol v1 (envelopes, resolve, route-cycle, request message, requeue, remove-owned); history v2 (bounded, no thinking, own-lineage rebuild, publish/read); storage `safeKey` + atomic write. |
| Integration | Mocked two-peer lifecycle: request delivery → peer `agent_end` response capture; busy queueing; latest-history reads. |
| E2E | Live two-session Herdr cutover in the `pi-peer/talk` namespace — **passed** (slice 7). Public-id verification (slice 9) **passed** after both peers reloaded on the slice-8 commit: discovery by public id, `talk_latest`/`talk_to` by public id, inbound `peer_id` match, raw-id rejection, no thinking. |
| Platform | macOS/Linux executed; Windows not validated. |
| Performance | N/A (bounded history 10 events; atomic single-file writes). |
| Logs/Audit | History artifacts + tool progress details (`queued`/`processing`/`completed`); `session_shutdown` record removal. |

## Fixtures

- Deterministic two-peer fixtures in `test/integration/peer-two-peer.test.ts`
  (mocked `ExtensionAPI`, temp dirs, session JSONL files).
- `test/peer/helpers.ts` mock extension API + temp-dir factory.

## Commands

```text
env -u PI_CODING_AGENT_DIR npm test
npm run test:focused
npm run test:integration
npm run typecheck
npm pack --dry-run
git add -A && git diff --cached --check
git diff --cached --name-status   # confirm only intended files changed
grep -nE "pi-interactive-subagents|call_agents|subagent|loop-workflow|advisor|features.talk|pi-roo/talk" $(git ls-files | grep -v package-lock)
```

## Acceptance Evidence

| Check | Result |
| --- | --- |
| `npm test` | 27/27 pass (3 suites) |
| `npm run test:focused` | 24/24 pass |
| `npm run test:integration` | 3/3 pass |
| `npm run typecheck` | clean (tsc 5.9.3) |
| `npm pack --dry-run` | 10 files (7 runtime sources + package.json/README/LICENSE, npm auto-included; no tests or Harness docs) |
| Markdown link/path scan | all kept-file references resolve; retired refs removed |
| Live Herdr cutover (slice 7) | **pass** — two live Pi panes in one workspace: `talk_sessions` = 2 peers; `talk_to` round-trip completed with `PI_PEER_3WAY_OK`; reverse discovery/read pass (10 events, oldest-first, labels assistant/toolCall/toolResult, no thinking); post-response history 6 events in order, peer idle; filesystem artifacts: 2 session records + 2 latest artifacts, history version 2, event counts 10 and 6, thinking events 0. Abort/session-switch/fail-closed remain automated-proof only. |
| Live public-id verification (slice 9) | **pass** — after both peers reloaded on the slice-8 commit: `talk_sessions` returned exactly two distinct public IDs in `peer-<last3>` format with correct current markers (display names may duplicate; IDs differ); `talk_latest`/`talk_to` resolved by public id (marker `PUBLIC_PEER_ID_LIVE_OK`, oldest-first, no thinking); inbound `peer_message` exposed `peer_id` equal to the sender's public id while keeping the full session id internal; receiver-side `talk_sessions`/`talk_latest` succeeded (labels toolCall/toolResult/assistant, no thinking); a live raw full-session-id target was rejected with `Peer session not found`; session registration filenames remain keyed by full internal session IDs. Collision behavior remains automated-test proven only. |
| `git diff --cached --check` | clean |

Remaining stale terms, if any, are justified in the slice report (explicit
migration/history context only).

## Metadata Debt (explicit)

- Resolved in slice 10: `author: sting8k`, `repository:
  git+https://github.com/sting8k/pi-peer.git`, `homepage`/`bugs` for the new
  public repo, `version: 1.0.0`, and `private: true` (npm publishing out of
  scope; GitHub-only distribution). Lockfile regenerated via `npm install
  --package-lock-only`.
- Repository state: `github.com/sting8k/pi-peer` exists; this clean-history
  root commit is published as the initial `main` release, and the canonical
  install `pi install git:github.com/sting8k/pi-peer` resolves from it. npm
  publishing stays out of scope.
- Live Herdr cutover passed (slice 7, pre-dating the public-id format);
  public-id live verification passed in slice 9 (see rows above); durable
  Harness rows unavailable (CLI absent).
