import { describe, expect, jest, test } from "@jest/globals";
import { RevnixClient } from "./client.js";
import { memoryStorage } from "./storage.js";

const CONFIG = { apiKey: "rvx_pk_test_abc", baseUrl: "https://demo.convex.site" };

function stubFetch(deferredDeepLink?: { url: string; match: "exact" | "probabilistic" }) {
  const impl = jest.fn<typeof fetch>(async () =>
    new Response(JSON.stringify({ ok: true, deferredDeepLink }), { status: 201 })
  );
  return impl;
}

function makeClient(
  fetchImpl: typeof fetch,
  extra: Partial<ConstructorParameters<typeof RevnixClient>[0]> = {},
) {
  return new RevnixClient({
    ...CONFIG,
    storage: memoryStorage(),
    reportInstalls: false,
    fetch: fetchImpl,
    ...extra,
  });
}

async function settle() {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
}

describe("onDeferredDeepLink", () => {
  test("an automatic install report delivers it once", async () => {
    const onDeferredDeepLink = jest.fn();
    const fetchImpl = stubFetch({ url: "https://app.example/promo", match: "exact" });
    makeClient(fetchImpl, { reportInstalls: true, onDeferredDeepLink });
    await settle();

    expect(onDeferredDeepLink).toHaveBeenCalledTimes(1);
    expect(onDeferredDeepLink).toHaveBeenCalledWith(
      "https://app.example/promo",
      "exact",
    );
  });

  test("handleInstallReferrer delivers it too", async () => {
    const onDeferredDeepLink = jest.fn();
    const fetchImpl = stubFetch({ url: "https://app.example/promo", match: "probabilistic" });
    const client = makeClient(fetchImpl, { onDeferredDeepLink });
    await settle();

    client.handleInstallReferrer("utm_source=instagram");
    await settle();

    expect(onDeferredDeepLink).toHaveBeenCalledTimes(1);
    expect(onDeferredDeepLink).toHaveBeenCalledWith(
      "https://app.example/promo",
      "probabilistic",
    );
  });

  test("a second response in the same install does not fire again", async () => {
    const onDeferredDeepLink = jest.fn();
    const storage = memoryStorage();
    const fetchImpl = stubFetch({ url: "https://app.example/promo", match: "exact" });
    const client = makeClient(fetchImpl, {
      reportInstalls: true,
      onDeferredDeepLink,
      storage,
    });
    await settle();
    expect(onDeferredDeepLink).toHaveBeenCalledTimes(1);

    client.handleInstallReferrer("utm_source=instagram");
    await settle();

    expect(onDeferredDeepLink).toHaveBeenCalledTimes(1);
  });

  test("no deferredDeepLink in the response means no call", async () => {
    const onDeferredDeepLink = jest.fn();
    const fetchImpl = stubFetch(undefined);
    makeClient(fetchImpl, { reportInstalls: true, onDeferredDeepLink });
    await settle();

    expect(onDeferredDeepLink).not.toHaveBeenCalled();
  });

  test("a throwing callback is swallowed and reported via onDiagnostic", async () => {
    const onDiagnostic = jest.fn();
    const fetchImpl = stubFetch({ url: "https://app.example/promo", match: "exact" });
    makeClient(fetchImpl, {
      reportInstalls: true,
      onDeferredDeepLink: () => {
        throw new Error("host blew up");
      },
      onDiagnostic,
    });
    await settle();

    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ op: "onDeferredDeepLink" }),
    );
  });

  test("a throwing storage adapter still delivers once, and reports via onDiagnostic", async () => {
    const onDeferredDeepLink = jest.fn();
    const onDiagnostic = jest.fn();
    const storage = {
      getItem: () => {
        throw new Error("storage read failed");
      },
      setItem: () => {
        throw new Error("storage write failed");
      },
    };
    const fetchImpl = stubFetch({ url: "https://app.example/promo", match: "exact" });
    makeClient(fetchImpl, {
      reportInstalls: true,
      onDeferredDeepLink,
      onDiagnostic,
      storage,
    });
    await settle();

    expect(onDeferredDeepLink).toHaveBeenCalledTimes(1);
    expect(onDeferredDeepLink).toHaveBeenCalledWith(
      "https://app.example/promo",
      "exact",
    );
    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ op: "onDeferredDeepLink" }),
    );
  });

  test("no callback configured means no error and no delivery", async () => {
    const fetchImpl = stubFetch({ url: "https://app.example/promo", match: "exact" });
    expect(() => {
      makeClient(fetchImpl, { reportInstalls: true });
    }).not.toThrow();
    await settle();
  });

  test("two responses in flight in the same tick still fire once", async () => {
    const onDeferredDeepLink = jest.fn();
    const map = new Map<string, string>();
    const storage = {
      getItem: (key: string) =>
        new Promise<string | null>((resolve) =>
          setTimeout(() => resolve(map.get(key) ?? null), 5),
        ),
      setItem: (key: string, value: string) =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            map.set(key, value);
            resolve();
          }, 5),
        ),
    };
    const fetchImpl = stubFetch({ url: "https://app.example/promo", match: "exact" });
    const client = makeClient(fetchImpl, { onDeferredDeepLink, storage });
    await settle();

    client.handleInstallReferrer("utm_source=instagram");
    client.handleInstallReferrer("utm_source=instagram");
    await new Promise((r) => setTimeout(r, 50));

    expect(onDeferredDeepLink).toHaveBeenCalledTimes(1);
  });

  test("a missing url is ignored without touching the flag", async () => {
    const onDeferredDeepLink = jest.fn();
    const impl = jest.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ deferredDeepLink: { match: "exact" } }), { status: 201 }),
    );
    makeClient(impl, { reportInstalls: true, onDeferredDeepLink });
    await settle();

    expect(onDeferredDeepLink).not.toHaveBeenCalled();
  });

  test("an unknown match value is ignored", async () => {
    const onDeferredDeepLink = jest.fn();
    const impl = jest.fn<typeof fetch>(async () =>
      new Response(
        JSON.stringify({ deferredDeepLink: { url: "https://app.example/promo", match: "guess" } }),
        { status: 201 },
      ),
    );
    makeClient(impl, { reportInstalls: true, onDeferredDeepLink });
    await settle();

    expect(onDeferredDeepLink).not.toHaveBeenCalled();
  });

  test("a malformed response does not block a later valid one", async () => {
    const onDeferredDeepLink = jest.fn();
    const impl = jest
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ deferredDeepLink: { match: "exact" } }), { status: 201 }),
      )
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            deferredDeepLink: { url: "https://app.example/promo", match: "exact" },
          }),
          { status: 201 },
        ),
      );
    const client = makeClient(impl, { onDeferredDeepLink });
    await settle();

    client.handleInstallReferrer("utm_source=instagram");
    await settle();
    expect(onDeferredDeepLink).not.toHaveBeenCalled();

    client.handleInstallReferrer("utm_source=instagram");
    await settle();
    expect(onDeferredDeepLink).toHaveBeenCalledTimes(1);
  });
});
