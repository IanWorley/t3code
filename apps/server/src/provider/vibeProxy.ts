import type {
  ProviderInstanceEnvironment,
  ServerProvider,
  ServerProviderVibeProxyStatus,
} from "@t3tools/contracts";
import { VIBEPROXY_CLIENT_API_KEY_ENV } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

const VIBEPROXY_MODELS_PATH = "/v1/models";
const VIBEPROXY_PROBE_TIMEOUT_MS = 2_000;
const VIBEPROXY_PROVIDER_ID = "t3_vibeproxy";
const CLAUDE_ALTERNATE_PROVIDER_ENVIRONMENT_VARIABLES = [
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

const VibeProxyModelsResponse = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
    }),
  ),
});
const decodeVibeProxyModelsResponse = Schema.decodeUnknownOption(VibeProxyModelsResponse);

export interface VibeProxyEndpoint {
  readonly rootUrl: string;
  readonly openAiBaseUrl: string;
}

export function parseVibeProxyUrl(value: string): VibeProxyEndpoint | null {
  try {
    const parsed = new URL(value.trim());
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0
    ) {
      return null;
    }
    const pathname = parsed.pathname.replace(/\/+$/u, "");
    const rootUrl = `${parsed.origin}${pathname}`;
    return { rootUrl, openAiBaseUrl: `${rootUrl}/v1` };
  } catch {
    return null;
  }
}

export function resolveVibeProxyClientKey(
  environment: ProviderInstanceEnvironment,
): string | undefined {
  return (
    environment.find((variable) => variable.name === VIBEPROXY_CLIENT_API_KEY_ENV)?.value.trim() ||
    undefined
  );
}

function requestSucceeded(status: number): boolean {
  return status >= 200 && status < 300;
}

export const probeVibeProxy = Effect.fn("probeVibeProxy")(function* (
  endpoint: VibeProxyEndpoint,
  clientKey: string | undefined,
) {
  const httpClient = yield* HttpClient.HttpClient;
  const baseRequest = HttpClientRequest.get(`${endpoint.rootUrl}${VIBEPROXY_MODELS_PATH}`).pipe(
    HttpClientRequest.setHeader("accept", "application/json"),
  );
  const request = clientKey
    ? baseRequest.pipe(HttpClientRequest.bearerToken(clientKey))
    : baseRequest;
  const modelsResponse = yield* httpClient.execute(request).pipe(
    Effect.timeoutOption(VIBEPROXY_PROBE_TIMEOUT_MS),
    Effect.orElseSucceed(() => Option.none()),
  );
  if (Option.isNone(modelsResponse)) {
    return {
      enabled: true,
      endpoint: endpoint.rootUrl,
      reachable: false,
      models: [],
      message: "VibeProxy is not running — requests will fail.",
    } satisfies ServerProviderVibeProxyStatus;
  }
  if (!requestSucceeded(modelsResponse.value.status)) {
    return {
      enabled: true,
      endpoint: endpoint.rootUrl,
      reachable: true,
      models: [],
      message: "VibeProxy is running, but its model list is unavailable. Check the client API key.",
    } satisfies ServerProviderVibeProxyStatus;
  }

  const payload = yield* modelsResponse.value.json.pipe(
    Effect.flatMap((json) =>
      Effect.succeed(decodeVibeProxyModelsResponse(json)).pipe(Effect.map(Option.getOrNull)),
    ),
    Effect.orElseSucceed(() => null),
  );
  if (payload === null) {
    return {
      enabled: true,
      endpoint: endpoint.rootUrl,
      reachable: true,
      models: [],
      message: "VibeProxy returned an invalid model list.",
    } satisfies ServerProviderVibeProxyStatus;
  }

  const models = [...new Set(payload.data.map((model) => model.id.trim()).filter(Boolean))];
  return {
    enabled: true,
    endpoint: endpoint.rootUrl,
    reachable: true,
    models,
  } satisfies ServerProviderVibeProxyStatus;
});

export function checkingVibeProxyStatus(
  endpoint: VibeProxyEndpoint,
): ServerProviderVibeProxyStatus {
  return {
    enabled: true,
    endpoint: endpoint.rootUrl,
    reachable: false,
    models: [],
    message: "Checking VibeProxy availability...",
  };
}

export function applyVibeProxyStatus(
  snapshot: ServerProvider,
  status: ServerProviderVibeProxyStatus,
  offerModels = true,
): ServerProvider {
  const models = [...snapshot.models];
  const addedModels: Array<string> = [];
  if (offerModels) {
    const seen = new Set(models.map((model) => model.slug));
    for (const slug of status.models) {
      if (seen.has(slug)) continue;
      seen.add(slug);
      addedModels.push(slug);
      models.push({
        slug,
        name: slug,
        isCustom: true,
        capabilities: null,
      });
    }
  }
  const hasRoutingWarning = !status.reachable || status.message !== undefined;
  const shouldApplyRoutingWarning = hasRoutingWarning && snapshot.status === "ready";
  return {
    ...snapshot,
    models,
    vibeProxy: { ...status, addedModels },
    ...(shouldApplyRoutingWarning
      ? {
          status: "warning" as const,
          message: status.message ?? "VibeProxy routing is unavailable.",
        }
      : {}),
  };
}

function codexConfigAssignment(key: string, value: string): string {
  return `-c '${key}="${value}"'`;
}

export function withVibeProxyCodexLaunchArgs(
  launchArgs: string,
  endpoint: VibeProxyEndpoint,
  hasClientKey: boolean,
): string {
  const overrides = [
    codexConfigAssignment("model_provider", VIBEPROXY_PROVIDER_ID),
    codexConfigAssignment(`model_providers.${VIBEPROXY_PROVIDER_ID}.name`, "VibeProxy"),
    codexConfigAssignment(
      `model_providers.${VIBEPROXY_PROVIDER_ID}.base_url`,
      endpoint.openAiBaseUrl,
    ),
    codexConfigAssignment(`model_providers.${VIBEPROXY_PROVIDER_ID}.wire_api`, "responses"),
    ...(hasClientKey
      ? [
          codexConfigAssignment(
            `model_providers.${VIBEPROXY_PROVIDER_ID}.env_key`,
            VIBEPROXY_CLIENT_API_KEY_ENV,
          ),
        ]
      : []),
  ];
  return [launchArgs.trim(), ...overrides].filter(Boolean).join(" ");
}

export function withVibeProxyClaudeEnvironment(
  environment: NodeJS.ProcessEnv,
  endpoint: VibeProxyEndpoint,
  clientKey: string | undefined,
): NodeJS.ProcessEnv {
  const routed = { ...environment };
  delete routed.ANTHROPIC_API_KEY;
  delete routed.ANTHROPIC_AUTH_TOKEN;
  for (const variable of CLAUDE_ALTERNATE_PROVIDER_ENVIRONMENT_VARIABLES) {
    delete routed[variable];
  }
  routed.ANTHROPIC_BASE_URL = endpoint.rootUrl;
  if (clientKey) routed.ANTHROPIC_AUTH_TOKEN = clientKey;
  return routed;
}
