import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect } from "vite-plus/test";

import { applyPiAcpModelSelection, buildPiAcpSpawnInput } from "./PiAcpSupport.ts";

describe("buildPiAcpSpawnInput", () => {
  it("starts the default Pi ACP adapter directly over stdio", () => {
    expect(buildPiAcpSpawnInput(undefined, "/tmp/project")).toEqual({
      command: "pi-acp",
      args: [],
      cwd: "/tmp/project",
    });
  });

  it("preserves a configured binary and environment", () => {
    expect(
      buildPiAcpSpawnInput({ binaryPath: "/opt/pi-acp" }, "/tmp/project", {
        PI_CODING_AGENT_DIR: "/tmp/pi-home",
      }),
    ).toEqual({
      command: "/opt/pi-acp",
      args: [],
      cwd: "/tmp/project",
      env: { PI_CODING_AGENT_DIR: "/tmp/pi-home" },
    });
  });
});

describe("applyPiAcpModelSelection", () => {
  it.effect("sets Pi's model and thought-level config options", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly id: string; readonly value: string }> = [];
      yield* applyPiAcpModelSelection({
        runtime: {
          setModel: (value) =>
            Effect.sync(() => {
              calls.push({ id: "model", value });
            }),
          setConfigOption: (id, value) =>
            Effect.sync(() => {
              calls.push({ id, value: String(value) });
              return { configOptions: [] };
            }),
        },
        model: "anthropic/claude-sonnet-4-6",
        selections: [{ id: "reasoningEffort", value: "high" }],
        mapError: ({ cause }) => cause,
      });

      expect(calls).toEqual([
        { id: "model", value: "anthropic/claude-sonnet-4-6" },
        { id: "thought_level", value: "high" },
      ]);
    }),
  );

  it.effect("leaves Pi's active model unchanged for the default placeholder", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      yield* applyPiAcpModelSelection({
        runtime: {
          setModel: (value) => Effect.sync(() => calls.push(value)),
          setConfigOption: () => Effect.succeed({ configOptions: [] }),
        },
        model: "default",
        selections: [],
        mapError: ({ cause }) => cause,
      });
      expect(calls).toEqual([]);
    }),
  );
});
