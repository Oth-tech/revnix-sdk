// Color handling for block paywalls.
//
// Two jobs the web renderer gets from CSS for free and React Native does not:
//
//  1. Palette TOKENS. Converted designs write `@accent`, `@text`, `@bg`,
//     `@accentInk` (optionally with an alpha percentage: `@text/12`) so the
//     four screen colors stay a single source of truth. The web renderer
//     expands the percentage form with `color-mix()`; here we compute the
//     rgba ourselves.
//
//  2. GRADIENTS. `background` is a CSS background string and may carry
//     several gradient layers. React Native has no gradient primitive, so we
//     parse the layers out: a host that supplies a gradient component renders
//     them properly, and without one we fall back to the base layer's first
//     color — a solid that keeps the screen on-palette instead of blank.

import { backgroundBaseColor } from "./background.js";
import type { PaywallBlockDoc } from "./types.js";

const TOKEN = /@(accentInk|accent|bg|text)(?:\/(\d{1,3}))?/g;

/** Expands palette tokens in a color string and applies any `/pct` alpha. */
export function resolveColor(
  value: string | undefined,
  doc: PaywallBlockDoc,
): string | undefined {
  if (value === undefined) return undefined;
  if (!value.includes("@")) return value;
  return value.replace(TOKEN, (_match, name: string, pct?: string) => {
    const base =
      name === "accentInk"
        ? doc.accentInk
        : name === "accent"
          ? doc.accent
          : name === "bg"
            ? backgroundBaseColor(doc.background)
            : doc.textColor;
    return pct === undefined ? base : withAlpha(base, Number(pct) / 100);
  });
}

/** Multiplies a color's alpha. Understands #rgb/#rgba/#rrggbb/#rrggbbaa and
 *  rgb()/rgba(); anything else (a named color, a gradient) is returned as-is
 *  rather than guessed at. */
