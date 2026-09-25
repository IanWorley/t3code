import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type CliProxyAction,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useRef, useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { environmentSession } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";

export function CliProxyControls({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const session = useAtomValue(environmentSession.sessionStateValueAtom(environmentId));
  const statusQuery = useEnvironmentQuery(
    serverEnvironment.cliProxyStatus({ environmentId, input: {} }),
  );
  const control = useAtomCommand(serverEnvironment.controlCliProxy, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const managed = config?.settings.vibeProxy.manager.mode === "managed";
  const canOperate =
    session?.authenticated === true &&
    (session.scopes === undefined || session.scopes.includes(AuthOrchestrationOperateScope));
  const status = statusQuery.data;
  const running = status?.state === "running";
  const canStop = running || status?.state === "failed";
  const disabled =
    !canOperate ||
    statusQuery.error !== null ||
    pending ||
    !status ||
    status.state === "starting" ||
    status.state === "stopping";
  const statusLabel =
    status?.state === "running"
      ? `Process running (PID ${status.pid})`
      : status?.state === "failed"
        ? "Process failed"
        : status?.state === "starting"
          ? "Starting process…"
          : status?.state === "stopping"
            ? "Stopping process…"
            : status?.state === "stopped"
              ? "Process stopped"
              : "Loading process status…";

  async function run(action: CliProxyAction) {
    if (disabled || pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await control({ environmentId, input: { action } });
      if (result._tag === "Failure") {
        const failure = squashAtomCommandFailure(result);
        setError(failure instanceof Error ? failure.message : "Could not control the CLI proxy.");
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not control the CLI proxy.");
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  return (
    <View className="gap-2 rounded-[14px] border border-input-border p-3">
      <Text className="text-sm font-t3-bold text-foreground">CLI proxy</Text>
      {managed || canStop || status?.state === "stopping" ? (
        <>
          <Text accessibilityLiveRegion="polite" className="text-xs text-foreground">
            {pending ? "Updating process…" : statusLabel}
          </Text>
          <Text className="text-xs text-foreground-muted">
            T3 manages this process on the server. A running process does not confirm provider
            connectivity.
          </Text>
          <View className="flex-row gap-2">
            {(["start", "stop", "restart"] as const).map((action) => (
              <Pressable
                key={action}
                accessibilityRole="button"
                accessibilityLabel={`${action === "start" ? "Start" : action === "stop" ? "Stop" : "Restart"} CLI proxy`}
                disabled={
                  disabled ||
                  (!managed && action !== "stop") ||
                  (action === "start" ? running : !canStop)
                }
                className="min-h-[44px] flex-1 items-center justify-center rounded-[14px] border border-input-border bg-input px-3 py-2 active:opacity-70 disabled:opacity-40"
                onPress={() => void run(action)}
              >
                <Text className="text-xs font-t3-bold text-foreground">
                  {action === "start" ? "Start" : action === "stop" ? "Stop" : "Restart"}
                </Text>
              </Pressable>
            ))}
          </View>
          {!canOperate ? (
            <Text className="text-xs text-foreground-muted">
              Process controls require permission to operate this environment.
            </Text>
          ) : null}
        </>
      ) : null}
      {!managed ? (
        <Text className="text-xs text-foreground-muted">
          To let T3 manage this proxy, open Settings → Providers for this environment in the web or
          desktop app.
        </Text>
      ) : null}
      {error || statusQuery.error || status?.state === "failed" ? (
        <Text accessibilityRole="alert" className="text-xs text-danger-foreground">
          {error ?? statusQuery.error ?? (status?.state === "failed" ? status.message : null)}
        </Text>
      ) : null}
    </View>
  );
}
