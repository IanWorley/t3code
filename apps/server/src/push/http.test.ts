import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthStandardClientScopes, EnvironmentHttpApi } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { environmentAuthenticatedAuthLayer } from "../auth/http.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makePushDeviceStore } from "./devices.ts";
import { pushHttpApiLayer } from "./http.ts";
import { SelfHostedPush } from "./SelfHostedPush.ts";

class PushTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.push) {}
const configLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-push-http-test-" });
const authLayer = EnvironmentAuth.layer.pipe(
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.identityLayer),
  Layer.provide(configLayer),
);
const dependencies = Layer.mergeAll(
  authLayer,
  SqlitePersistenceMemory,
  ServerSecretStore.layer,
).pipe(Layer.provide(configLayer), Layer.provide(NodeServices.layer));

it.effect("registers and removes a phone with a standard paired bearer session", () =>
  Effect.gen(function* () {
    const clock = yield* Clock.Clock;
    const nowIso = DateTime.formatIso(yield* DateTime.now);
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const store = yield* makePushDeviceStore;
    const session = yield* auth.issueSession({ scopes: AuthStandardClientScopes });
    const otherSession = yield* auth.issueSession({ scopes: AuthStandardClientScopes });
    const crypto = yield* Crypto.Crypto;
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const requestContext = Context.make(Crypto.Crypto, crypto).pipe(
      Context.add(ServerSecretStore.ServerSecretStore, secrets),
      Context.add(Clock.Clock, clock),
    );
    const routes = HttpApiBuilder.layer(PushTestApi).pipe(
      Layer.provide(pushHttpApiLayer),
      Layer.provide(environmentAuthenticatedAuthLayer),
      Layer.provide(Layer.succeed(EnvironmentAuth.EnvironmentAuth, auth)),
      Layer.provide(
        Layer.succeed(SelfHostedPush, {
          register: (input) => store.register(input).pipe(Effect.as(true)),
          remove: store.remove,
          start: () => Effect.void,
        }),
      ),
      Layer.provideMerge(
        HttpPlatform.layer.pipe(
          Layer.provideMerge(NodeServices.layer),
          Layer.provideMerge(Etag.layerWeak),
        ),
      ),
      Layer.provide(NodeServices.layer),
    );
    const server = HttpRouter.toWebHandler(routes, { disableLogger: true });
    yield* Effect.acquireUseRelease(
      Effect.succeed(server),
      () =>
        Effect.gen(function* () {
          const registerRequest = (token?: string) =>
            new Request("http://127.0.0.1/api/push/devices", {
              method: "POST",
              headers: {
                "content-type": "application/json",
                ...(token ? { authorization: `Bearer ${token}` } : {}),
              },
              body: JSON.stringify({ deviceId: "phone-one", platform: "ios", token: "aabbcc" }),
            });
          const registered = yield* Effect.promise(() =>
            server.handler(registerRequest(session.token), requestContext),
          );
          expect(registered.status).toBe(200);
          expect(yield* Effect.promise(() => registered.json())).toEqual({ registered: true });
          expect(yield* store.active(nowIso)).toEqual([{ platform: "ios", token: "aabbcc" }]);

          const foreignRemoval = yield* Effect.promise(() =>
            server.handler(
              new Request("http://127.0.0.1/api/push/devices/phone-one", {
                method: "DELETE",
                headers: { authorization: `Bearer ${otherSession.token}` },
              }),
              requestContext,
            ),
          );
          expect(yield* Effect.promise(() => foreignRemoval.json())).toEqual({ removed: false });
          expect(yield* store.active(nowIso)).toEqual([{ platform: "ios", token: "aabbcc" }]);

          const removed = yield* Effect.promise(() =>
            server.handler(
              new Request("http://127.0.0.1/api/push/devices/phone-one", {
                method: "DELETE",
                headers: { authorization: `Bearer ${session.token}` },
              }),
              requestContext,
            ),
          );
          expect(removed.status).toBe(200);
          expect(yield* Effect.promise(() => removed.json())).toEqual({ removed: true });
          expect(yield* store.active(nowIso)).toEqual([]);

          const missingAuth = yield* Effect.promise(() =>
            server.handler(registerRequest(), requestContext),
          );
          expect(missingAuth.status).toBe(401);
          yield* auth.revokeSession(session.sessionId);
          const revokedAuth = yield* Effect.promise(() =>
            server.handler(registerRequest(session.token), requestContext),
          );
          expect(revokedAuth.status).toBe(401);
        }),
      () => Effect.promise(() => server.dispose()),
    );
  }).pipe(Effect.provide(Layer.mergeAll(dependencies, NodeServices.layer))),
);
