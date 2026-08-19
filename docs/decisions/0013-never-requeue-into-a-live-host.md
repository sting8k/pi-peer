# Never Requeue an Unacknowledged Injection Into a Live Host

Date: 2026-08-20

## Status

Accepted

Supersedes the F2 acknowledgement-deadline rule in
`0012-async-peer-delivery-correctness.md`. The F1 idle-burst latch, the
`agent_settled` completion boundary, and the void-`sendUserMessage` finding from
that record all stand.

## Context

`0012` established that `ExtensionAPI.sendUserMessage()` returns `void`, so the
runtime needs a host event to confirm an injection landed. It chose
`message_start` as that acknowledgement and added a bounded deadline: an
injection not acknowledged in time was requeued. Its final tradeoff accepted the
consequence explicitly — *"a delayed `message_start` past the bounded
acknowledgement deadline can cause a duplicate; this is preferable to silently
losing the durable message."*

That tradeoff was priced wrong. Reading the Pi agent source rather than the
shipped type declarations shows the acknowledgement latency is **unbounded by
design**, so the duplicate is the common case rather than the rare one:

1. **Steered messages.** `packages/agent/src/agent-loop.ts:258` drains the
   steering queue only after the assistant stream completes *and* every tool
   call in the turn finishes; `:184` emits `message_start` on the following
   iteration. A single long tool call (build, test run, network fetch) exceeds
   any fixed deadline. The default drain mode is `one-at-a-time`
   (`agent.ts:231`), so a second steered message waits a further full turn.
2. **Non-steer messages.** `agent-session.ts:1201-1220` performs an auth check
   and `_checkCompaction` *before* the user message is built. On context
   overflow that runs a full LLM summarization, which routinely exceeds a
   ten-second deadline before `agent_start` is ever emitted.
3. **The host keeps its copy.** `abort()` does not clear the steering queue —
   `clearSteeringQueue` (`agent.ts:293`) is reached only from `reset()` and the
   explicit `clearQueue()`. A steered message survives an abort and is drained
   at the start of the next run.

Because the host retains the message in every one of these cases, requeueing on
timeout hands it a **second copy of a message it is still holding**. The peer
agent then receives the same `<peer_message>` twice.

A second, independent duplicate path existed at the completion boundary:
requeueing still-pending deliveries at `agent_settled` duplicated any steer
accepted after the run's final drain point, and any steer that survived an
abort.

Content-based acknowledgement matching is also unreliable in a way `0012` did
not anticipate. Every prompt, including one injected by an extension, passes
through the `input` event first (`agent-session.ts:1150-1168`). Another
extension returning `transform` rewrites the text so no content match can ever
succeed, and returning `handled` drops the message entirely — under the old rule
either outcome produced an unbounded redelivery loop.

## Decision

### An unacknowledged claim is never requeued into a live host

Requeueing is now reserved for the two cases where the host provably does not
hold the message:

- A **synchronous** injection failure, where nothing reached the host.
- `session_start`, where the host process restarted and its in-memory queues are
  gone.

Every other unacknowledged claim stays `.processing` and is recovered at the
next startup. `agent_settled` no longer requeues pending deliveries; a steer the
host has accepted but not yet replayed is carried forward so a later
`message_start` can acknowledge it.

### Acknowledgement is per-path, and never wall-clock bounded

- **Non-steer** injections are acknowledged by the `agent_start` of the turn they
  trigger. The turn carries the prompt, so this is independent of the final
  message text and therefore survives an `input` handler rewriting it.
- **Steered** injections are acknowledged by the `message_start` where the host
  replays them, matched on rendered content. A steered message has no other
  correlator, and two identical renderings are interchangeable, so acknowledging
  the oldest match is sound.

### The timeout releases the turn latch only

The non-steer path keeps a bounded timer, renamed to reflect its single
remaining job: if `agent_start` never arrives, it clears `turnStartPending` so
delivery cannot block forever. It does not requeue, and it does not run for
steered injections, which no wall clock can bound.

## Alternatives Considered

1. **Raise the deadline.** Rejected: no constant bounds a tool call or a
   compaction pass, so this converts a frequent duplicate into a rarer one
   without removing the defect.
2. **Positional (FIFO) matching instead of content matching.** Rejected: it
   would falsely acknowledge a pending claim whenever the human types any
   message while a steer is queued, which is far more likely than two identical
   renderings colliding.
3. **Carry an explicit correlation token in the injected text.** Rejected: the
   correlator was deliberately kept out of `peerMessageTag` so the model never
   sees bookkeeping, and `agent_start` already gives the non-steer path a
   content-independent acknowledgement.
4. **Drop acknowledgement entirely and consume every claim at `agent_settled`.**
   Rejected: it cannot distinguish a message the host replayed from one an
   explicit `clearQueue()` discarded, turning a recoverable claim into silent
   loss.

## Consequences

Positive:

- A peer message is delivered to the model once per host copy. Duplicate
  delivery from a long tool call, from pre-prompt compaction, from an abort, and
  from the settle-before-drain race are all eliminated.
- An `input` handler in another extension can rewrite or consume an injected
  message without causing an unbounded redelivery loop.
- The timer has one narrow, stated purpose instead of doubling as a delivery
  deadline.

Tradeoffs:

- If a user explicitly discards the queue (`clearQueue()`, such as
  escape-to-restore-editor in the TUI), a steered message is dropped and is not
  redelivered until the next `session_start`. This is at-most-once in that
  narrow case, chosen over near-certain duplication in the common case.
- A claim abandoned inside a live host stays `.processing` until the next
  startup rather than being retried within the session.
- The at-least-once guarantee now rests on startup recovery alone, so it spans a
  process restart rather than a poll interval.

## Follow-Up

- `docs/ARCHITECTURE.md` and `docs/TEST_MATRIX.md` describe the revised claim
  lifetime; the previous text promised requeue-on-unacknowledged-injection.
- `test/peer/delivery-once.test.ts` models the host's real steering semantics
  (drain after stream and tool calls, `one-at-a-time`) and asserts single
  delivery for the long-tool-call, settle-before-drain, and input-rewrite
  scenarios. All three fail against a build that requeues unacknowledged claims.
- `registerTalkTools` now carries fourteen pieces of mutable closure state.
  Both defects fixed here lived in that state machine. A structural pass is
  worth scheduling separately.
