import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { CliProxyAction, EnvironmentId, ServerSettings } from "@t3tools/contracts";
import * as Equal from "effect/Equal";
import { useRef, useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";

type ManagerSettings = ServerSettings["vibeProxy"]["manager"];

export function CliProxyManagerSettings({
  environmentId,
  manager,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly manager: ManagerSettings;
  readonly readOnly: boolean;
}) {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  if (config?.cliProxyManagement !== true) return null;
  return (
    <CliProxyManagerForm
      key={`${environmentId}:${JSON.stringify(manager)}`}
      environmentId={environmentId}
      manager={manager}
      readOnly={readOnly}
    />
  );
}

function CliProxyManagerForm({
  environmentId,
  manager,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly manager: ManagerSettings;
  readonly readOnly: boolean;
}) {
  const [managed, setManaged] = useState(manager.mode === "managed");
  const [binaryPath, setBinaryPath] = useState(
    manager.mode === "managed" ? manager.binaryPath : "",
  );
  const [configPath, setConfigPath] = useState(
    manager.mode === "managed" ? manager.configPath : "",
  );
  const [autoStart, setAutoStart] = useState(manager.mode === "managed" && manager.autoStart);
  const [pending, setPending] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const statusQuery = useEnvironmentQuery(
    serverEnvironment.cliProxyStatus({ environmentId, input: {} }),
  );
  const control = useAtomCommand(serverEnvironment.controlCliProxy, { reportFailure: false });
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const draft: ManagerSettings = managed
    ? { mode: "managed", binaryPath: binaryPath.trim(), configPath: configPath.trim(), autoStart }
    : { mode: "external" };
  const dirty = !Equal.equals(draft, manager);
  const status = statusQuery.data;
  const transitioning = status?.state === "starting" || status?.state === "stopping";
  const disabled = readOnly || pending !== null || transitioning || statusQuery.error !== null;
  const running = status?.state === "running";
  const canStop = running || status?.state === "failed";
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

  async function run(action: "save" | CliProxyAction) {
    if (pendingRef.current || disabled) return;
    pendingRef.current = true;
    setPending(
      action === "save"
        ? "Saving…"
        : `${action === "start" ? "Starting" : action === "stop" ? "Stopping" : "Restarting"}…`,
    );
    setError(null);
    try {
      const result =
        action === "save"
          ? await updateSettings({
              environmentId,
              input: { patch: { vibeProxy: { manager: draft } } },
            })
          : await control({ environmentId, input: { action } });
      if (result._tag === "Failure") {
        const failure = squashAtomCommandFailure(result);
        setError(failure instanceof Error ? failure.message : "Could not update the CLI proxy.");
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not update the CLI proxy.");
    } finally {
      pendingRef.current = false;
      setPending(null);
    }
  }

  return (
    <div className="mt-4 space-y-3 border-t border-border/70 pt-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-xs font-medium text-foreground">Let T3 manage the CLI proxy</div>
          <p className="mt-1 text-xs text-muted-foreground">
            {managed
              ? "Run CLIProxyAPI on this environment's server."
              : "Your external proxy remains responsible for its own process."}
          </p>
        </div>
        <Switch
          checked={managed}
          onCheckedChange={setManaged}
          disabled={disabled}
          aria-label="Let T3 manage the CLI proxy"
        />
      </div>
      {managed ? (
        <>
          <div className="grid gap-3 lg:grid-cols-2">
            <label className="block text-xs font-medium text-foreground">
              Executable path on server
              <Input
                className="mt-1.5"
                value={binaryPath}
                onChange={(event) => setBinaryPath(event.target.value)}
                disabled={disabled}
                placeholder="/path/to/cli-proxy-api"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label className="block text-xs font-medium text-foreground">
              Configuration file on server
              <Input
                className="mt-1.5"
                value={configPath}
                onChange={(event) => setConfigPath(event.target.value)}
                disabled={disabled}
                placeholder="/path/to/config.yaml"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
          </div>
          <p className="text-xs text-muted-foreground">
            Use an existing CLIProxyAPI configuration. Its listening address and client key must
            match the proxy settings above. T3 does not install the executable.
          </p>
          <label className="flex items-center justify-between gap-3 text-xs text-foreground">
            Start with this T3 server
            <Switch
              checked={autoStart}
              onCheckedChange={setAutoStart}
              disabled={disabled}
              aria-label="Start CLI proxy with T3 server"
            />
          </label>
        </>
      ) : null}
      {dirty ? (
        <div className="flex items-center gap-3">
          <Button
            size="sm"
            variant="outline"
            disabled={disabled || (managed && (!binaryPath.trim() || !configPath.trim()))}
            onClick={() => void run("save")}
          >
            Save proxy management
          </Button>
          <span className="text-xs text-muted-foreground">Save before starting or restarting.</span>
        </div>
      ) : null}
      {manager.mode === "managed" || canStop || transitioning ? (
        <div className="space-y-2">
          <p className="text-xs text-foreground" role="status">
            {pending ?? statusLabel}
          </p>
          <p className="text-xs text-muted-foreground">
            Process status is separate from provider connectivity shown below.
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={disabled || dirty || manager.mode !== "managed" || !status || running}
              onClick={() => void run("start")}
            >
              Start
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={disabled || dirty || !canStop}
              onClick={() => void run("stop")}
            >
              Stop
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={disabled || dirty || manager.mode !== "managed" || !canStop}
              onClick={() => void run("restart")}
            >
              Restart
            </Button>
          </div>
        </div>
      ) : null}
      {error || statusQuery.error || status?.state === "failed" ? (
        <p role="alert" className="text-xs text-destructive">
          {error ?? statusQuery.error ?? (status?.state === "failed" ? status.message : null)}
        </p>
      ) : null}
    </div>
  );
}
