# Async Peer Delivery Correctness (F1 Idle-Burst Latch, F2 Claim Lifetime)

Date: 2026-08-01

## Status

Accepted

## Context

`0011-standalone-pi-peer-extension.md` and the `feat: make talk_to send-only async
symmetric peer chat` change made `talk_to` a fire-and-forget send: it writes a
durable message to the peer's mailbox and returns a confirmation that the message
was sent, with the peer's reply arriving later as a new `<peer_message>`. A poll
interval drains the peer's inbox one message per tick.

Review surfaced two correctness gaps in that design:

1. **F1 idle-burst race.** The production `selfBusy` flag only flips at
   `agent_start`. After a peer injects a first idle message (a fresh plain user
   turn), the next 250ms tick can still observe `idle` and inject another plain
   user turn before `agent_start` arrives, opening overlapping plain turns from a
   burst of queued messages.
2. **F2 claim lifetime / fire-and-forget.** The `sendUserMessage` Promise only
   confirms the host *accepted* the injection, not that the turn consumed the
   injected message. Old code deleted the `.processing` claim immediately on a
   successful injection, so a crash after acceptance but before the turn completed
   would lose the message. There was also no recovery path for claims orphaned by
   a missed `agent_end` or a session rebind.

## Decision

Add a poll-time turn latch and a turn-scoped in-flight claim set to the inbox
drainer, and make the documented guarantee honest:

- **F1 — turn-start pending latch.** A non-steer (fresh-trigger) injection sets a
  `turnStartPending` latch *before* the injection. While the latch is set and
  `agent_start` has not arrived, `drainInbox` returns immediately and does not
  drain another message. `agent_start` clears the latch and marks the peer busy
  (when no external busy override is supplied); subsequent messages then steer
  into the running turn. `agent_end` clears the latch and the busy flag. A failed
  injection clears the latch and requeues only its own claim, so a burst never
  opens overlapping plain turns.
- **F2 — turn-scoped claim lifetime.** A successfully injected `.processing` claim
  is *not* deleted on injection. It is tracked in an `inFlightClaims` set and the 
  claim is consumed (deleted) only at `agent_end`, when the turn completes. The
  claim therefore covers the whole turn, not just the host's `sendUserMessage`
  acceptance. If injection fails, only that claim is requeued (via a new
  `requeueClaimedMessage`), never a sibling's in-flight claim.
- **Rebind / shutdown recovery.** `session_start` (a reload/resume or session
  rebind) clears local `selfBusy`, `turnStartPending`, and `inFlightClaims`, then
  requeues every orphaned `.processing` claim so they retry (at-least-once) rather
  than being lost. `session_shutdown` clears local latch/claim state and leaves any
  unconsumed `.processing` claims on disk, recoverable by the next startup
  requeue. This is a best-effort, single-process, at-least-once guarantee.
- **Honest guarantee.** We guarantee a durable mailbox plus a recoverable
  at-least-once claim through turn completion. We explicitly do not claim proof of
  receiver/model consumption beyond the host lifecycle: the claim is consumed at
  `agent_end`, which is host lifecycle, not a receipt that the model processed the
  message.

## Alternatives Considered

1. Keep deleting the claim on successful injection and rely on the host lifecycle
   alone: rejected because a crash between acceptance and turn completion loses the
   message, and the review flagged this as a data-loss blocker.
2. Build a full waiter/ack/RPC acknowledgement protocol to prove model consumption:
   rejected as over-engineering and out of scope for a symmetric, async,
   fire-and-forget chat. The at-least-once claim through turn completion is the
   right durability bar.
3. Requeue all claims on every failure (the old `requeueProcessing` used at startup
   only): rejected because that would release another runtime's in-flight claim.
   Only the acting claim is requeued on an injection failure.

## Consequences

Positive:

- A burst of queued messages cannot open overlapping plain turns; after the first
  idle trigger, the rest steer into the engaged turn.
- A message accepted by the host stays claimed through the turn, so a crash before
  `agent_end` is recoverable on the next startup/rebind.
- Claims orphaned by a missed `agent_end` or a session rebind are requeued and
  retried rather than silently lost.

Tradeoffs:

- The guarantee is at-least-once, not exactly-once: a crash or rebind after the
  host accepted/injected a message but before `agent_end` consumed the claim
  opens a window in which the message could be re-delivered on recovery. The
  window is bounded to the host turn, not to model processing.
- A peer that is perpetually idle after a non-steer injection holds the latch until
  `agent_start`; injection failures clear the latch so a poison message cannot
  wedge the mailbox forever.
