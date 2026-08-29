import type { ServerProviderSlashCommand } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import type * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const KIRO_COMMANDS_AVAILABLE_METHOD = "_kiro.dev/commands/available";

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
