import { describe, expect, jest, test } from "@jest/globals";
import { RevnixClient } from "./client.js";
import { memoryStorage } from "./storage.js";

// REV-283: the Android install referrer, SDK side.
//
// The SDK's whole job here is to carry a string it cannot read for itself —
// the Play Install Referrer API is an Android service binding, and the host
// already has it. So what is worth testing is the refusals: an empty string,
// a disposed client, and an anonymous id that will not survive the launch.
// The last one matters because filing a campaign against an id nobody will
// see again fills the Channel analytics axis with one-launch phantoms.

const CONFIG = { apiKey: "rvx_pk_test_abc", baseUrl: "https://demo.convex.site" };

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
    customerId: "cust-referrer",
    reportInstalls: false,
    fetch: fetchImpl,
    ...extra,
  });
}

async function settle() {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
}

const installsIn = (calls: RecordedCall[]) =>
  calls.filter((c) => c.path === "/v1/installs");

describe("handleInstallReferrer", () => {
  test("posts the referrer verbatim to /v1/installs", async () => {
    const { impl, calls } = stubFetch();
    const client = makeClient(impl);
    await settle();
    calls.length = 0;

    client.handleInstallReferrer(
      "utm_source=instagram&utm_medium=cpc&utm_campaign=winter",
    );
    await settle();

    const posts = installsIn(calls);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toMatchObject({
      customerId: "cust-referrer",
      // Verbatim: the server owns the parsing, so an SDK that "helpfully"
      // normalized it would be a second place for the vocabulary to drift.
      installReferrer: "utm_source=instagram&utm_medium=cpc&utm_campaign=winter",
    });
  });

  test("an empty or blank referrer sends nothing", async () => {
    const { impl, calls } = stubFetch();
    const client = makeClient(impl);
    await settle();
    calls.length = 0;

    client.handleInstallReferrer("");
    client.handleInstallReferrer("   ");
    await settle();

    expect(installsIn(calls)).toHaveLength(0);
  });

  test("calling it twice is safe — the server absorbs the duplicate", async () => {
    // The host learns the referrer asynchronously and may report it again on
    // a later launch; nothing here should suppress that, because the server
    // is what decides (fill-only seeding).
    const { impl, calls } = stubFetch();
    const client = makeClient(impl);
    await settle();
    calls.length = 0;

    client.handleInstallReferrer("utm_source=instagram");
    client.handleInstallReferrer("utm_source=instagram");
    await settle();

    expect(installsIn(calls)).toHaveLength(2);
  });

  test("an over-long referrer is truncated to the server's bound", async () => {
    const { impl, calls } = stubFetch();
    const client = makeClient(impl);
    await settle();
    calls.length = 0;

    client.handleInstallReferrer("utm_source=" + "x".repeat(2000));
    await settle();

    expect(
      String(installsIn(calls)[0]?.body?.installReferrer),
    ).toHaveLength(1024);
  });

  test("a disposed client sends nothing", async () => {
    const { impl, calls } = stubFetch();
    const client = makeClient(impl);
    await settle();
    client.dispose();
    calls.length = 0;

    client.handleInstallReferrer("utm_source=instagram");
    await settle();

    expect(installsIn(calls)).toHaveLength(0);
  });

  test("an ephemeral anonymous id sends nothing", async () => {
    // No persistent storage ⇒ the id changes every launch. Filing a campaign
    // against it would invent a new customer per launch and bury the real
    // channels under phantoms.
    const { impl, calls } = stubFetch();
    // No adapter ⇒ resolveStorage falls back to memory and reports the id as
    // non-persistent; no customerId ⇒ the client generates an anonymous one.
    const client = makeClient(impl, {
      customerId: undefined,
      storage: undefined,
    });
    await settle();
    calls.length = 0;

    client.handleInstallReferrer("utm_source=instagram");
    await settle();

    expect(installsIn(calls)).toHaveLength(0);
  });
});
