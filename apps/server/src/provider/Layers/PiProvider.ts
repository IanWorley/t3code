import {
  type ModelCapabilities,
  type PiSettings,
  type ServerProviderModel,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  deletePiAcpSession,
  makePiAcpRuntime,
  PI_REASONING_OPTION_ID,
} from "../acp/PiAcpSupport.ts";
import {
  buildServerProvider,
  isCommandMissingCause,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const PI_PRESENTATION = {
  displayName: "Pi",
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
} as const;
const PI_ACP_MODEL_DISCOVERY_TIMEOUT_MS = 15_000;
const PI_ACP_COMMAND_DISCOVERY_TIMEOUT_MS = 2_000;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });
const DEFAULT_PI_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "default",
    name: "Pi default",
    isCustom: false,
    isDefault: true,
    capabilities: EMPTY_CAPABILITIES,
  },
];
const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);
const isAcpSpawnError = Schema.is(EffectAcpErrors.AcpSpawnError);

function piModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
  discoveredModels: ReadonlyArray<ServerProviderModel> = DEFAULT_PI_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(discoveredModels, customModels ?? [], EMPTY_CAPABILITIES);
}

function flattenSelectOptions(
  option: Extract<EffectAcpSchema.SessionConfigOption, { readonly type: "select" }>,
) {
  return option.options.flatMap((entry) => ("value" in entry ? [entry] : entry.options));
}

function buildPiModelCapabilities(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): ModelCapabilities {
  const thoughtLevel = configOptions.find(
    (option) => option.type === "select" && option.category === "thought_level",
  );
  if (!thoughtLevel || thoughtLevel.type !== "select") {
    return EMPTY_CAPABILITIES;
  }
  const options = flattenSelectOptions(thoughtLevel).flatMap((option) => {
    const id = option.value.trim();
    if (!id) return [];
    const description = option.description?.trim();
    return [
      {
        id,
        label: option.name.trim() || id,
        ...(description ? { description } : {}),
        ...(id === thoughtLevel.currentValue ? { isDefault: true } : {}),
      },
    ];
  });
  if (options.length === 0) {
    return EMPTY_CAPABILITIES;
  }
  return createModelCapabilities({
    optionDescriptors: [
      {
        id: PI_REASONING_OPTION_ID,
        label: "Reasoning",
        type: "select",
        options,
        currentValue: thoughtLevel.currentValue,
      },
    ],
  });
}

export function buildPiModelsFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): ReadonlyArray<ServerProviderModel> {
  const modelOption = configOptions.find(
    (option) => option.type === "select" && option.category === "model",
  );
  if (!modelOption || modelOption.type !== "select") {
    return [];
  }
  const capabilities = buildPiModelCapabilities(configOptions);
  const seen = new Set<string>();
  return flattenSelectOptions(modelOption).flatMap((option) => {
    const slug = option.value.trim();
    if (!slug || seen.has(slug)) return [];
    seen.add(slug);
    return [
      {
        slug,
        name: option.name.trim() || slug,
        isCustom: false,
        isDefault: slug === modelOption.currentValue,
        capabilities,
      },
    ];
  });
}

export function buildPiSlashCommands(
  commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
): ReadonlyArray<ServerProviderSlashCommand> {
  const seen = new Set<string>();
  return commands.flatMap((command) => {
    const name = command.name.trim();
    const normalizedName = name.toLowerCase();
    if (!name || seen.has(normalizedName)) return [];
    seen.add(normalizedName);

    const description = command.description.trim();
    const inputHint = command.input?.hint.trim();
    return [
      {
        name,
        ...(description ? { description } : {}),
        ...(inputHint ? { input: { hint: inputHint } } : {}),
      },
    ];
  });
}

export function buildInitialPiProviderSnapshot(
  settings: PiSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const enabled = settings.enabled;
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled,
      checkedAt,
      models: piModelsFromSettings(settings.customModels),
      probe: enabled
        ? {
            installed: true,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Checking Pi ACP availability...",
          }
        : {
            installed: false,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Pi is disabled in T3 Code settings.",
          },
    });
  });
}

function isMissingPiAcp(error: EffectAcpErrors.AcpError): boolean {
  return isAcpSpawnError(error) && isCommandMissingCause(error.cause);
}

function isPiAuthenticationError(error: EffectAcpErrors.AcpError): boolean {
  if (!isAcpRequestError(error)) return false;
  const message = error.errorMessage.toLowerCase();
  return (
    message.includes("auth") ||
    message.includes("api key") ||
    message.includes("log in") ||
    message.includes("login")
  );
}

export const checkPiProviderStatus = Effect.fn("checkPiProviderStatus")(function* (
  settings: PiSettings,
  environment: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = piModelsFromSettings(settings.customModels);
  if (!settings.enabled) {
    return yield* buildInitialPiProviderSnapshot(settings);
  }

  const discovery = yield* Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runtime = yield* makePiAcpRuntime({
      piSettings: settings,
      environment,
      childProcessSpawner,
      cwd,
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
    const started = yield* runtime.start();
    yield* Effect.addFinalizer(() => deletePiAcpSession(runtime, started.sessionId));
    const availableCommands = yield* runtime.awaitAvailableCommands.pipe(
      Effect.timeoutOption(PI_ACP_COMMAND_DISCOVERY_TIMEOUT_MS),
      Effect.map(Option.getOrElse(() => [])),
    );
    return {
      version: started.initializeResult.agentInfo?.version?.trim() || null,
      models: buildPiModelsFromConfigOptions(started.sessionSetupResult.configOptions ?? []),
      slashCommands: buildPiSlashCommands(availableCommands),
    };
  }).pipe(Effect.scoped, Effect.timeoutOption(PI_ACP_MODEL_DISCOVERY_TIMEOUT_MS), Effect.exit);

  if (Exit.isSuccess(discovery) && Option.isSome(discovery.value)) {
    const result = discovery.value.value;
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: piModelsFromSettings(
        settings.customModels,
        result.models.length > 0 ? result.models : DEFAULT_PI_MODELS,
      ),
      slashCommands: result.slashCommands,
      probe: {
        installed: true,
        version: result.version,
        status: "ready",
        auth: { status: "authenticated" },
      },
    });
  }

  if (Exit.isSuccess(discovery)) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: `Pi ACP startup timed out after ${PI_ACP_MODEL_DISCOVERY_TIMEOUT_MS}ms.`,
      },
    });
  }

  const error = Cause.findErrorOption(discovery.cause).pipe(Option.getOrUndefined);
  yield* Effect.logWarning("Pi ACP model discovery failed", {
    errorTag: causeErrorTag(discovery.cause),
  });
  const missing = error !== undefined && isMissingPiAcp(error);
  const unauthenticated = error !== undefined && isPiAuthenticationError(error);
  return buildServerProvider({
    presentation: PI_PRESENTATION,
    enabled: true,
    checkedAt,
    models: fallbackModels,
    probe: {
      installed: !missing,
      version: null,
      status: "error",
      auth: { status: unauthenticated ? "unauthenticated" : "unknown" },
      message: missing
        ? "Pi ACP (`pi-acp`) is not installed or not on PATH."
        : unauthenticated
          ? "Pi has no authenticated model provider. Configure Pi in a terminal and try again."
          : "Pi ACP startup failed. Check server logs for details.",
    },
  });
});
