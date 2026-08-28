import { TextGenerationError, type PiSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  applyPiAcpModelSelection,
  deletePiAcpSession,
  makePiAcpRuntime,
} from "../provider/acp/PiAcpSupport.ts";
import { makeCoreAcpTextGeneration } from "./CursorTextGeneration.ts";

export const makePiTextGeneration = Effect.fn("makePiTextGeneration")(function* (
  settings: PiSettings,
  environment?: NodeJS.ProcessEnv,
) {
  return yield* makeCoreAcpTextGeneration(
    {
      displayName: "Pi",
      settings,
      makeRuntime: ({ settings: piSettings, ...input }) =>
        makePiAcpRuntime({ piSettings, ...input }),
      cleanupSession: deletePiAcpSession,
      applyModelSelection: ({ runtime, modelSelection, operation }) =>
        applyPiAcpModelSelection({
          runtime,
          model: modelSelection.model,
          selections: modelSelection.options,
          mapError: ({ cause, configId }) =>
            new TextGenerationError({
              operation,
              detail: `Failed to set Pi ACP config option "${configId}" for text generation.`,
              cause,
            }),
        }),
    },
    environment,
  );
});
