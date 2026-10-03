import { PiSettings, ProviderDriverKind } from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ServerConfig from "../../config.ts";
import { applyPiAcpModelSelection, makePiAcpRuntime } from "../../provider/acp/PiAcpSupport.ts";
import { makeAcpNativeLoggerFactory } from "../../provider/acp/AcpNativeLogging.ts";
import * as ProviderEventLoggers from "../../provider/Layers/ProviderEventLoggers.ts";
import { mergeProviderInstanceEnvironment } from "../../provider/ProviderInstanceEnvironment.ts";
import * as IdAllocator from "../IdAllocator.ts";
import * as ProviderContinuationRequests from "../ProviderContinuationRequests.ts";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "../ProviderAdapterDriver.ts";
import { AcpProviderCapabilitiesV2, makeAcpAdapterV2 } from "./AcpAdapterV2.ts";

const PI_PROVIDER = ProviderDriverKind.make("pi");
const DEFAULT_SETTINGS = Schema.decodeSync(PiSettings)({ binaryPath: "pi-acp" });

export type PiAcpAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | IdAllocator.IdAllocatorV2
  | ProviderEventLoggers.ProviderEventLoggers
  | ServerConfig.ServerConfig;

export const PiAcpAdapterV2Driver: ProviderAdapterDriver<PiSettings, PiAcpAdapterV2DriverEnv> = {
  driverKind: PI_PROVIDER,
  configSchema: PiSettings,
  defaultConfig: () => DEFAULT_SETTINGS,
  create: Effect.fn("PiAcpAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<PiSettings>) {
      const hostEnvironment = yield* HostProcessEnvironment;
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const crypto = yield* Crypto.Crypto;
      const fileSystem = yield* FileSystem.FileSystem;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const eventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
      const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
      const environment = mergeProviderInstanceEnvironment(input.environment, hostEnvironment);
      return makeAcpAdapterV2({
        instanceId: input.instanceId,
        crypto,
        fileSystem,
        idAllocator,
        serverConfig,
        selfInvocation: yield* resolveSelfInvocation(),
        continuationRequests,
        nativeLogging: (threadId) =>
          makeNativeLogger({
            nativeEventLogger: eventLoggers.native,
            provider: PI_PROVIDER,
            threadId,
          }),
        flavor: {
          driver: PI_PROVIDER,
          capabilities: {
            ...AcpProviderCapabilitiesV2,
            sessions: { ...AcpProviderCapabilitiesV2.sessions, supportsModelSwitchInSession: true },
          },
          makeRuntime: (runtimeInput) =>
            makePiAcpRuntime({
              ...runtimeInput,
              piSettings: input.config,
              environment,
              childProcessSpawner,
              mcpServers: [],
            }),
          resolveModelId: (selection) =>
            selection.model === "default" ? undefined : selection.model,
          applyModelSelection: ({ runtime, modelSelection }) =>
            applyPiAcpModelSelection({
              runtime,
              model: modelSelection.model,
              selections: modelSelection.options,
              mapError: ({ cause }) => cause,
            }).pipe(Effect.as(modelSelection.model)),
        },
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: PI_PROVIDER,
              instanceId: input.instanceId,
              detail: "Failed to create Pi ACP adapter.",
              cause,
            }),
        ),
      ),
  ),
};
