import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import type { TaskAgentObservation } from "@t3tools/contracts";
import {
  formatSubagentContextUsage,
  formatSubagentTokenCount,
  type SubagentUsage,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { AppText as Text } from "../../components/AppText";

const AGENT_CHAT_ENTRY_GAP = 12;

function AgentObservationEntry({ entry }: { entry: TaskAgentObservation["entries"][number] }) {
  const [expanded, setExpanded] = useState(false);
  const reasoning = entry.kind === "reasoning";
  const label =
    entry.kind === "user"
      ? "Task"
      : entry.kind === "assistant"
        ? "Reply"
        : entry.kind === "tool"
          ? "Tool"
          : "Reasoning";
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
            {expanded ? "Hide reasoning" : "Show reasoning"}
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
  const [expanded, setExpanded] = useState(false);
  return (
    <View className="gap-2 pl-3">
      <Text className="text-2xs text-foreground-muted">
        {formatSubagentContextUsage(observation.contextUsage)} ·{" "}
        {usage?.outputTokens !== undefined
          ? `${formatSubagentTokenCount(usage.outputTokens)} output tokens`
          : "Output tokens unavailable"}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
      >
        <Text className="text-xs text-foreground-muted">
          {expanded ? "Hide observed chat" : "Show observed chat"}
        </Text>
      </Pressable>
      {expanded ? (
        <View className="gap-2">
          <Text className="text-2xs text-foreground-muted">
            Recent observed chat.{observation.truncated ? " Earlier text was omitted." : ""}
          </Text>
          {observation.entries.length === 0 ? (
            <Text className="text-xs text-foreground-muted">No chat output received yet.</Text>
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
