// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ApprovalRequestId, KiroSettings, ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import { makeKiroAdapter } from "./KiroAdapter.ts";

const decodeKiroSettings = Schema.decodeSync(KiroSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");

async function makeMockAgentWrapper(platform: NodeJS.Platform, extraEnv?: Record<string, string>) {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kiro-acp-mock-"));
  const isWindows = platform === "win32";
  const wrapperPath = NodePath.join(
    directory,
    isWindows ? "fake-kiro-cli.cmd" : "fake-kiro-cli.sh",
  );
  const envCommands = Object.entries(extraEnv ?? {})
    .map(([key, value]) =>
      isWindows ? `set "${key}=${value}"` : `export ${key}=${JSON.stringify(value)}`,
    )
    .join(isWindows ? "\r\n" : "\n");
  const script = isWindows
    ? `@echo off\r\n${envCommands}\r\n${JSON.stringify(process.execPath)} ${JSON.stringify(mockAgentPath)} %*\r\n`
    : `#!/bin/sh
${envCommands}
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockAgentPath)} "$@"
`;
  await NodeFSP.writeFile(wrapperPath, script, "utf8");
  if (!isWindows) await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

async function readJsonLines(filePath: string) {
  const raw = await NodeFSP.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

it.effect("KiroAdapter maps a standard ACP prompt to canonical runtime events", () =>
  Effect.gen(function* () {
    const platform = yield* HostProcessPlatform;
    const wrapperPath = yield* Effect.promise(() => makeMockAgentWrapper(platform));
    const adapter = yield* makeKiroAdapter(
      decodeKiroSettings({ enabled: true, binaryPath: wrapperPath }),
    );
    const threadId = ThreadId.make("kiro-mock-thread");
    const eventsFiber = yield* Stream.take(adapter.streamEvents, 9).pipe(
      Stream.runCollect,
      Effect.forkChild,
    );

    const session = yield* adapter.startSession({
      threadId,
      provider: ProviderDriverKind.make("kiro"),
      cwd: process.cwd(),
      runtimeMode: "full-access",
    });
    assert.equal(session.provider, "kiro");
    assert.deepStrictEqual(session.resumeCursor, {
      schemaVersion: 1,
      sessionId: "mock-session-1",
    });

    yield* adapter.sendTurn({
      threadId,
      input: "hello mock",
      attachments: [],
    });

    const eventTypes = Array.from(yield* Fiber.join(eventsFiber), (event) => event.type);
    for (const eventType of [
      "session.started",
      "session.state.changed",
      "thread.started",
      "turn.started",
      "turn.plan.updated",
      "item.started",
      "content.delta",
      "item.completed",
      "turn.completed",
    ] as const) {
      assert.include(eventTypes, eventType);
    }
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3code-kiro-adapter-test-",
      }),
    ),
    Effect.scoped,
    Effect.provide(NodeServices.layer),
  ),
);

it.effect("KiroAdapter returns Kiro's advertised ACP permission option ID", () =>
  Effect.gen(function* () {
    const platform = yield* HostProcessPlatform;
    const directory = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kiro-acp-permission-")),
    );
    const requestLogPath = NodePath.join(directory, "requests.jsonl");
    const expectedOptionId = "kiro-session-approval";
    const wrapperPath = yield* Effect.promise(() =>
      makeMockAgentWrapper(platform, {
        T3_ACP_ALLOW_ALWAYS_OPTION_ID: expectedOptionId,
        T3_ACP_EMIT_TOOL_CALLS: "1",
        T3_ACP_REQUEST_LOG_PATH: requestLogPath,
      }),
    );
    const adapter = yield* makeKiroAdapter(
      decodeKiroSettings({ enabled: true, binaryPath: wrapperPath }),
    );
    const threadId = ThreadId.make("kiro-permission-thread");
    const turnCompleted = yield* Deferred.make<void>();

    yield* Stream.runForEach(adapter.streamEvents, (event) =>
      Effect.gen(function* () {
        if (String(event.threadId) !== String(threadId)) return;
        if (event.type === "request.opened" && event.requestId) {
          yield* adapter.respondToRequest(
            threadId,
            ApprovalRequestId.make(String(event.requestId)),
            "acceptAlways",
          );
        }
        if (event.type === "turn.completed") {
          yield* Deferred.succeed(turnCompleted, undefined).pipe(Effect.orDie);
        }
      }),
    ).pipe(Effect.forkChild);

    yield* adapter.startSession({
      threadId,
      provider: ProviderDriverKind.make("kiro"),
      cwd: process.cwd(),
      runtimeMode: "approval-required",
    });
    yield* adapter.sendTurn({
      threadId,
      input: "run a tool call",
      attachments: [],
    });
    yield* Deferred.await(turnCompleted);

    const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
    const permissionResponse = requests.find((entry) => {
      const result = entry.result;
      if (typeof result !== "object" || result === null || !("outcome" in result)) return false;
      const outcome = result.outcome;
      return (
        typeof outcome === "object" &&
        outcome !== null &&
        "optionId" in outcome &&
        outcome.optionId === expectedOptionId
      );
    });
    assert.isDefined(permissionResponse);
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3code-kiro-permission-test-",
      }),
    ),
    Effect.scoped,
    Effect.provide(NodeServices.layer),
  ),
);
