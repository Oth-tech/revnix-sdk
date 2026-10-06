// REV-271: paywall localization, SDK half. A designed paywall carries ONE
// tree plus a side table of translated strings — never one tree per language
// — so styles, layout and block ids are shared and only words differ.
//
// Selection happens HERE, at render, rather than server-side at resolve. The
// resolution is cached on the device (REV-157), so a locale chosen by the
// server would pin a cached paywall to whatever language it was fetched in:
// change the phone's language and the old copy would keep rendering until the
// cache expired, and offline it would never change at all. Choosing on the
// device also keeps the server's fleet-wide placement cache one entry per
// placement instead of one per language.
//
// Mirrored from the dashboard's src/lib/paywall-blocks/locale.ts and into the
// five native SDKs. The key scheme, the fallback chain and the field list
// must stay identical on every side — a paywall translated in the dashboard
// has to resolve the same way on all six.

import type { PaywallBlock, PaywallBlockDoc } from "./types.js";

/** BCP-47, hyphenated: "es_MX" and "es-mx" both normalize to "es-MX". Applied
 *  to authored tags and to the device's reported locale alike, so the two can
 *  never miss each other over punctuation or case. */
export function normalizeLocale(tag: string | undefined): string | undefined {
  if (typeof tag !== "string") return undefined;
  const parts = tag.trim().replace(/_/g, "-").split("-").filter(Boolean);
  const language = parts[0]?.toLowerCase();
  if (language === undefined || !/^[a-z]{2,3}$/.test(language)) return undefined;
  const rest: string[] = [];
  for (const part of parts.slice(1)) {
    // Region subtags are uppercase ("MX", "419"), scripts title case ("Hans").
    // Anything else is a variant and stays lowercase. A subtag outside
    // BCP-47's shapes makes the WHOLE tag junk rather than passing through —
    // otherwise a device reporting "es-!!" would look up a language.
    if (/^[A-Za-z]{2}$/.test(part) || /^\d{3}$/.test(part)) {
      rest.push(part.toUpperCase());
    } else if (/^[A-Za-z]{4}$/.test(part)) {
      rest.push(part.charAt(0).toUpperCase() + part.slice(1).toLowerCase());
    } else if (/^[A-Za-z0-9]{5,8}$/.test(part)) {
      rest.push(part.toLowerCase());
    } else {
      return undefined;
    }
  }
  return [language, ...rest].join("-");
}

function baseLanguage(tag: string): string {
  return tag.split("-")[0] ?? tag;
}

/** Which tables to consult, most specific first.
 *
 *  "es-MX" on a paywall translated into "es" reads the "es" table: a regional
 *  variant that was never authored falls back to its language rather than to
 *  the source, which is the difference between a Mexican user reading Spanish
 *  and reading English. The authored tree is the last resort and is NOT in
 *  this chain — the lookup falls through to it. */
export function localeChain(
  available: readonly string[],
  locale: string | undefined,
  defaultLocale: string | undefined,
): string[] {
  const chain: string[] = [];
  const push = (tag: string | undefined) => {
    if (tag !== undefined && available.includes(tag) && !chain.includes(tag)) {
      chain.push(tag);
    }
  };
  const wanted = normalizeLocale(locale);
  if (wanted !== undefined) {
    push(wanted);
    push(baseLanguage(wanted));
    // "es" asked for, only "es-MX" authored: one regional table beats the
    // source language, and the first sorted match keeps the choice
    // deterministic across devices rather than dependent on key order.
    if (chain.length === 0) {
      const language = baseLanguage(wanted);
      const regional = available
        .filter((tag) => baseLanguage(tag) === language)
        .sort();
      push(regional[0]);
    }
  }
  push(normalizeLocale(defaultLocale));
  return chain;
}

let localeOverride: string | undefined;

/** Forces the paywall language regardless of the device's, for a host whose
 *  in-app language picker differs from the OS locale. `undefined` clears it.
 *  Only paywalls MOUNTED AFTER this call pick it up — `detectLocale()` is
 *  read once per doc/locale in a `useMemo`. */
