import { describe, expect, it } from "vite-plus/test";

import { usesPiAcpTransport } from "./PiDriver.ts";

describe("Pi transport selection", () => {
  it("keeps a custom legacy wrapper on ACP", () => {
    expect(usesPiAcpTransport({ binaryPath: "/opt/team/pi-wrapper", transport: "acp" })).toBe(true);
    expect(usesPiAcpTransport({ binaryPath: "/opt/pi-acp/dist/index.js", transport: "acp" })).toBe(
      true,
    );
  });

  it("uses native RPC for an explicitly configured native wrapper", () => {
    expect(usesPiAcpTransport({ binaryPath: "/opt/team/pi-wrapper", transport: "rpc" })).toBe(
      false,
    );
  });

  it("recognizes existing pi-acp executable paths", () => {
    expect(usesPiAcpTransport({ binaryPath: "/opt/team/pi-acp", transport: "rpc" })).toBe(true);
    expect(usesPiAcpTransport({ binaryPath: "C:\\tools\\pi-acp.cmd", transport: "rpc" })).toBe(
      true,
    );
  });
});
