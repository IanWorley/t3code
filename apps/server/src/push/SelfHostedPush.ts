import type {
  AuthSessionId,
  EnvironmentId,
  OrchestrationEvent,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import type { AgentAwarenessState } from "@t3tools/shared/agentAwareness";
import { projectThreadAwareness } from "@t3tools/shared/agentAwareness";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type * as SqlError from "effect/unstable/sql/SqlError";
import type * as Scope from "effect/Scope";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { eventThreadId, shouldPublishAgentAwarenessEvent } from "../relay/AgentAwarenessRelay.ts";
import { forkParked } from "../serverActivation.ts";
import { createPushTransport, type PushAlert, type PushPlatform } from "./transport.ts";
import { makePushDeviceStore } from "./devices.ts";

const TERMINAL_NOTIFICATION_FRESHNESS_MS = 2 * 60 * 1_000;
const PUSH_DELIVERY_CONCURRENCY = 4;

export interface PushState extends AgentAwarenessState {
  readonly runId: TurnId | null;
}

export function makePushEventProcessor(input: {
  readonly previousByThread: Map<ThreadId, PushState | null>;
  readonly devices: Effect.Success<typeof makePushDeviceStore>;
  readonly transport: ReturnType<typeof createPushTransport>;
  readonly now: () => Effect.Effect<DateTime.DateTime>;
}) {
  return Effect.fn("SelfHostedPush.processEvent")(function* (
    event: OrchestrationEvent,
    next: PushState | null,
  ) {
    if (!shouldPublishAgentAwarenessEvent(event)) return;
    const threadId = eventThreadId(event);
    if (threadId === null) return;
    const previous = input.previousByThread.get(threadId);
    input.previousByThread.set(threadId, next);
    const now = yield* input.now();
    const alert = alertForTransition(previous, next, now.epochMilliseconds);
    if (!alert) return;
    const activeDevices = yield* input.devices.active(DateTime.formatIso(now));
    yield* Effect.forEach(
      activeDevices,
      (device) =>
        Effect.tryPromise(() => input.transport.send(device.platform, device.token, alert)).pipe(
          Effect.flatMap((result) =>
            result.kind === "invalid-token"
              ? input.devices.invalidate(device)
              : result.kind === "failed"
                ? Effect.logWarning("self-hosted push delivery failed", {
                    platform: device.platform,
                    status: result.status,
                    reason: result.reason,
                  })
                : Effect.void,
          ),
          Effect.catch((error) =>
            Effect.logWarning("self-hosted push transport failed", {
              platform: device.platform,
              error,
            }),
          ),
        ),
      { concurrency: PUSH_DELIVERY_CONCURRENCY, discard: true },
    );
  });
}

export class SelfHostedPush extends Context.Service<
  SelfHostedPush,
  {
    readonly register: (input: {
      readonly sessionId: AuthSessionId;
      readonly deviceId: string;
      readonly platform: PushPlatform;
      readonly token: string;
    }) => Effect.Effect<boolean, SqlError.SqlError>;
    readonly remove: (input: {
      readonly sessionId: AuthSessionId;
      readonly deviceId: string;
    }) => Effect.Effect<boolean, SqlError.SqlError>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/push/SelfHostedPush") {}

export function alertForTransition(
  previous: PushState | null | undefined,
  next: PushState | null,
  nowMs: number,
): PushAlert | null {
  if (!previous || !next) return null;
  const newRun = next.runId !== null && previous.runId !== next.runId;
  if (previous.phase === next.phase && !newRun) return null;
  if (next.phase === "waiting_for_approval" || next.phase === "waiting_for_input") {
    if (
      (previous.phase === "waiting_for_approval" || previous.phase === "waiting_for_input") &&
      !newRun
    )
      return null;
  } else if (next.phase === "completed" || next.phase === "failed") {
    if ((previous.phase === "completed" || previous.phase === "failed") && !newRun) return null;
    const updatedAt = Date.parse(next.updatedAt);
    if (!Number.isFinite(updatedAt) || nowMs - updatedAt > TERMINAL_NOTIFICATION_FRESHNESS_MS)
      return null;
  } else {
    return null;
  }
  return {
    title: `${next.headline}: ${next.projectTitle}`,
    body: next.threadTitle,
    deepLink: next.deepLink,
  };
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const devices = yield* makePushDeviceStore;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const orchestration = yield* OrchestrationEngine.OrchestrationEngineService;
  const transport = createPushTransport();
  const previousByThread = new Map<ThreadId, PushState | null>();

  const register: SelfHostedPush["Service"]["register"] = Effect.fn("SelfHostedPush.register")(
    function* (input) {
      if (!transport.capabilities[input.platform]) return false;
      yield* devices.register(input);
      return true;
    },
  );

  const remove: SelfHostedPush["Service"]["remove"] = Effect.fn("SelfHostedPush.remove")(
    function* (input) {
      return yield* devices.remove(input);
    },
  );

  const readState = Effect.fn("SelfHostedPush.readState")(function* (
    environmentId: EnvironmentId,
    threadId: ThreadId,
  ) {
    const thread = yield* snapshots.getThreadShellById(threadId);
    if (Option.isNone(thread)) return null;
    const project = yield* snapshots.getProjectShellById(thread.value.projectId);
    if (Option.isNone(project)) return null;
    const state = projectThreadAwareness({
      environmentId,
      project: project.value,
      thread: thread.value,
    });
    return state ? { ...state, runId: thread.value.latestTurn?.turnId ?? null } : null;
  });

  const processEvent = makePushEventProcessor({
    previousByThread,
    devices,
    transport,
    now: () => DateTime.now,
  });

  const worker = yield* makeDrainableWorker(
    (item: { readonly event: OrchestrationEvent; readonly state: PushState | null }) =>
      processEvent(item.event, item.state).pipe(
        Effect.catch((error) =>
          Effect.logWarning("self-hosted push processing failed", {
            threadId: eventThreadId(item.event),
            error,
          }),
        ),
      ),
  );

  const start: SelfHostedPush["Service"]["start"] = Effect.fn("SelfHostedPush.start")(function* () {
    if (!transport.capabilities.ios && !transport.capabilities.android) return;
    const environmentId = yield* environment.getEnvironmentId;
    yield* snapshots.getShellSnapshot().pipe(
      Effect.tap((snapshot) =>
        Effect.sync(() => {
          const projects = new Map(snapshot.projects.map((project) => [project.id, project]));
          for (const thread of snapshot.threads) {
            const project = projects.get(thread.projectId);
            if (!project) continue;
            const state = projectThreadAwareness({ environmentId, project, thread });
            previousByThread.set(
              thread.id,
              state ? { ...state, runId: thread.latestTurn?.turnId ?? null } : null,
            );
          }
        }),
      ),
      Effect.catch((error) => Effect.logWarning("self-hosted push baseline failed", { error })),
    );
    yield* forkParked(
      Stream.runForEach(orchestration.streamDomainEvents, (event) =>
        Effect.gen(function* () {
          if (!shouldPublishAgentAwarenessEvent(event)) return;
          const threadId = eventThreadId(event);
          if (threadId === null) return;
          const state = yield* readState(environmentId, threadId);
          yield* worker.enqueue({ event, state });
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("self-hosted push snapshot failed", { eventType: event.type, error }),
          ),
        ),
      ),
    );
    yield* Effect.logInfo("self-hosted push delivery started", transport.capabilities);
  });

  return SelfHostedPush.of({ register, remove, start });
});

export const layer = Layer.effect(SelfHostedPush, make);
