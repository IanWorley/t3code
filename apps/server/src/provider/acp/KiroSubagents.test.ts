import { assert, it } from "@effect/vitest";
import {
  EventId,
  ThreadId,
  TurnId,
  TaskAgentObservation,
  TASK_OBSERVATION_TEXT_LIMIT,
  ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as AcpError from "effect-acp/errors";
import * as AcpSchema from "effect-acp/schema-v1";
import type * as AcpCompat from "effect-acp/compat";
import * as TestClock from "effect/testing/TestClock";
import * as Queue from "effect/Queue";

import { kiroTaskEventToSubagentUpdate } from "../../orchestration-v2/Adapters/KiroAdapterV2.ts";
import type { AcpAdapterV2SubagentUpdate } from "@t3tools/provider-acp/server/adapter";
import capture from "../testFixtures/kiroSubagents.json" with { type: "json" };
import { makeKiroSubagents } from "./KiroSubagents.ts";

const FIRST_TURN = TurnId.make("kiro-first-turn");
const SECOND_TURN = TurnId.make("kiro-second-turn");
const STARTED_AT = Date.parse("2026-09-30T00:00:00.000Z");
const LIST_METHOD = "_kiro.dev/subagent/list_update";
const decodeNotification = Schema.decodeUnknownEffect(AcpSchema.SessionNotification);
const encodeEvents = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(ProviderRuntimeEvent)));
const encodeActivities = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const observationCodec = Schema.fromJsonString(TaskAgentObservation);
const encodeObservation = Schema.encodeEffect(observationCodec);
const decodeObservation = Schema.decodeEffect(observationCodec);

const makeHarness = Effect.fnUntraced(function* () {
  let list: (params: unknown) => Effect.Effect<void, AcpError.AcpError> = () => Effect.void;
  let update: (
    params: AcpCompat.SessionNotification,
  ) => Effect.Effect<void, AcpError.AcpError> = () => Effect.void;
  let turn = { id: FIRST_TURN, startedAtMs: STARTED_AT };
  let sequence = 0;
  const events: ProviderRuntimeEvent[] = [];
  const observations = yield* Queue.unbounded<TaskAgentObservation>();
  const children = yield* makeKiroSubagents({
    runtime: {
      handleExtNotification: (_method, codec, handler) =>
        Effect.sync(() => {
          const decode = Schema.decodeUnknownEffect(codec);
          list = (params) =>
            decode(params).pipe(
              Effect.mapError(
                (cause) =>
                  new AcpError.AcpTransportError({ detail: "Invalid test notification", cause }),
              ),
              Effect.flatMap(handler),
            );
        }),
      handleSessionUpdate: (handler) =>
        Effect.sync(() => {
          update = handler;
        }),
    },
    threadId: ThreadId.make("kiro-child-test"),
    scope: yield* Effect.scope,
    getTurn: () => turn,
    makeStamp: () =>
      Effect.sync(() => ({
        eventId: EventId.make(`kiro-event-${++sequence}`),
        createdAt: DateTime.formatIso(DateTime.makeUnsafe(STARTED_AT + sequence)),
      })),
    publish: (event) =>
      Effect.gen(function* () {
        events.push(event);
        if (event.type === "task.progress" && event.payload.observation) {
          yield* Queue.offer(observations, event.payload.observation);
        }
      }),
  });
  return {
    events,
    children,
    nextObservation: Queue.take(observations),
    nextTurn: () => {
      turn = { id: SECOND_TURN, startedAtMs: STARTED_AT + 1 };
    },
    notify: (method: string, params: unknown) =>
      method === LIST_METHOD
        ? list(params)
        : decodeNotification(params).pipe(
            Effect.flatMap((notification) =>
              notification.update.sessionUpdate === "agent_message_chunk" ||
              notification.update.sessionUpdate === "agent_thought_chunk" ||
              notification.update.sessionUpdate === "usage_update" ||
              notification.update.sessionUpdate === "tool_call" ||
              notification.update.sessionUpdate === "tool_call_update"
                ? update({ ...notification, update: notification.update })
                : Effect.void,
            ),
          ),
  };
});

function nativeChild(status: string, sessionId = "child-one", createdAtMs = STARTED_AT) {
  return {
    sessionId,
    sessionName: "alpha",
    role: "kiro_default",
    initialQuery: "Reply with alpha",
    createdAtMs,
    status: { type: status, message: "Running" },
  };
}

