import { type PiSettings, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";

import { applyPiAcpModelSelection, makePiAcpRuntime } from "../acp/PiAcpSupport.ts";
import { makeCoreAcpAdapter, type CoreAcpAdapterOptions } from "./CursorAdapter.ts";

const PI_PROVIDER = ProviderDriverKind.make("pi");

export type PiAdapterLiveOptions = CoreAcpAdapterOptions;

export function makePiAdapter(settings: PiSettings, options?: PiAdapterLiveOptions) {
  return makeCoreAcpAdapter(
    {
      provider: PI_PROVIDER,
      displayName: "Pi",
      defaultInstanceId: ProviderInstanceId.make("pi"),
      settings,
      supportsCursorExtensions: false,
      // Pi loads MCP servers from its own configuration. Current pi-acp
      // adapters cannot attach the HTTP server supplied by an ACP client.
      supportsMcpServers: false,
      // Pi's legacy ACP modes represent thinking levels, not plan/code modes.
      configureModes: false,
      makeRuntime: ({ settings: piSettings, ...input }) =>
        makePiAcpRuntime({ piSettings, ...input }),
      applyModelSelection: ({ runtime, model, selections, mapError }) =>
        applyPiAcpModelSelection({
          runtime,
          model,
          selections,
          mapError: ({ cause }) => mapError(cause),
        }),
      resolveModel: (model) => model?.trim() || "default",
    },
    options,
  );
}
