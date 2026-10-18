import {
  DEFAULT_MODEL_PROXY_URL,
  type EnvironmentId,
  type UnifiedSettings,
} from "@t3tools/contracts";
import { XIcon } from "lucide-react";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { SecretInput } from "./SecretInput";
import { searchableSetting } from "./settingsSearch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const INPUT_CLASS_NAME = "min-w-0 flex-1 @min-[32rem]/settings-row:w-64";

export function ModelProxySettingsSection({
  environmentId,
  modelProxy,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly modelProxy: UnifiedSettings["modelProxy"];
  readonly readOnly: boolean;
}) {
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const keyConfigured = modelProxy.apiKey.length > 0;
  const controlClassName = cn(
    "flex w-full min-w-0 items-center gap-2 @min-[32rem]/settings-row:w-auto",
    readOnly && "opacity-50 select-none",
  );

  return (
    <SettingsSection {...searchableSetting("model-proxy")}>
      <SettingsRow
        title="Proxy URL"
        description="An OpenAI- and Anthropic-compatible proxy reachable from this environment. Turn it on for each Codex or Claude provider in its Environment settings."
        control={
          <div inert={readOnly} aria-disabled={readOnly || undefined} className={controlClassName}>
            <DraftInput
              size="sm"
              className={INPUT_CLASS_NAME}
              aria-label="Model proxy URL"
              value={modelProxy.url}
              placeholder={DEFAULT_MODEL_PROXY_URL}
              spellCheck={false}
              autoComplete="off"
              onCommit={(url) =>
                updateSettings({ modelProxy: { url: url.trim() || DEFAULT_MODEL_PROXY_URL } })
              }
            />
          </div>
        }
      />
      <SettingsRow
        title="API key"
        description="The proxy's own client key, if it requires one. Not an OpenAI or Anthropic key."
        control={
          <div inert={readOnly} aria-disabled={readOnly || undefined} className={controlClassName}>
            <SecretInput
              size="sm"
              className={INPUT_CLASS_NAME}
              aria-label="Model proxy API key"
              configured={keyConfigured}
              value=""
              placeholder="Optional"
              onCommit={(apiKey) => updateSettings({ modelProxy: { apiKey } })}
            />
            {keyConfigured ? (
              <Button
                type="button"
                size="icon-sm"
                variant="ghost-destructive"
                aria-label="Clear model proxy API key"
                onClick={() => updateSettings({ modelProxy: { apiKey: "" } })}
              >
                <XIcon className="size-3.5" />
              </Button>
            ) : null}
          </div>
        }
      />
    </SettingsSection>
  );
}
