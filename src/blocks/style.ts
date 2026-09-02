// BlockStyle → React Native styles.
//
// The dashboard renderer maps a BlockStyle onto CSS; this maps the same style
// onto RN's subset. Where RN has no equivalent the property is DROPPED rather
// than approximated badly, and the omissions are documented on BlockStyle so
// a designer can see what will not survive the trip:
//
//   backdrop blur   RN has no backdrop-filter. The translucent `fill` a glass
//                   card already carries reads as frosted on its own.
//   filter          no equivalent; ignored.
//   textWrap        no equivalent (RN breaks lines its own way); ignored.
//   fillSize        RN paints `fill` as a flat colour, so a tiled wash has
//                   no size to honour; ignored.
//   clipPath        no equivalent; the shape renders as its uncut box.
//   % translate     RN transforms are points, not percentages. A percentage
//                   translate is ignored (a px one is applied), so a badge
//                   centred by `left:50%` + `translate:"-50% 0"` sits a half
//                   width to the right of where the web shows it.
//
// Two CSS units need converting rather than copying: `letterSpacing` is em in
// the document and points in RN, and `lineHeight` is a unitless multiplier in
// the document and points in RN. Both are resolved against the block's own
// font size, falling back to the inherited size the caller passes in.

import type { TextStyle, ViewStyle } from "react-native";

import {
  flatColor,
  gradientFallbackColor,
  isGradient,
  parseGradient,
  resolveColor,
  withAlpha,
} from "./color.js";
import type { BlockStyle, PaywallBlockDoc } from "./types.js";

const JUSTIFY = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  between: "space-between",
} as const;

const ITEMS = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  baseline: "baseline",
  stretch: "stretch",
} as const;

/**
 * What a design font maps onto in the host app.
 *
 * On the web one family name covers every weight and the browser picks the
 * face. React Native has no such indirection: each weight is a separately
 * registered family (`PlusJakartaSans_700Bold`). So a mapping is either one
 * family for everything, or a weight → family table, from which the nearest
 * registered weight is chosen.
 */
export type FontMapping = string | Record<number, string> | undefined;

export type FontFamilyMap = Record<string, FontMapping>;

export interface StyleContext {
  doc: PaywallBlockDoc;
  /** Whether the renderer will paint gradient layers over this style's
   *  background — true when the host passed a `gradient` component.
   *
   *  It decides whether a gradient `fill` degrades to its ground stop or is
   *  left transparent for the real layers. Painting the stop UNDER a gradient
   *  that will actually be drawn makes the box opaque, and 83 of the library's
   *  139 gradient fills fade through a translucent stop — they sit over the
   *  screen's photo precisely so it shows through. */
  paintsGradients?: boolean;
  /** Where a paint string this build cannot read is reported. Local only —
   *  the style still resolves, to a colour from the design rather than to
   *  black, so this is the only way a host learns it is approximating. */
  onDiagnostic?: (message: string) => void;
  /** Font size inherited from an ancestor, for em/multiplier conversions. */
  fontSize: number;
  /** Maps a design font family onto one the host app has registered. A name
   *  that is absent, or maps to undefined, renders in the system font. */
  fontFamilyMap?: FontFamilyMap;
}

/** The browser's default, which is what the dashboard preview inherits — a
 *  block that sets no size of its own must come out the same size in both. */
export const DEFAULT_FONT_SIZE = 16;

/**
 * Typography a container passes down to its subtree.
 *
 * CSS inherits `color`, `font-*`, `letter-spacing`, `line-height`,
 * `text-align` and `text-transform` — a card that sets `textColor` restyles
 * every descendant's text without touching them. React Native inherits none
 * of that through Views, so the tree has to carry it explicitly or a design
 * renders in the wrong color and size the moment a container sets the style
 * instead of each leaf.
 *
 * `lineHeight` rides along as the CSS multiplier rather than points, because
 * an unitless line-height is resolved against EACH element's own font size.
 */
export interface InheritedText {
  color: string;
  fontSize: number;
  /** The DESIGN's family name, resolved to a registered one only once the
   *  weight in force is known — RN selects a face by family name, so family
   *  and weight cannot be decided independently. */
  fontFamilyName?: string;
  fontWeight?: TextStyle["fontWeight"];
  fontStyle?: TextStyle["fontStyle"];
  textAlign?: TextStyle["textAlign"];
  textTransform?: TextStyle["textTransform"];
  /** em, like the document; resolved per element. */
  letterSpacing?: number;
  /** Unitless multiplier, like the document; resolved per element. */
  lineHeight?: number;
}

