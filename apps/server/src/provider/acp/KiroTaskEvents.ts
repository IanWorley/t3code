import {
  EventId,
  IsoDateTime,
  ProviderDriverKind,
  TaskAgentObservation,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/**
 * Kiro child-session activity, handed from `KiroSubagents` to `KiroAdapterV2`.
 * It never leaves the server, so it stays out of contracts; the schema exists so
 * tests can prove observations stay inside the wire bounds.
 */
export const KiroTaskLinkage = Schema.Struct({
  taskType: Schema.optional(TrimmedNonEmptyString),
  title: Schema.optional(TrimmedNonEmptyString),
  role: Schema.optional(TrimmedNonEmptyString),
  model: Schema.optional(TrimmedNonEmptyString),
});
export type KiroTaskLinkage = typeof KiroTaskLinkage.Type;

const envelope = {
  eventId: EventId,
  provider: ProviderDriverKind,
  threadId: ThreadId,
  createdAt: IsoDateTime,
  turnId: Schema.optional(TurnId),
};

const linkageFields = { taskId: TrimmedNonEmptyString, ...KiroTaskLinkage.fields };

const KiroTaskStatus = Schema.Literals(["running", "idle", "interrupted"]);

export const KiroTaskEvent = Schema.Union([
  Schema.Struct({
    ...envelope,
    type: Schema.Literal("task.started"),
    payload: Schema.Struct({
      ...linkageFields,
      description: Schema.optional(TrimmedNonEmptyString),
    }),
  }),
  Schema.Struct({
    ...envelope,
    type: Schema.Literal("task.progress"),
    payload: Schema.Struct({
      ...linkageFields,
      description: TrimmedNonEmptyString,
      summary: Schema.optional(TrimmedNonEmptyString),
      observation: Schema.optional(TaskAgentObservation),
      status: Schema.optional(KiroTaskStatus),
    }),
  }),
  Schema.Struct({
    ...envelope,
    type: Schema.Literal("task.updated"),
    payload: Schema.Struct({
      ...linkageFields,
      status: Schema.optional(KiroTaskStatus),
      description: Schema.optional(TrimmedNonEmptyString),
    }),
  }),
  Schema.Struct({
    ...envelope,
    type: Schema.Literal("task.completed"),
    payload: Schema.Struct({
      ...linkageFields,
      status: Schema.Literals(["completed", "failed", "stopped"]),
      summary: Schema.optional(TrimmedNonEmptyString),
    }),
  }),
]);
export type KiroTaskEvent = typeof KiroTaskEvent.Type;