function summaryUpdate(sessionId: string, completed: boolean) {
  return {
    sessionId,
    update: {
      sessionUpdate: completed ? "tool_call_update" : "tool_call",
      toolCallId: "summary-tool",
      ...(completed
        ? { status: "completed" }
        : { title: "Summarizing", _meta: { kiro: { toolName: "summary" } } }),
      rawInput: { taskResult: "alpha" },
    },
  };
}

function projectedActivities(events: ReadonlyArray<ProviderRuntimeEvent>) {
  const updates = new Map<string, AcpAdapterV2SubagentUpdate>();
  for (const event of events) {
    if (
      event.type === "task.started" ||
      event.type === "task.progress" ||
      event.type === "task.updated" ||
      event.type === "task.completed"
    ) {
      updates.set(
        event.payload.taskId,
        kiroTaskEventToSubagentUpdate(event, updates.get(event.payload.taskId)),
      );
    }
  }
  return [...updates.values()];
}

function textUpdate(text: string, sessionId = "child-one", reasoning = false) {
  return {
    sessionId,
    update: {
      sessionUpdate: reasoning ? "agent_thought_chunk" : "agent_message_chunk",
      content: { type: "text", text },
    },
  };
}

it.effect("bounds publication and serialized state for ten interleaved streaming children", () =>
  Effect.gen(function* () {
    const CHILD_COUNT = 10;
    const CHUNK_COUNT = 64;
    const CHUNK_LENGTH = 200;
    const CHUNKS_PER_FLUSH = 8;
    const MAX_WIRE_BYTES = 750_000;
    const MAX_SNAPSHOT_BYTES = 100_000;
    const h = yield* makeHarness();
    const ids = Array.from({ length: CHILD_COUNT }, (_, index) => `child-${index}`);
    yield* h.notify(LIST_METHOD, { subagents: ids.map((id) => nativeChild("working", id)) });
    for (let chunk = 0; chunk < CHUNK_COUNT; chunk++) {
      for (const id of ids)
        yield* h.notify("session/update", textUpdate("x".repeat(CHUNK_LENGTH), id));
      if ((chunk + 1) % CHUNKS_PER_FLUSH === 0) yield* TestClock.adjust("1 second");
    }
    for (const id of ids) yield* h.notify("session/update", textUpdate(" final reply", id));
    yield* h.children.close("stopped");
    const observations = h.events.filter(
      (event) => event.type === "task.progress" && event.payload.observation,
    );
    assert.ok(observations.length <= CHILD_COUNT * (CHUNK_COUNT / CHUNKS_PER_FLUSH + 3));
    const wire = yield* encodeEvents(h.events);
    assert.ok(Buffer.byteLength(wire) < MAX_WIRE_BYTES);
    const activities = projectedActivities(h.events);
    const snapshot = yield* encodeActivities(activities);
    assert.ok(Buffer.byteLength(snapshot) < MAX_SNAPSHOT_BYTES);
    const agents = activities;
    assert.equal(agents.length, CHILD_COUNT);
    assert.ok(
      agents.every((agent) => agent.observation?.entries.at(-1)?.text.endsWith(" final reply")),
    );
  }),
);

it.effect(
  "publishes the first child reply promptly and coalesces whitespace-preserving deltas",
  () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.notify(LIST_METHOD, { subagents: [nativeChild("working")] });
      yield* h.nextObservation;
      yield* h.notify("session/update", textUpdate(" alpha"));
      assert.equal((yield* h.nextObservation).entries.at(-1)?.text, " alpha");
      yield* h.notify("session/update", textUpdate("\n"));
      yield* h.notify("session/update", textUpdate(" beta "));
      const count = h.events.length;
      yield* TestClock.adjust("1 second");
      assert.equal((yield* h.nextObservation).entries.at(-1)?.text, " alpha\n beta ");
      assert.equal(h.events.length, count + 1);
      yield* TestClock.adjust("5 seconds");
      assert.equal(h.events.length, count + 1);
      const agents = projectedActivities(h.events);
      assert.equal(agents[0]?.progress, "Running");
      assert.equal(agents[0]?.status, "running");
    }),
);

