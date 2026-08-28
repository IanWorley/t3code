/**
 * Optional integration check against a real `kiro-cli acp` install.
 * Enable with: T3_KIRO_ACP_PROBE=1 vp test run KiroAcpCliProbe
 * Set T3_KIRO_LIVE_TURN=1 to also send a small prompt to the real model.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { KiroSettings } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect } from "vite-plus/test";

import { makeKiroAcpRuntime } from "./KiroAcpSupport.ts";
import { checkKiroProviderStatus } from "../Layers/KiroProvider.ts";

const decodeKiroSettings = Schema.decodeSync(KiroSettings);

const makeProbeRuntime = Effect.gen(function* () {
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* makeKiroAcpRuntime({
    kiroSettings: { binaryPath: "kiro-cli" },
    environment: process.env,
    childProcessSpawner,
    cwd: process.cwd(),
    clientInfo: { name: "t3-kiro-probe", version: "0.0.0" },
  });
});

describe.runIf(process.env.T3_KIRO_ACP_PROBE === "1")("Kiro ACP CLI probe", () => {
  it.effect("initializes without an ACP authenticate request", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime;
      const started = yield* runtime.start();
      expect(started.initializeResult.agentInfo?.name).toBe("Kiro CLI Agent");
      expect(started.initializeResult.authMethods).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("advertises models and default/planner modes", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime;
      const started = yield* runtime.start();
      const modelState = started.sessionSetupResult.models;
      const modeState = started.sessionSetupResult.modes;

      expect(modelState?.currentModelId).toBe("auto");
      expect(modelState?.availableModels.length ?? 0).toBeGreaterThan(0);
      expect(modeState?.availableModes.some((mode) => mode.id === "kiro_default")).toBe(true);
      expect(modeState?.availableModes.some((mode) => mode.id === "kiro_planner")).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("accepts a no-op model switch through standard ACP", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime;
      const started = yield* runtime.start();
      const currentModelId = started.sessionSetupResult.models?.currentModelId;
      expect(currentModelId).toBeDefined();
      if (currentModelId) yield* runtime.setSessionModel(currentModelId);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports the installed CLI, account, and discovered models", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkKiroProviderStatus(
        decodeKiroSettings({ enabled: true }),
        process.env,
        process.cwd(),
      );

      expect(snapshot.status).toBe("ready");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.auth.status).toBe("authenticated");
      expect(snapshot.models.length).toBeGreaterThan(1);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.skipIf(process.env.T3_KIRO_LIVE_TURN !== "1")(
    "finishes a real Kiro turn and streams its answer",
    () =>
      Effect.gen(function* () {
        const runtime = yield* makeProbeRuntime;
        yield* runtime.start();
        const chunks: string[] = [];
        const events = yield* Stream.runForEach(runtime.getEvents(), (event) => {
          if (event._tag === "EventStreamBarrier") {
            return Deferred.succeed(event.acknowledge, undefined);
          }
          if (event._tag === "ContentDelta") chunks.push(event.text);
          return Effect.void;
        }).pipe(Effect.forkChild);
        const result = yield* runtime.prompt({
          prompt: [{ type: "text", text: "Reply exactly KIRO_T3_OK. Do not use any tools." }],
        });
        yield* runtime.drainEvents;
        expect(result.stopReason).toBe("end_turn");
        expect(chunks.join("")).toContain("KIRO_T3_OK");
        yield* Fiber.interrupt(events);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
