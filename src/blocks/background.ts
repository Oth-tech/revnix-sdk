// The paywall screen background — the SDK half of the dashboard's model.
//
// A background is either the original CSS string (color or gradient) or a
// layered spec: ground color/gradient, then a photo (fit, focal point,
// opacity, blur), then a scrim. `backgroundLayers()` resolves either form to
// one paint list, mirroring the dashboard renderer exactly — the same
// function name, the same defaults, the same clamping — so a background can
// never look different on device than in the builder for reasons of
// interpretation. (Type parity with revnix-app/src/lib/paywall-blocks/
// background.ts; keep the two in step.)

export type BackgroundFit = "cover" | "contain";

export interface BackgroundImage {
  /** An https URL the device can load — Convex storage or any CDN. */
  url: string;
  /** Default "cover". */
  fit?: BackgroundFit;
  /** Focal point in percent (0–100, 50/50 = centered): the part of the
   *  photo that must survive a cover-crop. */
  focalX?: number;
  focalY?: number;
  /** 0–100, default 100. */
  opacity?: number;
  /** Gaussian blur radius in px. */
  blur?: number;
}

export interface BackgroundOverlay {
  /** Any CSS color or gradient; palette tokens resolve as in block fills. */
  fill: string;
  /** 0–100, default 100. */
  opacity?: number;
}

export interface PaywallBackgroundSpec {
  /** Ground paint under the image — a solid color or a CSS gradient. */
  color?: string;
  image?: BackgroundImage;
  overlay?: BackgroundOverlay;
  /** Builder bookkeeping (library preset id); ignored on device. */
  presetId?: string;
  /** Builder bookkeeping ("reset to design default"); ignored on device. */
  original?: PaywallBackground;
}

export type PaywallBackground = string | PaywallBackgroundSpec;

const DEFAULT_GROUND = "#000000";

/**
 * The flat color a ground stands in for — what `@bg` resolves to, and what
 * paints under a gradient this build cannot draw.
 *
 * It reads the LAST comma-separated layer, because in CSS the first-listed
 * layer paints on TOP: taking the first color would answer with the
 * translucent accent glow the library's Spotlight and Corner halo presets
 * stack over their base, not with the base itself. Fully transparent stops are
 * skipped for the same reason — a scrim that fades to `…00` says nothing about
 * the ground under it.
 *
 * Returning the raw gradient here instead is what put this SDK and the
 * dashboard out of step with the other five renderers, which have always
 * collapsed it: `@bg` is fed to `color-mix()` (and, inside a gradient, to
 * another gradient's stop list), and neither can take a gradient — so the raw
 * form resolved to something invalid and painted NOTHING. Of the 250 shipped
 * gallery presets only 7 have a gradient ground and none of those use `@bg`,
 * so no design that ships today changes; what changes is a background a
 * customer edits to a gradient, which used to silently drop every `@bg` tint
 * on the screen.
 */
export function backgroundBaseColor(
  bg: PaywallBackground | undefined,
): string {
  const ground = typeof bg === "string" ? bg : bg?.color;
  if (ground === undefined) return DEFAULT_GROUND;
  const layers = splitLayers(ground);
  const bottom = layers.length > 0 ? layers[layers.length - 1]! : ground;
  const colors = bottom.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/gi);
  if (!colors) return ground;
  return colors.find((color) => !isFullyTransparent(color)) ?? colors[0]!;
}

/** Whether a color literal is fully transparent. Kept here rather than routed
 *  through `color.ts`, which imports THIS module — only the two forms the
 *  dashboard emits are recognized, and anything else counts as opaque, which
 *  is the safe answer for picking a ground. */
function isFullyTransparent(color: string): boolean {
  const s = color.trim();
  if (s.startsWith("#")) {
    const hex = s.slice(1);
    if (hex.length === 8) return parseInt(hex.slice(6), 16) === 0;
    if (hex.length === 4) return parseInt(hex.slice(3).repeat(2), 16) === 0;
    return false;
  }
  const open = s.indexOf("(");
  const close = s.indexOf(")");
  if (open < 0 || close < 0) return false;
  const parts = s
    .slice(open + 1, close)
    .split(/[,/\s]+/)
    .filter(Boolean);
  return parts.length >= 4 && parseFloat(parts[3]!) === 0;
}

