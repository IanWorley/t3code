// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { KiroSettings, ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import { makeKiroAdapter } from "./KiroAdapter.ts";

const decodeKiroSettings = Schema.decodeSync(KiroSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");

async function makeMockAgentWrapper() {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kiro-acp-mock-"));
  const wrapperPath = NodePath.join(directory, "fake-kiro-cli.sh");
  const script = `#!/bin/sh
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockAgentPath)} "$@"
`;
  await NodeFSP.writeFile(wrapperPath, script, "utf8");
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

it.effect("KiroAdapter maps a standard ACP prompt to canonical runtime events", () =>
  Effect.gen(function* () {
    const wrapperPath = yield* Effect.promise(makeMockAgentWrapper);
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
