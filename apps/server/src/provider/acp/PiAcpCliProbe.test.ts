/** Optional integration check: T3_PI_ACP_PROBE=1 vp test run PiAcpCliProbe. */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect } from "vite-plus/test";

import { deletePiAcpSession, makePiAcpRuntime } from "./PiAcpSupport.ts";

describe.runIf(process.env.T3_PI_ACP_PROBE === "1")("Pi ACP CLI probe", () => {
  it.effect("discovers Pi's model and thought-level config options", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const runtime = yield* makePiAcpRuntime({
        piSettings: { binaryPath: "pi-acp" },
        environment: process.env,
        childProcessSpawner,
        cwd: process.cwd(),
        clientInfo: { name: "t3-pi-probe", version: "0.0.0" },
      });
      const started = yield* runtime.start();
      yield* Effect.addFinalizer(() => deletePiAcpSession(runtime, started.sessionId));
      const configOptions = started.sessionSetupResult.configOptions ?? [];
      expect(configOptions.some((option) => option.category === "model")).toBe(true);
      expect(configOptions.some((option) => option.category === "thought_level")).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
