// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalFetch:off -- Native APNs HTTP/2 and FCM fetch live outside Effect services.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp2 from "node:http2";
import * as Schema from "effect/Schema";

const PUSH_REQUEST_TIMEOUT_MS = 10_000;
const FCM_TOKEN_TTL_MS = 50 * 60 * 1_000;
const APNS_TOKEN_TTL_MS = 50 * 60 * 1_000;
const ALERT_TTL_SECONDS = 120;
const ALERT_TITLE_MAX_LENGTH = 120;
const ALERT_BODY_MAX_LENGTH = 240;
const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";

const ServiceAccount = Schema.Struct({
  project_id: Schema.NonEmptyString,
  client_email: Schema.NonEmptyString,
  private_key: Schema.NonEmptyString,
});
const decodeServiceAccount = Schema.decodeUnknownSync(ServiceAccount);

interface ApnsCredentials {
  readonly key: NodeCrypto.KeyObject;
  readonly keyId: string;
  readonly teamId: string;
  readonly bundleId: string;
  readonly environment: "sandbox" | "production";
}

interface FcmCredentials {
  readonly projectId: string;
  readonly clientEmail: string;
  readonly key: NodeCrypto.KeyObject;
}

export type PushPlatform = "ios" | "android";
export interface PushAlert {
  readonly title: string;
  readonly body: string;
  readonly deepLink: string;
}

export interface PushDeliveryResult {
  readonly kind: "delivered" | "invalid-token" | "failed";
  readonly status: number;
  readonly reason?: string;
}

function configuredApnsCredentials(env: NodeJS.ProcessEnv): ApnsCredentials | null {
  const path = env.T3CODE_PUSH_APNS_KEY_FILE?.trim();
  const keyId = env.T3CODE_PUSH_APNS_KEY_ID?.trim();
  const teamId = env.T3CODE_PUSH_APNS_TEAM_ID?.trim();
  const bundleId = env.T3CODE_PUSH_APNS_BUNDLE_ID?.trim();
  if (![path, keyId, teamId, bundleId, env.T3CODE_PUSH_APNS_ENVIRONMENT].some(Boolean)) return null;
  if (!path || !keyId || !teamId || !bundleId) {
    throw new Error(
      "APNs push configuration requires a key file, key ID, team ID, bundle ID, and environment.",
    );
  }
  const environment = env.T3CODE_PUSH_APNS_ENVIRONMENT;
  if (environment !== "sandbox" && environment !== "production") {
    throw new Error("T3CODE_PUSH_APNS_ENVIRONMENT must be sandbox or production.");
  }
  let key: NodeCrypto.KeyObject;
  try {
    key = NodeCrypto.createPrivateKey(NodeFS.readFileSync(path));
  } catch {
    throw new Error("APNs push key file could not be read as a private key.");
  }
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new Error("APNs push key must be a P-256 EC private key.");
  }
  return {
    key,
    keyId,
    teamId,
    bundleId,
    environment,
  };
}

function configuredFcmCredentials(env: NodeJS.ProcessEnv): FcmCredentials | null {
  const path = env.T3CODE_PUSH_FCM_SERVICE_ACCOUNT_FILE?.trim();
  if (!path) return null;
  let account: typeof ServiceAccount.Type;
  let key: NodeCrypto.KeyObject;
  try {
    account = decodeServiceAccount(JSON.parse(NodeFS.readFileSync(path, "utf8")));
    key = NodeCrypto.createPrivateKey(account.private_key);
  } catch {
    throw new Error("FCM service-account file could not be read as valid credentials.");
  }
  if (key.asymmetricKeyType !== "rsa") {
    throw new Error("FCM service-account private key must be RSA.");
  }
  return {
    projectId: env.T3CODE_PUSH_FCM_PROJECT_ID?.trim() || account.project_id,
    clientEmail: account.client_email,
    key,
  };
}

