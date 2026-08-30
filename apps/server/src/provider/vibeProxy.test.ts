import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  VIBEPROXY_CLIENT_API_KEY_ENV,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/unstable/http";

import {
  codexLaunchArgv,
  consumeCodexLaunchArgsEnvironment,
  resolveCodexLaunchArgs,
} from "./Layers/codexLaunchArgs.ts";
import {
  applyVibeProxyStatus,
  parseVibeProxyUrl,
  probeVibeProxy,
  withVibeProxyClaudeEnvironment,
  withVibeProxyCodexLaunchArgs,
  type VibeProxyEndpoint,
} from "./vibeProxy.ts";

const ENDPOINT: VibeProxyEndpoint = {
  rootUrl: "http://127.0.0.1:8318",
  openAiBaseUrl: "http://127.0.0.1:8318/v1",
};

const BASE_PROVIDER: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-08-28T00:00:00.000Z",
  models: [
    {
      slug: "gpt-existing",
      name: "GPT Existing",
      isCustom: false,
      capabilities: null,
    },
  ],
  slashCommands: [],
  skills: [],
};

describe("parseVibeProxyUrl", () => {
  it("builds the OpenAI endpoint from a configured proxy URL", () => {
    assert.deepStrictEqual(parseVibeProxyUrl("http://localhost:8317/"), {
      rootUrl: "http://localhost:8317",
      openAiBaseUrl: "http://localhost:8317/v1",
    });
  });

  it("rejects unsupported or credential-bearing URLs", () => {
    assert.isNull(parseVibeProxyUrl("ftp://localhost:8317"));
    assert.isNull(parseVibeProxyUrl("http://key@localhost:8317"));
    assert.isNull(parseVibeProxyUrl("not a URL"));
  });
});

describe("VibeProxy runtime routing", () => {
  it("keeps generated Codex routing after consuming an environment launch override", () => {
    const resolvedLaunch = consumeCodexLaunchArgsEnvironment("--enable settings-feature", {
      T3CODE_CODEX_LAUNCH_ARGS: "--strict-config --enable env-feature",
    });
    const launchArgs = withVibeProxyCodexLaunchArgs(resolvedLaunch.launchArgs, ENDPOINT, false);

    assert.deepStrictEqual(
      codexLaunchArgv(resolveCodexLaunchArgs(launchArgs, resolvedLaunch.environment)),
      [
        "--strict-config",
        "--enable",
        "env-feature",
        "-c",
        'model_provider="t3_vibeproxy"',
        "-c",
        'model_providers.t3_vibeproxy.name="VibeProxy"',
        "-c",
        'model_providers.t3_vibeproxy.base_url="http://127.0.0.1:8318/v1"',
        "-c",
        'model_providers.t3_vibeproxy.wire_api="responses"',
      ],
    );
  });

  it("appends typed Codex config overrides after user arguments", () => {
    const launchArgs = withVibeProxyCodexLaunchArgs("--enable foo", ENDPOINT, true);
    assert.deepStrictEqual(codexLaunchArgv(launchArgs), [
      "--enable",
      "foo",
      "-c",
      'model_provider="t3_vibeproxy"',
      "-c",
      'model_providers.t3_vibeproxy.name="VibeProxy"',
      "-c",
      'model_providers.t3_vibeproxy.base_url="http://127.0.0.1:8318/v1"',
      "-c",
      'model_providers.t3_vibeproxy.wire_api="responses"',
      "-c",
      `model_providers.t3_vibeproxy.env_key="${VIBEPROXY_CLIENT_API_KEY_ENV}"`,
    ]);
  });

  it("removes competing remote routes from the routed Claude environment", () => {
    assert.deepStrictEqual(
      withVibeProxyClaudeEnvironment(
        {
          ANTHROPIC_API_KEY: "direct-key",
          ANTHROPIC_AUTH_TOKEN: "direct-token",
          ANTHROPIC_AWS_BASE_URL: "https://aws.example.com",
          ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock.example.com",
          ANTHROPIC_BEDROCK_MANTLE_BASE_URL: "https://mantle.example.com",
          ANTHROPIC_FOUNDRY_BASE_URL: "https://foundry.example.com",
          ANTHROPIC_GOOGLE_CLOUD_BASE_URL: "https://google-cloud.example.com",
          ANTHROPIC_VERTEX_BASE_URL: "https://vertex.example.com",
          CLAUDE_CODE_USE_ANTHROPIC_AWS: "1",
          CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD: "1",
          CLAUDE_CODE_USE_BEDROCK: "1",
          CLAUDE_CODE_USE_FOUNDRY: "1",
          CLAUDE_CODE_USE_GATEWAY: "1",
          CLAUDE_CODE_USE_MANTLE: "1",
          CLAUDE_CODE_USE_VERTEX: "1",
          KEEP_ME: "yes",
        },
        ENDPOINT,
        "proxy-key",
      ),
      {
        ANTHROPIC_BASE_URL: ENDPOINT.rootUrl,
        ANTHROPIC_AUTH_TOKEN: "proxy-key",
        KEEP_ME: "yes",
      },
    );
  });

  it("adds proxy-only models without replacing built-in metadata", () => {
    const enriched = applyVibeProxyStatus(BASE_PROVIDER, {
      enabled: true,
      endpoint: ENDPOINT.rootUrl,
      reachable: true,
      models: ["gpt-existing", "proxy-only"],
    });
    assert.strictEqual(enriched.models[0]?.name, "GPT Existing");
    assert.deepStrictEqual(enriched.models[1], {
      slug: "proxy-only",
      name: "proxy-only",
      isCustom: true,
      capabilities: null,
    });
    assert.deepStrictEqual(enriched.vibeProxy?.addedModels, ["proxy-only"]);
  });

  it("keeps proxy-only models out of the picker when offering is disabled", () => {
    const enriched = applyVibeProxyStatus(
      BASE_PROVIDER,
      {
        enabled: true,
        endpoint: ENDPOINT.rootUrl,
        reachable: true,
        models: ["gpt-existing", "proxy-only"],
      },
      false,
    );
    assert.deepStrictEqual(enriched.models, BASE_PROVIDER.models);
    assert.deepStrictEqual(enriched.vibeProxy?.models, ["gpt-existing", "proxy-only"]);
    assert.deepStrictEqual(enriched.vibeProxy?.addedModels, []);
  });

  it("preserves a provider error when proxy routing is unavailable", () => {
    const enriched = applyVibeProxyStatus(
      {
        ...BASE_PROVIDER,
        status: "error",
        message: "Codex CLI is not installed.",
      },
      {
        enabled: true,
        endpoint: ENDPOINT.rootUrl,
        reachable: false,
        models: [],
        message: "VibeProxy is not running — requests will fail.",
      },
    );

    assert.strictEqual(enriched.status, "error");
    assert.strictEqual(enriched.message, "Codex CLI is not installed.");
  });
});

