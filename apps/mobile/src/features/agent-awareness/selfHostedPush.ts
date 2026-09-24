import * as Notifications from "expo-notifications";
import { AppState, Platform } from "react-native";
import type { EnvironmentId } from "@t3tools/contracts";

import type { SavedRemoteConnection } from "../../lib/connection";
import { isRelayManagedConnection } from "../../lib/connection";
import {
  loadAgentAwarenessDeviceId,
  loadOrCreateAgentAwarenessDeviceId,
} from "../../persistence/imperative";

export type SelfHostedPushStatus =
  | "disabled"
  | "unavailable"
  | "permission-needed"
  | "registering"
  | "registered"
  | "registration-failed"
  | "unregistration-failed";

export interface SelfHostedPushEnvironment {
  readonly connection: SavedRemoteConnection;
  readonly supported: boolean | undefined;
}

export interface SelfHostedPushSnapshot {
  readonly enabled: boolean;
  readonly environments: ReadonlyArray<SelfHostedPushEnvironment>;
}

interface RegisteredEnvironment {
  readonly connection: SavedRemoteConnection;
  readonly signature: string;
}

const PUSH_DEVICES_PATH = "/api/push/devices";
const PUSH_REQUEST_TIMEOUT_MS = 10_000;
const registered = new Map<EnvironmentId, RegisteredEnvironment>();
const registering = new Map<EnvironmentId, SavedRemoteConnection>();
const unregistered = new Map<EnvironmentId, string>();
const removing = new Set<EnvironmentId>();
const statusListeners = new Set<() => void>();
let status: SelfHostedPushStatus = "disabled";
let snapshot: SelfHostedPushSnapshot = { enabled: false, environments: [] };
let queue: Promise<void> = Promise.resolve();

function setStatus(next: SelfHostedPushStatus): void {
  if (status === next) return;
  status = next;
  for (const listener of statusListeners) listener();
}

export function getSelfHostedPushStatus(): SelfHostedPushStatus {
  return status;
}

export function hasSelfHostedPushRegistration(environmentId: EnvironmentId): boolean {
  return registered.has(environmentId);
}

export function subscribeSelfHostedPushStatus(listener: () => void): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

function isBearerConnection(connection: SavedRemoteConnection): boolean {
  return connection.bearerToken !== null && !isRelayManagedConnection(connection);
}

function endpoint(connection: SavedRemoteConnection, deviceId?: string): string {
  const base = connection.httpBaseUrl.replace(/\/$/, "");
  return `${base}${PUSH_DEVICES_PATH}${deviceId ? `/${encodeURIComponent(deviceId)}` : ""}`;
}

function registrationKey(connection: SavedRemoteConnection): string {
  return `${connection.environmentId}\n${connection.httpBaseUrl}\n${connection.bearerToken}`;
}

async function withPushRequestTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error("Push request timed out."));
    }, PUSH_REQUEST_TIMEOUT_MS);
  });
  try {
    return await Promise.race([operation(controller.signal), expired]);
  } finally {
    clearTimeout(timeout);
  }
}