function jwt(input: {
  readonly header: Readonly<Record<string, string>>;
  readonly payload: Readonly<Record<string, string | number>>;
  readonly key: NodeCrypto.KeyObject;
}): string {
  const header = Buffer.from(JSON.stringify(input.header)).toString("base64url");
  const payload = Buffer.from(JSON.stringify(input.payload)).toString("base64url");
  const signingInput = `${header}.${payload}`;
  const signature = NodeCrypto.sign("sha256", Buffer.from(signingInput), {
    key: input.key,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${signature.toString("base64url")}`;
}

function makeApnsSender(credentials: ApnsCredentials) {
  let providerToken: { value: string; expiresAt: number } | null = null;
  return async (token: string, alert: PushAlert): Promise<PushDeliveryResult> => {
    const host =
      credentials.environment === "sandbox"
        ? "https://api.sandbox.push.apple.com"
        : "https://api.push.apple.com";
    if (!providerToken || Date.now() >= providerToken.expiresAt) {
      const issuedAt = Math.floor(Date.now() / 1_000);
      providerToken = {
        value: jwt({
          header: { alg: "ES256", kid: credentials.keyId },
          payload: { iss: credentials.teamId, iat: issuedAt },
          key: credentials.key,
        }),
        expiresAt: Date.now() + APNS_TOKEN_TTL_MS,
      };
    }
    const client = NodeHttp2.connect(host);
    const authorization = providerToken.value;
    client.setTimeout(PUSH_REQUEST_TIMEOUT_MS, () => client.destroy(new Error("APNs timeout")));
    try {
      const body = JSON.stringify({
        aps: {
          alert: {
            title: alert.title.slice(0, ALERT_TITLE_MAX_LENGTH),
            body: alert.body.slice(0, ALERT_BODY_MAX_LENGTH),
          },
          sound: "default",
        },
        deepLink: alert.deepLink,
      });
      return await new Promise<PushDeliveryResult>((resolve, reject) => {
        const request = client.request({
          ":method": "POST",
          ":path": `/3/device/${encodeURIComponent(token)}`,
          authorization: `bearer ${authorization}`,
          "apns-topic": credentials.bundleId,
          "apns-push-type": "alert",
          "apns-priority": "10",
          "apns-expiration": String(Math.floor(Date.now() / 1_000) + ALERT_TTL_SECONDS),
          "content-type": "application/json",
        });
        let status = 0;
        let responseBody = "";
        request.setEncoding("utf8");
        request.setTimeout(PUSH_REQUEST_TIMEOUT_MS, () =>
          request.destroy(new Error("APNs timeout")),
        );
        request.on("response", (headers) => {
          status = Number(headers[":status"] ?? 0);
        });
        request.on("data", (chunk: string) => {
          responseBody += chunk;
        });
        request.on("end", () => {
          let reason: string | undefined;
          try {
            const parsed: unknown = JSON.parse(responseBody);
            if (
              typeof parsed === "object" &&
              parsed !== null &&
              "reason" in parsed &&
              typeof parsed.reason === "string"
            ) {
              reason = parsed.reason;
            }
          } catch {
            /* APNs success responses have no body. */
          }
          resolve({
            kind:
              status === 200
                ? "delivered"
                : ["BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered"].includes(
                      reason ?? "",
                    )
                  ? "invalid-token"
                  : "failed",
            status,
            ...(reason ? { reason } : {}),
          });
        });
        request.on("error", reject);
        client.on("error", reject);
        request.end(body);
      });
    } finally {
      client.destroy();
    }
  };
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(PUSH_REQUEST_TIMEOUT_MS) });
}

function makeFcmSender(credentials: FcmCredentials) {
  let cachedToken: { value: string; expiresAt: number } | null = null;
  let pendingAccessToken: Promise<string> | null = null;
  const requestAccessToken = async (): Promise<string> => {
    const now = Math.floor(Date.now() / 1_000);
    const assertion = jwt({
      header: { alg: "RS256", typ: "JWT" },
      payload: {
        iss: credentials.clientEmail,
        scope: FCM_SCOPE,
        aud: "https://oauth2.googleapis.com/token",
        iat: now,
        exp: now + 3_600,
      },
      key: credentials.key,
    });
    const response = await fetchWithTimeout("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
    });
    if (!response.ok) throw new Error(`FCM authorization failed (${response.status}).`);
    const value: unknown = await response.json();
    if (
      typeof value !== "object" ||
      value === null ||
      !("access_token" in value) ||
      typeof value.access_token !== "string"
    ) {
      throw new Error("FCM authorization returned no access token.");
    }
    cachedToken = { value: value.access_token, expiresAt: Date.now() + FCM_TOKEN_TTL_MS };
    return value.access_token;
  };
  const accessToken = (): Promise<string> => {
    if (cachedToken && Date.now() < cachedToken.expiresAt)
      return Promise.resolve(cachedToken.value);
    if (pendingAccessToken) return pendingAccessToken;
    pendingAccessToken = requestAccessToken().finally(() => {
      pendingAccessToken = null;
    });
    return pendingAccessToken;
  };
  return async (token: string, alert: PushAlert): Promise<PushDeliveryResult> => {
    const authorization = await accessToken();
    const response = await fetchWithTimeout(
      `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(credentials.projectId)}/messages:send`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${authorization}`, "content-type": "application/json" },
        body: JSON.stringify({
          message: {
            token,
            notification: {
              title: alert.title.slice(0, ALERT_TITLE_MAX_LENGTH),
              body: alert.body.slice(0, ALERT_BODY_MAX_LENGTH),
            },
            data: { deepLink: alert.deepLink },
            android: {
              ttl: `${ALERT_TTL_SECONDS}s`,
              priority: "HIGH",
              notification: { channel_id: "agent-alerts", sound: "default" },
            },
          },
        }),
      },
    );
    if (response.ok) return { kind: "delivered", status: response.status };
    const body: unknown = await response.json().catch(() => null);
    const error = typeof body === "object" && body !== null && "error" in body ? body.error : null;
    const details =
      typeof error === "object" && error !== null && "details" in error ? error.details : null;
    const invalid =
      Array.isArray(details) &&
      details.some(
        (detail: unknown) =>
          typeof detail === "object" &&
          detail !== null &&
          "errorCode" in detail &&
          detail.errorCode === "UNREGISTERED",
      );
    return { kind: invalid ? "invalid-token" : "failed", status: response.status };
  };
}

