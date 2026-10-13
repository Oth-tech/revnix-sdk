import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { RevnixClient } from "./client.js";
import { memoryStorage } from "./storage.js";
import type { IntegrityEvidence, RevnixDiagnostic } from "./types.js";

const CONFIG = { apiKey: "rvx_pk_test_abc", baseUrl: "https://demo.convex.site" };
const IOS_EVIDENCE: IntegrityEvidence = {
  platform: "ios",
  keyId: "key-1",
  attestation: "YXR0ZXN0",
};

interface RecordedCall {
  path: string;
  body?: Record<string, unknown>;
}

function stubFetch() {
  const calls: RecordedCall[] = [];
  const impl = jest.fn<typeof fetch>(async (input, init) => {
    calls.push({
      path: new URL(String(input)).pathname,
      body:
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined,
    });
    return new Response(JSON.stringify({ ok: true }), { status: 201 });
  });
  return { impl, calls };
}

function makeClient(
  fetchImpl: typeof fetch,
  extra: Partial<ConstructorParameters<typeof RevnixClient>[0]> = {},
) {
  return new RevnixClient({
    ...CONFIG,
    storage: memoryStorage(),
    customerId: "cust-integrity",
    reportInstalls: false,
    fetch: fetchImpl,
    ...extra,
  });
}

function freshInstallClient(
  fetchImpl: typeof fetch,
  extra: Partial<ConstructorParameters<typeof RevnixClient>[0]> = {},
) {
  return new RevnixClient({
    ...CONFIG,
    storage: { getItem: () => null, setItem: () => {} },
    fetch: fetchImpl,
    ...extra,
  });
}

async function settle() {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
}

const installsIn = (calls: RecordedCall[]) =>
  calls.filter((c) => c.path === "/v1/installs");

afterEach(() => {
  jest.useRealTimers();
});

describe("deviceIntegrity", () => {
  test("attaches evidence to the cold-start install report", async () => {
    const { impl, calls } = stubFetch();
    const deviceIntegrity = jest.fn(async () => IOS_EVIDENCE);
    freshInstallClient(impl, { deviceIntegrity });
    await settle();

    const posts = installsIn(calls);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body?.integrity).toEqual(IOS_EVIDENCE);
    expect(deviceIntegrity).toHaveBeenCalledWith(posts[0]?.body?.customerId);
  });

  test("attaches evidence to /v1/attribution", async () => {
    const { impl, calls } = stubFetch();
    const client = makeClient(impl, {
      deviceIntegrity: async () => ({ platform: "android", token: "tok" }),
    });
    await settle();

    client.setAttribution({ provider: "adjust", network: "meta" });
    await settle();

    const post = calls.find((c) => c.path === "/v1/attribution");
    expect(post?.body?.integrity).toEqual({ platform: "android", token: "tok" });
  });

  test("asks once per customer across install calls", async () => {
    const { impl, calls } = stubFetch();
    const deviceIntegrity = jest.fn(async () => IOS_EVIDENCE);
    const client = makeClient(impl, { deviceIntegrity });
    await settle();

    client.handleInstallReferrer("utm_source=a");
    await client.handleAttributionToken("asa-token");
    client.handleInstallReferrer("utm_source=b");
    await settle();

    const posts = installsIn(calls);
    expect(posts).toHaveLength(3);
    for (const post of posts) expect(post.body?.integrity).toEqual(IOS_EVIDENCE);
    expect(deviceIntegrity).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["rejects", async () => Promise.reject(new Error("attest failed"))],
    ["returns null", async () => null],
    ["returns malformed evidence", async () => ({ platform: "ios", keyId: "k" })],
  ])("sends without evidence when the hook %s", async (_, hook) => {
    const { impl, calls } = stubFetch();
    const diagnostics: RevnixDiagnostic[] = [];
    const client = makeClient(impl, {
      deviceIntegrity: hook as () => Promise<IntegrityEvidence | null>,
      onDiagnostic: (event) => diagnostics.push(event),
    });
    await settle();

    client.handleInstallReferrer("utm_source=a");
    await settle();

    const posts = installsIn(calls);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).not.toHaveProperty("integrity");
    expect(diagnostics.map((d) => d.op)).toContain("deviceIntegrity");
  });

  test("a hanging hook delays the request by at most the timeout", async () => {
    jest.useFakeTimers();
    const { impl, calls } = stubFetch();
    const diagnostics: RevnixDiagnostic[] = [];
    const client = makeClient(impl, {
      deviceIntegrity: () => new Promise(() => {}),
      onDiagnostic: (event) => diagnostics.push(event),
    });
    await jest.advanceTimersByTimeAsync(0);

    client.handleInstallReferrer("utm_source=a");
    await jest.advanceTimersByTimeAsync(9_000);
    expect(installsIn(calls)).toHaveLength(0);

    await jest.advanceTimersByTimeAsync(1_000);
    const posts = installsIn(calls);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).not.toHaveProperty("integrity");
    expect(diagnostics.map((d) => d.op)).toContain("deviceIntegrity");
  });

  test("no hook sends no integrity key", async () => {
    const { impl, calls } = stubFetch();
    freshInstallClient(impl);
    await settle();

    const posts = installsIn(calls);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).not.toHaveProperty("integrity");
  });
});