export function setLocale(tag?: string): void {
  localeOverride = tag || undefined;
}

/** The device's language, for hosts that do not pass one. Hermes without the
 *  full ICU build has no `Intl`, and a React Native `navigator.language` is
 *  the JS engine's, not the device's — so this is best effort and a host that
 *  cares passes `locale` explicitly. */
export function detectLocale(): string | undefined {
  if (localeOverride !== undefined) return localeOverride;
  try {
    const resolved = new Intl.DateTimeFormat().resolvedOptions().locale;
    if (typeof resolved === "string" && resolved.length > 0) return resolved;
  } catch {
    // Falls through to navigator below.
  }
  const nav = (globalThis as { navigator?: { language?: string } }).navigator;
  return typeof nav?.language === "string" && nav.language.length > 0
    ? nav.language
    : undefined;
}

function localizeBlock(
  block: PaywallBlock,
  lookup: (key: string, authored: string) => string,
): PaywallBlock {
  const at = (path: string, authored: string) =>
    lookup(`${block.id}.${path}`, authored);
  const opt = (path: string, authored: string | undefined) =>
    authored === undefined ? undefined : at(path, authored);
  switch (block.type) {
    case "text":
      return { ...block, text: at("text", block.text) };
    case "button":
      return { ...block, label: at("label", block.label) };
    case "list":
      return {
        ...block,
        items: block.items.map((item, i) => ({
          ...item,
          title: at(`items.${i}.title`, item.title),
          description: opt(`items.${i}.description`, item.description),
        })),
      };
    case "products":
      return {
        ...block,
        titleTpl: opt("titleTpl", block.titleTpl),
        priceTpl: opt("priceTpl", block.priceTpl),
        highlightSub: opt("highlightSub", block.highlightSub),
        badgeText: opt("badgeText", block.badgeText),
      };
    case "card":
      return {
        ...block,
        children: block.children.map((child) => localizeBlock(child, lookup)),
      };
    default:
      return block;
  }
}

/** Returns the document with every string swapped for `locale`'s.
 *
 *  Applied ONCE before rendering rather than at each text node: the renderer
 *  then needs no localization awareness at all, and the six SDKs cannot drift
 *  on which fields are translatable. Returns the input untouched when nothing
 *  applies, so an untranslated paywall allocates nothing.
 *
 *  `{price}` and the other copy tags survive, because they are resolved AFTER
 *  this on the localized string — "Solo {price} al mes" works. */
export function localizeBlockDoc(
  doc: PaywallBlockDoc,
  locale: string | undefined,
): PaywallBlockDoc {
  const tables = doc.locales;
  if (tables === undefined) return doc;
  const available = Object.keys(tables);
  if (available.length === 0) return doc;
  const chain = localeChain(available, locale, doc.defaultLocale);
  if (chain.length === 0) return doc;
  const lookup = (key: string, authored: string): string => {
    for (const tag of chain) {
      const value = tables[tag]?.[key];
      // An empty translation means "not translated", never "render nothing":
      // a blank CTA is a dead paywall, and an export/import round-trip leaves
      // empty cells behind for every untouched row.
      if (typeof value === "string" && value !== "") return value;
    }
    return authored;
  };
  return {
    ...doc,
    defaultLocale: chain[0],
    blocks: doc.blocks.map((b) => localizeBlock(b, lookup)),
  };
}

const LINK_LABEL_ALIASES: Record<string, string> = {
  iw: "he",
  in: "id",
  no: "nb",
  tl: "fil",
};

