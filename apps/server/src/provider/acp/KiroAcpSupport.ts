import {
  type KiroSettings,
  ProviderDriverKind,
  type ProviderOptionSelection,
  type RuntimeMode,
} from "@t3tools/contracts";
import { getProviderOptionStringSelectionValue, normalizeModelSlug } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import { setKiroEffort } from "./KiroAcpCommands.ts";

const KIRO_DRIVER_KIND = ProviderDriverKind.make("kiro");
export const KIRO_EFFORT_OPTION_ID = "effort";

type KiroAcpRuntimeSettings = Pick<KiroSettings, "binaryPath">;

export interface KiroAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly kiroSettings: KiroAcpRuntimeSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runtimeMode?: RuntimeMode;
}

export function kiroAcpSpawnArgs(runtimeMode?: RuntimeMode): ReadonlyArray<string> {
  return runtimeMode === "full-access" ? ["acp", "--trust-all-tools"] : ["acp"];
}

export function buildKiroAcpSpawnInput(
  kiroSettings: KiroAcpRuntimeSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  runtimeMode?: RuntimeMode,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: kiroSettings?.binaryPath || "kiro-cli",
    args: [...kiroAcpSpawnArgs(runtimeMode)],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

export const makeKiroAcpRuntime = (
  input: KiroAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildKiroAcpSpawnInput(
          input.kiroSettings,
          input.cwd,
          input.environment,
          input.runtimeMode,
        ),
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

export function resolveKiroAcpBaseModelId(model: string | null | undefined): string {
  return normalizeModelSlug(model?.trim() || "auto", KIRO_DRIVER_KIND) ?? "auto";
}

export function applyKiroAcpModelSelection<E>(input: {
  readonly runtime: Pick<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    "request" | "setSessionModel"
  >;
  readonly sessionId: string;
  readonly model: string | null | undefined;
  readonly selections?: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  readonly mapError: (context: {
    readonly cause: EffectAcpErrors.AcpError;
    readonly step: "set-effort" | "set-model";
  }) => E;
}): Effect.Effect<void, E> {
  return Effect.gen(function* () {
    yield* input.runtime
      .setSessionModel(resolveKiroAcpBaseModelId(input.model))
      .pipe(Effect.mapError((cause) => input.mapError({ cause, step: "set-model" })));

    const effort = getProviderOptionStringSelectionValue(
      input.selections,
      KIRO_EFFORT_OPTION_ID,
    )?.trim();
    if (effort) {
      yield* setKiroEffort(input.runtime, input.sessionId, effort).pipe(
        Effect.mapError((cause) => input.mapError({ cause, step: "set-effort" })),
      );
    }
  });
}
