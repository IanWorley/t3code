import type {
  ModelCapabilities,
  ProviderDriverKind,
  SelectProviderOptionDescriptor,
} from "@t3tools/contracts";

const CODEX_REASONING_OPTION: SelectProviderOptionDescriptor = {
  id: "reasoningEffort",
  label: "Reasoning",
  type: "select",
  options: [
    { id: "none", label: "None" },
    { id: "minimal", label: "Minimal" },
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium" },
    { id: "high", label: "High" },
    { id: "xhigh", label: "Extra High" },
  ],
};

const CLAUDE_REASONING_OPTION: SelectProviderOptionDescriptor = {
  id: "effort",
  label: "Reasoning",
  type: "select",
  options: [
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium" },
    { id: "high", label: "High" },
    { id: "max", label: "Max" },
  ],
};

/** Proxy model discovery lists IDs without the reasoning options accepted by each driver. */
export function withVibeProxyModelCapabilities(
  driver: ProviderDriverKind,
  capabilities: ModelCapabilities | null,
): ModelCapabilities | null {
  const reasoning =
    driver === "codex"
      ? CODEX_REASONING_OPTION
      : driver === "claudeAgent"
        ? CLAUDE_REASONING_OPTION
        : undefined;
  if (!reasoning) return capabilities;
  const descriptors = capabilities?.optionDescriptors ?? [];
  if (descriptors.some((descriptor) => descriptor.id === reasoning.id)) return capabilities;
  return { ...capabilities, optionDescriptors: [...descriptors, reasoning] };
}
