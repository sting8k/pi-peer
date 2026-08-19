# Async Peer Delivery Correctness (F1 Idle-Burst Latch, F2 Claim Lifetime)

Date: 2026-08-01

## Status

Accepted; the F2 acknowledgement-deadline rule is superseded by
`0013-never-requeue-into-a-live-host.md`. Requeueing an unacknowledged injection
into a live host duplicates a message the host still holds, because
acknowledgement latency is unbounded by design. The F1 latch, the
`agent_settled` boundary, and the void-`sendUserMessage` finding below stand.

## Context

`0011-standalone-pi-peer-extension.md` and the async-chat redesign made
`talk_to` a fire-and-forget send: it writes a durable message to the peer's
mailbox and returns delivery confirmation, with the peer's reply arriving later
as a new `<peer_message>`. A poll interval drains the peer's inbox one message
per tick.

Review against the Pi `0.84.2` extension contract found three lifecycle facts
that the runtime must follow:

1. `agent_end` marks only one low-level run. Pi may still retry, compact and
   retry, or process queued follow-up messages. `agent_settled` is the boundary
   after those continuations finish.
2. `ExtensionAPI.sendUserMessage()` is fire-and-forget and returns `void`.
   Asynchronous injection failures are not observable through `await`/`catch`.
3. `message_start` is the host lifecycle acknowledgement that a submitted user
   message actually entered the agent message stream.

## Decision

### F1 — Idle-burst latch

A non-steer (fresh-trigger) injection sets a `turnStartPending` latch before the
injection. While the latch is set and `agent_start` has not arrived,
`drainInbox` returns without draining another message. `agent_start` clears the
latch and marks the peer busy; subsequent messages steer into the running turn.
A synchronous injection failure clears the latch and requeues only its own claim.

### F2 — Host-acknowledged, settled-run claim lifetime

A claimed `.processing` file is tracked in one of two states:

- **Pending delivery:** after the host call is invoked, the claim remains
  `.processing` until the matching `message_start` event arrives. A synchronous
  failure or a missing acknowledgement after the bounded deadline requeues only
  that claim.
- **In-flight delivery:** after `message_start`, the claim remains in
  `inFlightClaims` until `agent_settled`, then the file is consumed.

The Pi API returns `void`, so the matching `message_start` event is the only
injection acknowledgement.

### Rebind and shutdown recovery

`session_start` clears local busy/latch state, requeues pending and in-flight
claims from the previous runtime, and reclaims all orphaned `.processing` files.
`session_shutdown` cancels pending acknowledgement timers and leaves unconsumed
claims on disk for the next startup requeue. This is a best-effort,
single-process, at-least-once guarantee.

### History and status boundary

Busy state is cleared and current-lineage history is rebuilt only at
`agent_settled`, after Pi's retries, compaction, and queued continuations are
finished. `agent_end` produces no automatic reply and does not consume claims.

## Alternatives Considered

1. Use `agent_end` as the completion boundary: rejected because Pi documents
   retries, compaction retries, and queued continuations after that event.
2. Await `sendUserMessage()` and catch failures: rejected because the real
   `ExtensionAPI` method returns `void` and reports asynchronous failures through
   Pi's extension error channel.
3. Delete the claim immediately after invoking `sendUserMessage`: rejected
   because the host can accept the call and the process can crash before the
   message enters the agent stream.
4. Build a full peer acknowledgement/RPC protocol: rejected as over-engineering
   and out of scope for symmetric, send-only chat. `message_start` is a local
   host acknowledgement, not a peer reply.

## Consequences

Positive:

- A burst of queued messages cannot open overlapping plain turns.
- Busy status and history reflect the full Pi run, not an intermediate retry or
  queued continuation.
- The actual void host API is handled without falsely claiming synchronous
  delivery or error propagation.
- Claims remain recoverable until Pi acknowledges and settles the host run.

Tradeoffs:

- The guarantee is at-least-once, not exactly-once. A crash or timeout after
  host acceptance can cause redelivery.
- A delayed `message_start` past the bounded acknowledgement deadline can cause
  a duplicate; this is preferable to silently losing the durable message.
  **Revised by `0013`:** this priced the duplicate as rare. It is the common
  case — the host drains steering only at turn boundaries and may compact before
  a triggered turn starts — so the deadline no longer requeues.
- Full live peer-chat E2E remains unavailable on POSIX in this checkout.
