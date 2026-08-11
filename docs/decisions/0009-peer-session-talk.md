# Peer Pi Session Talk

Date: 2026-07-23

## Status

Accepted

> **Superseded (async-chat redesign).** The request/response protocol contract
> below was replaced by symmetric, send-only chat: `talk_to` now enqueues one
> durable message and returns delivery confirmation only; a reply is simply
> another `talk_to` in the opposite direction delivered as a new
> `<peer_message>`. Request/response correlation, waiters, `replies/`, timeout/
> pending wake behavior, `<peer_pong>`, and route/cycle machinery were removed.

## Context

The main-owned persistent advisor only connects one main Pi session to a special child it creates. The accepted product direction is broader and simpler: independently running Pi sessions in one HerdR workspace should communicate as peers, including nested consultation across several sessions.

## Decision

Replace the persistent advisor subsystem with a HerdR workspace-scoped peer protocol:

- Main-session tools are `talk_sessions`, `talk_latest`, and `talk_to`.
- Every eligible Pi session registers its session id, display name, cwd, and HerdR pane in a shared workspace directory.
- Each peer atomically publishes a bounded history of completed conversation events (user messages, assistant text, tool calls, and tool results), including a current-lineage backfill from its own session on startup/resume and a rebuild on `agent_end`; `talk_latest` reads that bounded artifact and returns the N most recent completed events (oldest-first; `count` defaults to 1, max 10). The caller never reads the target's session JSONL directly; the peer explicitly publishes these selected event payloads (including tool-call blocks; thinking is never published) into the history.
- Requests and responses are versioned JSON envelopes written through atomic rename and correlated by request id.
- Receivers queue requests while busy and process one at a time; sender tool updates mirror queued and processing envelope states before returning the final assistant response captured at `agent_end`.
- Nested calls carry a route and reject a target already in that route.
- HerdR pane state is the liveness authority; the protocol has no heartbeat or broker.
- The extension never creates, owns, restarts, or reads another peer's session transcript; sessions opt out of the peer registry via `PI_PEER_DISABLED=1` in the standalone runtime.

This decision superseded the earlier persistent-advisor design (decision `0008`, retired with the advisor product during the standalone pi-peer docs cutover). Packaging, eligibility, and storage-namespace details for the standalone package are superseded by `0011-standalone-pi-peer-extension.md`; the protocol contract above is unchanged.

## Alternatives Considered

1. Rename `advisor_ask` while retaining main-owned advisor lifecycle: rejected because it cannot address independently running peers.
2. Add a broker, heartbeat, acknowledgements, retries, in-flight turn cancellation, and distributed deadlock detection: rejected as unnecessary for the requested v1.
3. Read target JSONL session files for replies or latest-turn access: rejected because transcript access would broaden the data boundary. Peers instead publish a bounded history artifact they own (extended with `count` in `0010-peer-talk-history-count.md`); reading the peer's history is not reading its transcript, and the peer explicitly surfaces the event payloads it publishes.

## Consequences

Positive:

- Any eligible Pi session in the workspace can initiate or receive a conversation.
- The protocol remains inspectable and durable without an extra service.
- Delegation semantics remain separate and unchanged.

Tradeoffs:

- V1 is HerdR-only.
- Simultaneous independent calls can wait until timeout; only same-chain cycles are rejected.
- Abort/timeout withdraws a request only while it remains queued; a response produced after an already-claimed request may remain as a late reply artifact.

## Follow-Up

- Add live HerdR smoke evidence for two independently launched Pi sessions when the environment is available.
