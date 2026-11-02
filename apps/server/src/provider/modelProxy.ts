import type {
  ModelCapabilities,
  ModelProxySettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
  ServerProviderModel,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

import { ProviderDriverError } from "./Errors.ts";
import { resolveCodexLaunchArgs, T3CODE_CODEX_LAUNCH_ARGS_ENV } from "./codexLaunchArgs.ts";

// CLIProxyAPI answers a `client_version` request with its Codex catalog, which carries each model's
// configured reasoning levels. Other proxies ignore the parameter and return the plain model list.
const MODELS_PATH = "/v1/models?client_version=";
const PROBE_TIMEOUT_MS = 2_000;
const PROXY_MODEL_SUB_PROVIDER = "Proxy";
const CLAUDE_MODEL_PREFIX = "claude-";
const offersProxyModel = (driver: ProviderDriverKind, slug: string) =>
  driver !== "codex" || !slug.startsWith(CLAUDE_MODEL_PREFIX);
const REASONING_LABEL = "Reasoning";
const DEFAULT_REASONING = "medium";
const REASONING_LEVEL_LABELS: Readonly<Record<string, string>> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
  ultra: "Ultra",
};
interface ProxyReasoningOption {
  readonly optionId: string;
  /** Levels the harness accepts, in display order. */
  readonly supported: ReadonlyArray<string>;
  /** Offered when the proxy does not report a model's levels. */
  readonly fallback: ReadonlyArray<string>;
}
const PROXY_REASONING_BY_DRIVER: Readonly<Record<string, ProxyReasoningOption>> = {
  codex: {
    optionId: "reasoningEffort",
    supported: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
    fallback: ["low", "medium", "high", "xhigh"],
  },
  claudeAgent: {
    optionId: "effort",
    supported: ["low", "medium", "high", "xhigh", "max"],
    fallback: ["low", "medium", "high", "xhigh", "max"],
  },
};
const CODEX_PROVIDER_ID = "t3_model_proxy";
const CODEX_API_KEY_ENV = "T3CODE_MODEL_PROXY_API_KEY";
// Claude refuses to start without a credential, even for a proxy that accepts anonymous clients.
const CLAUDE_PLACEHOLDER_TOKEN = "t3-model-proxy";
const CLAUDE_BACKEND_SELECTOR_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_AWS_BASE_URL",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "ANTHROPIC_GOOGLE_CLOUD_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_GATEWAY",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_VERTEX",
] as const;

const ModelsResponse = Schema.Union([
  Schema.Struct({
    models: Schema.Array(
      Schema.Struct({
        slug: Schema.String,
        supported_reasoning_levels: Schema.optional(
          Schema.Array(Schema.Struct({ effort: Schema.String })),
        ),
        default_reasoning_level: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  }),
  Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String })) }),
]);
const decodeModelsResponse = Schema.decodeUnknownOption(ModelsResponse);

export interface ModelProxyRoute {
  /** Origin plus any path prefix, without a trailing slash. */
  readonly rootUrl: string;
  readonly apiKey: string | undefined;
}

interface ModelProxyModel {
  readonly slug: string;
  /** Undefined when the proxy does not report the model's levels. */
  readonly reasoningLevels?: ReadonlyArray<string>;
  readonly defaultReasoningLevel?: string;
}

interface ModelProxyProbe {
  readonly available: boolean;
  readonly models: ReadonlyArray<ModelProxyModel>;
  readonly message?: string;
}

export function parseModelProxyUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    const plainHttp =
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "";
    // The URL is embedded in a single-quoted Codex `-c` argument, and WHATWG URLs keep `'` raw.
    const path = url.pathname.replace(/\/+$/u, "").replaceAll("'", "%27");
    return plainHttp ? `${url.origin}${path}` : null;
  } catch {
    return null;
  }
}

export const resolveModelProxyRoute = (input: {
  readonly driver: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId;
  readonly settings: ModelProxySettings | undefined;
}): Effect.Effect<ModelProxyRoute | undefined, ProviderDriverError> => {
  if (input.settings === undefined) return Effect.undefined;
  const rootUrl = parseModelProxyUrl(input.settings.url);
  if (rootUrl === null) {
    return Effect.fail(
      new ProviderDriverError({
        driver: input.driver,
        instanceId: input.instanceId,
        detail: `This instance uses the model proxy, but '${input.settings.url}' is not a valid http(s) URL. Fix it in Settings → Providers → Model proxy.`,
      }),
    );
  }
  return Effect.succeed({ rootUrl, apiKey: input.settings.apiKey || undefined });
};

export function modelProxyCodexEnvironment(
  environment: NodeJS.ProcessEnv,
  launchArgs: string | undefined,
  route: ModelProxyRoute | undefined,
): NodeJS.ProcessEnv {
  if (route === undefined) return environment;
  const set = (key: string, value: string) => `-c '${key}="${value}"'`;
  const provider = `model_providers.${CODEX_PROVIDER_ID}`;
  const overrides = [
    set("model_provider", CODEX_PROVIDER_ID),
    set(`${provider}.name`, "Model proxy"),
    set(`${provider}.base_url`, `${route.rootUrl}/v1`),
    set(`${provider}.wire_api`, "responses"),
    ...(route.apiKey ? [set(`${provider}.env_key`, CODEX_API_KEY_ENV)] : []),
  ];
  return {
    ...environment,
    [T3CODE_CODEX_LAUNCH_ARGS_ENV]: [resolveCodexLaunchArgs(launchArgs, environment), ...overrides]
      .filter(Boolean)
      .join(" "),
    ...(route.apiKey ? { [CODEX_API_KEY_ENV]: route.apiKey } : {}),
  };
}

