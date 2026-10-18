import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { describe, expect, it } from "@effect/vitest";

import { codexExecLaunchArgs } from "./codexLaunchArgs.ts";
import {
  applyModelProxyProbe,
  modelProxyClaudeEnvironment,
  modelProxyCodexEnvironment,
  parseModelProxyUrl,
  resolveModelProxyRoute,
} from "./modelProxy.ts";

const route = { rootUrl: "http://proxy.test:8317", apiKey: "proxy-key" };

const readySnapshot = {
  driver: "codex",
  status: "ready",
  models: [{ slug: "gpt-5.5", name: "GPT-5.5", isCustom: false, capabilities: null }],
} as unknown as ServerProvider;

describe("resolveModelProxyRoute", () => {
  it.effect("fails instead of routing directly when the proxy URL is unusable", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        resolveModelProxyRoute({
          driver: ProviderDriverKind.make("codex"),
          instanceId: ProviderInstanceId.make("codex"),
          settings: { url: "localhost:8317", apiKey: "" },
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );
});

describe("modelProxyClaudeEnvironment", () => {
  it("points Claude at the proxy and drops competing backends", () => {
    const env = modelProxyClaudeEnvironment(
      { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-direct", CLAUDE_CODE_USE_BEDROCK: "1" },
      route,
    );
    expect(env).toEqual({
      PATH: "/usr/bin",
      ANTHROPIC_BASE_URL: "http://proxy.test:8317",
      ANTHROPIC_AUTH_TOKEN: "proxy-key",
    });
  });
});

describe("modelProxyCodexEnvironment", () => {
  it("adds the proxy provider after the launch args Codex would otherwise use", () => {
    const env = modelProxyCodexEnvironment(
      { T3CODE_CODEX_LAUNCH_ARGS: "--strict-config" },
      "--ignored-settings-args",
      route,
    );
    expect(env.T3CODE_CODEX_LAUNCH_ARGS).toBe(
      [
        "--strict-config",
        `-c 'model_provider="t3_model_proxy"'`,
        `-c 'model_providers.t3_model_proxy.name="Model proxy"'`,
        `-c 'model_providers.t3_model_proxy.base_url="http://proxy.test:8317/v1"'`,
        `-c 'model_providers.t3_model_proxy.wire_api="responses"'`,
        `-c 'model_providers.t3_model_proxy.env_key="T3CODE_MODEL_PROXY_API_KEY"'`,
      ].join(" "),
    );
    expect(env.T3CODE_MODEL_PROXY_API_KEY).toBe("proxy-key");
  });
});

describe("parseModelProxyUrl", () => {
  it("keeps an apostrophe in the path from breaking the Codex launch args", () => {
    const rootUrl = parseModelProxyUrl("http://proxy.test/O'Brien");
    expect(rootUrl).not.toBeNull();
    const env = modelProxyCodexEnvironment({}, undefined, { rootUrl: rootUrl!, apiKey: undefined });
    expect(codexExecLaunchArgs(env.T3CODE_CODEX_LAUNCH_ARGS)).toContain(
      'model_providers.t3_model_proxy.base_url="http://proxy.test/O%27Brien/v1"',
    );
  });
});

describe("applyModelProxyProbe", () => {
  it("adds proxy-only models without duplicating harness models", () => {
    const next = applyModelProxyProbe(readySnapshot, {
      available: true,
      models: ["gpt-5.5", "gpt-6.1-sol"],
    });
    expect(next.models.map((model) => [model.slug, model.subProvider])).toEqual([
      ["gpt-5.5", undefined],
      ["gpt-6.1-sol", "Proxy"],
    ]);
    expect(next.models[1]?.capabilities?.optionDescriptors?.[0]?.id).toBe("reasoningEffort");
    expect(next.status).toBe("ready");
    expect(next.modelProxy).toEqual({ status: "available" });
  });

  it("keeps Claude models off Codex but offers GPT models to Claude", () => {
    const probe = { available: true, models: ["claude-sonnet-5", "gpt-6.1-sol"] };
    const proxySlugs = (snapshot: ServerProvider) =>
      applyModelProxyProbe(snapshot, probe)
        .models.filter((model) => model.subProvider === "Proxy")
        .map((model) => model.slug);

    expect(proxySlugs(readySnapshot)).toEqual(["gpt-6.1-sol"]);
    expect(
      proxySlugs({ ...readySnapshot, driver: ProviderDriverKind.make("claudeAgent") }),
    ).toEqual(["claude-sonnet-5", "gpt-6.1-sol"]);
  });

  it("treats a catalog alias as a model the harness already has", () => {
    const snapshot = {
      ...readySnapshot,
      driver: ProviderDriverKind.make("claudeAgent"),
      models: [
        {
          slug: "claude-sonnet-5",
          name: "Claude Sonnet 5",
          aliases: ["sonnet"],
          isCustom: false,
          capabilities: null,
        },
      ],
    } as ServerProvider;
    const next = applyModelProxyProbe(snapshot, { available: true, models: ["sonnet"] });
    expect(next.models.map((model) => model.slug)).toEqual(["claude-sonnet-5"]);
  });

  it("warns on a ready instance when the proxy is unavailable", () => {
    const next = applyModelProxyProbe(readySnapshot, {
      available: false,
      models: [],
      message: "down",
    });
    expect(next).toMatchObject({
      status: "warning",
      message: "down",
      modelProxy: { status: "unavailable" },
    });
  });
});