/** The inheritable half of a block's style, layered over what it inherited. */
export function inherit(
  base: InheritedText,
  s: BlockStyle | undefined,
  ctx: StyleContext,
): InheritedText {
  if (!s) return base;
  const next: InheritedText = { ...base };
  const color = resolveColor(s.textColor, ctx.doc);
  if (color !== undefined) next.color = color;
  if (s.fontSize !== undefined) next.fontSize = s.fontSize;
  if (s.fontFamily !== undefined) next.fontFamilyName = s.fontFamily;
  if (s.fontWeight !== undefined) {
    next.fontWeight = String(s.fontWeight) as TextStyle["fontWeight"];
  }
  if (s.fontStyle !== undefined) next.fontStyle = s.fontStyle;
  if (s.align !== undefined) next.textAlign = s.align;
  if (s.textTransform !== undefined) next.textTransform = s.textTransform;
  if (s.letterSpacing !== undefined) next.letterSpacing = s.letterSpacing;
  if (s.lineHeight !== undefined) next.lineHeight = s.lineHeight;
  return next;
}

/** Inherited typography as an RN style, with the em/multiplier units resolved
 *  against the size that actually applies here, and the family resolved
 *  against the weight in force. */
export function inheritedTextStyle(
  t: InheritedText,
  ctx: StyleContext,
): TextStyle {
  const out: TextStyle = { color: t.color, fontSize: t.fontSize };
  const family = resolveFontFamily(t.fontFamilyName, ctx, t.fontWeight);
  if (family !== undefined) out.fontFamily = family;
  if (t.fontWeight !== undefined) out.fontWeight = t.fontWeight;
  if (t.fontStyle !== undefined) out.fontStyle = t.fontStyle;
  if (t.textAlign !== undefined) out.textAlign = t.textAlign;
  if (t.textTransform !== undefined) out.textTransform = t.textTransform;
  if (t.letterSpacing !== undefined) {
    out.letterSpacing = t.letterSpacing * t.fontSize;
  }
  if (t.lineHeight !== undefined) out.lineHeight = t.lineHeight * t.fontSize;
  return out;
}

/** Border shorthand ("1.5px solid @text/12") → width + color. */
function parseBorder(
  value: string,
  doc: PaywallBlockDoc,
  onDiagnostic?: (message: string) => void,
): { width: number; color?: string } {
  const width = value.match(/(-?[\d.]+)px/);
  // The color is whatever remains once the width and the style keyword go.
  const color = value
    .replace(/(-?[\d.]+)px/, "")
    .replace(/\b(solid|dashed|dotted|none|hidden)\b/i, "")
    .trim();
  return {
    width: width ? parseFloat(width[1]!) : 1,
    color: color ? flatColor(color, doc, onDiagnostic) : undefined,
  };
}

function parseAspectRatio(value: number | string): number | undefined {
  if (typeof value === "number") return value;
  const ratio = value.match(/^\s*([\d.]+)\s*\/\s*([\d.]+)\s*$/);
  if (ratio) {
    const h = parseFloat(ratio[2]!);
    return h ? parseFloat(ratio[1]!) / h : undefined;
  }
  const n = parseFloat(value);
  return Number.isNaN(n) ? undefined : n;
}

/** A rough RN shadow for a CSS box-shadow. Only the presence and color of a
 *  shadow survive — RN cannot express layered glows, so one soft shadow is
 *  drawn rather than none (a card designed to lift should still lift). */
