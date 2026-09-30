import { assert, it } from "@effect/vitest";
import { EventId, ThreadId, TurnId, type ProviderRuntimeEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as AcpError from "effect-acp/errors";
import * as AcpSchema from "effect-acp/schema";

import { foldSubagentActivities } from "../../../../../packages/client-runtime/src/state/subagentRuntime.ts";
import { runtimeEventToActivities } from "../../orchestration/Layers/ProviderRuntimeIngestion.ts";
import capture from "../testFixtures/kiroSubagents.json" with { type: "json" };
import { makeKiroSubagents } from "./KiroSubagents.ts";

const FIRST_TURN = TurnId.make("kiro-first-turn");
const SECOND_TURN = TurnId.make("kiro-second-turn");
const STARTED_AT = Date.parse("2026-09-30T00:00:00.000Z");
const LIST_METHOD = "_kiro.dev/subagent/list_update";
const decodeNotification = Schema.decodeUnknownEffect(AcpSchema.SessionNotification);

const makeHarness = Effect.fnUntraced(function* () {
  let list: (params: unknown) => Effect.Effect<void, AcpError.AcpError> = () => Effect.void;
  let update: (
    params: AcpSchema.SessionNotification,
  ) => Effect.Effect<void, AcpError.AcpError> = () => Effect.void;
  let turn = { id: FIRST_TURN, startedAtMs: STARTED_AT };
  let sequence = 0;
  const events: ProviderRuntimeEvent[] = [];
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
    getTurn: () => turn,
    makeStamp: () =>
      Effect.sync(() => ({
        eventId: EventId.make(`kiro-event-${++sequence}`),
        createdAt: DateTime.formatIso(DateTime.makeUnsafe(STARTED_AT + sequence)),
      })),
    publish: (event) =>
      Effect.sync(() => {
        events.push(event);
      }),
  });
  return {
    events,
    children,
    nextTurn: () => {
      turn = { id: SECOND_TURN, startedAtMs: STARTED_AT + 1 };
    },
    notify: (method: string, params: unknown) =>
      method === LIST_METHOD
        ? list(params)
        : decodeNotification(params).pipe(Effect.flatMap(update)),
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

it.effect(
  "replays two real Kiro children into the existing Agents model without duplicate lifecycles",
  () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      for (const notification of capture) yield* h.notify(notification.method, notification.params);
      for (const notification of capture) yield* h.notify(notification.method, notification.params);
      assert.equal(h.events.filter((event) => event.type === "task.started").length, 2);
      assert.equal(h.events.filter((event) => event.type === "task.progress").length, 2);
      assert.equal(h.events.filter((event) => event.type === "task.completed").length, 2);
      const agents = foldSubagentActivities(
        h.events.flatMap((event) => runtimeEventToActivities(event)),
      );
      assert.deepStrictEqual(
        agents.map(({ id, title, role, status, result }) => ({ id, title, role, status, result })),
        [
          {
            id: "14c60fe5-3a00-470e-8ac9-85b404431d0c",
            title: "alpha",
            role: "kiro_default",
            status: "completed",
            result: "alpha",
          },
          {
            id: "5f6692e4-3655-4ed1-91b1-8c70b48c177e",
            title: "beta",
            role: "kiro_default",
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
      let agents = foldSubagentActivities(
        h.events.flatMap((event) => runtimeEventToActivities(event)),
      );
      assert.equal(agents[0]?.status, "idle");
      assert.equal(agents[0]?.result, null);
      yield* h.notify("session/update", summaryUpdate("child-one", false));
      yield* h.notify("session/update", summaryUpdate("child-one", true));
      agents = foldSubagentActivities(h.events.flatMap((event) => runtimeEventToActivities(event)));
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
      const agents = foldSubagentActivities(
        h.events.flatMap((event) => runtimeEventToActivities(event)),
      );
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
    const agents = foldSubagentActivities(
      h.events.flatMap((event) => runtimeEventToActivities(event)),
    );
    assert.deepStrictEqual(
      agents.map(({ status, result }) => ({ status, result })),
      [
        { status: "completed", result: "alpha" },
        { status: "interrupted", result: null },
      ],
    );
  }),
);
