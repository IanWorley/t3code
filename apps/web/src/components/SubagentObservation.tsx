import {
  formatSubagentContextUsage,
  formatSubagentTokenCount,
  type SubagentUsage,
} from "@t3tools/client-runtime/state/subagentRuntime";
import type { TaskAgentObservation } from "@t3tools/contracts";

const ENTRY_LABELS: Record<TaskAgentObservation["entries"][number]["kind"], string> = {
  user: "Task",
  assistant: "Reply",
  reasoning: "Reasoning",
  tool: "Tool",
};

export function SubagentObservation({
  observation,
  usage,
}: {
  observation: TaskAgentObservation;
  usage: SubagentUsage | null;
}) {
  return (
    <div className="space-y-3 text-xs">
      <p className="font-mono text-muted-foreground">
        {formatSubagentContextUsage(observation.contextUsage)}
        {" · "}
        {usage?.outputTokens !== undefined
          ? `${formatSubagentTokenCount(usage.outputTokens)} output tokens`
          : "Output tokens unavailable"}
      </p>
      <p className="text-muted-foreground">
        Recent observed chat.{observation.truncated ? " Earlier text was omitted." : ""}
      </p>
      {observation.entries.length === 0 ? <p>No chat output received yet.</p> : null}
      <div className="max-h-80 space-y-3 overflow-auto">
        {observation.entries.map((entry) =>
          entry.kind === "reasoning" ? (
            <details key={entry.id}>
              <summary className="cursor-pointer text-muted-foreground">Reasoning</summary>
              <pre className="mt-1 whitespace-pre-wrap break-words font-mono">{entry.text}</pre>
            </details>
          ) : (
            <div key={entry.id}>
              <p className="mb-1 text-muted-foreground">{ENTRY_LABELS[entry.kind]}</p>
              <pre className="whitespace-pre-wrap break-words font-mono">{entry.text}</pre>
            </div>
          ),
        )}
      </div>
    </div>
  );
}
