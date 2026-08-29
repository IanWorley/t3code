import { describe, expect, it } from "vite-plus/test";
import * as EffectAcpErrors from "effect-acp/errors";
import { ProviderDriverKind } from "@t3tools/contracts";

import { acpPermissionOutcome, mapAcpToAdapterError } from "./AcpAdapterSupport.ts";

describe("AcpAdapterSupport", () => {
  const permissionOptions = [
    { optionId: "kiro-approve", name: "Approve", kind: "allow_once" as const },
    {
      optionId: "kiro-approve-session",
      name: "Approve for session",
      kind: "allow_always" as const,
    },
    { optionId: "kiro-reject", name: "Reject", kind: "reject_once" as const },
  ];

  it("returns the exact ACP option ID for each approval decision", () => {
    expect(acpPermissionOutcome("accept", permissionOptions)).toEqual({
      outcome: "selected",
      optionId: "kiro-approve",
    });
    expect(acpPermissionOutcome("acceptForSession", permissionOptions)).toEqual({
      outcome: "selected",
      optionId: "kiro-approve-session",
    });
    expect(acpPermissionOutcome("acceptAlways", permissionOptions)).toEqual({
      outcome: "selected",
      optionId: "kiro-approve-session",
    });
    expect(acpPermissionOutcome("decline", permissionOptions)).toEqual({
      outcome: "selected",
      optionId: "kiro-reject",
    });
  });

  it("cancels when the user cancels or the requested option is unavailable", () => {
    expect(acpPermissionOutcome("cancel", permissionOptions)).toEqual({ outcome: "cancelled" });
    expect(acpPermissionOutcome("acceptAlways", [permissionOptions[0]!])).toEqual({
      outcome: "cancelled",
    });
  });

  it("maps ACP request errors to provider adapter request errors", () => {
    const error = mapAcpToAdapterError(
      ProviderDriverKind.make("cursor"),
      "thread-1" as never,
      "session/prompt",
      new EffectAcpErrors.AcpRequestError({
        code: -32602,
        errorMessage: "Invalid params",
      }),
    );

    expect(error._tag).toBe("ProviderAdapterRequestError");
    expect(error.message).toContain("Invalid params");
  });
});