export function createPushTransport(env: NodeJS.ProcessEnv = process.env) {
  const apns = configuredApnsCredentials(env);
  const sendApns = apns ? makeApnsSender(apns) : null;
  const fcm = configuredFcmCredentials(env);
  const sendFcm = fcm ? makeFcmSender(fcm) : null;
  return {
    capabilities: { ios: apns !== null, android: fcm !== null },
    send: (platform: PushPlatform, token: string, alert: PushAlert) => {
      if (platform === "ios" && sendApns) return sendApns(token, alert);
      if (platform === "android" && sendFcm) return sendFcm(token, alert);
      throw new Error(`Push delivery is not configured for ${platform}.`);
    },
  };
}

export function configuredPushCapabilities(env: NodeJS.ProcessEnv = process.env) {
  return {
    ios: Boolean(
      env.T3CODE_PUSH_APNS_KEY_FILE &&
      env.T3CODE_PUSH_APNS_KEY_ID &&
      env.T3CODE_PUSH_APNS_TEAM_ID &&
      env.T3CODE_PUSH_APNS_BUNDLE_ID &&
      (env.T3CODE_PUSH_APNS_ENVIRONMENT === "sandbox" ||
        env.T3CODE_PUSH_APNS_ENVIRONMENT === "production"),
    ),
    android: Boolean(env.T3CODE_PUSH_FCM_SERVICE_ACCOUNT_FILE),
  };
}