export function withAlpha(color: string, alpha: number): string {
  const rgb = toRgb(color);
  if (!rgb) return color;
  const a = Math.max(0, Math.min(1, rgb.a * alpha));
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${round(a)})`;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

interface Rgb {
  r: number;
  g: number;
  b: number;
  a: number;
}

export function toRgb(color: string): Rgb | null {
  const value = color.trim();
  if (value.startsWith("#")) {
    const hex = value.slice(1);
    const expand = (c: string) => parseInt(c + c, 16);
    if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
    if (hex.length === 3 || hex.length === 4) {
      return {
        r: expand(hex[0]!),
        g: expand(hex[1]!),
        b: expand(hex[2]!),
        a: hex.length === 4 ? expand(hex[3]!) / 255 : 1,
      };
    }
    if (hex.length === 6 || hex.length === 8) {
      const byte = (i: number) => parseInt(hex.slice(i, i + 2), 16);
      return {
        r: byte(0),
        g: byte(2),
        b: byte(4),
        a: hex.length === 8 ? byte(6) / 255 : 1,
      };
    }
    return null;
  }
  const fn = value.match(/^rgba?\(([^)]+)\)$/i);
  if (fn) {
    const parts = fn[1]!.split(/[,/\s]+/).filter(Boolean).map(Number);
    if (parts.length < 3 || parts.slice(0, 3).some(Number.isNaN)) return null;
    return {
      r: parts[0]!,
      g: parts[1]!,
      b: parts[2]!,
      a: parts.length > 3 && !Number.isNaN(parts[3]!) ? parts[3]! : 1,
    };
  }
  return null;
}

/** One parsed background layer, in the order CSS paints them (first =
 *  topmost). A background may end in a plain color — the design's ground —
 *  which is a layer like any other and must not be dropped. */
export interface GradientLayer {
  kind: "linear" | "radial" | "solid";
  /** Degrees, CSS convention (0 = to top, 180 = to bottom). Linear only. */
  angle: number;
  colors: string[];
  /** 0–1 positions, one per color, when the source stated them. */
  locations?: number[];
  /** Radial only: the `at X% Y%` centre, 0–1. Kept because it decides which
   *  way the linear stand-in fades — a glow anchored to the top of the screen
   *  must not end up washing the bottom. */
  center?: { x: number; y: number };
}

/** True when the string is a CSS gradient rather than a plain color. */
export function isGradient(value: string): boolean {
  return /gradient\s*\(/i.test(value);
}

/** Splits a CSS background into its gradient layers. Layers CSS paints last
 *  (the base) come last in the returned array, matching source order. */
export function parseGradient(value: string): GradientLayer[] {
  const layers: GradientLayer[] = [];
  for (const raw of splitLayers(value)) {
    const match = raw.match(/^(linear|radial)-gradient\s*\(([\s\S]*)\)$/i);
    if (!match) {
      // A plain color among the layers is the design's ground. Dropping it
      // would leave the screen painted by a translucent glow instead.
      if (raw) layers.push({ kind: "solid", angle: 180, colors: [raw] });
      continue;
    }
    const kind = match[1]!.toLowerCase() as "linear" | "radial";
    const args = splitTop(match[2]!);
    // A radial's center is dropped (RN has no radial gradient), so it is drawn
    // as a top-down fade — 180deg, like every other default.
    let angle = 180;
    let start = 0;
    let center: { x: number; y: number } | undefined;
    const first = args[0]?.trim() ?? "";
    if (kind === "linear" && /^-?[\d.]+deg$/i.test(first)) {
      angle = parseFloat(first);
      start = 1;
    } else if (kind === "linear" && /^to\s+/i.test(first)) {
      angle = TO_ANGLE[first.trim().toLowerCase()] ?? 180;
      start = 1;
    } else if (kind === "radial" && !hasColor(first)) {
      // Radial shape/position prelude ("120% 90% at 85% 5%"). RN has no
      // radial gradient, but the centre decides which way the stand-in fades,
      // so it is kept rather than dropped with the rest.
      center = readCenter(first);
      start = 1;
    }
    const colors: string[] = [];
    const locations: number[] = [];
    let positioned = 0;
    for (const arg of args.slice(start)) {
      const stop = arg.trim();
      if (!stop) continue;
      const pct = stop.match(/\s(-?[\d.]+)%$/);
      const color = pct ? stop.slice(0, stop.length - pct[0].length).trim() : stop;
      if (!color) continue;
      colors.push(color);
      if (pct) {
        locations.push(Math.max(0, Math.min(1, parseFloat(pct[1]!) / 100)));
        positioned++;
      } else {
        locations.push(colors.length === 1 ? 0 : 1);
      }
    }
    if (colors.length === 0) continue;
    layers.push({
      kind,
      angle,
      colors,
      // Partial position data would place stops wrongly; only pass locations
      // through when the source positioned every stop.
      locations: positioned === colors.length ? locations : undefined,
      center,
    });
  }
  return layers;
}

const TO_ANGLE: Record<string, number> = {
  "to top": 0,
  "to right": 90,
  "to bottom": 180,
  "to left": 270,
  "to top right": 45,
  "to right top": 45,
  "to bottom right": 135,
  "to right bottom": 135,
  "to bottom left": 225,
  "to left bottom": 225,
  "to top left": 315,
  "to left top": 315,
};

/** The `at X% Y%` part of a radial's prelude, as 0–1. Defaults to the CSS
 *  default centre when the prelude names none. */
function readCenter(prelude: string): { x: number; y: number } {
  const at = prelude.split(/\bat\b/i)[1];
  const pcts = at ? [...at.matchAll(/(-?[\d.]+)%/g)].map((m) => parseFloat(m[1]!)) : [];
  return {
    x: (pcts[0] ?? 50) / 100,
    y: (pcts[1] ?? 50) / 100,
  };
}

function hasColor(value: string): boolean {
  return /^(#|rgb|hsl|@)/i.test(value.trim());
}

/** The solid to paint when no gradient component is available: the base
 *  layer's first stop, which is the design's ground color. */
export function gradientFallbackColor(value: string): string | undefined {
  const layers = parseGradient(value);
  const base = layers[layers.length - 1];
  return base?.colors[0];
}

/** Splits comma-separated background layers, ignoring commas inside parens. */
function splitLayers(value: string): string[] {
  return splitTop(value).map((s) => s.trim());
}

function splitTop(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of value) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current);
  return out;
}
