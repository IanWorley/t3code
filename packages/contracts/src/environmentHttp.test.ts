import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  EnvironmentAuthInvalidError,
  EnvironmentInternalError,
  EnvironmentOperationForbiddenError,
  EnvironmentPushRegisterDeviceRequest,
  PUSH_DEVICE_ID_MAX_LENGTH,
  EnvironmentRequestInvalidError,
  EnvironmentResourceNotFoundError,
  EnvironmentScopeRequiredError,
} from "./environmentHttp.ts";

const traceId = "trace-1";

describe("environment HTTP errors", () => {
  // A client squashes the cause and shows `message`; an empty one becomes a generic
  // "The environment request failed." that names nothing the reader can act on.
  it("each carries a message that names its reason", () => {
    const errors = [
      new EnvironmentRequestInvalidError({
        code: "invalid_request",
        reason: "invalid_command",
        traceId,
      }),
      new EnvironmentAuthInvalidError({
        code: "auth_invalid",
        reason: "missing_credential",
        traceId,
      }),
      new EnvironmentScopeRequiredError({
        code: "insufficient_scope",
        requiredScope: "orchestration:read",
        traceId,
      }),
      new EnvironmentOperationForbiddenError({
        code: "operation_forbidden",
        reason: "current_session_revoke_not_allowed",
        traceId,
      }),
      new EnvironmentResourceNotFoundError({
        code: "not_found",
        reason: "thread_not_found",
        traceId,
      }),
      new EnvironmentInternalError({
        code: "internal_error",
        reason: "orchestration_snapshot_failed",
        traceId,
      }),
    ] as const;
    const details = [
      "invalid_command",
      "missing_credential",
      "orchestration:read",
      "current_session_revoke_not_allowed",
      "thread_not_found",
      "orchestration_snapshot_failed",
    ];
    errors.forEach((error, index) => {
      expect(error.message).toContain(details[index]);
    });
  });
});

describe("push device registration request", () => {
  const isRequest = Schema.is(EnvironmentPushRegisterDeviceRequest);

  it("accepts platform tokens and rejects empty or oversized device identities", () => {
    const request = { deviceId: "phone-1", platform: "ios", token: "aabb0011" };
    expect(isRequest(request)).toBe(true);
    expect(isRequest({ ...request, token: "apns-token" })).toBe(false);
    expect(isRequest({ ...request, deviceId: "" })).toBe(false);
    expect(isRequest({ ...request, deviceId: "x".repeat(PUSH_DEVICE_ID_MAX_LENGTH + 1) })).toBe(
      false,
    );
    expect(isRequest({ ...request, token: "" })).toBe(false);
  });
});
