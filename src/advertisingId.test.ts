import { describe, expect, jest, test } from "@jest/globals";
import { RevnixClient } from "./client.js";
import { memoryStorage } from "./storage.js";
import type { RevnixDiagnostic, RevnixStorage } from "./types.js";

const GAID = "38400000-8cf0-11bd-b23e-10b96e40000d";

function stubFetch() {
  const attributes: unknown[] = [];
  const impl = jest.fn<typeof fetch>(async (input, init) => {
    if (new URL(String(input)).pathname.endsWith("/attributes")) {
      attributes.push(JSON.parse(String(init?.body)).attributes);
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  return { impl, attributes };
}

async function settle() {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
}

async function launch(
  fetchImpl: typeof fetch,
  storage: RevnixStorage,
  id: string | null | Error,
  onDiagnostic?: (d: RevnixDiagnostic) => void,
) {
  new RevnixClient({
    apiKey: "rvx_pk_test_abc",
    baseUrl: "https://demo.convex.site",
    storage,
    customerId: "cust-gaid",
    reportInstalls: false,
    fetch: fetchImpl,
    advertisingId: async () => {
      if (id instanceof Error) throw id;
      return id;
    },
    onDiagnostic,
  });
  await settle();
}

describe("advertisingId", () => {
  test("stores gps_adid once per value and deletes it after an opt-out", async () => {
    const { impl, attributes } = stubFetch();
    const storage = memoryStorage();

    await launch(impl, storage, null);
    expect(attributes).toEqual([]);

    await launch(impl, storage, GAID);
    await launch(impl, storage, GAID);
    expect(attributes).toEqual([{ gps_adid: GAID }]);

    await launch(impl, storage, new Error("play services updating"));
    expect(attributes).toEqual([{ gps_adid: GAID }]);

    await launch(impl, storage, null);
    expect(attributes).toEqual([{ gps_adid: GAID }, { gps_adid: null }]);
  });

  test("a failed write is retried on the next launch", async () => {
    const storage = memoryStorage();
    const diagnostics: string[] = [];
    const failing = jest.fn<typeof fetch>(
      async () => new Response("{}", { status: 500 }),
    );
    await launch(failing, storage, GAID, (d) => diagnostics.push(d.op));
    expect(diagnostics).toContain("advertisingId");

    const { impl, attributes } = stubFetch();
    await launch(impl, storage, GAID);
    expect(attributes).toEqual([{ gps_adid: GAID }]);
  });
});
