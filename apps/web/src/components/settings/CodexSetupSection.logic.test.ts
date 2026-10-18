import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { withCodexSetupMode } from "./CodexSetupSection.logic";

const routedCodex = {
  driver: ProviderDriverKind.make("codex"),
  useModelProxy: true,
  config: { binaryPath: "/usr/local/bin/codex" },
};

describe("withCodexSetupMode", () => {
  it("turns off model proxy routing when the instance switches to Managed setup", () => {
    expect(withCodexSetupMode(routedCodex, "managed")).toEqual({
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      config: { binaryPath: "/usr/local/bin/codex", enabled: true, setupMode: "managed" },
    });
  });

  it("keeps model proxy routing for an existing Codex installation", () => {
    expect(withCodexSetupMode(routedCodex, "existing").useModelProxy).toBe(true);
  });
});
