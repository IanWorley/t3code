import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { EnvironmentId } from "@t3tools/contracts";

import type { SavedRemoteConnection } from "../../lib/connection";

const native = vi.hoisted(() => ({
  platform: "ios" as "ios" | "android",
  granted: true,
  token: "native-token-1",
  deviceId: "device-1",
}));

vi.mock("react-native", () => ({
  Platform: {
    get OS() {
      return native.platform;
    },
  },
  AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
}));
vi.mock("expo-notifications", () => ({
  getPermissionsAsync: vi.fn(async () => ({ granted: native.granted })),
  getDevicePushTokenAsync: vi.fn(async () => ({ type: native.platform, data: native.token })),
  addPushTokenListener: vi.fn(() => ({ remove: vi.fn() })),
}));
vi.mock("../../persistence/imperative", () => ({
  loadAgentAwarenessDeviceId: vi.fn(async () => native.deviceId),
  loadOrCreateAgentAwarenessDeviceId: vi.fn(async () => native.deviceId),
}));

function connection(id: string, bearerToken = "paired-token"): SavedRemoteConnection {
  return {
    environmentId: id as EnvironmentId,
    environmentLabel: id,
    pairingUrl: `https://${id}.example/pair`,
    displayUrl: `https://${id}.example`,
    httpBaseUrl: `https://${id}.example`,
    wsBaseUrl: `wss://${id}.example/ws`,
    bearerToken,
  };
}

function ok(body: unknown = { registered: true }): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as Response;
}

let push: typeof import("./selfHostedPush");
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.resetModules();
  native.platform = "ios";
  native.granted = true;
  native.token = "native-token-1";
  fetchMock = vi.fn(async () => ok());
  vi.stubGlobal("fetch", fetchMock);
  push = await import("./selfHostedPush");
});

describe("self-hosted push registration", () => {
  it("registers a paired bearer connection with its native token", async () => {
    push.updateSelfHostedPushSnapshot({
      enabled: true,
      environments: [{ connection: connection("env-a"), supported: true }],
    });
    await push.waitForSelfHostedPushSync();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://env-a.example/api/push/devices",
      expect.objectContaining({
        method: "POST",
        headers: {
          authorization: "Bearer paired-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ platform: "ios", token: "native-token-1", deviceId: "device-1" }),
      }),
    );
    expect(push.getSelfHostedPushStatus()).toBe("registered");
  });

  it("registers the FCM token for an Android build", async () => {
    native.platform = "android";
    native.token = "fcm-token";
    push.updateSelfHostedPushSnapshot({
      enabled: true,
      environments: [{ connection: connection("env-a"), supported: true }],
    });
    await push.waitForSelfHostedPushSync();

    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({ platform: "android", token: "fcm-token", deviceId: "device-1" }),
    );
  });

  it("removes server registration when the user turns notifications off", async () => {
    const environment = { connection: connection("env-a"), supported: true };
    push.updateSelfHostedPushSnapshot({ enabled: true, environments: [environment] });
    await push.waitForSelfHostedPushSync();

    push.updateSelfHostedPushSnapshot({ enabled: false, environments: [environment] });
    await push.waitForSelfHostedPushSync();

    expect(fetchMock).toHaveBeenLastCalledWith(
      "https://env-a.example/api/push/devices/device-1",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(push.getSelfHostedPushStatus()).toBe("disabled");

    push.updateSelfHostedPushSnapshot({ enabled: false, environments: [environment] });
    await push.waitForSelfHostedPushSync();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("removes registration when system permission is revoked", async () => {
    const environment = { connection: connection("env-a"), supported: true };
    push.updateSelfHostedPushSnapshot({ enabled: true, environments: [environment] });
    await push.waitForSelfHostedPushSync();

    native.granted = false;
    push.refreshSelfHostedPushRegistration();
    await push.waitForSelfHostedPushSync();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe("DELETE");
    expect(push.getSelfHostedPushStatus()).toBe("permission-needed");
  });

  it("does not treat a rejected registration as enabled", async () => {
    fetchMock.mockResolvedValueOnce(ok({ registered: false }));
    push.updateSelfHostedPushSnapshot({
      enabled: true,
      environments: [{ connection: connection("env-a"), supported: true }],
    });
    await push.waitForSelfHostedPushSync();

    expect(push.getSelfHostedPushStatus()).toBe("registration-failed");
  });

  it("reports a failed removal instead of claiming notifications are off", async () => {
    const environment = { connection: connection("env-a"), supported: true };
    push.updateSelfHostedPushSnapshot({ enabled: true, environments: [environment] });
    await push.waitForSelfHostedPushSync();
    fetchMock.mockRejectedValueOnce(new Error("offline"));

    push.updateSelfHostedPushSnapshot({ enabled: false, environments: [environment] });
    await push.waitForSelfHostedPushSync();

    expect(push.getSelfHostedPushStatus()).toBe("unregistration-failed");
    push.refreshSelfHostedPushRegistration();
    await push.waitForSelfHostedPushSync();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(push.getSelfHostedPushStatus()).toBe("disabled");
  });

  it("only contacts servers that support push on this platform", async () => {
    push.updateSelfHostedPushSnapshot({
      enabled: true,
      environments: [
        { connection: connection("env-ios"), supported: true },
        { connection: connection("env-android-only"), supported: false },
      ],
    });
    await push.waitForSelfHostedPushSync();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://env-ios.example/api/push/devices");
  });

  it("continues registering other servers when one server is unavailable", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    push.updateSelfHostedPushSnapshot({
      enabled: true,
      environments: [
        { connection: connection("env-offline"), supported: true },
        { connection: connection("env-online"), supported: true },
      ],
    });
    await push.waitForSelfHostedPushSync();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://env-online.example/api/push/devices");
    expect(push.getSelfHostedPushStatus()).toBe("registration-failed");
  });

  it("registers a rotated native token and skips relay-managed connections", async () => {
    push.updateSelfHostedPushSnapshot({
      enabled: true,
      environments: [
        { connection: connection("env-a"), supported: true },
        {
          connection: { ...connection("env-relay"), authenticationMethod: "dpop" },
          supported: true,
        },
      ],
    });
    await push.waitForSelfHostedPushSync();

    native.token = "native-token-2";
    push.refreshSelfHostedPushRegistration();
    await push.waitForSelfHostedPushSync();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(
      JSON.stringify({ platform: "ios", token: "native-token-2", deviceId: "device-1" }),
    );
  });

  it("waits for an in-flight registration before removing a disconnected environment", async () => {
    const environment = { connection: connection("env-a"), supported: true };
    const deferred: { resolve?: (response: Response) => void } = {};
    const postStarted = new Promise<void>((resolveStarted) => {
      fetchMock.mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            deferred.resolve = resolve;
            resolveStarted();
          }),
      );
    });
    push.updateSelfHostedPushSnapshot({ enabled: true, environments: [environment] });
    await postStarted;

    const removed = push.unregisterSelfHostedPushConnection(
      environment.connection.environmentId,
      undefined,
    );
    push.updateSelfHostedPushSnapshot({ enabled: true, environments: [environment] });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    deferred.resolve?.(ok());
    await removed;
    expect(fetchMock.mock.calls.map((call) => call[1]?.method)).toEqual(["POST", "DELETE"]);
    push.updateSelfHostedPushSnapshot({ enabled: true, environments: [] });
    await push.waitForSelfHostedPushSync();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map((call) => call[1]?.method)).toEqual(["POST", "DELETE"]);
    expect(push.hasSelfHostedPushRegistration(environment.connection.environmentId)).toBe(false);
  });
});
