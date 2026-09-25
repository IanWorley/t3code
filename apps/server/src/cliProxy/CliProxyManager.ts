import {
  CliProxyManagementError,
  type ServerSettingsError,
  type CliProxyAction,
  type CliProxyManagerSettings,
  type CliProxyStatus,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as ServerSettings from "../serverSettings.ts";

const FORCE_KILL_AFTER = "2 seconds";
const STOP_TIMEOUT = "5 seconds";

interface OwnedProcess {
  readonly handle: ChildProcessSpawner.ChildProcessHandle;
  readonly scope: Scope.Closeable;
  readonly manager: Extract<CliProxyManagerSettings, { readonly mode: "managed" }>;
}

export class CliProxyManager extends Context.Service<
  CliProxyManager,
  {
    readonly status: Effect.Effect<CliProxyStatus>;
    readonly changes: Stream.Stream<CliProxyStatus>;
    readonly control: (
      action: CliProxyAction,
    ) => Effect.Effect<CliProxyStatus, CliProxyManagementError>;
    readonly reconcileSettings: Effect.Effect<void, CliProxyManagementError | ServerSettingsError>;
  }
>()("t3/cliProxy/CliProxyManager") {}

const failure = (message: string) => new CliProxyManagementError({ message });

export const make = Effect.fn("CliProxyManager.make")(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settings = yield* ServerSettings.ServerSettingsService;
  const ownerScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
    Scope.close(scope, Exit.void),
  );
  const mutex = yield* Semaphore.make(1);
  const status = yield* SubscriptionRef.make<CliProxyStatus>({ state: "stopped" });
  let owned: OwnedProcess | null = null;

  const stopOwned = Effect.fn("CliProxyManager.stopOwned")(function* () {
    const current = owned;
    if (current === null) {
      yield* SubscriptionRef.set(status, { state: "stopped" });
      return;
    }
    yield* SubscriptionRef.set(status, { state: "stopping" });
    yield* current.handle
      .kill({
        killSignal: "SIGTERM",
        forceKillAfter: FORCE_KILL_AFTER,
      })
      .pipe(Effect.timeoutOption(STOP_TIMEOUT), Effect.ignore);
    const stillRunning = yield* current.handle.isRunning.pipe(Effect.orElseSucceed(() => true));
    if (stillRunning) {
      const message = "CLIProxyAPI did not stop. Check the process on the server and retry.";
      yield* SubscriptionRef.set(status, { state: "failed", message });
      return yield* failure(message);
    }
    owned = null;
    yield* Scope.close(current.scope, Exit.void).pipe(Effect.ignore);
    yield* SubscriptionRef.set(status, { state: "stopped" });
  });

  const start = Effect.fn("CliProxyManager.start")(function* () {
    const previous = owned;
    if (previous !== null) {
      const running = yield* previous.handle.isRunning.pipe(
        Effect.mapError(() => failure("Could not check the owned CLIProxyAPI process.")),
      );
      if (running) {
        const currentStatus = yield* SubscriptionRef.get(status);
        if (currentStatus.state === "failed") return yield* failure(currentStatus.message);
        return currentStatus;
      }
      owned = null;
      yield* Scope.close(previous.scope, Exit.void).pipe(Effect.ignore);
    }
    const current = (yield* settings.getSettings.pipe(
      Effect.mapError(() => failure("Could not read CLIProxyAPI settings.")),
    )).vibeProxy.manager;
    if (current.mode !== "managed") {
      return yield* failure("Select managed CLIProxyAPI mode before starting the process.");
    }
    if (current.binaryPath.length === 0 || current.configPath.length === 0) {
      return yield* failure(
        "Set both the CLIProxyAPI executable and config file paths before starting.",
      );
    }
    if (!path.isAbsolute(current.configPath)) {
      return yield* failure("Use an absolute path to the CLIProxyAPI config file on the server.");
    }
    const configExists = yield* fileSystem
      .exists(current.configPath)
      .pipe(
        Effect.mapError(() =>
          failure(`Cannot access CLIProxyAPI config file: ${current.configPath}`),
        ),
      );
    if (!configExists) {
      return yield* failure(`CLIProxyAPI config file does not exist: ${current.configPath}`);
    }
    yield* SubscriptionRef.set(status, { state: "starting" });
    const childScope = yield* Scope.make();
    const spawned = yield* Effect.exit(
      spawner
        .spawn(
          ChildProcess.make(current.binaryPath, ["-config", current.configPath], {
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
            shell: false,
            killSignal: "SIGTERM",
            forceKillAfter: FORCE_KILL_AFTER,
          }),
        )
        .pipe(Effect.provideService(Scope.Scope, childScope)),
    );
    if (Exit.isFailure(spawned)) {
      yield* Scope.close(childScope, Exit.void).pipe(Effect.ignore);
      return yield* failure(`Could not start CLIProxyAPI: ${String(Cause.squash(spawned.cause))}`);
    }
    const process: OwnedProcess = { handle: spawned.value, scope: childScope, manager: current };
    owned = process;
    yield* SubscriptionRef.set(status, { state: "running", pid: Number(process.handle.pid) });
    yield* process.handle.exitCode.pipe(
      Effect.exit,
      Effect.flatMap((exit) =>
        mutex.withPermit(
          Effect.gen(function* () {
            if (owned !== process) return;
            owned = null;
            yield* Scope.close(process.scope, Exit.void).pipe(Effect.ignore);
            yield* SubscriptionRef.set(status, {
              state: "failed",
              message: Exit.isSuccess(exit)
                ? `CLIProxyAPI exited with code ${Number(exit.value)}. Check its config file and whether another proxy is using its port.`
                : "CLIProxyAPI exited unexpectedly. Check its config file and whether another proxy is using its port.",
            });
          }),
        ),
      ),
      Effect.forkIn(ownerScope),
    );
    return yield* SubscriptionRef.get(status);
  });

  const control = (action: CliProxyAction) =>
    Effect.uninterruptible(
      mutex.withPermit(
        Effect.gen(function* () {
          if (action === "stop" || action === "restart") yield* stopOwned();
          if (action === "start" || action === "restart") {
            const result = yield* Effect.exit(start());
            if (Exit.isFailure(result)) {
              const cause = Cause.squash(result.cause);
              const message = cause instanceof Error ? cause.message : String(cause);
              yield* SubscriptionRef.set(status, { state: "failed", message });
              return yield* Effect.failCause(result.cause);
            }
            return result.value;
          }
          return yield* SubscriptionRef.get(status);
        }),
      ),
    );

  const reconcileSettings = Effect.uninterruptible(
    mutex.withPermit(
      Effect.gen(function* () {
        const manager = (yield* settings.getSettings).vibeProxy.manager;
        const current = owned;
        if (
          current !== null &&
          (manager.mode === "external" ||
            manager.binaryPath !== current.manager.binaryPath ||
            manager.configPath !== current.manager.configPath)
        )
          yield* stopOwned();
      }),
    ),
  );

  yield* Effect.addFinalizer(() =>
    Effect.uninterruptible(mutex.withPermit(stopOwned())).pipe(Effect.ignoreCause({ log: true })),
  );
  yield* settings.subscribeChanges.pipe(
    Effect.flatMap((changes) =>
      changes.pipe(
        Stream.runForEach(() => reconcileSettings.pipe(Effect.ignoreCause({ log: true }))),
        Effect.forkIn(ownerScope),
      ),
    ),
  );
  const initial = yield* settings.getSettings;
  if (initial.vibeProxy.manager.mode === "managed" && initial.vibeProxy.manager.autoStart) {
    yield* control("start").pipe(Effect.ignore);
  }

  return CliProxyManager.of({
    status: SubscriptionRef.get(status),
    changes: SubscriptionRef.changes(status),
    control,
    reconcileSettings,
  });
});

export const layer = Layer.effect(CliProxyManager, make());
