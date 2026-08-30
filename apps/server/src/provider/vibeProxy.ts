import * as NodeOS from "node:os";

import type {
  ProviderInstanceEnvironment,
  ServerProvider,
  ServerProviderVibeProxyStatus,
} from "@t3tools/contracts";
import { VIBEPROXY_CLIENT_API_KEY_ENV } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

const VIBEPROXY_CONFIG_DIRECTORY = ".cli-proxy-api";
const VIBEPROXY_CONFIG_FILENAMES = ["merged-config.yaml", "config.yaml"] as const;
const VIBEPROXY_HEALTH_PATH = "/healthz";
const VIBEPROXY_MODELS_PATH = "/v1/models";
const VIBEPROXY_PROBE_TIMEOUT_MS = 2_000;
const LOOPBACK_HOST = "127.0.0.1";
const MAX_PORT = 65_535;
const VIBEPROXY_PROVIDER_ID = "t3_vibeproxy";

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

interface ParsedVibeProxyConfig {
  readonly host: string;
  readonly port: number;
}

function unquoteYamlScalar(value: string): string {
  const withoutComment = value.split("#", 1)[0]?.trim() ?? "";
  if (withoutComment.length >= 2) {
    const first = withoutComment[0];
    const last = withoutComment.at(-1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return withoutComment.slice(1, -1).trim();
    }
  }
  return withoutComment;
}

function normalizeLoopbackHost(host: string): string | null {
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/gu, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1"
    ? LOOPBACK_HOST
    : null;
}

export function parseVibeProxyConfig(contents: string): VibeProxyEndpoint | null {
  let rawHost: string | undefined;
  let rawPort: string | undefined;
  for (const line of contents.split(/\r?\n/gu)) {
    if (/^\s/gu.test(line)) continue;
    const separatorIndex = line.indexOf(":");
    if (separatorIndex < 0) continue;
    const key = line.slice(0, separatorIndex).trim();
    const value = unquoteYamlScalar(line.slice(separatorIndex + 1));
    if (key === "host") rawHost = value;
    if (key === "port") rawPort = value;
  }

  const host = rawHost === undefined ? null : normalizeLoopbackHost(rawHost);
  const port = rawPort === undefined ? Number.NaN : Number(rawPort);
  if (host === null || !Number.isInteger(port) || port < 1 || port > MAX_PORT) {
    return null;
  }
  const parsed = { host, port } satisfies ParsedVibeProxyConfig;
  const rootUrl = `http://${parsed.host}:${parsed.port}`;
  return {
    rootUrl,
    openAiBaseUrl: `${rootUrl}/v1`,
  };
}

export const discoverVibeProxyEndpoint = Effect.fn("discoverVibeProxyEndpoint")(function* (
  configDirectoryOverride?: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configDirectory =
    configDirectoryOverride ?? path.join(NodeOS.homedir(), VIBEPROXY_CONFIG_DIRECTORY);
  for (const filename of VIBEPROXY_CONFIG_FILENAMES) {
    const contents = yield* fileSystem
      .readFileString(path.join(configDirectory, filename))
      .pipe(Effect.option);
    if (Option.isNone(contents)) continue;
    const endpoint = parseVibeProxyConfig(contents.value);
    if (endpoint !== null) return endpoint;
  }
  return null;
});

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
  const healthResponse = yield* httpClient
    .execute(HttpClientRequest.get(`${endpoint.rootUrl}${VIBEPROXY_HEALTH_PATH}`))
    .pipe(
      Effect.timeoutOption(VIBEPROXY_PROBE_TIMEOUT_MS),
      Effect.orElseSucceed(() => Option.none()),
    );
  if (Option.isNone(healthResponse) || !requestSucceeded(healthResponse.value.status)) {
    return {
      enabled: true,
      endpoint: endpoint.rootUrl,
      reachable: false,
      models: [],
      message: "VibeProxy is not running — requests will fail.",
    } satisfies ServerProviderVibeProxyStatus;
  }

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
  if (Option.isNone(modelsResponse) || !requestSucceeded(modelsResponse.value.status)) {
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
  if (offerModels) {
    const seen = new Set(models.map((model) => model.slug));
    for (const slug of status.models) {
      if (seen.has(slug)) continue;
      seen.add(slug);
      models.push({
        slug,
        name: slug,
        isCustom: true,
        capabilities: null,
      });
    }
  }
  const hasRoutingWarning = !status.reachable || status.message !== undefined;
  return {
    ...snapshot,
    models,
    vibeProxy: status,
    ...(hasRoutingWarning
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
  routed.ANTHROPIC_BASE_URL = endpoint.rootUrl;
  if (clientKey) routed.ANTHROPIC_AUTH_TOKEN = clientKey;
  return routed;
}
