import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { describe, expect } from "vite-plus/test";

import { buildKiroSlashCommands, getKiroCommandOptions, setKiroEffort } from "./KiroAcpCommands.ts";

describe("KiroAcpCommands", () => {
  it("normalizes Kiro commands and excludes entries T3 cannot host", () => {
    expect(
      buildKiroSlashCommands([
        { name: " /HELP ", description: " Show help ", meta: { hint: " topic " } },
        { name: "/help", description: "Duplicate" },
        { name: "/model", description: "Managed by T3" },
        { name: "/quit", description: "Quit", meta: { local: true } },
        { name: "/stats", description: "Stats", meta: { hidden: true } },
        { name: "/skill:review", description: "Review changes" },
        { name: " ", description: "Ignored" },
      ]),
    ).toEqual([
      { name: "HELP", description: "Show help", input: { hint: "topic" } },
      { name: "skill:review", description: "Review changes" },
    ]);
  });

  it.effect("decodes effort options and rejects unsuccessful changes", () =>
    Effect.gen(function* () {
      const options = yield* getKiroCommandOptions(
        {
          request: () =>
            Effect.succeed({
              options: [{ value: "high", label: "High [active]" }],
              hasMore: false,
            }),
        },
        "kiro-session-1",
        "effort",
      );
      expect(options).toEqual([{ value: "high", label: "High [active]" }]);

      const result = yield* Effect.exit(
        setKiroEffort(
          {
            request: () =>
              Effect.succeed({ success: false, message: "Effort is unavailable for this model." }),
          },
          "kiro-session-1",
          "high",
        ),
      );
      expect(Exit.isFailure(result)).toBe(true);
    }),
  );
});
