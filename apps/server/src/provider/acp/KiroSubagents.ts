import {
  ProviderDriverKind,
  RuntimeTaskId,
  type ProviderRuntimeEvent,
  type TaskAgentLinkage,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as AcpSchema from "effect-acp/schema";
import * as AcpErrors from "effect-acp/errors";

import type { AcpSessionRuntime } from "./AcpSessionRuntime.ts";

const PROVIDER = ProviderDriverKind.make("kiro");
const LIST_UPDATE_METHOD = "_kiro.dev/subagent/list_update";
const TEXT_LIMIT = 8_000;
const UNKNOWN_OUTCOME = "Agent ended; result unavailable.";
const DEFAULT_TITLE = "Kiro subagent";

const Inventory = Schema.Struct({ subagents: Schema.Array(Schema.Unknown) });
const NativeChild = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  sessionName: Schema.optional(Schema.String),
  agentName: Schema.optional(Schema.String),
  initialQuery: Schema.optional(Schema.String),
  role: Schema.optional(Schema.String),
  createdAtMs: Schema.optional(Schema.Number),
  status: Schema.Struct({ type: Schema.String, message: Schema.optional(Schema.String) }),
});
const SummaryMeta = Schema.Struct({ kiro: Schema.Struct({ toolName: Schema.Literal("summary") }) });
const SummaryInput = Schema.Struct({ taskResult: Schema.String });
const decodeInventory = Schema.decodeUnknownOption(Inventory);
const decodeChild = Schema.decodeUnknownOption(NativeChild);
const decodeSummaryMeta = Schema.decodeUnknownOption(SummaryMeta);
const decodeSummaryInput = Schema.decodeUnknownOption(SummaryInput);

type TaskEvent = Extract<
  ProviderRuntimeEvent,
  { type: "task.started" | "task.progress" | "task.updated" | "task.completed" }
>;
type TaskDraft = TaskEvent extends infer E
  ? E extends TaskEvent
    ? Pick<E, "type" | "payload">
    : never
  : never;

interface Child {
  readonly taskId: RuntimeTaskId;
  readonly linkage: TaskAgentLinkage;
  readonly turnId: TurnId | undefined;
  readonly description: string;
  state: "active" | "terminated" | "completed" | "closed";
  progress: string | undefined;
  summaryTool: { readonly id: string; readonly result: string | undefined } | undefined;
  summary: string | undefined;
}

function bounded(value: string | undefined): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  return text.length > TEXT_LIMIT
    ? Buffer.from(text.slice(0, TEXT_LIMIT), "utf16le").toString("utf16le")
    : text;
}

/** Observes real child sessions without forwarding their messages into the root reply. */
export interface KiroSubagents<E> {
  readonly close: (reason: "stopped" | "interrupted") => Effect.Effect<void, E>;
}

