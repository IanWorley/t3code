// @effect-diagnostics nodeBuiltinImport:off globalFetch:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeHttp2 from "node:http2";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createPushTransport } from "./transport.ts";

const redirect = vi.hoisted(() => ({ apnsOrigin: "", requestedOrigin: "" }));
vi.mock("node:http2", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:http2")>();
  return {
    ...actual,
    connect: (origin: string) => {
      redirect.requestedOrigin = origin;
      return actual.connect(redirect.apnsOrigin);
    },
  };
});

const alert = {
  title: "Finished: Example project",
  body: "Fix mobile notifications",
  deepLink: "/threads/environment-one/thread-one",
};
const files = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-push-transport-test-"));
const apnsKeys = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const fcmKeys = NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const apnsKeyPath = NodePath.join(files, "apns.p8");
const fcmKeyPath = NodePath.join(files, "fcm.json");
NodeFS.writeFileSync(apnsKeyPath, apnsKeys.privateKey.export({ type: "pkcs8", format: "pem" }), {
  mode: 0o600,
});
NodeFS.writeFileSync(
  fcmKeyPath,
  JSON.stringify({
    project_id: "test-project",
    client_email: "push@test-project.iam.gserviceaccount.com",
    private_key: fcmKeys.privateKey.export({ type: "pkcs8", format: "pem" }),
  }),
  { mode: 0o600 },
);

const apnsEnv = {
  T3CODE_PUSH_APNS_KEY_FILE: apnsKeyPath,
  T3CODE_PUSH_APNS_KEY_ID: "TESTKEY123",
  T3CODE_PUSH_APNS_TEAM_ID: "TESTTEAM12",
  T3CODE_PUSH_APNS_BUNDLE_ID: "com.example.mobile",
  T3CODE_PUSH_APNS_ENVIRONMENT: "sandbox",
};