it.effect(
  "flushes pending output on completion and retains late output without reopening the child",
  () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.notify(LIST_METHOD, { subagents: [nativeChild("working")] });
      yield* h.notify("session/update", textUpdate("first"));
      yield* h.notify("session/update", textUpdate(" final tail"));
      yield* h.notify("session/update", summaryUpdate("child-one", false));
      yield* h.notify("session/update", summaryUpdate("child-one", true));
      yield* h.notify(LIST_METHOD, { subagents: [nativeChild("terminated")] });
      let agent = projectedActivities(h.events)[0];
      assert.equal(agent?.status, "completed");
      assert.equal(
        agent?.observation?.entries.find((entry) => entry.kind === "assistant")?.text,
        "first final tail",
      );
      yield* h.notify("session/update", textUpdate("late reply"));
      yield* h.children.close("stopped");
      agent = projectedActivities(h.events)[0];
      assert.equal(agent?.status, "completed");
      assert.equal(agent?.observation?.entries.at(-1)?.text, "late reply");
    }),
);

it.effect(
  "replaces decreasing context snapshots after completion without inventing output usage",
  () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.notify(LIST_METHOD, { subagents: [nativeChild("working")] });
      yield* h.notify("session/update", summaryUpdate("child-one", false));
      yield* h.notify("session/update", summaryUpdate("child-one", true));
      yield* h.notify(LIST_METHOD, { subagents: [nativeChild("terminated")] });
      for (const used of [12_000, 4_000]) {
        yield* h.notify("session/update", {
          sessionId: "child-one",
          update: { sessionUpdate: "usage_update", used, size: 200_000 },
        });
        yield* TestClock.adjust("1 second");
      }
      const agent = projectedActivities(h.events)[0];
      assert.deepStrictEqual(agent?.observation?.contextUsage, {
        usedTokens: 4_000,
        capacityTokens: 200_000,
      });
      assert.equal(agent?.status, "completed");
    }),
);

it.effect("ignores replay and root chunks while retaining separate child reasoning", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    yield* h.notify(LIST_METHOD, { subagents: [nativeChild("working")] });
    yield* h.notify("session/update", textUpdate("root answer", "root"));
    yield* h.notify("session/update", { ...textUpdate("old answer"), _meta: { isReplay: true } });
    yield* h.notify("session/update", textUpdate("thinking", "child-one", true));
    yield* h.notify("session/update", textUpdate("reply"));
    yield* h.children.close("stopped");
    assert.deepStrictEqual(
      projectedActivities(h.events)[0]?.observation?.entries.map(({ kind, text }) => ({
        kind,
        text,
      })),
      [
        { kind: "user", text: "Reply with alpha" },
        { kind: "reasoning", text: "thinking" },
        { kind: "assistant", text: "reply" },
      ],
    );
  }),
);

it.effect("keeps a bounded Unicode output tail and the task instruction", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    yield* h.notify(LIST_METHOD, { subagents: [nativeChild("working")] });
    yield* h.notify("session/update", textUpdate("😀".repeat(TASK_OBSERVATION_TEXT_LIMIT)));
    yield* h.notify("session/update", textUpdate(" final answer"));
    yield* h.children.close("stopped");
    const observation = projectedActivities(h.events)[0]?.observation;
    assert.ok(observation);
    assert.equal(observation.entries[0]?.text, "Reply with alpha");
    assert.equal(observation.truncated, true);
    assert.ok(observation.entries.at(-1)?.text.endsWith(" final answer"));
    assert.ok(
      observation.entries.reduce((length, entry) => length + entry.text.length, 0) <=
        TASK_OBSERVATION_TEXT_LIMIT,
    );
    assert.ok(observation.entries.every((entry) => entry.text.isWellFormed()));
    assert.deepStrictEqual(
      yield* decodeObservation(yield* encodeObservation(observation)),
      observation,
    );
  }),
);

it.effect(
  "replays two real Kiro children into the existing Agents model without duplicate lifecycles",
  () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      for (const notification of capture) yield* h.notify(notification.method, notification.params);
      const observed = projectedActivities(h.events);
      assert.deepStrictEqual(
        observed.map((agent) =>
          agent.observation?.entries
            .filter((entry) => entry.kind === "assistant")
            .map((entry) => entry.text),
        ),
        [["alpha"], ["beta"]],
      );
      for (const notification of capture) yield* h.notify(notification.method, notification.params);
      assert.equal(h.events.filter((event) => event.type === "task.started").length, 2);
      assert.equal(
        h.events.filter((event) => event.type === "task.progress" && !event.payload.observation)
          .length,
        2,
      );
      assert.equal(h.events.filter((event) => event.type === "task.completed").length, 2);
      const agents = projectedActivities(h.events);
      assert.deepStrictEqual(
        agents.map(({ nativeTaskId, title, status, result }) => ({
          id: nativeTaskId,
          title,
          status,
          result,
        })),
        [
          {
            id: "14c60fe5-3a00-470e-8ac9-85b404431d0c",
            title: "alpha",
            status: "completed",
            result: "alpha",
          },
          {
            id: "5f6692e4-3655-4ed1-91b1-8c70b48c177e",
            title: "beta",
            status: "completed",
            result: 'Replied with "beta" as instructed.',
          },
        ],
      );
    }),
);