/** Splits on top-level commas only, so the commas inside `rgba(...)` and
 *  inside a gradient's argument list do not tear a layer in half. */
function splitLayers(input: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of input) {
    if (ch === "(") depth++;
    else if (ch === ")" && depth > 0) depth--;
    if (ch === "," && depth === 0) {
      out.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  const tail = current.trim();
  if (tail) out.push(tail);
  return out;
}

export interface ResolvedBackgroundImage {
  url: string;
  fit: BackgroundFit;
  focalX: number;
  focalY: number;
  /** 0–1. */
  opacity: number;
  /** px; absent when no blur was asked for. */
  blur?: number;
}

export interface ResolvedBackgroundOverlay {
  fill: string;
  /** 0–1. */
  opacity: number;
}

export interface BackgroundLayers {
  /** The ground fill (color or gradient string), or undefined for none. */
  ground?: string;
  image?: ResolvedBackgroundImage;
  overlay?: ResolvedBackgroundOverlay;
}

function pct(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value / 100));
}

function coord(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 50;
  return Math.min(100, Math.max(0, value));
}

/** The paint list, bottom layer first. Layers that would draw nothing (no
 *  url, zero opacity) are dropped, so a legacy string resolves to exactly
 *  one ground layer. */
export function backgroundLayers(
  bg: PaywallBackground | undefined,
  /** Resolves palette tokens in the ground and overlay fills. */
  resolve: (value: string) => string = (v) => v,
): BackgroundLayers {
  const spec: PaywallBackgroundSpec =
    bg === undefined ? {} : typeof bg === "string" ? { color: bg } : bg;
  const layers: BackgroundLayers = {};

  if (spec.color) layers.ground = resolve(spec.color);

  if (spec.image?.url) {
    const opacity = pct(spec.image.opacity, 1);
    if (opacity > 0) {
      layers.image = {
        url: spec.image.url,
        fit: spec.image.fit === "contain" ? "contain" : "cover",
        focalX: coord(spec.image.focalX),
        focalY: coord(spec.image.focalY),
        opacity,
        ...(spec.image.blur ? { blur: spec.image.blur } : {}),
      };
    }
  }

  if (spec.overlay?.fill) {
    const opacity = pct(spec.overlay.opacity, 1);
    if (opacity > 0) {
      layers.overlay = { fill: resolve(spec.overlay.fill), opacity };
    }
  }

  return layers;
}

/**
 * Cover-fit geometry with a focal point — the SDK's stand-in for CSS
 * `object-position`, which React Native's <Image> lacks. Given the box and
 * the source dimensions it returns the drawn size and the offset that puts
 * the focal point as close to the box's matching anchor as the image edges
 * allow (exactly CSS's `object-position: X% Y%` rule: the X% point of the
 * image aligns to the X% point of the box, clamped so no edge shows).
 */
export function coverPlacement(
  box: { width: number; height: number },
  source: { width: number; height: number },
  focalX: number,
  focalY: number,
): { width: number; height: number; left: number; top: number } {
  if (box.width <= 0 || box.height <= 0 || source.width <= 0 || source.height <= 0) {
    return { width: box.width, height: box.height, left: 0, top: 0 };
  }
  const scale = Math.max(box.width / source.width, box.height / source.height);
  const width = source.width * scale;
  const height = source.height * scale;
  const place = (boxLen: number, drawnLen: number, pctPoint: number) => {
    const offset = (boxLen - drawnLen) * (pctPoint / 100);
    // Clamp: never pull an image edge inside the box. `|| 0` normalises the
    // -0 that falls out of the arithmetic at the edges — harmless to RN, but
    // it makes the returned geometry compare cleanly.
    return Math.min(0, Math.max(boxLen - drawnLen, offset)) || 0;
  };
  return {
    width,
    height,
    left: place(box.width, width, focalX),
    top: place(box.height, height, focalY),
  };
}
