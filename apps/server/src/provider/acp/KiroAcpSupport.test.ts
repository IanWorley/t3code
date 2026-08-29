import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveSpawnCommand, SpawnExecutableResolution } from "@t3tools/shared/shell";
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

  it.effect("resolves the native Kiro executable on Windows", () =>
    Effect.gen(function* () {
      const environment = {
        PATH: "C:\\Program Files\\Kiro-Cli",
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      };
      const spawnInput = buildKiroAcpSpawnInput(
        { binaryPath: "kiro-cli" },
        "C:\\Users\\developer\\project",
        environment,
        "full-access",
      );
      const command = yield* resolveSpawnCommand(spawnInput.command, spawnInput.args, {
        env: environment,
      });

      expect(command).toEqual({
        command: "C:\\Program Files\\Kiro-Cli\\kiro-cli.exe",
        args: ["acp", "--trust-all-tools"],
        shell: false,
      });
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.provideService(HostProcessPlatform, "win32"),
      Effect.provideService(
        SpawnExecutableResolution,
        () => "C:\\Program Files\\Kiro-Cli\\kiro-cli.exe",
      ),
    ),
  );

  it("uses Kiro's auto model when no model is selected", () => {
    expect(resolveKiroAcpBaseModelId(undefined)).toBe("auto");
    expect(resolveKiroAcpBaseModelId(" claude-sonnet-4.5 ")).toBe("claude-sonnet-4.5");
  });

  it.effect("selects the requested model and effort through ACP", () =>
    Effect.gen(function* () {
      const selections: string[] = [];
      const requests: Array<{ method: string; payload: unknown }> = [];
      yield* applyKiroAcpModelSelection({
        runtime: {
          setSessionModel: (modelId) =>
            Effect.sync(() => {
              selections.push(modelId);
              return {};
            }),
          request: (method, payload) =>
            Effect.sync(() => {
              requests.push({ method, payload });
              return { success: true };
            }),
        },
        sessionId: "kiro-session-1",
        model: "claude-haiku-4.5",
        selections: [{ id: "effort", value: "high" }],
        mapError: ({ cause }) => cause,
      });

      expect(selections).toEqual(["claude-haiku-4.5"]);
      expect(requests).toEqual([
        {
          method: "_kiro.dev/commands/execute",
          payload: {
            sessionId: "kiro-session-1",
            command: { command: "effort", args: { value: "high" } },
          },
        },
      ]);
    }),
  );

  it("keeps the provider kind available as an open contract slug", () => {
    expect(ProviderDriverKind.make("kiro")).toBe("kiro");
  });
});