export function modelProxyClaudeEnvironment(
  environment: NodeJS.ProcessEnv,
  route: ModelProxyRoute | undefined,
): NodeJS.ProcessEnv {
  if (route === undefined) return environment;
  const routed = { ...environment };
  for (const name of CLAUDE_BACKEND_SELECTOR_ENV) delete routed[name];
  routed.ANTHROPIC_BASE_URL = route.rootUrl;
  routed.ANTHROPIC_AUTH_TOKEN = route.apiKey ?? CLAUDE_PLACEHOLDER_TOKEN;
  return routed;
}

const unavailable = (message: string): ModelProxyProbe => ({
  available: false,
  models: [],
  message,
});

const probeModelProxy = Effect.fn("probeModelProxy")(function* (route: ModelProxyRoute) {
  const httpClient = yield* HttpClient.HttpClient;
  const request = HttpClientRequest.get(`${route.rootUrl}${MODELS_PATH}`).pipe(
    HttpClientRequest.setHeader("accept", "application/json"),
    route.apiKey ? HttpClientRequest.bearerToken(route.apiKey) : (request) => request,
  );
  const response = yield* httpClient.execute(request).pipe(
    Effect.timeoutOption(PROBE_TIMEOUT_MS),
    Effect.orElseSucceed(() => Option.none()),
  );
  if (Option.isNone(response)) {
    return unavailable(
      `The model proxy at ${route.rootUrl} is not responding. Requests from this instance will fail.`,
    );
  }
  if (response.value.status < 200 || response.value.status >= 300) {
    return unavailable(
      `The model proxy rejected its model list request (HTTP ${response.value.status}). Check the proxy's API key.`,
    );
  }
  const payload = yield* response.value.json.pipe(
    Effect.map(decodeModelsResponse),
    Effect.timeoutOption(PROBE_TIMEOUT_MS),
    Effect.map(Option.flatten),
    Effect.orElseSucceed(() => Option.none()),
  );
  if (Option.isNone(payload)) {
    return unavailable("The model proxy returned a model list T3 Code could not read.");
  }
  return { available: true, models: readProxyModels(payload.value) } satisfies ModelProxyProbe;
});

function readProxyModels(response: typeof ModelsResponse.Type): ReadonlyArray<ModelProxyModel> {
  const models: ReadonlyArray<ModelProxyModel> =
    "models" in response
      ? response.models.map((model) => ({
          slug: model.slug.trim(),
          ...(model.supported_reasoning_levels
            ? { reasoningLevels: model.supported_reasoning_levels.map((level) => level.effort) }
            : {}),
          ...(model.default_reasoning_level
            ? { defaultReasoningLevel: model.default_reasoning_level }
            : {}),
        }))
      : response.data.map((model) => ({ slug: model.id.trim() }));
  const bySlug = new Map(models.filter((model) => model.slug).map((model) => [model.slug, model]));
  return [...bySlug.values()];
}

function proxyModelCapabilities(
  driver: ProviderDriverKind,
  model: ModelProxyModel,
): ModelCapabilities | null {
  const reasoning = PROXY_REASONING_BY_DRIVER[driver];
  if (reasoning === undefined) return null;
  const reported = model.reasoningLevels;
  const levels =
    reported === undefined
      ? reasoning.fallback
      : reasoning.supported.filter((level) => reported.includes(level));
  if (levels.length === 0) return { optionDescriptors: [] };
  const defaultLevel =
    [model.defaultReasoningLevel, DEFAULT_REASONING].find(
      (level) => level !== undefined && levels.includes(level),
    ) ?? levels[0];
  return {
    optionDescriptors: [
      {
        id: reasoning.optionId,
        label: REASONING_LABEL,
        type: "select",
        options: levels.map((id) => ({
          id,
          label: REASONING_LEVEL_LABELS[id] ?? id,
          ...(id === defaultLevel ? { isDefault: true } : {}),
        })),
      },
    ],
  };
}

export function applyModelProxyProbe(
  snapshot: ServerProvider,
  probe: ModelProxyProbe,
): ServerProvider {
  const known = new Set(snapshot.models.flatMap((model) => [model.slug, ...(model.aliases ?? [])]));
  const proxyModels = probe.models
    .filter((model) => !known.has(model.slug) && offersProxyModel(snapshot.driver, model.slug))
    .map((model): ServerProviderModel => ({
      slug: model.slug,
      name: model.slug,
      subProvider: PROXY_MODEL_SUB_PROVIDER,
      isCustom: false,
      capabilities: proxyModelCapabilities(snapshot.driver, model),
    }));
  const proxyWarning = probe.message !== undefined && snapshot.status === "ready";
  return {
    ...snapshot,
    models: [...snapshot.models, ...proxyModels],
    modelProxy: { status: probe.available ? "available" : "unavailable" },
    ...(proxyWarning ? { status: "warning" as const, message: probe.message } : {}),
  };
}

export function withModelProxyPending<E, R>(
  route: ModelProxyRoute | undefined,
  initialSnapshot: Effect.Effect<ServerProvider, E, R>,
): Effect.Effect<ServerProvider, E, R> {
  if (route === undefined) return initialSnapshot;
  return initialSnapshot.pipe(
    Effect.map((snapshot) => ({ ...snapshot, modelProxy: { status: "checking" as const } })),
  );
}

export function withModelProxyProbe<E, R>(
  route: ModelProxyRoute | undefined,
  httpClient: HttpClient.HttpClient,
  checkProvider: Effect.Effect<ServerProvider, E, R>,
): Effect.Effect<ServerProvider, E, R> {
  if (route === undefined) return checkProvider;
  return Effect.zipWith(
    checkProvider,
    probeModelProxy(route).pipe(Effect.provideService(HttpClient.HttpClient, httpClient)),
    applyModelProxyProbe,
    { concurrent: true },
  );
}
