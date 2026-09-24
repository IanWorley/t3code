import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE self_hosted_push_devices (
      session_id TEXT NOT NULL REFERENCES auth_sessions(session_id) ON DELETE CASCADE,
      device_id TEXT NOT NULL,
      platform TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
      token TEXT NOT NULL,
      PRIMARY KEY (session_id, device_id)
    )
  `;
  yield* sql`
    CREATE INDEX idx_self_hosted_push_devices_token
    ON self_hosted_push_devices(platform, token)
  `;
});
