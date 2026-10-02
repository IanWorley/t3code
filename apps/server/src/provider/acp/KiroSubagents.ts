import {
  ProviderDriverKind,
  RuntimeTaskId,
  TASK_OBSERVATION_ENTRY_LIMIT,
  TASK_OBSERVATION_TEXT_LIMIT,
  type TaskAgentObservation,
  type ProviderRuntimeEvent,
  type TaskAgentLinkage,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import type * as AcpSchema from "effect-acp/schema";
import * as AcpErrors from "effect-acp/errors";

import type { AcpSessionRuntime } from "./AcpSessionRuntime.ts";
import { sessionUpdateIsReplay } from "./AcpRuntimeModel.ts";

const PROVIDER = ProviderDriverKind.make("kiro");
const LIST_UPDATE_METHOD = "_kiro.dev/subagent/list_update";
const TEXT_LIMIT = 8_000;
const UNKNOWN_OUTCOME = "Agent ended; result unavailable.";
const DEFAULT_TITLE = "Kiro subagent";
const OBSERVATION_FLUSH_INTERVAL_MS = 1_000;
const OBSERVATION_SIGNAL_CAPACITY = 1;
const PROMPT_TEXT_LIMIT = 1_000;
const TOOL_TITLE_LIMIT = 180;

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
  observation: TaskAgentObservation;
  observationDirty: boolean;
  firstReplyPublished: boolean;
  nextEntry: number;
  openTextId: string | undefined;
}

type ObservationEntry = TaskAgentObservation["entries"][number];

function retainObservation(child: Child, entries: ReadonlyArray<ObservationEntry>): void {
  const retained = [...entries];
  let truncated = child.observation.truncated;
  const oldestOutput = () => (retained[0]?.id === "prompt" ? 1 : 0);
  while (retained.length > TASK_OBSERVATION_ENTRY_LIMIT) {
    retained.splice(oldestOutput(), 1);
    truncated = true;
  }
  let length = retained.reduce((total, entry) => total + entry.text.length, 0);
  while (length > TASK_OBSERVATION_TEXT_LIMIT) {
    const index = oldestOutput();
    const entry = retained[index];
    if (!entry) break;
    if (index < retained.length - 1) {
      retained.splice(index, 1);
      length -= entry.text.length;
    } else {
      const available = TASK_OBSERVATION_TEXT_LIMIT - (length - entry.text.length);
      retained[index] = {
        ...entry,
        text: entry.text.slice(-available).replace(/^[\uDC00-\uDFFF]/u, ""),
      };
      length = TASK_OBSERVATION_TEXT_LIMIT;
    }
    truncated = true;
  }
  child.observation = { ...child.observation, entries: retained, truncated };
  child.observationDirty = true;
}