const LINK_LABELS: Record<string, readonly [string, string, string]> = {
  ar: ["استعادة", "الشروط", "الخصوصية"],
  bg: ["Възстановяване", "Условия", "Поверителност"],
  bn: ["পুনরুদ্ধার", "শর্তাবলী", "গোপনীয়তা"],
  ca: ["Restaura", "Condicions", "Privadesa"],
  cs: ["Obnovit", "Podmínky", "Soukromí"],
  da: ["Gendan", "Vilkår", "Privatliv"],
  de: ["Wiederherstellen", "AGB", "Datenschutz"],
  el: ["Επαναφορά", "Όροι", "Απόρρητο"],
  en: ["Restore", "Terms", "Privacy"],
  es: ["Restaurar", "Términos", "Privacidad"],
  et: ["Taasta", "Tingimused", "Privaatsus"],
  fa: ["بازیابی", "شرایط", "حریم خصوصی"],
  fi: ["Palauta", "Ehdot", "Tietosuoja"],
  fil: ["I-restore", "Mga Tuntunin", "Privacy"],
  fr: ["Restaurer", "Conditions", "Confidentialité"],
  he: ["שחזור", "תנאים", "פרטיות"],
  hi: ["पुनर्स्थापित करें", "शर्तें", "गोपनीयता"],
  hr: ["Vrati", "Uvjeti", "Privatnost"],
  hu: ["Visszaállítás", "Feltételek", "Adatvédelem"],
  id: ["Pulihkan", "Ketentuan", "Privasi"],
  it: ["Ripristina", "Termini", "Privacy"],
  ja: ["購入を復元", "利用規約", "プライバシー"],
  ko: ["구매 복원", "이용약관", "개인정보"],
  lt: ["Atkurti", "Sąlygos", "Privatumas"],
  lv: ["Atjaunot", "Noteikumi", "Privātums"],
  ms: ["Pulihkan", "Terma", "Privasi"],
  nb: ["Gjenopprett", "Vilkår", "Personvern"],
  nl: ["Herstellen", "Voorwaarden", "Privacy"],
  pl: ["Przywróć", "Regulamin", "Prywatność"],
  pt: ["Restaurar", "Termos", "Privacidade"],
  ro: ["Restaurează", "Termeni", "Confidențialitate"],
  ru: ["Восстановить", "Условия", "Конфиденциальность"],
  sk: ["Obnoviť", "Podmienky", "Súkromie"],
  sl: ["Obnovi", "Pogoji", "Zasebnost"],
  sr: ["Врати", "Услови", "Приватност"],
  sv: ["Återställ", "Villkor", "Integritet"],
  th: ["กู้คืน", "ข้อกำหนด", "ความเป็นส่วนตัว"],
  tr: ["Geri Yükle", "Koşullar", "Gizlilik"],
  uk: ["Відновити", "Умови", "Конфіденційність"],
  ur: ["بحال کریں", "شرائط", "رازداری"],
  vi: ["Khôi phục", "Điều khoản", "Quyền riêng tư"],
  zh: ["恢复购买", "条款", "隐私"],
  "zh-Hant": ["恢復購買", "條款", "隱私"],
};

/** The three built-in paywall footer labels (restore/terms/privacy), in the
 *  language `locale` resolves to. Falls back to English for any language not
 *  in the 43-entry table. Mandarin picks traditional script for Taiwan, Hong
 *  Kong and Macau unless the tag is explicitly simplified. */
export function linkLabels(
  locale: string | undefined
): { restore: string; terms: string; privacy: string } {
  const [restore, terms, privacy] = LINK_LABELS[resolveLinkLabelTag(locale)]!;
  return { restore, terms, privacy };
}

function resolveLinkLabelTag(locale: string | undefined): string {
  const tag = normalizeLocale(locale);
  if (tag === undefined) return "en";
  const lang = baseLanguage(tag);
  if (lang === "zh") {
    const parts = tag.split("-").slice(1);
    const hasHant = parts.includes("Hant");
    const hasHans = parts.includes("Hans");
    const region = parts.find((part) => /^[A-Z]{2}$/.test(part));
    const isTraditionalRegion =
      region !== undefined && ["TW", "HK", "MO"].includes(region);
    return hasHant || (!hasHans && isTraditionalRegion) ? "zh-Hant" : "zh";
  }
  const base = LINK_LABEL_ALIASES[lang] ?? lang;
  return base in LINK_LABELS ? base : "en";
}
