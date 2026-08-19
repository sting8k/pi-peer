import { Type } from "typebox";

export const TalkToParams = Type.Object({
  target: Type.String({
    minLength: 1,
    description: "Public peer id (e.g. `peer-abc`, from `talk_sessions`) or unique display name of the peer session.",
  }),
  message: Type.String({
    minLength: 1,
    description: "Message to send to the peer session.",
  }),
});

export const TalkSessionsParams = Type.Object({});

export const TalkLatestParams = Type.Object({
  target: Type.String({
    minLength: 1,
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