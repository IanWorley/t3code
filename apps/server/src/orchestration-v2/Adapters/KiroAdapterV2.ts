import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import {
  EventId,
  KiroSettings,
  ProviderDriverKind,
  ThreadId,
  type ProviderRuntimeEvent,
  type OrchestrationV2ProviderCapabilities,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import type { AcpSessionModeState } from "@t3tools/provider-acp/server/runtimeModel";
import type { ProviderInteractionMode } from "@t3tools/contracts";
import { ChildProcessSpawner } from "effect/process";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { makeAcpNativeLoggerFactory } from "@t3tools/provider-acp/server/nativeLogging";
import {
  applyKiroAcpModelSelection,
  makeKiroAcpRuntime,
  resolveKiroAcpBaseModelId,
} from "../../provider/acp/KiroAcpSupport.ts";
import { makeKiroSubagents } from "../../provider/acp/KiroSubagents.ts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "@t3tools/provider-core/server/adapterDriver";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
  type AcpAdapterV2SubagentUpdate,
  type AcpAdapterV2Options,
} from "@t3tools/provider-acp/server/adapter";

export const KIRO_PROVIDER = ProviderDriverKind.make("kiro");
const KIRO_DRIVER_KIND = KIRO_PROVIDER;
const DEFAULT_KIRO_SETTINGS = Schema.decodeSync(KiroSettings)({});
const KIRO_PLANNER_MODE_ID = "kiro_planner";
const ACP_PLAN_MODE_ALIASES = ["plan", "architect"];
export type KiroAdapterV2Options = Omit<AcpAdapterV2Options, "flavor"> & {
  readonly settings: KiroSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly makeRuntime?: AcpAdapterV2Flavor["makeRuntime"];
};
export const KiroProviderCapabilitiesV2 = {
  ...AcpProviderCapabilitiesV2,
  sessions: { ...AcpProviderCapabilitiesV2.sessions, supportsModelSwitchInSession: true },
  subagents: {
    ...AcpProviderCapabilitiesV2.subagents,
    supportsSubagents: true,
    exposesSubagentThreadIds: true,
    emitsSubagentLifecycle: true,
  },
} satisfies OrchestrationV2ProviderCapabilities;

type KiroTaskEvent = Extract<
  ProviderRuntimeEvent,
  { type: "task.started" | "task.progress" | "task.updated" | "task.completed" }
>;
export function kiroTaskEventToSubagentUpdate(
  event: KiroTaskEvent,
  previous?: AcpAdapterV2SubagentUpdate,
): AcpAdapterV2SubagentUpdate {
  const payload = event.payload;
  const status = "status" in payload ? payload.status : undefined;
  const observationOnly =
    event.type === "task.progress" &&
    "observation" in payload &&
    payload.observation !== undefined &&
    status === undefined &&
    payload.summary === undefined;
  const progress =
    event.type !== "task.started" &&
    !observationOnly &&
    "description" in payload &&
    payload.description !== undefined
      ? payload.description
      : "summary" in payload && payload.summary !== undefined && event.type !== "task.completed"
        ? payload.summary
        : undefined;
  return {
    ...previous,
    observationOnly,
    nativeTaskId: payload.taskId,
    childSessionId: payload.taskId,
    prompt:
      event.type === "task.started" && "description" in payload
        ? (payload.description ?? previous?.prompt ?? "")
        : (previous?.prompt ?? ""),
    title: payload.title ?? previous?.title ?? "Kiro subagent",
    model: payload.model ?? null,
    status:
      status === "stopped"
        ? "interrupted"
        : status === "interrupted"
          ? "interrupted"
          : status === "failed"
            ? "failed"
            : status === "completed"
              ? "completed"
              : status === "idle"
                ? "idle"
                : status === undefined
                  ? (previous?.status ?? "running")
                  : "running",
    result:
      "summary" in payload
        ? (payload.summary ?? previous?.result ?? null)
        : (previous?.result ?? null),
    ...("observation" in payload && payload.observation !== undefined
      ? { observation: payload.observation }
      : {}),
    ...(progress === undefined ? {} : { progress }),
  };
}

export function resolveKiroRequestedModeId(input: {
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly modeState: AcpSessionModeState | undefined;
  readonly defaultModeId: string | undefined;
}): string | undefined {
  if (input.modeState === undefined) return undefined;
  if (input.interactionMode !== "plan") {
    if (input.defaultModeId !== undefined) return input.defaultModeId;
    if (input.modeState.currentModeId !== KIRO_PLANNER_MODE_ID) {
      return input.modeState.currentModeId;
    }
    return input.modeState.availableModes.find((mode) => mode.id !== KIRO_PLANNER_MODE_ID)?.id;
  }
  const modes = input.modeState.availableModes;
  return (
    modes.find((mode) => mode.id === KIRO_PLANNER_MODE_ID)?.id ??
    ACP_PLAN_MODE_ALIASES.flatMap((alias) =>
      modes.filter(
        (mode) =>
          mode.id.toLowerCase() === alias ||
          mode.name.toLowerCase() === alias ||
          `${mode.id} ${mode.name} ${mode.description ?? ""}`.toLowerCase().includes(alias),
      ),
    )[0]?.id
  );
}

