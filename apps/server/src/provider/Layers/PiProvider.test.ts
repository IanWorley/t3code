import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { PiSettings } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";

import { buildInitialPiProviderSnapshot, buildPiModelsFromConfigOptions } from "./PiProvider.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);

describe("buildPiModelsFromConfigOptions", () => {
  it("maps Pi model and thought-level menus into T3 model capabilities", () => {
    const models = buildPiModelsFromConfigOptions([
      {
        id: "model",
        category: "model",
        name: "Model",
        type: "select",
        currentValue: "openai/gpt-5.6",
        options: [
          { value: "openai/gpt-5.6", name: "OpenAI GPT-5.6" },
          { value: "anthropic/claude-sonnet-4-6", name: "Anthropic Claude Sonnet 4.6" },
        ],
      },
      {
        id: "thought_level",
        category: "thought_level",
        name: "Thinking",
        type: "select",
        currentValue: "high",
        options: [
          { value: "medium", name: "Medium" },
          { value: "high", name: "High" },
        ],
      },
    ]);

    expect(models.map(({ slug, name, isDefault }) => ({ slug, name, isDefault }))).toEqual([
      { slug: "openai/gpt-5.6", name: "OpenAI GPT-5.6", isDefault: true },
      {
        slug: "anthropic/claude-sonnet-4-6",
        name: "Anthropic Claude Sonnet 4.6",
        isDefault: false,
      },
    ]);
    expect(models[0]?.capabilities?.optionDescriptors).toEqual([
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        currentValue: "high",
        options: [
          { id: "medium", label: "Medium" },
          { id: "high", label: "High", isDefault: true },
        ],
      },
    ]);
  });
});

describe("buildInitialPiProviderSnapshot", () => {
  it.effect("keeps Pi disabled until the user opts in", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialPiProviderSnapshot(decodePiSettings({}));
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.displayName).toBe("Pi");
    }),
  );
});
