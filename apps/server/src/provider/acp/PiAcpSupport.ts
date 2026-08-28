import { type PiSettings, type ProviderOptionSelection } from "@t3tools/contracts";
import { getProviderOptionStringSelectionValue } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const PI_ACP_AUTH_METHOD_ID = "pi_terminal_login";
export const PI_THOUGHT_LEVEL_CONFIG_ID = "thought_level";
export const PI_REASONING_OPTION_ID = "reasoningEffort";
const PI_DELETE_SESSION_METHOD = "session/delete";

type PiAcpRuntimeSettings = Pick<PiSettings, "binaryPath">;

export interface PiAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly piSettings: PiAcpRuntimeSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export function buildPiAcpSpawnInput(
  piSettings: PiAcpRuntimeSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: piSettings?.binaryPath || "pi-acp",
    args: [],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

export const makePiAcpRuntime = (
  input: PiAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildPiAcpSpawnInput(input.piSettings, input.cwd, input.environment),
        authMethodId: PI_ACP_AUTH_METHOD_ID,
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

export const deletePiAcpSession = (
  runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "request">,
  sessionId: string,
): Effect.Effect<void, never> =>
  runtime.request(PI_DELETE_SESSION_METHOD, { sessionId }).pipe(Effect.ignore);

export function applyPiAcpModelSelection<E>(input: {
  readonly runtime: Pick<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    "setConfigOption" | "setModel"
  >;
  readonly model: string | null | undefined;
  readonly selections: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  readonly mapError: (context: {
    readonly cause: EffectAcpErrors.AcpError;
    readonly configId: "model" | typeof PI_THOUGHT_LEVEL_CONFIG_ID;
  }) => E;
}): Effect.Effect<void, E> {
  return Effect.gen(function* () {
    const model = input.model?.trim();
    if (model && model !== "default") {
      yield* input.runtime
        .setModel(model)
        .pipe(Effect.mapError((cause) => input.mapError({ cause, configId: "model" })));
    }

    const reasoningEffort = getProviderOptionStringSelectionValue(
      input.selections,
      PI_REASONING_OPTION_ID,
    );
    if (reasoningEffort) {
      yield* input.runtime.setConfigOption(PI_THOUGHT_LEVEL_CONFIG_ID, reasoningEffort).pipe(
        Effect.mapError((cause) => input.mapError({ cause, configId: PI_THOUGHT_LEVEL_CONFIG_ID })),
        Effect.asVoid,
      );
    }
  });
}
