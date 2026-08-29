import { describe, expect, it } from "vite-plus/test";

import { buildKiroSlashCommands } from "./KiroAcpCommands.ts";

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
});
