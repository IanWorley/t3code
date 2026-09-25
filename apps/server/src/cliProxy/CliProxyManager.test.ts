// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ServerSettings from "../serverSettings.ts";
import * as CliProxyManager from "./CliProxyManager.ts";

const CONFIG_PATH = NodePath.resolve("cli-proxy-test-config.yaml");
const MISSING_CONFIG_PATH = NodePath.resolve("cli-proxy-missing-config.yaml");
const MANAGED_SETTINGS = {
  vibeProxy: {
    manager: {
      mode: "managed" as const,
      binaryPath: "/test/cli-proxy-api",
      configPath: CONFIG_PATH,
      autoStart: false,
    },
  },
};

const makeSpawner = Effect.gen(function* () {
  const commands = yield* Ref.make<
    Array<{ command: string; args: ReadonlyArray<string>; shell: boolean | string | undefined }>
  >([]);
  const exits = yield* Ref.make<Array<Deferred.Deferred<ChildProcessSpawner.ExitCode>>>([]);
  const refuseKill = yield* Ref.make(false);
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (command._tag !== "StandardCommand") throw new Error("Expected one executable command.");
      const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      const pid = ChildProcessSpawner.ProcessId(
        100 +
          (yield* Ref.updateAndGet(commands, (all) => [
            ...all,
            { command: command.command, args: command.args, shell: command.options.shell },
          ])).length,
      );
      yield* Ref.update(exits, (all) => [...all, exit]);
      return ChildProcessSpawner.makeHandle({
        pid,
        exitCode: Deferred.await(exit),
        isRunning: Deferred.isDone(exit).pipe(Effect.map((done) => !done)),
        kill: () =>
          Ref.get(refuseKill).pipe(
            Effect.flatMap((refuse) =>
              refuse
                ? Effect.void
                : Deferred.succeed(exit, ChildProcessSpawner.ExitCode(0)).pipe(Effect.asVoid),
            ),
          ),
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.empty,
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  return { spawner, commands, exits, refuseKill };
});

const testLayer = (
  harness: { readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"] },
  settings: Parameters<typeof ServerSettings.layerTest>[0],
) =>
  Layer.mergeAll(
    NodeServices.layer,
    ServerSettings.layerTest(settings),
    FileSystem.layerNoop({ exists: (path) => Effect.succeed(path === CONFIG_PATH) }),
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, harness.spawner),
  );

describe("CLIProxyAPI process manager", () => {
  it.effect("serializes commands and stops only its captured child", () =>
    Effect.gen(function* () {
      const harness = yield* makeSpawner;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const manager = yield* CliProxyManager.make();
          expect(
            yield* manager.changes.pipe(Stream.runHead, Effect.map(Option.getOrThrow)),
          ).toEqual({ state: "stopped" });
          const [first, second] = yield* Effect.all(
            [manager.control("start"), manager.control("start")],
            {
              concurrency: "unbounded",
            },
          );
          expect(first).toEqual({ state: "running", pid: 101 });
          expect(second).toEqual(first);
          expect(yield* Ref.get(harness.commands)).toEqual([
            {
              command: "/test/cli-proxy-api",
              args: ["-config", CONFIG_PATH],
              shell: false,
            },
          ]);

          expect(yield* manager.control("restart")).toEqual({ state: "running", pid: 102 });
          const [oldExit, newExit] = yield* Ref.get(harness.exits);
          if (oldExit === undefined || newExit === undefined)
            throw new Error("Expected two child exits.");
          expect(yield* Deferred.isDone(oldExit)).toBe(true);
          expect(yield* Deferred.isDone(newExit)).toBe(false);
          expect(yield* manager.control("stop")).toEqual({ state: "stopped" });
          expect(yield* manager.control("stop")).toEqual({ state: "stopped" });
          expect(yield* Deferred.isDone(newExit)).toBe(true);
        }).pipe(Effect.provide(testLayer(harness, MANAGED_SETTINGS))),
      );
    }),
  );

  it.effect("rejects a missing config file without spawning", () =>
    Effect.gen(function* () {
      const harness = yield* makeSpawner;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const manager = yield* CliProxyManager.make();
          const error = yield* manager.control("start").pipe(Effect.flip);
          expect(error.message).toContain("config file does not exist");
          expect(yield* manager.status).toEqual({ state: "failed", message: error.message });
          expect(yield* Ref.get(harness.commands)).toEqual([]);
        }).pipe(
          Effect.provide(
            testLayer(harness, {
              vibeProxy: {
                manager: { ...MANAGED_SETTINGS.vibeProxy.manager, configPath: MISSING_CONFIG_PATH },
              },
            }),
          ),
        ),
      );
    }),
  );

  it.effect("does not report start success while a failed stop still owns the child", () =>
    Effect.gen(function* () {
      const harness = yield* makeSpawner;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const manager = yield* CliProxyManager.make();
          expect(yield* manager.control("start")).toEqual({ state: "running", pid: 101 });
          yield* Ref.set(harness.refuseKill, true);
          const stopError = yield* manager.control("stop").pipe(Effect.flip);
          expect(stopError.message).toContain("did not stop");
          const startError = yield* manager.control("start").pipe(Effect.flip);
          expect(startError.message).toBe(stopError.message);
          expect(yield* Ref.get(harness.commands)).toHaveLength(1);
          yield* Ref.set(harness.refuseKill, false);
          expect(yield* manager.control("stop")).toEqual({ state: "stopped" });
        }).pipe(Effect.provide(testLayer(harness, MANAGED_SETTINGS))),
      );
    }),
  );

  it.effect("auto-starts once and stays stopped after a manual stop", () =>
    Effect.gen(function* () {
      const harness = yield* makeSpawner;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const manager = yield* CliProxyManager.make();
          expect(yield* manager.status).toEqual({ state: "running", pid: 101 });
          expect(yield* manager.control("stop")).toEqual({ state: "stopped" });
          expect(yield* manager.status).toEqual({ state: "stopped" });
          expect(yield* Ref.get(harness.commands)).toHaveLength(1);
          expect(yield* manager.control("start")).toEqual({ state: "running", pid: 102 });
        }).pipe(
          Effect.provide(
            testLayer(harness, {
              vibeProxy: { manager: { ...MANAGED_SETTINGS.vibeProxy.manager, autoStart: true } },
            }),
          ),
        ),
      );
      const exits = yield* Ref.get(harness.exits);
      expect(exits).toHaveLength(2);
      for (const exit of exits) expect(yield* Deferred.isDone(exit)).toBe(true);
    }),
  );

  it.effect("stops its child when settings switch to external mode", () =>
    Effect.gen(function* () {
      const harness = yield* makeSpawner;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const manager = yield* CliProxyManager.make();
          const settings = yield* ServerSettings.ServerSettingsService;
          expect(yield* manager.control("start")).toEqual({ state: "running", pid: 101 });
          yield* settings.updateSettings({ vibeProxy: { manager: { mode: "external" } } });
          yield* manager.reconcileSettings;
          expect(yield* manager.status).toEqual({ state: "stopped" });
          const [exit] = yield* Ref.get(harness.exits);
          if (exit === undefined) throw new Error("Expected one child exit.");
          expect(yield* Deferred.isDone(exit)).toBe(true);
          const error = yield* manager.control("start").pipe(Effect.flip);
          expect(error.message).toContain("Select managed");
          expect(yield* Ref.get(harness.commands)).toHaveLength(1);
        }).pipe(Effect.provide(testLayer(harness, MANAGED_SETTINGS))),
      );
    }),
  );

  it.effect("publishes an unexpected child exit and permits an explicit restart", () =>
    Effect.gen(function* () {
      const harness = yield* makeSpawner;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const manager = yield* CliProxyManager.make();
          expect(yield* manager.control("start")).toEqual({ state: "running", pid: 101 });
          const [firstExit] = yield* Ref.get(harness.exits);
          if (firstExit === undefined) throw new Error("Expected one child exit.");
          const failureEvent = yield* manager.changes.pipe(
            Stream.filter((value) => value.state === "failed"),
            Stream.runHead,
            Effect.map(Option.getOrThrow),
            Effect.forkChild,
          );
          yield* Deferred.succeed(firstExit, ChildProcessSpawner.ExitCode(3));
          const failed = yield* Fiber.join(failureEvent);
          expect(failed.state).toBe("failed");
          if (failed.state === "failed") expect(failed.message).toContain("code 3");
          expect(yield* manager.control("start")).toEqual({ state: "running", pid: 102 });
        }).pipe(Effect.provide(testLayer(harness, MANAGED_SETTINGS))),
      );
      const [, restartedExit] = yield* Ref.get(harness.exits);
      if (restartedExit === undefined) throw new Error("Expected restarted child exit.");
      expect(yield* Deferred.isDone(restartedExit)).toBe(true);
    }),
  );
});
