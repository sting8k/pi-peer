import { Type } from "@sinclair/typebox";

export const TalkToParams = Type.Object({
  target: Type.String({
    description: "Public peer id (e.g. `peer-abc`, from `talk_sessions`) or unique display name of the peer session.",
  }),
  message: Type.String({
    description: "Message to send to the peer session.",
  }),
  timeoutMs: Type.Optional(Type.Number({
    description: "Optional wait in milliseconds before returning a non-error pending result. Effective deadline is the exact timeoutMs (default 10 min, clamped 1 000–3 600 000 ms); when it passes with the target still alive, the call returns a non-error pending result and this session is woken later with the reply. Liveness is verified periodically; a confirmed-dead target fails the call.",
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