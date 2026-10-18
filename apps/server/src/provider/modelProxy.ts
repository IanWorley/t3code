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

const MODELS_PATH = "/v1/models";
const PROBE_TIMEOUT_MS = 2_000;
const PROXY_MODEL_SUB_PROVIDER = "Proxy";
const CLAUDE_MODEL_PREFIX = "claude-";
const offersProxyModel = (driver: ProviderDriverKind, slug: string) =>
  driver !== "codex" || !slug.startsWith(CLAUDE_MODEL_PREFIX);
const REASONING_LABEL = "Reasoning";
const DEFAULT_REASONING = "medium";
const reasoningChoices = (levels: ReadonlyArray<readonly [id: string, label: string]>) =>
  levels.map(([id, label]) => ({
    id,
    label,
    ...(id === DEFAULT_REASONING ? { isDefault: true } : {}),
  }));
const SHARED_REASONING_LEVELS = [
  ["low", "Low"],
  ["medium", "Medium"],
  ["high", "High"],
  ["xhigh", "Extra High"],
] as const;
/**
 * The proxy's model list carries no capabilities, so proxy-only models get the reasoning option in
 * the harness's own vocabulary; the proxy maps it onto whichever model family serves the request.
 */
const PROXY_MODEL_CAPABILITIES_BY_DRIVER: Readonly<Record<string, ModelCapabilities>> = {
  codex: {
    optionDescriptors: [
      {
        id: "reasoningEffort",
        label: REASONING_LABEL,
        type: "select",
        options: reasoningChoices(SHARED_REASONING_LEVELS),
      },
    ],
  },
  claudeAgent: {
    optionDescriptors: [
      {
        id: "effort",
        label: REASONING_LABEL,
        type: "select",
        options: reasoningChoices([...SHARED_REASONING_LEVELS, ["max", "Max"]]),
      },
    ],
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

const ModelsResponse = Schema.Struct({
  data: Schema.Array(Schema.Struct({ id: Schema.String })),
});
const decodeModelsResponse = Schema.decodeUnknownOption(ModelsResponse);

export interface ModelProxyRoute {
  /** Origin plus any path prefix, without a trailing slash. */
  readonly rootUrl: string;
  readonly apiKey: string | undefined;
}

interface ModelProxyProbe {
  readonly available: boolean;
  readonly models: ReadonlyArray<string>;
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
  if (input.settings === undefined) return Effect.succeed(undefined);
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
  const models = new Set(payload.value.data.map((model) => model.id.trim()).filter(Boolean));
  return { available: true, models: [...models] } satisfies ModelProxyProbe;
});

export function applyModelProxyProbe(
  snapshot: ServerProvider,
  probe: ModelProxyProbe,
): ServerProvider {
  const known = new Set(snapshot.models.flatMap((model) => [model.slug, ...(model.aliases ?? [])]));
  const proxyModels = probe.models
    .filter((slug) => !known.has(slug) && offersProxyModel(snapshot.driver, slug))
    .map((slug): ServerProviderModel => ({
      slug,
      name: slug,
      subProvider: PROXY_MODEL_SUB_PROVIDER,
      isCustom: false,
      capabilities: PROXY_MODEL_CAPABILITIES_BY_DRIVER[snapshot.driver] ?? null,
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
