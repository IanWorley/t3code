import {
  DEFAULT_MODEL_PROXY_URL,
  type EnvironmentId,
  type UnifiedSettings,
} from "@t3tools/contracts";
import { useGT } from "gt-react";
import { XIcon } from "lucide-react";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { SecretInput } from "./SecretInput";
import { useSearchableSetting } from "./settingsSearch";
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
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const keyConfigured = modelProxy.apiKey.length > 0;
  const controlClassName = cn(
    "flex w-full min-w-0 items-center gap-2 @min-[32rem]/settings-row:w-auto",
    readOnly && "opacity-50 select-none",
  );

  return (
    <SettingsSection {...searchableSetting("model-proxy")}>
      <SettingsRow
        title={gt("Proxy URL")}
        description={gt(
          "An OpenAI- and Anthropic-compatible proxy reachable from this environment. Turn it on for each Codex or Claude provider in its Environment settings.",
        )}
        control={
          <div inert={readOnly} aria-disabled={readOnly || undefined} className={controlClassName}>
            <DraftInput
              size="sm"
              className={INPUT_CLASS_NAME}
              aria-label={gt("Model proxy URL")}
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
        title={gt("API key")}
        description={gt(
          "The proxy's own client key, if it requires one. Not an OpenAI or Anthropic key.",
        )}
        control={
          <div inert={readOnly} aria-disabled={readOnly || undefined} className={controlClassName}>
            <SecretInput
              size="sm"
              className={INPUT_CLASS_NAME}
              aria-label={gt("Model proxy API key")}
              configured={keyConfigured}
              value=""
              placeholder={gt("Optional")}
              onCommit={(apiKey) => updateSettings({ modelProxy: { apiKey } })}
            />
            {keyConfigured ? (
              <Button
                type="button"
                size="icon-sm"
                variant="ghost-destructive"
                aria-label={gt("Clear model proxy API key")}
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
