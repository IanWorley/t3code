import type { ProviderInstanceConfig } from "@t3tools/contracts";

export function readCodexSetupMode(config: unknown): "managed" | "existing" {
  return config !== null &&
    typeof config === "object" &&
    "setupMode" in config &&
    config.setupMode === "managed"
    ? "managed"
    : "existing";
}

export function withCodexSetupMode(
  instance: ProviderInstanceConfig,
  setupMode: "managed" | "existing",
): ProviderInstanceConfig {
  const { useModelProxy, ...rest } = instance;
  return {
    ...rest,
    ...(setupMode === "existing" && useModelProxy !== undefined ? { useModelProxy } : {}),
    enabled: true,
    config: {
      ...(instance.config !== null && typeof instance.config === "object" ? instance.config : {}),
      enabled: true,
      setupMode,
    },
  };
}
