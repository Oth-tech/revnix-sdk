import { afterEach, describe, expect, test } from "@jest/globals";
import {
  detectLocale,
  linkLabels,
  localeChain,
  localizeBlockDoc,
  normalizeLocale,
  setLocale,
} from "./locale.js";
import type { PaywallBlockDoc } from "./types.js";

// REV-271. The dashboard writes the table; this SDK reads it. These tests are
// the parity contract — the same cases run in revnix-app's locale.test.ts, so
// a paywall translated in the builder resolves identically on the device.

const doc = (over: Partial<PaywallBlockDoc> = {}): PaywallBlockDoc => ({
  version: 1,
  background: "#111111",
  textColor: "#ffffff",
  accent: "#6478ff",
  accentInk: "#ffffff",
  blocks: [
    { id: "hed", type: "text", text: "Unlock Pro", style: { fontSize: 28 } },
    {
      id: "feats",
      type: "list",
      items: [{ title: "Offline mode", description: "Take it anywhere" }, { title: "No ads" }],
    },
    {
      id: "wrap",
      type: "card",
      layout: "column",
      children: [
        { id: "plans", type: "products", priceTpl: "{price}/mo", titleTpl: "{title}" },
        { id: "cta", type: "button", label: "Continue" },
      ],
    },
  ],
  ...over,
});


/** Indexed reads are `T | undefined` under this package's strictness; the
 *  fixtures above guarantee the block exists, so assert rather than branch. */
function at(blocks: PaywallBlockDoc["blocks"], index: number) {
  const block = blocks[index];
  if (block === undefined) throw new Error(`no block at ${index}`);
  return block;
}

const spanish = doc({
  defaultLocale: "en",
  locales: {
    es: {
      "hed.text": "Desbloquea Pro",
      "feats.items.0.title": "Modo sin conexión",
      "plans.priceTpl": "{price}/mes",
      "cta.label": "Continuar",
    },
  },
});

test("locale tags normalize to one canonical form", () => {
  expect(normalizeLocale("es_mx")).toBe("es-MX");
  expect(normalizeLocale("zh-hans-cn")).toBe("zh-Hans-CN");
  expect(normalizeLocale("english")).toBeUndefined();
});

test("a regional device locale falls back to its language, not to English", () => {
  expect(localeChain(["es", "fr"], "es-MX", "en")).toEqual(["es"]);
  expect(localeChain(["es-MX", "es-AR"], "es", undefined)).toEqual(["es-AR"]);
});

describe("applying a language", () => {
  test("swaps strings at every depth", () => {
    const out = localizeBlockDoc(spanish, "es-MX");
    expect(at(out.blocks, 0)).toMatchObject({ text: "Desbloquea Pro" });
    const card = at(out.blocks, 2);
    expect(card.type === "card" && at(card.children, 1)).toMatchObject({ label: "Continuar" });
  });

  test("an untranslated or empty string keeps the authored copy", () => {
    // A shipped app cannot be patched: a blank CTA would be a dead paywall.
    const out = localizeBlockDoc(
      doc({ locales: { es: { "cta.label": "" } } }),
      "es",
    );
    const card = at(out.blocks, 2);
    expect(card.type === "card" && at(card.children, 1)).toMatchObject({ label: "Continue" });
    const list = at(localizeBlockDoc(spanish, "es").blocks, 1);
    expect(list.type === "list" && list.items[1]?.title).toBe("No ads");
  });

  test("copy tags survive so {price} still resolves after translation", () => {
    const card = at(localizeBlockDoc(spanish, "es").blocks, 2);
    expect(card.type === "card" && at(card.children, 0)).toMatchObject({
      priceTpl: "{price}/mes",
    });
  });

  test("only words change", () => {
    const out = localizeBlockDoc(spanish, "es");
    expect(out.accent).toBe(spanish.accent);
    expect(at(out.blocks, 0).id).toBe("hed");
    expect(at(out.blocks, 0).style).toEqual({ fontSize: 28 });
  });

  test("an unmatched locale and an untranslated paywall both render as authored", () => {
    expect(localizeBlockDoc(spanish, "ja")).toBe(spanish);
    const plain = doc();
    expect(localizeBlockDoc(plain, "es")).toBe(plain);
  });

  test("sets defaultLocale to the resolved language", () => {
    const out = localizeBlockDoc(doc({ locales: { es: {} } }), "es-MX");
    expect(out.defaultLocale).toBe("es");
  });
});

describe("linkLabels", () => {
  test("resolves a language and its regional variants", () => {
    expect(linkLabels("ur")).toEqual({
      restore: "بحال کریں",
      terms: "شرائط",
      privacy: "رازداری",
    });
    expect(linkLabels("ur-PK")).toEqual(linkLabels("ur"));
  });

  test("Mandarin picks traditional script for TW/HK, simplified elsewhere", () => {
    const hant = { restore: "恢復購買", terms: "條款", privacy: "隱私" };
    const hans = { restore: "恢复购买", terms: "条款", privacy: "隐私" };
    expect(linkLabels("zh-Hant-TW")).toEqual(hant);
    expect(linkLabels("zh-TW")).toEqual(hant);
    expect(linkLabels("zh-HK")).toEqual(hant);
    expect(linkLabels("zh-Hans-HK")).toEqual(hans);
    expect(linkLabels("zh-CN")).toEqual(hans);
    expect(linkLabels("zh")).toEqual(hans);
  });

  test("legacy and macrolanguage aliases resolve to their modern tag", () => {
    expect(linkLabels("iw")).toEqual({
      restore: "שחזור",
      terms: "תנאים",
      privacy: "פרטיות",
    });
    expect(linkLabels("no")).toEqual({
      restore: "Gjenopprett",
      terms: "Vilkår",
      privacy: "Personvern",
    });
  });

  test("falls back to English when unknown, undefined or empty", () => {
    const english = { restore: "Restore", terms: "Terms", privacy: "Privacy" };
    expect(linkLabels("xx")).toEqual(english);
    expect(linkLabels(undefined)).toEqual(english);
    expect(linkLabels("")).toEqual(english);
  });

  test("underscores normalize same as hyphens", () => {
    expect(linkLabels("pt_BR")).toEqual({
      restore: "Restaurar",
      terms: "Termos",
      privacy: "Privacidade",
    });
  });
});

describe("setLocale", () => {
  afterEach(() => setLocale(undefined));

  test("overrides detectLocale until cleared", () => {
    const detected = detectLocale();
    setLocale("ur");
    expect(detectLocale()).toBe("ur");
    setLocale(undefined);
    expect(detectLocale()).toBe(detected);
  });
});
