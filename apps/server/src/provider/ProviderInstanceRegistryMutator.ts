/**
 * Closes the per-instance `Scope` of every removed or replaced entry (tearing
 * down adapter processes, refresh fibres, temp files) BEFORE creating the
 * replacement — `reconcile` guarantees "at most one live instance per id" at
 * all times.
 */
import type { ProviderDriverKind, ProviderInstanceConfigMap } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface ProviderInstanceRegistryMutatorShape {
  /**
   * Bring the live registry in line with the supplied config map.
   * `forceRebuildDrivers` rebuilds unchanged instances of those drivers, for
   * settings that live outside their instance config.
   */
  readonly reconcile: (
    configMap: ProviderInstanceConfigMap,
    options?: {
      readonly forceRebuildDrivers?: ReadonlySet<ProviderDriverKind>;
    },
  ) => Effect.Effect<void>;
}

export class ProviderInstanceRegistryMutator extends Context.Service<
  ProviderInstanceRegistryMutator,
  ProviderInstanceRegistryMutatorShape
>()("t3/provider/ProviderInstanceRegistryMutator") {}
