import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import type { TaskAgentObservation } from "@t3tools/contracts";
import {
  formatSubagentContextUsage,
  formatSubagentTokenCount,
  type SubagentUsage,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { msg, useGT, useMessages } from "gt-react-native";
import { AppText as Text } from "../../components/ui/AppText";

const AGENT_CHAT_ENTRY_GAP = 12;

const ENTRY_LABELS = {
  user: msg("Task", { $context: "subagent chat entry: the prompt given to the agent" }),
  assistant: msg("Reply", { $context: "subagent chat entry: the agent's response" }),
  reasoning: msg("Reasoning", { $context: "subagent chat entry: the agent's thinking" }),
  tool: msg("Tool", { $context: "subagent chat entry: a tool call" }),
} satisfies Record<TaskAgentObservation["entries"][number]["kind"], string>;

function AgentObservationEntry({ entry }: { entry: TaskAgentObservation["entries"][number] }) {
  const gt = useGT();
  const m = useMessages();
  const [expanded, setExpanded] = useState(false);
  const reasoning = entry.kind === "reasoning";
  const label = m(ENTRY_LABELS[entry.kind]);
  return (
    <View className="gap-1">
      {reasoning ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          onPress={(event) => {
            event.stopPropagation();
            setExpanded((value) => !value);
          }}
        >
          <Text className="text-xs text-foreground-muted">
            {expanded ? gt("Hide reasoning") : gt("Show reasoning")}
          </Text>
        </Pressable>
      ) : (
        <Text className="text-xs text-foreground-muted">{label}</Text>
      )}
      {!reasoning || expanded ? (
        <Text selectable className="font-mono text-2xs leading-normal text-foreground-muted">
          {entry.text}
        </Text>
      ) : null}
    </View>
  );
}

export function AgentObservationDetail({
  observation,
  usage,
}: {
  observation: TaskAgentObservation;
  usage: SubagentUsage | null | undefined;
}) {
  const gt = useGT();
  const m = useMessages();
  const [expanded, setExpanded] = useState(false);
  return (
    <View className="gap-2 pl-3">
      <Text className="text-2xs text-foreground-muted">
        {formatSubagentContextUsage(observation.contextUsage, m)} ·{" "}
        {usage?.outputTokens !== undefined
          ? gt("{tokens} output tokens", { tokens: formatSubagentTokenCount(usage.outputTokens) })
          : gt("Output tokens unavailable")}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
      >
        <Text className="text-xs text-foreground-muted">
          {expanded ? gt("Hide observed chat") : gt("Show observed chat")}
        </Text>
      </Pressable>
      {expanded ? (
        <View className="gap-2">
          <Text className="text-2xs text-foreground-muted">
            {observation.truncated
              ? gt("Recent observed chat. Earlier text was omitted.")
              : gt("Recent observed chat.")}
          </Text>
          {observation.entries.length === 0 ? (
            <Text className="text-xs text-foreground-muted">
              {gt("No chat output received yet.")}
            </Text>
          ) : null}
          <ScrollView
            nestedScrollEnabled
            className="max-h-80"
            contentContainerStyle={{ gap: AGENT_CHAT_ENTRY_GAP }}
          >
            {observation.entries.map((entry) => (
              <AgentObservationEntry key={entry.id} entry={entry} />
            ))}
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}