async function sendRegistration(
  connection: SavedRemoteConnection,
  deviceId: string,
  token: string,
  platform: "ios" | "android",
): Promise<void> {
  await withPushRequestTimeout(async (signal) => {
    const response = await fetch(endpoint(connection), {
      method: "POST",
      headers: {
        authorization: `Bearer ${connection.bearerToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ platform, token, deviceId }),
      signal,
    });
    if (!response.ok) throw new Error(`Push registration failed (${response.status}).`);
    const body: unknown = await response.json();
    if (
      typeof body !== "object" ||
      body === null ||
      !("registered" in body) ||
      body.registered !== true
    ) {
      throw new Error("Push registration was not accepted by the server.");
    }
  });
}

async function sendUnregistration(
  connection: SavedRemoteConnection,
  deviceId: string,
): Promise<void> {
  await withPushRequestTimeout(async (signal) => {
    const response = await fetch(endpoint(connection, deviceId), {
      method: "DELETE",
      headers: { authorization: `Bearer ${connection.bearerToken}` },
      signal,
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(`Push unregistration failed (${response.status}).`);
    }
  });
}

async function reconcile(force: boolean): Promise<void> {
  const current = snapshot;
  const platform = Platform.OS;
  const desired = current.enabled
    ? current.environments.filter(
        ({ connection, supported }) =>
          supported === true &&
          isBearerConnection(connection) &&
          !removing.has(connection.environmentId),
      )
    : [];
  const permission =
    current.enabled && desired.length > 0 ? await Notifications.getPermissionsAsync() : null;
  const permissionRevoked = permission !== null && !permission.granted;

  const toRemove = new Map<string, SavedRemoteConnection>();
  for (const [id, previous] of registered) {
    const entry = current.environments.find(({ connection }) => connection.environmentId === id);
    if (
      !entry ||
      !current.enabled ||
      permissionRevoked ||
      removing.has(id) ||
      entry.supported === false ||
      !isBearerConnection(entry.connection) ||
      entry.connection.httpBaseUrl !== previous.connection.httpBaseUrl
    ) {
      toRemove.set(registrationKey(previous.connection), previous.connection);
    }
  }
  if (!current.enabled || permissionRevoked) {
    for (const { connection, supported } of current.environments) {
      if (
        isBearerConnection(connection) &&
        unregistered.get(connection.environmentId) !== registrationKey(connection) &&
        supported === true
      ) {
        toRemove.set(registrationKey(connection), connection);
      }
    }
  }

  let removalFailed = false;
  if (toRemove.size > 0) {
    const deviceId = await loadAgentAwarenessDeviceId();
    if (deviceId) {
      for (const connection of toRemove.values()) {
        try {
          await sendUnregistration(connection, deviceId);
          const previous = registered.get(connection.environmentId);
          if (previous && registrationKey(previous.connection) === registrationKey(connection)) {
            registered.delete(connection.environmentId);
          }
          unregistered.set(connection.environmentId, registrationKey(connection));
        } catch {
          removalFailed = true;
        }
      }
    }
  }

  if (!current.enabled) {
    setStatus(removalFailed ? "unregistration-failed" : "disabled");
    return;
  }
  if (platform !== "ios" && platform !== "android") {
    setStatus("unavailable");
    return;
  }
  if (desired.length === 0) {
    setStatus(removalFailed ? "unregistration-failed" : "unavailable");
    return;
  }

  if (permissionRevoked) {
    setStatus(removalFailed ? "unregistration-failed" : "permission-needed");
    return;
  }
  setStatus("registering");
  const pushToken = await Notifications.getDevicePushTokenAsync();
  if (pushToken.type !== platform || typeof pushToken.data !== "string" || !pushToken.data.trim()) {
    throw new Error("A native push token is unavailable for this device.");
  }
  const token = pushToken.data.trim();
  const deviceId = await loadOrCreateAgentAwarenessDeviceId();
  let failed = false;
  for (const { connection } of desired) {
    // A permission or settings change can arrive while a request is in flight.
    // The queued pass will remove any registration that is no longer wanted.
    const signature = `${connection.httpBaseUrl}\n${connection.bearerToken}\n${platform}\n${token}`;
    if (!force && registered.get(connection.environmentId)?.signature === signature) continue;
    registering.set(connection.environmentId, connection);
    try {
      await sendRegistration(connection, deviceId, token, platform);
      registered.set(connection.environmentId, { connection, signature });
      unregistered.delete(connection.environmentId);
    } catch {
      failed = true;
    } finally {
      registering.delete(connection.environmentId);
    }
  }
  setStatus(
    removalFailed ? "unregistration-failed" : failed ? "registration-failed" : "registered",
  );
}

function enqueue(force: boolean): void {
  queue = queue
    .then(() => reconcile(force))
    .catch(() => {
      setStatus(snapshot.enabled ? "registration-failed" : "unregistration-failed");
    });
}

export function updateSelfHostedPushSnapshot(next: SelfHostedPushSnapshot): void {
  snapshot = next;
  for (const environmentId of removing) {
    if (!next.environments.some(({ connection }) => connection.environmentId === environmentId)) {
      removing.delete(environmentId);
    }
  }
  enqueue(false);
}

export function refreshSelfHostedPushRegistration(): void {
  enqueue(true);
}

export function startSelfHostedPushListeners(): () => void {
  const tokenSubscription = Notifications.addPushTokenListener(() =>
    refreshSelfHostedPushRegistration(),
  );
  const appStateSubscription = AppState.addEventListener("change", (state) => {
    if (state === "active") refreshSelfHostedPushRegistration();
  });
  return () => {
    tokenSubscription.remove();
    appStateSubscription.remove();
  };
}

export async function unregisterSelfHostedPushConnection(
  environmentId: EnvironmentId,
  currentConnection: SavedRemoteConnection | undefined,
): Promise<void> {
  const connection =
    registering.get(environmentId) ??
    registered.get(environmentId)?.connection ??
    currentConnection;
  if (!connection || !isBearerConnection(connection)) return;
  removing.add(environmentId);
  const operation = queue.then(async () => {
    const deviceId = await loadAgentAwarenessDeviceId();
    if (!deviceId) return;
    if (unregistered.get(environmentId) === registrationKey(connection)) return;
    await sendUnregistration(connection, deviceId);
    registered.delete(environmentId);
    unregistered.set(environmentId, registrationKey(connection));
  });
  queue = operation.catch(() => {
    setStatus("unregistration-failed");
  });
  try {
    await operation;
  } catch (error) {
    cancelSelfHostedPushRemoval(environmentId);
    throw error;
  }
}

export function cancelSelfHostedPushRemoval(environmentId: EnvironmentId): void {
  removing.delete(environmentId);
  enqueue(false);
}

export async function waitForSelfHostedPushSync(): Promise<void> {
  await queue;
}
