import {
  AuthSessionId,
  EnvironmentId,
  ThreadId,
  TurnId,
  OrchestrationEvent,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as AuthSessions from "../persistence/AuthSessions.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makePushDeviceStore } from "./devices.ts";
import { makePushEventProcessor, type PushState } from "./SelfHostedPush.ts";

const NOW = "2026-09-24T12:00:00.000Z";
const FUTURE = "2026-10-24T12:00:00.000Z";
const decodeEvent = Schema.decodeUnknownEffect(OrchestrationEvent);

const testLayer = AuthSessions.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory));

function createSession(sessionId: AuthSessionId) {
  return Effect.gen(function* () {
    const sessions = yield* AuthSessions.AuthSessionRepository;
    yield* sessions.create({
      sessionId,
      subject: sessionId,
      scopes: ["orchestration:read"],
      method: "bearer-access-token",
      client: {
        label: null,
        ipAddress: null,
        userAgent: null,
        deviceType: "mobile",
        os: null,
        browser: null,
      },
      issuedAt: DateTime.makeUnsafe(NOW),
      expiresAt: DateTime.makeUnsafe(FUTURE),
    });
  });
}

describe("self-hosted push device registrations", () => {
  it.effect("delivers only to active sessions and removes an opted-out device", () =>
    Effect.gen(function* () {
      const first = AuthSessionId.make("push-session-a");
      const second = AuthSessionId.make("push-session-b");
      yield* createSession(first);
      yield* createSession(second);
      const store = yield* makePushDeviceStore;
      yield* store.register({
        sessionId: first,
        deviceId: "phone-a",
        platform: "ios",
        token: "aa11",
      });
      yield* store.register({
        sessionId: second,
        deviceId: "phone-b",
        platform: "android",
        token: "fcm-b",
      });
      assert.deepStrictEqual(yield* store.active(NOW), [
        { platform: "ios", token: "aa11" },
        { platform: "android", token: "fcm-b" },
      ]);

      const sessions = yield* AuthSessions.AuthSessionRepository;
      yield* sessions.revoke({ sessionId: first, revokedAt: DateTime.makeUnsafe(NOW) });
      assert.deepStrictEqual(yield* store.active(NOW), [{ platform: "android", token: "fcm-b" }]);
      assert.equal(yield* store.remove({ sessionId: second, deviceId: "phone-b" }), true);
      assert.deepStrictEqual(yield* store.active(NOW), []);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("moves a rotated token to the current session and invalidates a rejected token", () =>
    Effect.gen(function* () {
      const first = AuthSessionId.make("push-rotation-a");
      const second = AuthSessionId.make("push-rotation-b");
      yield* createSession(first);
      yield* createSession(second);
      const store = yield* makePushDeviceStore;
      yield* store.register({
        sessionId: first,
        deviceId: "phone",
        platform: "ios",
        token: "aa11",
      });
      yield* store.register({
        sessionId: second,
        deviceId: "phone",
        platform: "ios",
        token: "aa11",
      });
      assert.equal(yield* store.remove({ sessionId: first, deviceId: "phone" }), false);
      assert.deepStrictEqual(yield* store.active(NOW), [{ platform: "ios", token: "aa11" }]);
      yield* store.invalidate({ platform: "ios", token: "aa11" });
      assert.deepStrictEqual(yield* store.active(NOW), []);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("sends a projected approval after a domain event and removes a rejected token", () =>
    Effect.gen(function* () {
      const sessionId = AuthSessionId.make("push-event-session");
      yield* createSession(sessionId);
      const store = yield* makePushDeviceStore;
      yield* store.register({ sessionId, deviceId: "phone", platform: "ios", token: "aa11" });
      const threadId = ThreadId.make("push-event-thread");
      const running: PushState = {
        environmentId: EnvironmentId.make("push-environment"),
        threadId,
        projectTitle: "Project",
        threadTitle: "Fix login",
        phase: "running",
        headline: "Working",
        modelTitle: "Codex",
        updatedAt: NOW,
        deepLink: "/threads/push-environment/push-event-thread",
        runId: TurnId.make("run-a"),
      };
      const deliveries: Array<{ platform: string; token: string; title: string }> = [];
      const processEvent = makePushEventProcessor({
        previousByThread: new Map([[threadId, running]]),
        devices: store,
        transport: {
          capabilities: { ios: true, android: false },
          send: async (platform, token, alert) => {
            deliveries.push({ platform, token, title: alert.title });
            return { kind: "invalid-token", status: 410 };
          },
        },
        now: () => Effect.succeed(DateTime.makeUnsafe(NOW)),
      });
      const event = yield* decodeEvent({
        sequence: 1,
        eventId: "push-event-1",
        occurredAt: NOW,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        type: "thread.meta-updated",
        aggregateKind: "thread",
        aggregateId: threadId,
        metadata: {},
        payload: { threadId, title: "Fix login", updatedAt: NOW },
      });
      yield* processEvent(event, {
        ...running,
        phase: "waiting_for_approval",
        headline: "Approval",
      });
      assert.deepStrictEqual(deliveries, [
        { platform: "ios", token: "aa11", title: "Approval: Project" },
      ]);
      assert.deepStrictEqual(yield* store.active(NOW), []);
    }).pipe(Effect.provide(testLayer)),
  );
});
