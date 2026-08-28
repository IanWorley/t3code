import { KiroSettings } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect } from "vite-plus/test";

import { buildInitialKiroProviderSnapshot, parseKiroAuth } from "./KiroProvider.ts";

const decodeKiroSettings = Schema.decodeSync(KiroSettings);

describe("KiroProvider", () => {
  it("parses authenticated and unauthenticated CLI status", () => {
    expect(
      parseKiroAuth({
        code: 0,
        stdout: "Logged in with GitHub\nEmail: developer@example.com\n",
        stderr: "",
      }),
    ).toEqual({ status: "authenticated", email: "developer@example.com" });
    expect(parseKiroAuth({ code: 1, stdout: "", stderr: "Not logged in" })).toEqual({
      status: "unauthenticated",
    });
  });

  it.effect("builds an opt-in disabled snapshot with the Auto fallback model", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialKiroProviderSnapshot(decodeKiroSettings({}));

      expect(snapshot).toMatchObject({
        displayName: "Kiro",
        enabled: false,
        status: "disabled",
        models: [{ slug: "auto", name: "Auto", isCustom: false }],
      });
    }),
  );
});