async function listen(server: NodeHttp.Server | NodeHttp2.Http2Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server has no TCP address.");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: NodeHttp.Server | NodeHttp2.Http2Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

function verifyJwt(
  token: string,
  publicKey: NodeCrypto.KeyObject,
): { header: unknown; payload: unknown } {
  const [header, payload, signature] = token.split(".");
  if (!header || !payload || !signature) throw new Error("Push provider received a malformed JWT.");
  expect(
    NodeCrypto.verify(
      "sha256",
      Buffer.from(`${header}.${payload}`),
      {
        key: publicKey,
        dsaEncoding: "ieee-p1363",
      },
      Buffer.from(signature, "base64url"),
    ),
  ).toBe(true);
  return {
    header: JSON.parse(Buffer.from(header, "base64url").toString()),
    payload: JSON.parse(Buffer.from(payload, "base64url").toString()),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
afterAll(() => NodeFS.rmSync(files, { recursive: true, force: true }));

describe("self-hosted push wire delivery", () => {
  it("sends a signed APNs alert with a routable thread link over HTTP/2", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const received: Array<{ headers: NodeHttp2.IncomingHttpHeaders; body: string }> = [];
    const server = NodeHttp2.createServer();
    server.on("stream", (stream, headers) => {
      let body = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        body += chunk;
      });
      stream.on("end", () => {
        received.push({ headers, body });
        stream.respond({ ":status": 200 });
        stream.end();
      });
    });
    redirect.apnsOrigin = await listen(server);
    try {
      const sender = createPushTransport(apnsEnv);
      expect(await sender.send("ios", "aabbcc", alert)).toEqual({ kind: "delivered", status: 200 });
      expect(await sender.send("ios", "ddeeff", alert)).toEqual({ kind: "delivered", status: 200 });
      expect(redirect.requestedOrigin).toBe("https://api.sandbox.push.apple.com");
      const first = received[0];
      if (!first) throw new Error("APNs received no request.");
      expect(first.headers).toMatchObject({
        ":method": "POST",
        ":path": "/3/device/aabbcc",
        "apns-topic": "com.example.mobile",
        "apns-push-type": "alert",
        "apns-priority": "10",
        "apns-expiration": "1700000120",
      });
      expect(JSON.parse(first.body)).toEqual({
        aps: { alert: { title: alert.title, body: alert.body }, sound: "default" },
        deepLink: "/threads/environment-one/thread-one",
      });
      const authorization = first.headers.authorization;
      if (typeof authorization !== "string") throw new Error("APNs received no authorization.");
      const jwt = verifyJwt(authorization.slice("bearer ".length), apnsKeys.publicKey);
      expect(jwt.header).toEqual({ alg: "ES256", kid: "TESTKEY123" });
      expect(jwt.payload).toMatchObject({ iss: "TESTTEAM12", iat: expect.any(Number) });
      expect(received[1]?.headers.authorization).toBe(authorization);
    } finally {
      await close(server);
    }
  });

  it("distinguishes invalid APNs tokens from transient delivery failures", async () => {
    const responses = [
      { status: 410, reason: "Unregistered" },
      { status: 503, reason: "ServiceUnavailable" },
    ];
    const server = NodeHttp2.createServer();
    server.on("stream", (stream) => {
      stream.resume();
      stream.on("end", () => {
        const response = responses.shift();
        stream.respond({ ":status": response?.status ?? 500 });
        stream.end(JSON.stringify({ reason: response?.reason }));
      });
    });
    redirect.apnsOrigin = await listen(server);
    try {
      const sender = createPushTransport(apnsEnv);
      expect(await sender.send("ios", "aabbcc", alert)).toEqual({
        kind: "invalid-token",
        status: 410,
        reason: "Unregistered",
      });
      expect(await sender.send("ios", "aabbcc", alert)).toEqual({
        kind: "failed",
        status: 503,
        reason: "ServiceUnavailable",
      });
    } finally {
      await close(server);
    }
  });

  it("authorizes FCM with a signed assertion and preserves valid tokens on project errors", async () => {
    const received: Array<{ path: string; authorization: string | undefined; body: string }> = [];
    let sends = 0;
    const server = NodeHttp.createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        received.push({
          path: request.url ?? "",
          authorization: request.headers.authorization,
          body,
        });
        response.setHeader("content-type", "application/json");
        if (request.url === "/token") {
          response.end(JSON.stringify({ access_token: "test-oauth-token", expires_in: 3600 }));
        } else if (++sends === 1) {
          response.end(JSON.stringify({ name: "projects/test-project/messages/one" }));
        } else if (sends === 2) {
          response.writeHead(404);
          response.end(
            JSON.stringify({ error: { status: "NOT_FOUND", message: "Project not found" } }),
          );
        } else {
          response.writeHead(404);
          response.end(
            JSON.stringify(
              {
                error: {
                  details: [
                    {
                      "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError",
                      errorCode: "UNREGISTERED",
                    },
                  ],
                },
              },
              null,
              2,
            ),
          );
        }
      });
    });
    const origin = await listen(server);
    const nativeFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (url: string, init: RequestInit) =>
      nativeFetch(`${origin}${new URL(url).pathname}`, init),
    );
    try {
      const sender = createPushTransport({ T3CODE_PUSH_FCM_SERVICE_ACCOUNT_FILE: fcmKeyPath });
      expect(await sender.send("android", "fcm-phone-token", alert)).toEqual({
        kind: "delivered",
        status: 200,
      });
      expect(await sender.send("android", "fcm-phone-token", alert)).toEqual({
        kind: "failed",
        status: 404,
      });
      expect(await sender.send("android", "fcm-phone-token", alert)).toEqual({
        kind: "invalid-token",
        status: 404,
      });
      const auth = received[0];
      if (!auth) throw new Error("FCM received no OAuth request.");
      expect(auth.path).toBe("/token");
      const params = new URLSearchParams(auth.body);
      expect(params.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
      const jwt = verifyJwt(params.get("assertion") ?? "", fcmKeys.publicKey);
      expect(jwt.header).toEqual({ alg: "RS256", typ: "JWT" });
      expect(jwt.payload).toMatchObject({
        iss: "push@test-project.iam.gserviceaccount.com",
        aud: "https://oauth2.googleapis.com/token",
        scope: "https://www.googleapis.com/auth/firebase.messaging",
      });
      expect(received.filter((request) => request.path === "/token")).toHaveLength(1);
      expect(received[1]?.path).toBe("/v1/projects/test-project/messages:send");
      expect(received[1]?.authorization).toBe("Bearer test-oauth-token");
      expect(JSON.parse(received[1]?.body ?? "null")).toMatchObject({
        message: {
          token: "fcm-phone-token",
          notification: { title: alert.title, body: alert.body },
          data: { deepLink: "/threads/environment-one/thread-one" },
        },
      });
    } finally {
      await close(server);
    }
  });
});
