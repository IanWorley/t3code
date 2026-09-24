import { AuthOrchestrationReadScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { requireEnvironmentScope, failEnvironmentInternal } from "../auth/http.ts";
import * as SelfHostedPush from "./SelfHostedPush.ts";

export const pushHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "push",
  Effect.fnUntraced(function* (handlers) {
    const push = yield* SelfHostedPush.SelfHostedPush;
    return handlers
      .handle(
        "registerDevice",
        Effect.fn("environment.push.registerDevice")(function* (args) {
          const session = yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const registered = yield* push
            .register({ sessionId: session.sessionId, ...args.payload })
            .pipe(Effect.catch((error) => failEnvironmentInternal("internal_error", error)));
          return { registered };
        }),
      )
      .handle(
        "removeDevice",
        Effect.fn("environment.push.removeDevice")(function* (args) {
          const session = yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const removed = yield* push
            .remove({
              sessionId: session.sessionId,
              deviceId: args.params.deviceId,
            })
            .pipe(Effect.catch((error) => failEnvironmentInternal("internal_error", error)));
          return { removed };
        }),
      );
  }),
);
