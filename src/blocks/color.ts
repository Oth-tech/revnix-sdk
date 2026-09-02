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

/**
 * Whether a paint string's BOTTOM layer is a repeating pattern.
 *
 * A `repeating-*` gradient is a TEXTURE, and the colors inside it are stripe
 * colors rather than the surface's. React Native cannot draw one, and painting
 * a color lifted out of its arguments across the whole box is a WRONG answer
 * rather than a degraded one — the library's hairline grid is one color every
 * 26px, and as a solid fill it is a slab. Such a fill paints nothing instead.
 *
 * The bottom layer decides, so a pattern stacked over a real ground
 * (`repeating-…(…), #FBF3E4`) still falls back to that ground.
 */
export function isRepeatingPattern(value: string | undefined): boolean {
  const s = value?.trim() ?? "";
  if (!s) return false;
  const layers = splitLayers(s);
  const bottom = layers.length > 0 ? layers[layers.length - 1]! : s;
  return /^repeating-/i.test(bottom);
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
      //
      // It has to LOOK like a color, though: any other layer — a
      // `repeating-linear-gradient`, a `url()` — used to be accepted here and
      // handed to the host's gradient component as a color string, which is not
      // one. Dropping it instead is what lets the caller see there is nothing
      // paintable and degrade to a flat color.
      if (raw && hasColor(raw)) {
        layers.push({ kind: "solid", angle: 180, colors: [raw] });
      }
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
      // CSS allows TWO positions on one stop — `@accent 0 22%` is the same
      // color at both, the hard edge the library's progress bars and split
      // panels are drawn with — and a unitless `0` is a valid position. Reading
      // only the last one left those designs a smooth fade instead of an edge.
      let body = arg.trim();
      const positions: number[] = [];
      while (positions.length < 2) {
        const found = body.match(/\s(-?[\d.]+%|0)$/);
        if (!found) break;
        const text = found[1]!;
        const value = parseFloat(text);
        // The token comes off `body` either way. Leaving a position this build
        // could not read attached to the color would make the color itself
        // unparseable, dropping the whole stop — and a gradient left with one
        // stop does not parse at all. A malformed position is worth losing; the
        // stop is not, so it falls through to the interpolated position.
        body = body.slice(0, body.length - found[0].length).trim();
        if (Number.isNaN(value)) break;
        positions.unshift(
          Math.max(0, Math.min(1, text.endsWith("%") ? value / 100 : value)),
        );
      }
      if (!body) continue;
      if (positions.length === 0) {
        colors.push(body);
        locations.push(colors.length === 1 ? 0 : 1);
        continue;
      }
      for (const position of positions) {
        colors.push(body);
        locations.push(position);
        positioned++;
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
  const s = value.trim();
  return /^(#|rgb|hsl|@)/i.test(s) || s.toLowerCase() === "transparent";
}

/**
 * A field that can only ever be ONE color — a border, text, an icon, a shadow.
 *
 * A gradient there has no native form (nor a CSS one: `border-color` takes no
 * gradient, so the dashboard drops the declaration outright). Collapsing it to
 * the color it stands for keeps the stroke or the glyph visible, which is
 * nearer the design's intent than losing it — and, on React Native, avoids
 * handing the platform a color string it cannot parse.
 */
export function flatColor(
  value: string | undefined,
  doc: PaywallBlockDoc,
  onDiagnostic?: (message: string) => void,
): string | undefined {
  const resolved = resolveColor(value, doc);
  if (resolved === undefined || !isGradient(resolved)) return resolved;
  onDiagnostic?.(`gradient flattened in a colour-only field: ${resolved}`);
  return gradientFallbackColor(resolved);
}

/** The solid to paint when no gradient component is available: the base
 *  layer's first stop, which is the design's ground color.
 *
 *  A value with no paintable layer at all — a `repeating-linear-gradient`, or
 *  any other form this build does not read — falls through to the same colour
 *  extraction the six SDKs share, so a box the design coloured still gets a
 *  colour from the design rather than nothing. */
export function gradientFallbackColor(value: string): string | undefined {
  // A pattern's colors are STRIPE colors; spreading one over the whole box is a
  // wrong answer rather than a degraded one, so it paints nothing.
  if (isRepeatingPattern(value)) return undefined;
  const layers = parseGradient(value);
  const base = layers[layers.length - 1];
  return base?.colors[0] ?? backgroundBaseColor(value);
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
