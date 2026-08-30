import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";

import { deriveProviderInstanceEntries } from "./providerInstances";
import {
  describeVibeProxyInstance,
  getVibeProxyModelAdvisory,
  getVibeProxyModelSourceLabel,
} from "./vibeProxyPresentation";

const provider = (reachable: boolean): ServerProvider => ({
  instanceId: ProviderInstanceId.make("codex_proxy"),
  driver: ProviderDriverKind.make("codex"),
  displayName: "Codex Proxy",
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-08-28T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  vibeProxy: {
    enabled: true,
    endpoint: "http://127.0.0.1:8318",
    reachable,
    models: ["gpt-available"],
  },
});

describe("VibeProxy picker presentation", () => {
  it("marks only models absent from the reachable proxy", () => {
    const entry = deriveProviderInstanceEntries([provider(true)])[0];
    expect(getVibeProxyModelSourceLabel(entry)).toBe("VibeProxy");
    expect(getVibeProxyModelAdvisory(entry, "gpt-available")).toBeNull();
    expect(getVibeProxyModelAdvisory(entry, "gpt-missing")).toBe(
      "Not currently available through VibeProxy",
    );
  });

  it("describes reachable and unreachable routing without dimming stale models", () => {
    const reachable = deriveProviderInstanceEntries([provider(true)])[0]!;
    const unreachable = deriveProviderInstanceEntries([provider(false)])[0]!;
    expect(describeVibeProxyInstance(reachable)).toBe("Codex Proxy — via VibeProxy");
    expect(describeVibeProxyInstance(unreachable)).toBe(
      "Codex Proxy — VibeProxy is not running; requests will fail.",
    );
    expect(getVibeProxyModelAdvisory(unreachable, "gpt-missing")).toBeNull();
  });

  it("does not label models from a direct provider instance", () => {
    const { vibeProxy: _omit, ...direct } = provider(true);
    const entry = deriveProviderInstanceEntries([direct])[0];
    expect(getVibeProxyModelSourceLabel(entry)).toBeNull();
  });
});
