import { Type } from "@sinclair/typebox";

export const TalkToParams = Type.Object({
  target: Type.String({
    description: "Public peer id (e.g. `peer-abc`, from `talk_sessions`) or unique display name of the peer session.",
  }),
  message: Type.String({
    description: "Message to send to the peer session.",
  }),
  timeoutMs: Type.Optional(Type.Number({
    description: "Optional soft timeout in milliseconds. After it elapses, talk_to keeps waiting while HerdR confirms the peer is live, up to a minimum hard deadline of 10 minutes.",
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