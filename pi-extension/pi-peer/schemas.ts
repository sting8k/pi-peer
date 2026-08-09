import { Type } from "@sinclair/typebox";

export const TalkToParams = Type.Object({
  target: Type.String({
    description: "Public peer id (e.g. `peer-abc`, from `talk_sessions`) or unique display name of the peer session.",
  }),
  message: Type.String({
    description: "Message to send to the peer session.",
  }),
  timeoutMs: Type.Optional(Type.Number({
    description: "How long THIS session blocks waiting, in milliseconds (default 60 000; clamped 1 000–3 600 000). This is not a time budget for the peer: it keeps working past this and its reply is never lost. When the wait elapses the call returns a non-error pending result and the reply is delivered to you later as a <peer_pong>. You only need the send to succeed. Prefer the default and get on with other work; raise it only when you need the answer inline in this same turn. Liveness is verified periodically; a confirmed-dead target fails the call.",
  })),
});

export const TalkSessionsParams = Type.Object({});

export const TalkLatestParams = Type.Object({
  target: Type.String({
    description: "Public peer id (e.g. `peer-abc`, from `talk_sessions`) or unique display name of the peer session.",
  }),
  count: Type.Optional(Type.Integer({
    minimum: 1,
    maximum: 10,
    default: 1,
    description:
      "Number of most recent completed conversation events to return, ordered oldest to newest. Defaults to 1; max 10.",
  })),
});