export const makeKiroSubagents = Effect.fn("makeKiroSubagents")(function* <E>(input: {
  readonly runtime: Pick<
    AcpSessionRuntime["Service"],
    "handleExtNotification" | "handleSessionUpdate"
  >;
  readonly threadId: ThreadId;
  readonly getTurn: () => { readonly id: TurnId; readonly startedAtMs: number } | undefined;
  readonly makeStamp: () => Effect.Effect<Pick<ProviderRuntimeEvent, "eventId" | "createdAt">, E>;
  readonly publish: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
}): Effect.fn.Return<KiroSubagents<E>> {
  const children = new Map<string, Child>();
  const lock = yield* Semaphore.make(1);
  let closed = false;
  const callback = (effect: Effect.Effect<void, E>) =>
    effect.pipe(
      Effect.mapError(
        (cause) =>
          new AcpErrors.AcpTransportError({
            detail: "Failed to publish Kiro subagent activity.",
            cause,
          }),
      ),
    );

  const publish = (child: Child, draft: TaskDraft) =>
    Effect.gen(function* () {
      yield* input.publish({
        ...draft,
        ...(yield* input.makeStamp()),
        provider: PROVIDER,
        threadId: input.threadId,
        ...(child.turnId !== undefined ? { turnId: child.turnId } : {}),
      });
    });
  const linkage = (child: Child) => ({ taskId: child.taskId, ...child.linkage });
  const complete = (child: Child) =>
    Effect.gen(function* () {
      if (child.state !== "terminated" || child.summary === undefined) return;
      child.state = "completed";
      yield* publish(child, {
        type: "task.completed",
        payload: { ...linkage(child), status: "completed", summary: child.summary },
      });
    });

  // Decode members separately: one malformed or newer member must not fail the root prompt.
  yield* input.runtime.handleExtNotification(LIST_UPDATE_METHOD, Schema.Unknown, (payload) =>
    callback(
      lock.withPermit(
        Effect.gen(function* () {
          if (closed) return;
          const inventory = Option.getOrUndefined(decodeInventory(payload));
          if (!inventory) return;
          for (const member of inventory.subagents) {
            const native = Option.getOrUndefined(decodeChild(member));
            if (!native || !native.sessionId.trim()) continue;
            let child = children.get(native.sessionId);
            if (!child) {
              const turn = input.getTurn();
              child = {
                taskId: RuntimeTaskId.make(native.sessionId),
                linkage: {
                  taskType: "subagent",
                  title: bounded(native.sessionName) ?? DEFAULT_TITLE,
                  ...(bounded(native.role ?? native.agentName)
                    ? { role: bounded(native.role ?? native.agentName) }
                    : {}),
                },
                turnId:
                  turn && native.createdAtMs !== undefined && native.createdAtMs >= turn.startedAtMs
                    ? turn.id
                    : undefined,
                description:
                  bounded(native.initialQuery) ?? bounded(native.sessionName) ?? DEFAULT_TITLE,
                state: "active",
                progress: undefined,
                summaryTool: undefined,
                summary: undefined,
              };
              children.set(native.sessionId, child);
              yield* publish(child, {
                type: "task.started",
                payload: { ...linkage(child), description: child.description },
              });
            }
            if (child.state === "completed" || child.state === "closed") continue;
            if (native.status.type === "terminated") {
              const firstTermination = child.state !== "terminated";
              child.state = "terminated";
              if (child.summary !== undefined) {
                yield* complete(child);
              } else if (firstTermination) {
                // Idle clears liveness while allowing a later proven result to complete the row.
                yield* publish(child, {
                  type: "task.updated",
                  payload: { ...linkage(child), status: "idle", description: UNKNOWN_OUTCOME },
                });
              }
            } else if (native.status.type === "working" && child.state === "active") {
              const progress = bounded(native.status.message) ?? child.description;
              if (progress === child.progress) continue;
              child.progress = progress;
              yield* publish(child, {
                type: "task.progress",
                payload: { ...linkage(child), status: "running", description: progress },
              });
            }
          }
        }),
      ),
    ),
  );

  yield* input.runtime.handleSessionUpdate((notification: AcpSchema.SessionNotification) =>
    callback(
      lock.withPermit(
        Effect.gen(function* () {
          if (closed) return;
          const child = children.get(notification.sessionId);
          if (!child || child.state === "completed" || child.state === "closed") return;
          const update = notification.update;
          if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update")
            return;
          const result = Option.getOrUndefined(decodeSummaryInput(update.rawInput));
          if (Option.isSome(decodeSummaryMeta(update._meta))) {
            child.summaryTool = { id: update.toolCallId, result: bounded(result?.taskResult) };
          }
          if (update.toolCallId !== child.summaryTool?.id || update.status !== "completed") return;
          const summary = bounded(result?.taskResult) ?? child.summaryTool.result;
          if (!summary) return;
          child.summary = summary;
          yield* complete(child);
        }),
      ),
    ),
  );

  return {
    close: (reason: "stopped" | "interrupted") =>
      lock.withPermit(
        Effect.gen(function* () {
          if (closed) return;
          closed = true;
          for (const child of children.values()) {
            if (child.state === "completed" || child.state === "closed") continue;
            child.state = "closed";
            if (reason === "stopped") {
              yield* publish(child, {
                type: "task.completed",
                payload: { ...linkage(child), status: "stopped" },
              });
            } else {
              yield* publish(child, {
                type: "task.updated",
                payload: { ...linkage(child), status: "interrupted", description: UNKNOWN_OUTCOME },
              });
            }
          }
        }),
      ),
  };
});
