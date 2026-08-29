import type { ServerProviderSlashCommand } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as EffectAcpErrors from "effect-acp/errors";

import type * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const KIRO_COMMANDS_AVAILABLE_METHOD = "_kiro.dev/commands/available";
export const KIRO_COMMANDS_EXECUTE_METHOD = "_kiro.dev/commands/execute";
export const KIRO_COMMANDS_OPTIONS_METHOD = "_kiro.dev/commands/options";
export const KIRO_EFFORT_COMMAND = "effort";

const KiroCommandMeta = Schema.Struct({
  hidden: Schema.optionalKey(Schema.Boolean),
  hint: Schema.optionalKey(Schema.String),
  local: Schema.optionalKey(Schema.Boolean),
});

export const KiroAvailableCommand = Schema.Struct({
  name: Schema.String,
  description: Schema.optionalKey(Schema.NullOr(Schema.String)),
  meta: Schema.optionalKey(KiroCommandMeta),
});
export type KiroAvailableCommand = typeof KiroAvailableCommand.Type;

const KiroCommandsAvailableNotification = Schema.Struct({
  sessionId: Schema.String,
  commands: Schema.Array(KiroAvailableCommand),
});

export const KiroCommandOption = Schema.Struct({
  value: Schema.String,
  label: Schema.String,
  description: Schema.optionalKey(Schema.String),
  group: Schema.optionalKey(Schema.String),
});
export type KiroCommandOption = typeof KiroCommandOption.Type;

const KiroCommandOptionsResponse = Schema.Struct({
  options: Schema.Array(KiroCommandOption),
  hasMore: Schema.optionalKey(Schema.Boolean),
});

const KiroCommandExecuteResponse = Schema.Struct({
  success: Schema.Boolean,
  message: Schema.optionalKey(Schema.String),
  data: Schema.optionalKey(Schema.Unknown),
});

const decodeCommandOptionsResponse = Schema.decodeUnknownEffect(KiroCommandOptionsResponse);
const decodeCommandExecuteResponse = Schema.decodeUnknownEffect(KiroCommandExecuteResponse);

export const getKiroCommandOptions = Effect.fn("getKiroCommandOptions")(function* (
  runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "request">,
  sessionId: string,
  command: string,
): Effect.fn.Return<ReadonlyArray<KiroCommandOption>, EffectAcpErrors.AcpError> {
  const response = yield* runtime.request(KIRO_COMMANDS_OPTIONS_METHOD, {
    sessionId,
    command,
    partial: "",
  });
  const decoded = yield* decodeCommandOptionsResponse(response).pipe(
    Effect.mapError((cause) =>
      EffectAcpErrors.AcpRequestError.invalidExtensionPayload(KIRO_COMMANDS_OPTIONS_METHOD, cause),
    ),
  );
  return decoded.options;
});

export const setKiroEffort = Effect.fn("setKiroEffort")(function* (
  runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "request">,
  sessionId: string,
  effort: string,
): Effect.fn.Return<void, EffectAcpErrors.AcpError> {
  const rawResponse = yield* runtime.request(KIRO_COMMANDS_EXECUTE_METHOD, {
    sessionId,
    command: {
      command: KIRO_EFFORT_COMMAND,
      args: { value: effort },
    },
  });
  const response = yield* decodeCommandExecuteResponse(rawResponse).pipe(
    Effect.mapError((cause) =>
      EffectAcpErrors.AcpRequestError.invalidExtensionPayload(KIRO_COMMANDS_EXECUTE_METHOD, cause),
    ),
  );
  if (!response.success) {
    return yield* EffectAcpErrors.AcpRequestError.invalidParams(
      response.message ?? `Kiro rejected effort level '${effort}'.`,
      response,
    );
  }
});

export interface KiroCommandInventory {
  readonly getCommands: Effect.Effect<ReadonlyArray<KiroAvailableCommand>>;
  readonly awaitCommands: Effect.Effect<ReadonlyArray<KiroAvailableCommand>>;
}

/** Registers Kiro's private command notification before ACP session startup. */
export const makeKiroCommandInventory = Effect.fn("makeKiroCommandInventory")(function* (
  runtime: AcpSessionRuntime.AcpSessionRuntime["Service"],
): Effect.fn.Return<KiroCommandInventory> {
  const commandsRef = yield* Ref.make<ReadonlyArray<KiroAvailableCommand>>([]);
  const commandsReady = yield* Deferred.make<ReadonlyArray<KiroAvailableCommand>>();

  yield* runtime.handleExtNotification(
    KIRO_COMMANDS_AVAILABLE_METHOD,
    KiroCommandsAvailableNotification,
    ({ commands }) =>
      Ref.set(commandsRef, commands).pipe(
        Effect.andThen(Deferred.succeed(commandsReady, commands)),
        Effect.asVoid,
      ),
  );

  return {
    getCommands: Ref.get(commandsRef),
    awaitCommands: Deferred.await(commandsReady),
  };
});

const T3_MANAGED_COMMANDS = new Set(["default", "model", "plan"]);

export function buildKiroSlashCommands(
  commands: ReadonlyArray<KiroAvailableCommand>,
): ReadonlyArray<ServerProviderSlashCommand> {
  const seen = new Set<string>();
  return commands.flatMap((command) => {
    const name = command.name.trim().replace(/^\/+/, "");
    const normalizedName = name.toLowerCase();
    if (
      !name ||
      command.meta?.hidden === true ||
      command.meta?.local === true ||
      T3_MANAGED_COMMANDS.has(normalizedName) ||
      seen.has(normalizedName)
    ) {
      return [];
    }
    seen.add(normalizedName);

    const description = command.description?.trim();
    const inputHint = command.meta?.hint?.trim();
    return [
      {
        name,
        ...(description ? { description } : {}),
        ...(inputHint ? { input: { hint: inputHint } } : {}),
      },
    ];
  });
}