function parseShadow(
  value: string,
  doc: PaywallBlockDoc,
  onDiagnostic?: (message: string) => void,
): ViewStyle {
  const lengths = [...value.matchAll(/(-?[\d.]+)px/g)].map((m) =>
    parseFloat(m[1]!),
  );
  const [offsetX = 0, offsetY = 0, blur = 0] = lengths;
  const colorMatch = value.match(/(rgba?\([^)]*\)|#[0-9a-fA-F]{3,8}|@[\w/]+)/);
  const color = colorMatch ? flatColor(colorMatch[1]!, doc, onDiagnostic) : undefined;
  return {
    shadowColor: color ?? "#000000",
    shadowOffset: { width: offsetX, height: offsetY },
    shadowOpacity: color ? 1 : 0.25,
    shadowRadius: blur / 2,
    // Android has no per-shadow control; elevation is the only lever.
    elevation: Math.round(Math.max(0, blur) / 4),
  };
}

/** The layout/paint half of a BlockStyle — everything a <View> understands. */
export function toViewStyle(
  s: BlockStyle | undefined,
  ctx: StyleContext,
): ViewStyle {
  if (!s) return {};
  const { doc } = ctx;
  const out: ViewStyle = {};
  if (s.fill !== undefined) {
    // A gradient fill reaches RN as an unparseable string and paints nothing,
    // so it degrades to its ground color here — UNLESS the renderer is about to
    // paint the real layers over this box, in which case the ground color would
    // sit under them as an opaque backing and flatten every translucent stop.
    const fill = resolveColor(s.fill, doc);
    if (fill && isGradient(fill)) {
      out.backgroundColor =
        ctx.paintsGradients && parseGradient(fill).length > 0
          ? "transparent"
          : gradientFallbackColor(fill);
    } else {
      out.backgroundColor = fill;
    }
  }
  if (s.opacity !== undefined) out.opacity = s.opacity / 100;
  if (s.borderColor !== undefined || s.borderWidth !== undefined) {
    out.borderWidth = s.borderWidth ?? 1;
    // A gradient here reached RN as a color string it cannot parse; it is
    // collapsed to the color it stands for so the stroke still draws.
    out.borderColor = flatColor(s.borderColor, doc, ctx.onDiagnostic) ?? doc.textColor;
  }
  for (const [prop, side] of [
    ["borderTop", "Top"],
    ["borderRight", "Right"],
    ["borderBottom", "Bottom"],
    ["borderLeft", "Left"],
  ] as const) {
    const raw = s[prop];
    if (raw === undefined) continue;
    const { width, color } = parseBorder(raw, doc, ctx.onDiagnostic);
    (out as Record<string, unknown>)[`border${side}Width`] = width;
    if (color) (out as Record<string, unknown>)[`border${side}Color`] = color;
  }
  if (s.radius !== undefined) out.borderRadius = s.radius;
  if (s.padding !== undefined) out.padding = s.padding;
  if (s.paddingX !== undefined) out.paddingHorizontal = s.paddingX;
  if (s.paddingY !== undefined) out.paddingVertical = s.paddingY;
  if (s.paddingTop !== undefined) out.paddingTop = s.paddingTop;
  if (s.paddingRight !== undefined) out.paddingRight = s.paddingRight;
  if (s.paddingBottom !== undefined) out.paddingBottom = s.paddingBottom;
  if (s.paddingLeft !== undefined) out.paddingLeft = s.paddingLeft;
  if (s.margin !== undefined) out.margin = s.margin;
  if (s.marginTop !== undefined) out.marginTop = s.marginTop;
  if (s.marginRight !== undefined) out.marginRight = s.marginRight;
  if (s.marginBottom !== undefined) out.marginBottom = s.marginBottom;
  if (s.marginLeft !== undefined) out.marginLeft = s.marginLeft;
  if (s.gap !== undefined) out.gap = s.gap;
  if (s.height !== undefined) out.height = s.height as ViewStyle["height"];
  if (s.minHeight !== undefined) out.minHeight = s.minHeight;
  if (s.width !== undefined) out.width = s.width as ViewStyle["width"];
  if (s.maxWidth !== undefined) out.maxWidth = s.maxWidth as ViewStyle["maxWidth"];
  if (s.aspectRatio !== undefined) {
    const ratio = parseAspectRatio(s.aspectRatio);
    if (ratio !== undefined) out.aspectRatio = ratio;
  }
  if (s.flex !== undefined) out.flexGrow = s.flex;
  if (s.shrink !== undefined) out.flexShrink = s.shrink;
  if (s.basis !== undefined) out.flexBasis = s.basis;
  if (s.wrap) out.flexWrap = "wrap";
  if (s.justify !== undefined) out.justifyContent = JUSTIFY[s.justify];
  if (s.items !== undefined) out.alignItems = ITEMS[s.items];
  if (s.selfAlign !== undefined) out.alignSelf = ITEMS[s.selfAlign];
  if (s.shadow !== undefined) Object.assign(out, parseShadow(s.shadow, doc, ctx.onDiagnostic));
  // RN types the prop as a readonly array OR a raw CSS string, so the element
  // type is taken from the array arm and built up mutably before assignment.
  type Transform = Exclude<
    NonNullable<ViewStyle["transform"]>,
    string
  >[number];
  const transform: Transform[] = [];
  if (s.rotate !== undefined) transform.push({ rotate: `${s.rotate}deg` });
  if (s.translate !== undefined) {
    // Percentages have no RN equivalent and are dropped rather than guessed
    // at; a px pair translates directly.
    const [x, y] = s.translate.trim().split(/\s+/);
    const px = (v: string | undefined) => {
      if (!v) return 0;
      const n = Number(v.endsWith("px") ? v.slice(0, -2) : v);
      return Number.isFinite(n) ? n : 0;
    };
    // A zero component is a no-op; leaving it out keeps the list to the
    // moves the design actually makes.
    if (x !== undefined && !x.endsWith("%") && px(x) !== 0) {
      transform.push({ translateX: px(x) });
    }
    if (y !== undefined && !y.endsWith("%") && px(y) !== 0) {
      transform.push({ translateY: px(y) });
    }
  }
  if (transform.length) out.transform = transform;
  if (s.zIndex !== undefined) out.zIndex = s.zIndex;
  if (s.overflow !== undefined) out.overflow = s.overflow;
  // Stack placement: `inset` fills the parent, individual offsets pin edges.
  // Both imply absolute positioning, which is inert outside a stack parent.
  if (s.inset) {
    out.position = "absolute";
    out.top = 0;
    out.right = 0;
    out.bottom = 0;
    out.left = 0;
  } else if (
    s.top !== undefined ||
    s.right !== undefined ||
    s.bottom !== undefined ||
    s.left !== undefined
  ) {
    out.position = "absolute";
    if (s.top !== undefined) out.top = s.top as ViewStyle["top"];
    if (s.right !== undefined) out.right = s.right as ViewStyle["right"];
    if (s.bottom !== undefined) out.bottom = s.bottom as ViewStyle["bottom"];
    if (s.left !== undefined) out.left = s.left as ViewStyle["left"];
  }
  return out;
}

/** The typography half — everything a <Text> understands. */
export function toTextStyle(
  s: BlockStyle | undefined,
  ctx: StyleContext,
): TextStyle {
  if (!s) return {};
  const { doc } = ctx;
  const out: TextStyle = {};
  const fontSize = s.fontSize ?? ctx.fontSize;
  if (s.textColor !== undefined) out.color = flatColor(s.textColor, doc, ctx.onDiagnostic);
  if (s.fontSize !== undefined) out.fontSize = s.fontSize;
  if (s.fontWeight !== undefined)
    out.fontWeight = String(s.fontWeight) as TextStyle["fontWeight"];
  if (s.fontFamily !== undefined) {
    const family = resolveFontFamily(s.fontFamily, ctx);
    if (family) out.fontFamily = family;
  }
  if (s.fontStyle !== undefined) out.fontStyle = s.fontStyle;
  if (s.align !== undefined) out.textAlign = s.align;
  // em → points, against this block's own size.
  if (s.letterSpacing !== undefined)
    out.letterSpacing = s.letterSpacing * fontSize;
  // Unitless multiplier → points.
  if (s.lineHeight !== undefined) out.lineHeight = s.lineHeight * fontSize;
  if (s.textTransform !== undefined) out.textTransform = s.textTransform;
  if (s.decoration !== undefined && s.decoration !== "none")
    out.textDecorationLine = s.decoration;
  return out;
}

/**
 * A design font renders only when the host app has registered it — RN cannot
 * load a family by name at runtime. `fontFamilyMap` lets the app point a
 * design's family at whatever it bundled (and drop the ones it did not), so an
 * unregistered face falls back to the system font instead of, on Android,
 * failing to render.
 *
 * The weight matters because RN picks a face by family NAME, not by
 * `fontWeight`: asking for weight 800 of a family registered only at 400 gets
 * a synthesised bold at best. Given a weight table, the nearest registered
 * weight wins.
 */
export function resolveFontFamily(
  family: string | undefined,
  ctx: StyleContext,
  weight?: TextStyle["fontWeight"],
): string | undefined {
  if (!family) return undefined;
  const mapping = ctx.fontFamilyMap?.[family];
  if (mapping === undefined) return undefined;
  if (typeof mapping === "string") return mapping;
  const want = Number(weight ?? 400);
  const weights = Object.keys(mapping)
    .map(Number)
    .filter((w) => Number.isFinite(w))
    .sort((a, b) => a - b);
  if (weights.length === 0) return undefined;
  const target = Number.isFinite(want) ? want : 400;
  const nearest = weights.reduce((best, w) =>
    Math.abs(w - target) < Math.abs(best - target) ? w : best,
  );
  return mapping[nearest];
}

/** A `line` block is drawn from the current color at low alpha — the web
 *  renderer uses `currentColor` with opacity, which RN has no notion of, so
 *  the caller passes the color that is in force at that point in the tree. */
export function hairlineColor(currentColor: string): string {
  return withAlpha(currentColor, 0.16);
}