export function makeKiroAdapterV2(options: KiroAdapterV2Options) {
  const defaultModes = new WeakMap<object, string | undefined>();
  const flavor: AcpAdapterV2Flavor = {
    driver: KIRO_PROVIDER,
    runtimeHarness: "Kiro",
    capabilities: KiroProviderCapabilitiesV2,
    resolveModelId: (selection) => resolveKiroAcpBaseModelId(selection.model),
    applyModelSelection: ({ runtime, startResult, modelSelection }) =>
      applyKiroAcpModelSelection({
        runtime,
        sessionId: startResult.sessionId,
        model: modelSelection.model,
        selections: modelSelection.options,
        mapError: ({ cause }) => cause,
      }).pipe(Effect.as(resolveKiroAcpBaseModelId(modelSelection.model))),
    applySessionMode: ({ runtime, runtimePolicy }) =>
      Effect.gen(function* () {
        const modeState = yield* runtime.getModeState;
        if (!defaultModes.has(runtime)) {
          defaultModes.set(
            runtime,
            resolveKiroRequestedModeId({
              interactionMode: "default",
              modeState,
              defaultModeId: undefined,
            }),
          );
        }
        const mode = resolveKiroRequestedModeId({
          interactionMode: runtimePolicy.interactionMode,
          modeState,
          defaultModeId: defaultModes.get(runtime),
        });
        if (mode !== undefined && mode !== modeState?.currentModeId) yield* runtime.setMode(mode);
      }),
    makeRuntime:
      options.makeRuntime ??
      (({ runtimePolicy, ...input }) =>
        makeKiroAcpRuntime({
          ...input,
          kiroSettings: options.settings,
          environment: options.environment,
          childProcessSpawner: options.childProcessSpawner,
          runtimeMode: runtimePolicy.runtimeMode,
        })),
    registerExtensions: ({ runtime, scope, currentTurn, updateSubagent }) =>
      Effect.gen(function* () {
        const updates = new Map<string, AcpAdapterV2SubagentUpdate>();
        const tracker = yield* makeKiroSubagents({
          runtime,
          scope,
          threadId: ThreadId.make("kiro-session"),
          getTurn: () => undefined,
          resolveTurn: currentTurn,
          makeStamp: () =>
            DateTime.now.pipe(
              Effect.map((now) => ({
                eventId: EventId.make(`kiro:${DateTime.toEpochMillis(now)}`),
                createdAt: DateTime.formatIso(now),
              })),
            ),
          publish: (event) => {
            if (
              event.type !== "task.started" &&
              event.type !== "task.progress" &&
              event.type !== "task.updated" &&
              event.type !== "task.completed"
            )
              return Effect.void;
            const update = kiroTaskEventToSubagentUpdate(event, updates.get(event.payload.taskId));
            updates.set(event.payload.taskId, update);
            return updateSubagent(update);
          },
        });
        yield* Scope.addFinalizer(scope, tracker.close("interrupted"));
      }),
  };
  return makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor,
    selfInvocation: options.selfInvocation,
    ...(options.nativeLogging === undefined ? {} : { nativeLogging: options.nativeLogging }),
    ...(options.continuationRequests === undefined
      ? {}
      : { continuationRequests: options.continuationRequests }),
    ...(options.testHooks === undefined ? {} : { testHooks: options.testHooks }),
  });
}

export type KiroAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | Path.Path
  | McpProviderSessions.McpProviderSessions
  | ProviderEventLoggers.ProviderEventLoggers
  | ProviderHost.ProviderHost;

export const KiroAdapterV2Driver: ProviderAdapterDriver<KiroSettings, KiroAdapterV2DriverEnv> = {
  driverKind: KIRO_DRIVER_KIND,
  configSchema: KiroSettings,
  defaultConfig: (): KiroSettings => DEFAULT_KIRO_SETTINGS,
  create: Effect.fn("KiroAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<KiroSettings>) {
      const hostEnvironment = yield* HostProcessEnvironment;
      const selfInvocation = yield* resolveSelfInvocation();
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const providerEventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
      const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
      const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
      return yield* makeKiroAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
        childProcessSpawner,
        selfInvocation,
        continuationRequests,
        nativeLogging: (threadId) =>
          makeNativeLogger({
            nativeEventLogger: providerEventLoggers.native,
            provider: KIRO_PROVIDER,
            threadId,
          }),
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: KIRO_DRIVER_KIND,
              instanceId: input.instanceId,
              detail: "Failed to create Kiro ACP adapter.",
              cause,
            }),
        ),
      ),
  ),
};
