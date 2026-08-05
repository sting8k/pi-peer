# Peer Talk History and `count`

Date: 2026-07-24

## Status

Accepted

The storage namespace implied by this decision (`talk/<workspace-id>/...`
under the legacy `pi-roo/talk` root) is superseded by
`0011-standalone-pi-peer-extension.md`, which establishes
`<agent-dir>/pi-peer/talk/<workspace-id>/`; this decision's history contract is
unchanged.

## Context

`0009-peer-session-talk.md` established `talk_latest` as a cross-peer read of a single latest completed assistant response. Peers need more context than the response alone: the recent turns, tool calls, and tool results that explain how a peer reached its current state. Reading another peer's transcript remains out of scope, so the artifact must be extended rather than the transcript exposed.

## Decision

Extend `talk_latest` with an optional `count` parameter and replace the single latest-response artifact with a bounded history of completed conversation events:

- `count` is an optional integer, default `1`, minimum `1`, maximum `10`. Out-of-range or non-integer values are rejected with a validation error.
- `talk_latest({ target, count })` returns the `count` most recent completed conversation events, ordered oldest to newest, regardless of event type: user messages, assistant text, tool calls, and tool results. Thinking is never published.
- Each peer atomically publishes a bounded history of up to 10 completed conversation events at `talk/<workspace-id>/latest/<session-id>.json`. The history is the only cross-peer artifact for `talk_latest`; the caller does not read another peer's transcript directly, and the peer explicitly publishes these event payloads.
- On `session_start`/resume and on `agent_end` a peer rebuilds its history from its own current lineage (completed entries only). Session entries are persisted before the `agent_end` event, so rebuilding from the durable lineage yields stable entry-based ids and no duplicate risk; an empty current lineage clears any stale history.
- Currently streaming or incomplete content is excluded: aborted assistant messages are dropped, and durable backfill only includes assistant messages that reached a terminal stop reason. Infrastructure/session metadata entries (`session`, `branch_summary`) are never published.
- The publisher, not the caller, owns the history; `talk_latest` only reads the bounded artifact. Backward compatibility is preserved for callers that omit `count` (they get the single most recent completed event).

### Migration (thinking removal)

Thinking was removed from the published set. The artifact `version` is bumped from `1` to `2`, and the event-type validator accepts only `user`, `assistant`, `toolCall`, and `toolResult`. A stale `version: 1` artifact (which may contain `thinking` events) fails validation and `readHistory` returns an empty history, so `talk_latest` reports no events until the publisher next rebuilds its history from its durable lineage. This keeps stale thinking from ever surfacing during rollout without a sidecar migration.

## Alternatives Considered

1. Keep publishing only the latest assistant response and let callers poll repeatedly: rejected because it cannot convey a sequence of recent events and still reads like a single-message primitive.
2. Let `talk_latest` read the peer's session JSONL directly: rejected because it broadens the data boundary (`0009`).
3. Publish an unbounded history: rejected in favor of a fixed 10-event bound to keep the artifact small and the write atomic.

## Consequences

Positive:

- Callers get a coherent, ordered view of recent peer activity without transcript access.
- Immutable, completable events make the publisher-side history easy to rebuild from the durable lineage on resume.
- The 10-event bound keeps the artifact small and atomic writes cheap.

Tradeoffs:

- Only the most recent 10 events are available; older context is not exposed.
- History is a best-effort copy of completed events; streaming/incomplete turns are intentionally absent.