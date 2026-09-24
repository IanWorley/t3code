import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useMemo } from "react";
import { Platform } from "react-native";

import { mobilePreferencesAtom } from "../../state/preferences";
import { environmentServerConfigsAtom } from "../../state/server";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { supportsAgentAwarenessPush } from "./capabilities";
import { startSelfHostedPushListeners, updateSelfHostedPushSnapshot } from "./selfHostedPush";

export function SelfHostedPushCoordinator() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const configs = useAtomValue(environmentServerConfigsAtom);
  const { savedConnectionsById } = useSavedRemoteConnections();
  const environments = useMemo(
    () =>
      Object.values(savedConnectionsById).map((connection) => ({
        connection,
        supported:
          supportsAgentAwarenessPush() && (Platform.OS === "ios" || Platform.OS === "android")
            ? configs.get(connection.environmentId)?.environment.capabilities.selfHostedPush?.[
                Platform.OS
              ]
            : false,
      })),
    [configs, savedConnectionsById],
  );

  useEffect(() => startSelfHostedPushListeners(), []);

  useEffect(() => {
    if (!AsyncResult.isSuccess(preferences)) return;
    updateSelfHostedPushSnapshot({
      enabled: preferences.value.selfHostedPushEnabled === true,
      environments,
    });
  }, [environments, preferences]);

  return null;
}
