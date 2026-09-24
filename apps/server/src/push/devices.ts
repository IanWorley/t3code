import type { AuthSessionId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { PushPlatform } from "./transport.ts";

export interface PushDevice {
  readonly platform: PushPlatform;
  readonly token: string;
}

export const makePushDeviceStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return {
    register: Effect.fn("PushDeviceStore.register")(function* (input: {
      readonly sessionId: AuthSessionId;
      readonly deviceId: string;
      readonly platform: PushPlatform;
      readonly token: string;
    }) {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`
            DELETE FROM self_hosted_push_devices
            WHERE platform = ${input.platform} AND token = ${input.token}
              AND (session_id != ${input.sessionId} OR device_id != ${input.deviceId})
          `;
          yield* sql`
            INSERT INTO self_hosted_push_devices (session_id, device_id, platform, token)
            VALUES (${input.sessionId}, ${input.deviceId}, ${input.platform}, ${input.token})
            ON CONFLICT(session_id, device_id) DO UPDATE SET
              platform = excluded.platform,
              token = excluded.token
          `;
        }),
      );
    }),
    remove: Effect.fn("PushDeviceStore.remove")(function* (input: {
      readonly sessionId: AuthSessionId;
      readonly deviceId: string;
    }) {
      const rows = yield* sql`
        DELETE FROM self_hosted_push_devices
        WHERE session_id = ${input.sessionId} AND device_id = ${input.deviceId}
        RETURNING device_id
      `;
      return rows.length > 0;
    }),
    active: Effect.fn("PushDeviceStore.active")(function* (nowIso: string) {
      return yield* sql<PushDevice>`
        SELECT DISTINCT devices.platform, devices.token
        FROM self_hosted_push_devices AS devices
        JOIN auth_sessions AS sessions ON sessions.session_id = devices.session_id
        WHERE sessions.revoked_at IS NULL AND sessions.expires_at > ${nowIso}
      `;
    }),
    invalidate: Effect.fn("PushDeviceStore.invalidate")(function* (device: PushDevice) {
      yield* sql`
        DELETE FROM self_hosted_push_devices
        WHERE platform = ${device.platform} AND token = ${device.token}
      `;
    }),
  };
});
