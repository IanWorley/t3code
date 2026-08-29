import { describe, expect, it } from "vite-plus/test";

import { disablePiToolsForTextGeneration } from "./PiTextGeneration.ts";

describe("disablePiToolsForTextGeneration", () => {
  it("forces tool-free Pi sessions without mutating the source environment", () => {
    const environment = { PI_ACP_NO_TOOLS: "0", PI_CODING_AGENT_DIR: "/tmp/pi-home" };

    expect(disablePiToolsForTextGeneration(environment)).toEqual({
      PI_ACP_NO_TOOLS: "1",
      PI_CODING_AGENT_DIR: "/tmp/pi-home",
    });
    expect(environment.PI_ACP_NO_TOOLS).toBe("0");
  });
});