it.effect(
  "preserves the originating turn and ignores omitted, stale and malformed inventory members",
  () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.notify(LIST_METHOD, {
        subagents: [null, { sessionId: "bad" }, nativeChild("working")],
      });
      h.nextTurn();
      yield* h.notify(LIST_METHOD, { subagents: [] });
      yield* h.notify(LIST_METHOD, {
        subagents: [
          nativeChild("future-status"),
          nativeChild("working", "old-child", STARTED_AT - 1),
        ],
      });
      yield* h.notify("session/update", summaryUpdate("child-one", false));
      yield* h.notify("session/update", summaryUpdate("child-one", true));
      assert.equal(h.events.filter((event) => event.type === "task.completed").length, 0);
      yield* h.notify(LIST_METHOD, { subagents: [nativeChild("terminated")] });
      assert.equal(h.events.at(-1)?.turnId, FIRST_TURN);
      assert.equal(
        h.events.find(
          (event) => event.type === "task.started" && event.payload.taskId === "old-child",
        )?.turnId,
        undefined,
      );
    }),
);

it.effect(
  "settles unknown termination as idle and accepts a later proven result in the UI fold",
  () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.notify(LIST_METHOD, { subagents: [nativeChild("terminated")] });
      let agents = projectedActivities(h.events);
      assert.equal(agents[0]?.status, "idle");
      assert.equal(agents[0]?.result, null);
      assert.equal(agents[0]?.progress, "Agent ended; result unavailable.");
      yield* h.notify("session/update", summaryUpdate("child-one", false));
      yield* h.notify("session/update", summaryUpdate("child-one", true));
      agents = projectedActivities(h.events);
      assert.equal(agents[0]?.status, "completed");
      assert.equal(agents[0]?.result, "alpha");
    }),
);

it.effect(
  "interrupts unresolved children on connection loss and ignores events after closure",
  () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.notify(LIST_METHOD, {
        subagents: [nativeChild("terminated"), nativeChild("working", "child-two")],
      });
      yield* h.children.close("interrupted");
      yield* h.children.close("interrupted");
      yield* h.notify(LIST_METHOD, { subagents: [nativeChild("working", "child-three")] });
      const agents = projectedActivities(h.events);
      assert.deepStrictEqual(
        agents.map((agent) => agent.status),
        ["interrupted", "interrupted"],
      );
    }),
);

it.effect(
  "retains summary input for sparse completion without claiming success before termination",
  () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.notify(LIST_METHOD, { subagents: [nativeChild("working")] });
      yield* h.notify("session/update", summaryUpdate("child-one", false));
      yield* h.notify("session/update", {
        sessionId: "child-one",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "summary-tool",
          status: "completed",
        },
      });
      assert.equal(h.events.filter((event) => event.type === "task.completed").length, 0);
      yield* h.notify(LIST_METHOD, { subagents: [nativeChild("terminated")] });
      assert.deepStrictEqual(
        h.events.flatMap((event) =>
          event.type === "task.completed" ? [event.payload.summary] : [],
        ),
        ["alpha"],
      );
    }),
);

it.effect("stops live children on session shutdown while preserving successful results", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    yield* h.notify(LIST_METHOD, {
      subagents: [nativeChild("working"), nativeChild("working", "child-two")],
    });
    yield* h.notify("session/update", summaryUpdate("child-one", false));
    yield* h.notify("session/update", summaryUpdate("child-one", true));
    yield* h.notify(LIST_METHOD, { subagents: [nativeChild("terminated")] });
    yield* h.children.close("stopped");
    const agents = projectedActivities(h.events);
    assert.deepStrictEqual(
      agents.map(({ status, result }) => ({ status, result })),
      [
        { status: "completed", result: "alpha" },
        { status: "interrupted", result: null },
      ],
    );
  }),
);