const httpClientLayer = (
  handler: (request: Parameters<Parameters<typeof HttpClient.make>[0]>[0]) => Response,
) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, handler(request))),
    ),
  );

describe("probeVibeProxy", () => {
  it.effect("loads models with the configured bearer token", () => {
    const seen: Array<{ readonly url: string; readonly authorization: string | undefined }> = [];
    return Effect.gen(function* () {
      const status = yield* probeVibeProxy(ENDPOINT, "client-key");
      assert.deepStrictEqual(status, {
        enabled: true,
        endpoint: ENDPOINT.rootUrl,
        reachable: true,
        models: ["gpt-one", "claude-one"],
      });
      assert.deepStrictEqual(seen, [
        { url: `${ENDPOINT.rootUrl}/v1/models`, authorization: "Bearer client-key" },
      ]);
    }).pipe(
      Effect.provide(
        httpClientLayer((request) => {
          seen.push({
            url: request.url,
            authorization: request.headers.authorization,
          });
          return Response.json({ data: [{ id: "gpt-one" }, { id: "claude-one" }] });
        }),
      ),
    );
  });

  it.effect("reports an unreachable proxy when the models request cannot connect", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* probeVibeProxy(ENDPOINT, undefined), {
        enabled: true,
        endpoint: ENDPOINT.rootUrl,
        reachable: false,
        models: [],
        message: "VibeProxy is not running — requests will fail.",
      });
    }).pipe(
      Effect.provide(
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({
                  request,
                  cause: new Error("Connection refused"),
                }),
              }),
            ),
          ),
        ),
      ),
    ),
  );

  it.effect("reports a reachable proxy when its model list is unavailable", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* probeVibeProxy(ENDPOINT, "invalid-key"), {
        enabled: true,
        endpoint: ENDPOINT.rootUrl,
        reachable: true,
        models: [],
        message:
          "VibeProxy is running, but its model list is unavailable. Check the client API key.",
      });
    }).pipe(Effect.provide(httpClientLayer(() => new Response(null, { status: 401 })))),
  );
});
