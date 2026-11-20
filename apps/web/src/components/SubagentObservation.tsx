import {
  formatSubagentContextUsage,
  formatSubagentTokenCount,
  type SubagentUsage,
} from "@t3tools/client-runtime/state/subagentRuntime";
import type { TaskAgentObservation } from "@t3tools/contracts";
import { msg, T, useGT, useMessages } from "gt-react";

const ENTRY_LABELS = {
  user: msg("Task", { $context: "subagent chat entry: the prompt given to the agent" }),
  assistant: msg("Reply", { $context: "subagent chat entry: the agent's response" }),
  reasoning: msg("Reasoning", { $context: "subagent chat entry: the agent's thinking" }),
  tool: msg("Tool", { $context: "subagent chat entry: a tool call" }),
} satisfies Record<TaskAgentObservation["entries"][number]["kind"], string>;

export function SubagentObservation({
  observation,
  usage,
}: {
  observation: TaskAgentObservation;
  usage: SubagentUsage | null;
}) {
  const gt = useGT();
  const m = useMessages();
  return (
    <div className="space-y-3 text-xs">
      <p className="font-mono text-muted-foreground">
        {formatSubagentContextUsage(observation.contextUsage, m)}
        {" · "}
        {usage?.outputTokens !== undefined
          ? gt("{tokens} output tokens", { tokens: formatSubagentTokenCount(usage.outputTokens) })
          : gt("Output tokens unavailable")}
      </p>
      <p className="text-muted-foreground">
        {observation.truncated
          ? gt("Recent observed chat. Earlier text was omitted.")
          : gt("Recent observed chat.")}
      </p>
      {observation.entries.length === 0 ? (
        <p>
          <T>No chat output received yet.</T>
        </p>
      ) : null}
      <div className="max-h-80 space-y-3 overflow-auto">
        {observation.entries.map((entry) =>
          entry.kind === "reasoning" ? (
            <details key={entry.id}>
              <summary className="cursor-pointer text-muted-foreground">
                {m(ENTRY_LABELS.reasoning)}
              </summary>
              <pre className="mt-1 whitespace-pre-wrap break-words font-mono">{entry.text}</pre>
            </details>
          ) : (
            <div key={entry.id}>
              <p className="mb-1 text-muted-foreground">{m(ENTRY_LABELS[entry.kind])}</p>
              <pre className="whitespace-pre-wrap break-words font-mono">{entry.text}</pre>
            </div>
          ),
        )}
      </div>
    </div>
  );
}
