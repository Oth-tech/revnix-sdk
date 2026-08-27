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

/** The color `@bg` resolves to. A legacy string answers with itself — even
 *  a gradient, matching the dashboard renderer byte for byte. */
export function backgroundBaseColor(
  bg: PaywallBackground | undefined,
): string {
  if (bg === undefined) return DEFAULT_GROUND;
  if (typeof bg === "string") return bg;
  return bg.color ?? DEFAULT_GROUND;
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
