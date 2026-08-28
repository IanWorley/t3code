import { ProviderDriverKind } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect } from "vite-plus/test";

import {
  applyKiroAcpModelSelection,
  buildKiroAcpSpawnInput,
  kiroAcpSpawnArgs,
  resolveKiroAcpBaseModelId,
} from "./KiroAcpSupport.ts";

describe("KiroAcpSupport", () => {
  it("builds supervised and full-access spawn arguments", () => {
    expect(kiroAcpSpawnArgs("approval-required")).toEqual(["acp"]);
    expect(kiroAcpSpawnArgs("full-access")).toEqual(["acp", "--trust-all-tools"]);
  });

  it("builds the configured Kiro ACP command", () => {
    expect(
      buildKiroAcpSpawnInput(
        { binaryPath: "/opt/kiro-cli" },
        "/tmp/project",
        { KIRO_API_KEY: "test" },
        "full-access",
      ),
    ).toEqual({
      command: "/opt/kiro-cli",
      args: ["acp", "--trust-all-tools"],
      cwd: "/tmp/project",
      env: { KIRO_API_KEY: "test" },
    });
  });

  it("uses Kiro's auto model when no model is selected", () => {
    expect(resolveKiroAcpBaseModelId(undefined)).toBe("auto");
    expect(resolveKiroAcpBaseModelId(" claude-sonnet-4.5 ")).toBe("claude-sonnet-4.5");
  });

  it.effect("selects the requested model through standard ACP", () =>
    Effect.gen(function* () {
      const selections: string[] = [];
      yield* applyKiroAcpModelSelection({
        runtime: {
          setSessionModel: (modelId) =>
            Effect.sync(() => {
              selections.push(modelId);
              return {};
            }),
        },
        model: "claude-haiku-4.5",
        mapError: ({ cause }) => cause,
      });

      expect(selections).toEqual(["claude-haiku-4.5"]);
    }),
  );

  it("keeps the provider kind available as an open contract slug", () => {
    expect(ProviderDriverKind.make("kiro")).toBe("kiro");
  });
});
