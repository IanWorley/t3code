import type { ProviderDriverKind } from "@t3tools/contracts";

import type { ProviderInstanceEntry } from "./providerInstances";

const VIBEPROXY_SUPPORTED_DRIVERS = new Set<string>(["codex", "claudeAgent"]);

export const VIBEPROXY_UNAVAILABLE_MODEL_MESSAGE = "Not currently available through VibeProxy";

export function isVibeProxySupportedDriver(driver: ProviderDriverKind): boolean {
  return VIBEPROXY_SUPPORTED_DRIVERS.has(driver);
}

export function getVibeProxyModelAdvisory(
  entry: ProviderInstanceEntry | undefined,
  model: string,
): string | null {
  const status = entry?.snapshot.vibeProxy;
  if (!status?.enabled || !status.reachable) return null;
  return status.models.includes(model) ? null : VIBEPROXY_UNAVAILABLE_MODEL_MESSAGE;
}

export function getVibeProxyModelSourceLabel(
  entry: ProviderInstanceEntry | undefined,
  model: string,
): string | null {
  return entry?.snapshot.vibeProxy?.addedModels?.includes(model) ? "VibeProxy" : null;
}

export function describeVibeProxyInstance(entry: ProviderInstanceEntry): string | null {
  const status = entry.snapshot.vibeProxy;
  if (!status?.enabled) return null;
  return status.reachable
    ? `${entry.displayName} — via VibeProxy`
    : `${entry.displayName} — VibeProxy is not running; requests will fail.`;
}
