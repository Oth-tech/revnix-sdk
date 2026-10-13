// Tag variables — the vocabulary a designed paywall's copy uses to talk about
// the packages attached to it.
//
// A designed paywall must never hardcode a price: the merchant's price differs
// from the design's sample, and the store charges a different amount (and
// currency) in every territory. So any text or button in a block tree can
// write `{price}` and have the live package fill it in.
//
// Mirrors revnix-app's src/lib/paywall-blocks/tags.ts. Tags that cannot be
// answered from real package data are left in place, visible, rather than
// approximated — a wrong price must never reach a customer silently.

import type { RevnixPaywallPackage } from "../ui/RevnixPaywall.js";
import type { TimerBlock } from "./types.js";

/** Renewal cycles, in months. Lifetime and one-time products have no cycle. */
const MONTHS: Record<string, number | undefined> = {
  weekly: 1 / 4.345,
  monthly: 1,
  two_months: 2,
  three_months: 3,
  six_months: 6,
  annual: 12,
  lifetime: undefined,
  non_subscription: undefined,
  consumable: undefined,
};

const PERIOD_WORD: Record<string, string> = {
  weekly: "week",
  monthly: "month",
  two_months: "2 months",
  three_months: "3 months",
  six_months: "6 months",
  annual: "year",
  lifetime: "lifetime",
};

const PERIOD_SHORT: Record<string, string> = {
  weekly: "wk",
  monthly: "mo",
  two_months: "2mo",
  three_months: "3mo",
  six_months: "6mo",
  annual: "yr",
  lifetime: "once",
};

/** Minor units per major unit. Not every currency is a hundredth: JPY and KRW
 *  have no minor unit at all, so dividing by 100 would understate a price by
 *  100×. Intl knows each currency's exponent — ask it rather than assume.
 *
 *  Exported because a host app usually holds the store's price in MAJOR units
 *  and has to convert before filling in `RevnixPaywallPackage.amountMinor`;
 *  hardcoding 100 there would reintroduce the same bug one layer up. */
export function minorUnitsForCurrency(currency: string): number {
  try {
    const digits = new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
    }).resolvedOptions().maximumFractionDigits;
    return 10 ** (digits ?? 2);
  } catch {
    return 100;
  }
}

function money(amountMinor: number, currency: string): string {
  const per = minorUnitsForCurrency(currency);
  const major = amountMinor / per;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      // A whole amount reads better without ".00"; a fractional one must keep
      // its digits.
      maximumFractionDigits: amountMinor % per === 0 ? 0 : undefined,
    }).format(major);
  } catch {
    // Hermes without full ICU, or an unknown currency code.
    return `${major.toFixed(per === 1 ? 0 : 2)} ${currency}`;
  }
}

function perMonthMinor(pkg: RevnixPaywallPackage): number | undefined {
  const months = pkg.period ? MONTHS[pkg.period] : undefined;
  if (!months || pkg.amountMinor === undefined) return undefined;
  return pkg.amountMinor / months;
}

/** Fills a copy template from one package. `all` is the rest of the offering,
 *  which {save_percent} needs to have something to compare against. */
export function resolveTags(
  text: string,
  pkg: RevnixPaywallPackage | undefined,
  all: RevnixPaywallPackage[] = [],
): string {
  if (!pkg || !text.includes("{")) return text;
  return text.replace(/\{(\w+)\}/g, (raw, name: string) => {
    switch (name) {
      case "title":
        return pkg.title;
      case "price":
        return pkg.priceLabel;
      case "period":
        return pkg.period ? (PERIOD_WORD[pkg.period] ?? raw) : raw;
      case "period_short":
        return pkg.period ? (PERIOD_SHORT[pkg.period] ?? raw) : raw;
      case "price_per_month": {
        const per = perMonthMinor(pkg);
        return per !== undefined && pkg.currency
          ? money(Math.round(per), pkg.currency)
          : raw;
      }
      case "save_percent": {
        const mine = perMonthMinor(pkg);
        const dearest = Math.max(...all.map((p) => perMonthMinor(p) ?? 0), 0);
        if (!mine || !dearest || dearest <= mine) return raw;
        return `${Math.round((1 - mine / dearest) * 100)}%`;
      }
      default:
        // Unknown tag: leave it visible rather than guess.
        return raw;
    }
  });
}

export function formatCountdown(format: string, remaining: number): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  let span = Infinity;
  const part = (token: string, unit: number) => {
    const value = Math.floor((remaining % span) / unit);
    if (format.includes(token)) span = unit;
    return value;
  };
  const days = part("{d}", 86400);
  const hours = part("{hh}", 3600);
  const minutes = part("{mm}", 60);
  const seconds = part("{ss}", 1);
  return format
    .replace(/\{d\}/g, String(days))
    .replace(/\{hh\}/g, pad(hours))
    .replace(/\{mm\}/g, pad(minutes))
    .replace(/\{ss\}/g, pad(seconds));
}

export function timerText(
  block: TimerBlock,
  shownAt: number,
  now: number,
): string | null {
  const deadline =
    block.endsAt !== undefined
      ? Date.parse(block.endsAt)
      : shownAt + (block.duration ?? 0) * 1000;
  const remaining = Number.isNaN(deadline)
    ? 0
    : Math.max(0, Math.floor((deadline - now) / 1000));
  if (remaining > 0) {
    return formatCountdown(block.format ?? "{hh}:{mm}:{ss}", remaining);
  }
  return block.expiredText ?? null;
}
