/** Reconcile closes removed/replaced scopes before creating replacements: at most one live instance per id. */
import type {
  ModelProxySettings,
  ProviderInstanceConfig,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export type ProviderInstanceEntry = ProviderInstanceConfig & {
  readonly modelProxy?: ModelProxySettings;
};
export type ProviderInstanceEntryMap = Readonly<Record<ProviderInstanceId, ProviderInstanceEntry>>;

export interface ProviderInstanceRegistryMutatorShape {
  readonly reconcile: (entries: ProviderInstanceEntryMap) => Effect.Effect<void>;
}

export class ProviderInstanceRegistryMutator extends Context.Service<
  ProviderInstanceRegistryMutator,
  ProviderInstanceRegistryMutatorShape
>()("t3/provider/ProviderInstanceRegistryMutator") {}