function appendText(child: Child, kind: "assistant" | "reasoning", text: string): void {
  if (!text) return;
  const last = child.observation.entries.at(-1);
  if (last && last.id === child.openTextId && last.kind === kind) {
    retainObservation(child, [
      ...child.observation.entries.slice(0, -1),
      { ...last, text: last.text + text },
    ]);
  } else {
    const id = `text-${++child.nextEntry}`;
    child.openTextId = id;
    retainObservation(child, [...child.observation.entries, { id, kind, text }]);
  }
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
  readonly scope: Scope.Scope;
  readonly getTurn: () => { readonly id: TurnId; readonly startedAtMs: number } | undefined;
  readonly makeStamp: () => Effect.Effect<Pick<ProviderRuntimeEvent, "eventId" | "createdAt">, E>;
  readonly publish: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
}): Effect.fn.Return<KiroSubagents<E>> {
  const children = new Map<string, Child>();
  const lock = yield* Semaphore.make(1);
  const signals = yield* Queue.sliding<void>(OBSERVATION_SIGNAL_CAPACITY);
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
  const flushObservation = Effect.fnUntraced(function* (child: Child) {
    if (!child.observationDirty) return;
    yield* publish(child, {
      type: "task.progress",
      payload: {
        ...linkage(child),
        description: child.description,
        observation: child.observation,
      },
    });
    child.observationDirty = false;
  });
  const worker = yield* Effect.gen(function* () {
    while (true) {
      yield* Queue.take(signals);
      yield* Effect.sleep(OBSERVATION_FLUSH_INTERVAL_MS);
      yield* lock
        .withPermit(
          Effect.gen(function* () {
            if (closed) return;
            for (const child of children.values()) yield* flushObservation(child);
          }),
        )
        .pipe(
          Effect.catch((cause) => Effect.logError("Failed to publish Kiro child chat", { cause })),
        );
    }
  }).pipe(Effect.forkIn(input.scope));
  const complete = (child: Child) =>
    Effect.gen(function* () {
      if (child.state !== "terminated" || child.summary === undefined) return;
      yield* flushObservation(child);
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
                observation: {
                  entries: native.initialQuery
                    ? [
                        {
                          id: "prompt",
                          kind: "user",
                          text: native.initialQuery
                            .slice(0, PROMPT_TEXT_LIMIT)
                            .replace(/[\uD800-\uDBFF]$/u, ""),
                        },
                      ]
                    : [],
                  truncated: (native.initialQuery?.length ?? 0) > PROMPT_TEXT_LIMIT,
                  contextUsage: null,
                },
                observationDirty: true,
                firstReplyPublished: false,
                nextEntry: 0,
                openTextId: undefined,
              };
              children.set(native.sessionId, child);
              yield* publish(child, {
                type: "task.started",
                payload: { ...linkage(child), description: child.description },
              });
              yield* flushObservation(child);
            }
            if (child.state === "completed" || child.state === "closed") continue;
            if (native.status.type === "terminated") {
              yield* flushObservation(child);
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
          if (!child || child.state === "closed" || sessionUpdateIsReplay(notification)) return;
          const update = notification.update;
          if (
            update.sessionUpdate === "agent_message_chunk" ||
            update.sessionUpdate === "agent_thought_chunk"
          ) {
            if (update.content.type !== "text" || !update.content.text) return;
            appendText(
              child,
              update.sessionUpdate === "agent_message_chunk" ? "assistant" : "reasoning",
              update.content.text,
            );
            if (!child.firstReplyPublished) {
              yield* flushObservation(child);
              child.firstReplyPublished = true;
            } else {
              yield* Queue.offer(signals, undefined);
            }
            return;
          }
          if (update.sessionUpdate === "usage_update") {
            const previous = child.observation.contextUsage;
            if (previous?.usedTokens === update.used && previous.capacityTokens === update.size)
              return;
            child.observation = {
              ...child.observation,
              contextUsage: { usedTokens: update.used, capacityTokens: update.size },
            };
            child.observationDirty = true;
            yield* Queue.offer(signals, undefined);
            return;
          }
          if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update")
            return;
          child.openTextId = undefined;
          const id = `tool:${update.toolCallId}`;
          const previous = child.observation.entries.find((entry) => entry.id === id);
          const title = update.title ?? previous?.text.split(" · ")[0];
          if (title) {
            const entry: ObservationEntry = {
              id,
              kind: "tool",
              text: `${title.slice(0, TOOL_TITLE_LIMIT).replace(/[\uD800-\uDBFF]$/u, "")}${update.status ? ` · ${update.status}` : ""}`,
            };
            if (entry.text !== previous?.text) {
              retainObservation(
                child,
                previous
                  ? child.observation.entries.map((current) =>
                      current.id === id ? entry : current,
                    )
                  : [...child.observation.entries, entry],
              );
              yield* Queue.offer(signals, undefined);
            }
          }
          if (child.state === "completed") return;
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
      lock
        .withPermit(
          Effect.gen(function* () {
            if (closed) return;
            closed = true;
            for (const child of children.values()) {
              yield* flushObservation(child);
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
                  payload: {
                    ...linkage(child),
                    status: "interrupted",
                    description: UNKNOWN_OUTCOME,
                  },
                });
              }
            }
          }),
        )
        .pipe(Effect.andThen(Fiber.interrupt(worker)), Effect.asVoid),
  };
});
