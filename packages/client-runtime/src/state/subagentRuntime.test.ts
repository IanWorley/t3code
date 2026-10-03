import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import { projectedSubagentsToRuntime, formatSubagentContextUsage } from "./subagentRuntime.ts";

describe("projected subagent observations", () => {
  it("retains completed child chat and context independently of processed-token usage", () => {
    const now = DateTime.makeUnsafe("2026-09-30T00:00:00Z");
    const observation = {
      entries: [
        { id: "reply", kind: "assistant" as const, text: "Full child reply\nwith whitespace." },
      ],
      truncated: false,
      contextUsage: { usedTokens: 4000, capacityTokens: 200000 },
    };
    const agents = projectedSubagentsToRuntime([
      {
        id: "kiro-child",
        title: "Review",
        prompt: "Review changes",
        model: "auto",
        status: "completed",
        result: "Done",
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        observation,
      },
    ]);
    expect(agents[0]).toMatchObject({
      status: "completed",
      result: "Done",
      usage: null,
      observation,
    });
    expect(formatSubagentContextUsage(agents[0]?.observation?.contextUsage ?? null)).toBe(
      "Context 4.0k / 200k tokens",
    );
  });

  it("renders providers without observations with a null observation", () => {
    const now = DateTime.makeUnsafe("2026-09-30T00:00:00Z");
    expect(
      projectedSubagentsToRuntime([
        {
          id: "child",
          title: "Review",
          prompt: "Review changes",
          model: null,
          status: "running",
          result: null,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
        },
      ])[0]?.observation,
    ).toBeNull();
  });
});
