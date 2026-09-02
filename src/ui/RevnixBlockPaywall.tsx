// RevnixBlockPaywall — renders a designed paywall (a block tree) natively.
//
// The dashboard's paywall builder publishes `config.blocks`: a tree of styled
// elements the builder previews with BlockScreen.tsx (revnix-app). This is the
// second interpreter of that same document, so the design a merchant approves
// in the dashboard is the design their customers see. Keep the two in
// lockstep — a block type only one side understands ships as a surprise.
//
// What React Native cannot reproduce is listed on BlockStyle and handled by
// degrading rather than failing:
//   * CSS gradients need a gradient component from the host app (`gradient`
//     prop). Without one the screen paints the design's ground color.
//   * backdrop blur has no RN equivalent; the translucent fill carries it.
//   * Design fonts render only through `fontFamilyMap` — RN cannot load a
//     family by name at runtime.
//
// RevnixPaywall delegates here whenever a config carries `blocks`, so apps
// get designed paywalls without changing a line of their integration.

import * as React from "react";
import {
  Image,
  Linking,
  Pressable,
  ScrollView,
  Text,
  View,
  type ColorValue,
  type StyleProp,
  type ViewStyle,
} from "react-native";

import {
  gradientFallbackColor,
  isGradient,
  parseGradient,
  resolveColor,
  withAlpha,
  type GradientLayer,
} from "../blocks/color.js";
import {
  DEFAULT_FONT_SIZE,
  hairlineColor,
  inherit,
  inheritedTextStyle,
  resolveFontFamily,
  toTextStyle,
  toViewStyle,
  type FontFamilyMap,
  type InheritedText,
  type StyleContext,
} from "../blocks/style.js";
import {
  backgroundLayers,
  coverPlacement,
  type ResolvedBackgroundImage,
} from "../blocks/background.js";
import { resolveTags } from "../blocks/tags.js";
import {
  DESIGN_CANVAS,
  hasCloseAction,
  type BlockStyle,
  type PaywallBlock,
  type PaywallBlockDoc,
  type ProductsBlock,
} from "../blocks/types.js";
import type { RevnixPaywallPackage } from "./RevnixPaywall.js";

/** Props a gradient component must accept. Both `expo-linear-gradient` and
 *  `react-native-linear-gradient` satisfy this, so an app passes its own:
 *  `<RevnixPaywall gradient={LinearGradient} />`.
 *
 *  `colors` is a two-or-more tuple rather than an array because that is what
 *  expo-linear-gradient's own props declare — a plain `string[]` would not be
 *  assignable and the host could not pass its component at all. The renderer
 *  therefore never emits a one-stop gradient. */
export interface RevnixGradientProps {
  colors: readonly [ColorValue, ColorValue, ...ColorValue[]];
  locations?: readonly [number, number, ...number[]] | null;
  /** The object and tuple forms expo-linear-gradient accepts — both are here
   *  so `typeof LinearGradient` is assignable to this component type. */
  start?: GradientPoint | null;
  end?: GradientPoint | null;
  style?: StyleProp<ViewStyle>;
}

/** Mutable tuple, not readonly: that is the shape expo-linear-gradient's own
 *  native point type declares, and a readonly one is not assignable to it. */
export type GradientPoint = { x: number; y: number } | [number, number];

export type RevnixGradientComponent = React.ComponentType<RevnixGradientProps>;

/** Props a blur component must accept. `intensity` is 0–100 (expo-blur's
 *  scale); a component that wants a px radius can read `radius`. */
export interface RevnixBlurProps {
  intensity?: number;
  radius?: number;
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
}

export type RevnixBlurComponent = React.ComponentType<RevnixBlurProps>;

export interface RevnixBlockPaywallProps {
  doc: PaywallBlockDoc;
  packages: RevnixPaywallPackage[];
  onPurchase: (packageId: string) => void;
  selectedPackageId?: string;
  onSelectPackage?: (packageId: string) => void;
  highlightPackageId?: string;
  /** Fallback for an image block that names no url of its own. */
  heroImageUrl?: string;
  onRestore?: () => void;
  onTerms?: () => void;
  onPrivacy?: () => void;
  /** Dismissal (REV-252). Omitted means no close is drawn at all — a dead
   *  close button is worse than none. The host performs the dismissal; the
   *  paywall never unmounts itself. */
  onClose?: () => void;
  /** Paywall-level Terms/Privacy, used when a links block sets none. */
  footer?: { termsUrl?: string; privacyUrl?: string };
  /** Renders CSS gradients. Without it, gradients paint as a solid ground. */
  gradient?: RevnixGradientComponent;
  /** Renders a blurred background photo. React Native has no blur primitive,
   *  so a design that blurs its background photo needs the host's own —
   *  `@react-native-community/blur` or `expo-blur` satisfy this. Without it
   *  the photo renders sharp; everything else about the background is
   *  unaffected. Same opt-in shape as `gradient`. */
  blur?: RevnixBlurComponent;
  /** Design font family → the face(s) the app has registered. Either one
   *  family for every weight, or a weight → family table (RN picks a face by
   *  family NAME, so each weight is its own registered family). Names absent
   *  from the map render in the system font. */
  fontFamilyMap?: FontFamilyMap;
  /** Reports a paint string the renderer could not read, or a gradient it had
   *  to flatten because no `gradient` component was passed.
   *
   *  Local only: nothing is sent anywhere. The screen still draws — a fill
   *  falls back to a colour from the design rather than to black — so this is
   *  the only way to learn that a paywall is rendering approximately. */
  onDiagnostic?: (message: string) => void;
  style?: StyleProp<ViewStyle>;
  loading?: boolean;
}

/** CSS angle (0 = up, 90 = right) → RN gradient start/end points. */
function angleToPoints(angle: number): {
  start: { x: number; y: number };
  end: { x: number; y: number };
} {
  const rad = (angle * Math.PI) / 180;
  const dx = Math.sin(rad);
  const dy = -Math.cos(rad);
  return {
    start: { x: 0.5 - dx / 2, y: 0.5 - dy / 2 },
    end: { x: 0.5 + dx / 2, y: 0.5 + dy / 2 },
  };
}

/**
 * A radial gradient has no React Native equivalent, so it is stood in for by a
 * linear one. Two things make that stand-in read like the original rather than
 * a coloured band:
 *
 *  * DIRECTION comes from the radial's own centre — a glow anchored at the top
 *    of the screen has to fade downwards, not upwards.
 *  * ALPHA is scaled down. A radial reaches its opening colour only at the
 *    centre point and falls off in every direction; a linear paints that
 *    colour across the entire width. Carrying the stated alpha across would
 *    turn a soft glow into a solid header.
 *
 * Linear layers translate exactly, and a solid is a flat fill.
 */
const RADIAL_ALPHA = 0.55;

function layerColors(layer: GradientLayer): {
  colors: readonly [string, string, ...string[]];
  locations?: readonly [number, number, ...number[]];
  angle: number;
} {
  if (layer.kind === "linear" && layer.colors.length >= 2) {
    const colors = layer.colors as [string, string, ...string[]];
    const locations =
      layer.locations && layer.locations.length >= 2
        ? (layer.locations as [number, number, ...number[]])
        : undefined;
    return { colors, locations, angle: layer.angle };
  }
  const first = layer.colors[0]!;
  if (layer.kind !== "radial") {
    return { colors: [first, first], angle: layer.angle };
  }
  const last = layer.colors[layer.colors.length - 1]!;
  // Fade away from the centre: a centre in the top third falls downwards, one
  // in the bottom third upwards, anything else keeps the default.
  const y = layer.center?.y ?? 0.5;
  const angle = y >= 0.65 ? 0 : 180;
  // Where the radial's outermost stop sits, so the glow stops where it did.
  const extent = layer.locations?.[layer.locations.length - 1] ?? 1;
  return {
    colors: [withAlpha(first, RADIAL_ALPHA), withAlpha(last, 0)],
    locations: [0, Math.max(0.05, Math.min(1, extent))],
    angle,
  };
}

const FILL_ABSOLUTE = {
  position: "absolute",
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
} as const;

/** The gradient layers of a fill, as absolutely-positioned siblings to be
 *  rendered behind a box's content. Null whenever the fill is a plain color,
 *  or no gradient component was supplied — in both cases the caller's
 *  `backgroundColor` (the design's ground color) is the whole paint job. */
function GradientLayers({
  fill,
  doc,
  gradient: Gradient,
  radius,
  onDiagnostic,
}: {
  fill: string | undefined;
  doc: PaywallBlockDoc;
  gradient?: RevnixGradientComponent;
  onDiagnostic?: (message: string) => void;
  /** The box's corner radius. CSS clips a background to it for free; here the
   *  layers are real children, so they have to be rounded themselves or a
   *  rounded card shows square gradient corners. */
  radius?: number;
}): React.ReactElement | null {
  const resolved = resolveColor(fill, doc);
  if (!resolved || !isGradient(resolved)) return null;
  if (!Gradient) {
    // The fill still paints — `toViewStyle` degraded it to its ground stop —
    // but the design asked for a gradient and this app passed no gradient
    // component, so say so rather than letting it silently render flat.
    onDiagnostic?.(
      `gradient flattened: pass RevnixPaywall a \`gradient\` component to render ${resolved}`,
    );
    return null;
  }
  const layers = parseGradient(resolved);
  if (layers.length === 0) return null;
  return (
    <React.Fragment>
      {/* CSS paints the first layer on top, so render in reverse. */}
      {[...layers].reverse().map((layer, i) => {
        const { colors, locations, angle } = layerColors(layer);
        const { start, end } = angleToPoints(angle);
        return (
          <Gradient
            key={i}
            colors={colors}
            locations={locations}
            start={start}
            end={end}
            style={
              radius === undefined
                ? FILL_ABSOLUTE
                : [FILL_ABSOLUTE, { borderRadius: radius }]
            }
          />
        );
      })}
    </React.Fragment>
  );
}

/** A block's own gradient fill, ready to drop in as the first child of
 *  whatever box that block renders. `toViewStyle` has already painted the
 *  ground stop as the box's backgroundColor, so this adds the real gradient
 *  over it — and renders nothing at all for a plain colour. */
function BlockFill({
  block,
  ctx,
}: {
  block: PaywallBlock;
  ctx: RenderContext;
}): React.ReactElement | null {
  return (
    <GradientLayers
      fill={block.style?.fill}
      doc={ctx.doc}
      gradient={ctx.gradient}
      radius={block.style?.radius}
      onDiagnostic={ctx.onDiagnostic}
    />
  );
}

/** The solid a fill paints under any gradient layers. */
function fillColor(
  fill: string | undefined,
  doc: PaywallBlockDoc,
): string | undefined {
  const resolved = resolveColor(fill, doc);
  if (!resolved) return undefined;
  return isGradient(resolved) ? gradientFallbackColor(resolved) : resolved;
}

/** Paints a fill that may be a CSS gradient, behind `children`. */
function Surface({
  fill,
  doc,
  gradient,
  style,
  children,
}: {
  fill: string | undefined;
  doc: PaywallBlockDoc;
  gradient?: RevnixGradientComponent;
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
}) {
  const solid = fillColor(fill, doc);
  return (
    <View style={[style, solid ? { backgroundColor: solid } : null]}>
      <GradientLayers fill={fill} doc={doc} gradient={gradient} />
      {children}
    </View>
  );
}

/**
 * The screen background's photo layer.
 *
 * React Native's <Image> has no `object-position`, so a focal point other
 * than the centre is drawn by hand: measure the box, ask the platform for
 * the source dimensions, and place the scaled image with `coverPlacement` —
 * the same rule CSS applies for `object-position: X% Y%`. Until both
 * measurements land (and always for a centred focal point, and for
 * `contain`) the plain resizeMode path is already correct, so there is no
 * flash of a wrongly-cropped photo.
 */
function BackgroundPhoto({
  image,
  blur: Blur,
}: {
  image: ResolvedBackgroundImage;
  blur?: RevnixBlurComponent;
}) {
  const centred = image.focalX === 50 && image.focalY === 50;
  const needsPlacement = image.fit === "cover" && !centred;

  const [box, setBox] = React.useState<{ width: number; height: number } | null>(
    null,
  );
  const [source, setSource] = React.useState<{
    width: number;
    height: number;
  } | null>(null);

  React.useEffect(() => {
    if (!needsPlacement) return;
    let live = true;
    Image.getSize(
      image.url,
      (width, height) => live && setSource({ width, height }),
      // A failed measure is not an error worth surfacing — the centred
      // resizeMode path below stays in place.
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [image.url, needsPlacement]);

  const placement =
    needsPlacement && box && source
      ? coverPlacement(box, source, image.focalX, image.focalY)
      : null;

  const photo = placement ? (
    <Image
      source={{ uri: image.url }}
      style={{
        position: "absolute",
        left: placement.left,
        top: placement.top,
        width: placement.width,
        height: placement.height,
      }}
      resizeMode="cover"
    />
  ) : (
    <Image
      source={{ uri: image.url }}
      style={FILL_ABSOLUTE}
      resizeMode={image.fit}
    />
  );

  return (
    <View
      pointerEvents="none"
      style={[FILL_ABSOLUTE, { opacity: image.opacity, overflow: "hidden" }]}
      onLayout={
        needsPlacement
          ? (e) =>
              setBox({
                width: e.nativeEvent.layout.width,
                height: e.nativeEvent.layout.height,
              })
          : undefined
      }
    >
      {photo}
      {image.blur !== undefined && Blur ? (
        <Blur
          intensity={Math.min(100, Math.round((image.blur / 30) * 100))}
          radius={image.blur}
          style={FILL_ABSOLUTE}
        />
      ) : null}
    </View>
  );
}

/**
 * The whole screen background: ground, then photo, then scrim — the same
 * three layers, in the same order, as the dashboard renderer paints. A
 * document whose background is still a plain string resolves to a ground
 * and nothing else, so this is byte-for-byte the old `Surface` for every
 * paywall that has not had its background edited.
 */
function ScreenBackground({
  doc,
  gradient,
  blur,
  style,
  onDiagnostic,
  children,
}: {
  doc: PaywallBlockDoc;
  gradient?: RevnixGradientComponent;
  blur?: RevnixBlurComponent;
  style?: StyleProp<ViewStyle>;
  onDiagnostic?: (message: string) => void;
  children?: React.ReactNode;
}) {
  const layers = backgroundLayers(
    doc.background,
    (value) => resolveColor(value, doc) ?? value,
  );
  const ground = fillColor(layers.ground, doc);
  return (
    <View style={[style, ground ? { backgroundColor: ground } : null]}>
      <GradientLayers
        fill={layers.ground}
        doc={doc}
        gradient={gradient}
        onDiagnostic={onDiagnostic}
      />
      {layers.image ? (
        <BackgroundPhoto image={layers.image} blur={blur} />
      ) : null}
      {layers.overlay ? (
        <Surface
          fill={layers.overlay.fill}
          doc={doc}
          gradient={gradient}
          style={[FILL_ABSOLUTE, { opacity: layers.overlay.opacity }]}
        />
      ) : null}
      {children}
    </View>
  );
}

/** A container block's box. The style lands on the PRESSABLE itself when the
 *  card is a selection target — wrapping a styled View in a bare Pressable
 *  would leave absolute offsets resolving against a zero-sized parent, which
 *  makes an `inset` card vanish and a pinned badge fly off the edge. */
function CardBox({
  style,
  fill,
  doc,
  gradient,
  radius,
  onPress,
  children,
}: {
  style: StyleProp<ViewStyle>;
  fill: string | undefined;
  doc: PaywallBlockDoc;
  gradient?: RevnixGradientComponent;
  radius?: number;
  onPress?: () => void;
  children: React.ReactNode;
}) {
  const layers = (
    <GradientLayers fill={fill} doc={doc} gradient={gradient} radius={radius} />
  );
  if (onPress) {
    return (
      <Pressable onPress={onPress} style={style}>
        {layers}
        {children}
      </Pressable>
    );
  }
  return (
    <View style={style}>
      {layers}
      {children}
    </View>
  );
}

/** The dismiss affordance the renderer supplies itself (REV-252).
 *
 *  Drawn only when the design authors none of its own and the host wired an
 *  onClose — which is what makes every paywall published before close existed
 *  dismissible without being re-authored, while a design that DOES carry a
 *  close chip never ends up showing two.
 *
 *  Deliberately plain: it is a safety net, not a design element. It is tinted
 *  from the screen's own ink rather than a fixed white so it stays legible on
 *  a light design as well as a dark one, and it sits outside the canvas
 *  transform so it is never scaled away on a small screen. */
function FallbackClose({
  doc,
  onPress,
}: {
  doc: PaywallBlockDoc;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Close"
      hitSlop={10}
      onPress={onPress}
      style={{
        position: "absolute",
        top: 14,
        right: 14,
        zIndex: 50,
        width: 30,
        height: 30,
        borderRadius: 15,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: withAlpha(doc.textColor, 0.14),
      }}
    >
      <Text style={{ color: doc.textColor, fontSize: 17, lineHeight: 20 }}>
        ×
      </Text>
    </Pressable>
  );
}

interface RenderContext {
  doc: PaywallBlockDoc;
  packages: RevnixPaywallPackage[];
  selectedId?: string;
  onSelect: (packageId: string) => void;
  onPurchase: () => void;
  onRestore?: () => void;
  onTerms?: () => void;
  onPrivacy?: () => void;
  onClose?: () => void;
  footer?: { termsUrl?: string; privacyUrl?: string };
  heroImageUrl?: string;
  gradient?: RevnixGradientComponent;
  /** Where the renderer reports a paint string it could not read, or a
   *  gradient it had to flatten for want of a gradient component. Local only:
   *  nothing is sent anywhere. */
  onDiagnostic?: (message: string) => void;
  style: StyleContext;
}

/** Text blocks always render inside a View: a style may carry both typography
 *  and box properties (a round chip is a 34pt circle with a centered glyph),
 *  and RN cannot centre a glyph inside <Text> the way flexbox does. */
function BlockText({
  text,
  style,
  ctx,
  inherited,
  onPress,
}: {
  text: string;
  style: BlockStyle | undefined;
  ctx: RenderContext;
  inherited: InheritedText;
  /** Set when the design marks this element as the close (REV-252). */
  onPress?: () => void;
}) {
  const styleCtx = { ...ctx.style, fontSize: inherited.fontSize };
  // The block's own typography is folded into the inherited set first, so
  // em letter-spacing and unitless line-height resolve against whichever font
  // size actually applies — the block's, or the one it inherited.
  const own = inherit(inherited, style, styleCtx);
  const body = (
    <React.Fragment>
      <GradientLayers
        fill={style?.fill}
        doc={ctx.doc}
        gradient={ctx.gradient}
        radius={style?.radius}
        onDiagnostic={ctx.onDiagnostic}
      />
      <Text
        numberOfLines={style?.nowrap ? 1 : undefined}
        style={[inheritedTextStyle(own, ctx.style), textOnly(style, styleCtx)]}
      >
        {text}
      </Text>
    </React.Fragment>
  );
  // The whole box is the target, not just the glyph: a close chip is mostly
  // padding, and a 12pt × is under the 44pt tap minimum on its own. The style
  // lands on the Pressable itself for the same reason CardBox does it —
  // wrapping a styled View would leave a pinned chip resolving its offsets
  // against a zero-sized parent.
  if (onPress) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close"
        hitSlop={8}
        onPress={onPress}
        style={toViewStyle(style, styleCtx)}
      >
        {body}
      </Pressable>
    );
  }
  return <View style={toViewStyle(style, styleCtx)}>{body}</View>;
}

/** The press handler for a block the design marks as the close, or undefined
 *  when it is not one (or the host wired no dismissal). One helper so text,
 *  image and button blocks cannot drift on what "action: close" means. */
function closePress(
  block: { action?: "close" },
  ctx: RenderContext
): (() => void) | undefined {
  return block.action === "close" && ctx.onClose ? ctx.onClose : undefined;
}

/** Typography that is NOT inherited (decoration) — everything else already
 *  arrives through the inherited set. */
function textOnly(s: BlockStyle | undefined, ctx: StyleContext) {
  const t = toTextStyle(s, ctx);
  return t.textDecorationLine !== undefined
    ? { textDecorationLine: t.textDecorationLine }
    : null;
}

function Products({
  block,
  ctx,
  inherited,
}: {
  block: ProductsBlock;
  ctx: RenderContext;
  inherited: InheritedText;
}) {
  const { doc, packages } = ctx;
  const base = inheritedTextStyle(inherited, ctx.style);
  const row = block.direction === "row";
  return (
    <View
      style={[
        {
          flexDirection: row ? "row" : "column",
          gap: block.style?.gap ?? 8,
        },
        toViewStyle(block.style, ctx.style),
      ]}
    >
      <BlockFill block={block} ctx={ctx} />
      {packages.map((pkg) => {
        const selected = pkg.packageId === ctx.selectedId;
        const cardStyle = selected ? block.highlightStyle : block.cardStyle;
        return (
          <Pressable
            key={pkg.packageId}
            onPress={() => ctx.onSelect(pkg.packageId)}
            style={[
              {
                position: "relative",
                flexGrow: row ? 1 : undefined,
                flexBasis: row ? 0 : undefined,
                gap: 3,
                borderRadius: 14,
                paddingVertical: 12,
                paddingHorizontal: 14,
                borderWidth: 1.5,
                borderColor: selected ? doc.accent : withAlpha("#808080", 0.35),
                backgroundColor: selected
                  ? withAlpha(doc.accent, 0.12)
                  : "transparent",
              },
              toViewStyle(cardStyle, ctx.style),
            ]}
          >
            <GradientLayers
              fill={cardStyle?.fill}
              doc={doc}
              gradient={ctx.gradient}
              radius={cardStyle?.radius ?? 14}
              onDiagnostic={ctx.onDiagnostic}
            />
            {selected && block.badgeText ? (
              <View
                style={{
                  position: "absolute",
                  top: -9,
                  right: 12,
                  backgroundColor: doc.accent,
                  paddingVertical: 2,
                  paddingHorizontal: 8,
                  borderRadius: 99,
                }}
              >
                <Text
                  style={{
                    color: doc.accentInk,
                    fontSize: 10,
                    fontWeight: "800",
                    letterSpacing: 0.5,
                  }}
                >
                  {block.badgeText}
                </Text>
              </View>
            ) : null}
            <Text
              style={[
                base,
                {
                  fontWeight: "700",
                  fontSize: 14,
                  textAlign: row ? "center" : "left",
                },
              ]}
            >
              {resolveTags(block.titleTpl ?? "{title}", pkg, packages)}
            </Text>
            <Text
              style={[
                base,
                { fontSize: 13, textAlign: row ? "center" : "left" },
              ]}
            >
              {resolveTags(block.priceTpl ?? "{price}", pkg, packages)}
            </Text>
            {selected && block.highlightSub ? (
              <Text
                style={[
                  base,
                  {
                    fontSize: 11.5,
                    opacity: 0.75,
                    textAlign: row ? "center" : "left",
                  },
                ]}
              >
                {block.highlightSub}
              </Text>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

/** grid track list ("1fr 60px 66px") → per-column flex/width. */
function gridTracks(
  block: Extract<PaywallBlock, { type: "card" }>,
): Array<{ flex?: number; width?: number }> {
  if (block.gridColumns) {
    return block.gridColumns
      .trim()
      .split(/\s+/)
      .map((track) => {
        const fr = track.match(/^([\d.]*)fr$/);
        if (fr) return { flex: fr[1] ? parseFloat(fr[1]) : 1 };
        const px = track.match(/^([\d.]+)px$/);
        if (px) return { width: parseFloat(px[1]!) };
        return { flex: 1 };
      });
  }
  return Array.from({ length: block.columns ?? 2 }, () => ({ flex: 1 }));
}

function Block({
  block,
  ctx,
  pkg,
  inherited,
}: {
  block: PaywallBlock;
  ctx: RenderContext;
  /** The package this subtree describes — set inside a repeat container. */
  pkg?: RevnixPaywallPackage;
  inherited: InheritedText;
}): React.ReactElement | null {
  const { doc } = ctx;
  const styleCtx = { ...ctx.style, fontSize: inherited.fontSize };
  // Web flex items shrink by default (`flex: 0 1 auto`); RN's do not. Without
  // matching that, a row the browser fits by squeezing its children overflows
  // the screen here instead.
  const view = { flexShrink: 1, ...toViewStyle(block.style, styleCtx) };
  const text = inherit(inherited, block.style, styleCtx);
  const size = text.fontSize;

  switch (block.type) {
    case "text":
      return (
        <BlockText
          text={resolveTags(block.text, pkg, ctx.packages)}
          style={block.style}
          ctx={ctx}
          inherited={inherited}
          onPress={closePress(block, ctx)}
        />
      );

    case "image": {
      const url = block.url || ctx.heroImageUrl;
      const round = block.shape === "circle";
      const s = block.style;
      // A converted design sizes its own slot; the 160pt default is only for
      // a slot dropped into a flow column, and must not fight it.
      const sized =
        s !== undefined &&
        (s.inset ||
          s.height !== undefined ||
          s.aspectRatio !== undefined ||
          (s.top !== undefined && s.bottom !== undefined) ||
          s.flex !== undefined);
      // An icon the design marks as the close (REV-252). Same rule as text:
      // the whole box is the target, and the style lands on the Pressable so
      // a pinned icon keeps its offsets.
      const closeImage = closePress(block, ctx);
      const ImageBox = closeImage ? Pressable : View;
      return (
        <ImageBox
          accessibilityRole={closeImage ? "button" : undefined}
          accessibilityLabel={closeImage ? "Close" : undefined}
          hitSlop={closeImage ? 8 : undefined}
          onPress={closeImage}
          style={[
            sized ? null : { height: 160 },
            { borderRadius: round ? 9999 : sized ? 0 : 16, overflow: "hidden", flexShrink: 0 },
            view,
          ]}
        >
          <BlockFill block={block} ctx={ctx} />
          {url ? (
            <Image
              source={{ uri: url }}
              resizeMode={block.fit ?? "cover"}
              style={{ width: "100%", height: "100%" }}
            />
          ) : (
            <View
              style={{
                width: "100%",
                height: "100%",
                backgroundColor: withAlpha("#7d879b", 0.2),
              }}
            />
          )}
        </ImageBox>
      );
    }

    case "list":
      return (
        <View
          style={[{ flexDirection: "column", gap: block.style?.gap ?? 8 }, view]}
        >
          <BlockFill block={block} ctx={ctx} />
          {block.items.map((item, i) => (
            <View key={i} style={{ flexDirection: "row", gap: 9 }}>
              <Text
                style={[
                  inheritedTextStyle(text, ctx.style),
                  {
                    color: resolveColor(block.iconColor, doc) ?? doc.accent,
                    fontWeight: "800",
                  },
                ]}
              >
                {item.icon ?? "✓"}
              </Text>
              <View style={{ flexShrink: 1 }}>
                <Text
                  style={[
                    inheritedTextStyle(text, ctx.style),
                    { fontWeight: item.description ? "700" : "500" },
                  ]}
                >
                  {item.title}
                </Text>
                {item.description ? (
                  <Text
                    style={[
                      inheritedTextStyle(text, ctx.style),
                      { fontSize: 12, opacity: 0.7 },
                    ]}
                  >
                    {item.description}
                  </Text>
                ) : null}
              </View>
            </View>
          ))}
        </View>
      );

    case "products":
      return <Products block={block} ctx={ctx} inherited={text} />;

    case "button": {
      // A converted CTA sizes itself and centres with flex; the padded default
      // is only for buttons added by hand.
      const sized = block.style?.height !== undefined;
      // A button the design marks as the close dismisses instead of buying,
      // and takes no accent fill: the CTA must stay the one accented thing on
      // the screen, or a "Not now" competes with "Subscribe" for the eye.
      const close = closePress(block, ctx);
      return (
        <Pressable
          accessibilityRole="button"
          onPress={close ?? ctx.onPurchase}
          style={[
            {
              backgroundColor: close ? "transparent" : doc.accent,
              borderRadius: 12,
              paddingVertical: sized ? 0 : 15,
              paddingHorizontal: 16,
              alignItems: "center",
              justifyContent: "center",
            },
            view,
          ]}
        >
          <BlockFill block={block} ctx={ctx} />
          <Text
            style={[
              inheritedTextStyle(text, ctx.style),
              {
                color: close ? doc.textColor : doc.accentInk,
                fontWeight: "800",
                textAlign: "center",
              },
              // The CTA's own colour/size, when the design set one.
              toTextStyle(block.style, styleCtx),
            ]}
          >
            {resolveTags(block.label, pkg, ctx.packages)}
          </Text>
        </Pressable>
      );
    }

    case "links": {
      const open = (url?: string) =>
        url ? () => void Linking.openURL(url) : undefined;
      const links: Array<{ label: string; onPress?: () => void }> = [];
      if (block.showRestore ?? true)
        links.push({ label: "Restore", onPress: ctx.onRestore });
      if (block.showTerms ?? true)
        links.push({
          label: "Terms",
          onPress:
            ctx.onTerms ?? open(block.termsUrl ?? ctx.footer?.termsUrl),
        });
      if (block.showPrivacy ?? true)
        links.push({
          label: "Privacy",
          onPress:
            ctx.onPrivacy ?? open(block.privacyUrl ?? ctx.footer?.privacyUrl),
        });
      if (links.length === 0) return null;
      return (
        <View
          style={[
            { flexDirection: "row", justifyContent: "center", gap: 20 },
            view,
          ]}
        >
          <BlockFill block={block} ctx={ctx} />
          {links.map((link) => (
            <Pressable key={link.label} onPress={link.onPress}>
              <Text
                style={[
                  inheritedTextStyle(text, ctx.style),
                  { fontSize: text.fontSize === inherited.fontSize ? 12 : text.fontSize },
                  { opacity: 0.65 },
                ]}
              >
                {link.label}
              </Text>
            </Pressable>
          ))}
        </View>
      );
    }

    case "line":
      return (
        // The web rule paints in `currentColor` at low alpha — that is the
        // INHERITED text colour, not the screen default.
        <View
          style={[{ height: 1, backgroundColor: hairlineColor(text.color) }, view]}
        >
          <BlockFill block={block} ctx={ctx} />
        </View>
      );

    case "spacer":
      // A flexing spacer still honours the rest of its style (a minHeight
      // floor, margins) — flex decides how it grows, not what it is.
      return (
        <View style={[block.flex ? { flexGrow: 1 } : { height: 16 }, view]} />
      );

    case "card": {
      const layout = block.layout ?? "column";
      const base: ViewStyle =
        layout === "stack"
          ? { position: "relative" }
          : layout === "grid"
            ? {
                position: "relative",
                flexDirection: "row",
                flexWrap: "wrap",
                gap: block.style?.gap ?? 10,
              }
            : {
                position: "relative",
                flexDirection: layout === "row" ? "row" : "column",
                gap: block.style?.gap ?? 10,
              };

      const tracks = layout === "grid" ? gridTracks(block) : null;
      const renderChildren = (context: RevnixPaywallPackage | undefined) =>
        block.children.map((child, i) => {
          const node = (
            <Block
              key={child.id}
              block={child}
              ctx={ctx}
              pkg={context}
              inherited={text}
            />
          );
          if (!tracks) return node;
          const track = tracks[i % tracks.length]!;
          return (
            <View
              key={child.id}
              style={
                track.width !== undefined
                  ? { width: track.width }
                  : // A grid row must WRAP after `columns` items, so each cell
                    // claims its share of the width as a basis rather than
                    // flexing to fit everything on one line.
                    { flexBasis: `${100 / tracks.length}%`, flexGrow: 0, flexShrink: 1 }
              }
            >
              {node}
            </View>
          );
        });

      // A card that describes a package the offering does not reach is
      // dropped rather than shown with unresolved tags.
      if (
        block.packageIndex !== undefined &&
        ctx.packages[block.packageIndex] === undefined
      ) {
        return null;
      }

      const boxStyle = (selected: boolean) => [
        base,
        layout === "stack" ? null : { borderRadius: 16 },
        view,
        selected ? toViewStyle(block.selectedStyle, styleCtx) : null,
      ];

      if (block.repeat === "packages") {
        const list: Array<RevnixPaywallPackage | undefined> = ctx.packages
          .length
          ? ctx.packages
          : [undefined];
        return (
          <React.Fragment>
            {list.map((p, i) => (
              <CardBox
                key={p?.packageId ?? i}
                style={boxStyle(
                  p !== undefined && p.packageId === ctx.selectedId,
                )}
                fill={block.style?.fill}
                doc={doc}
                gradient={ctx.gradient}
                radius={block.style?.radius ?? (layout === "stack" ? undefined : 16)}
                onPress={p ? () => ctx.onSelect(p.packageId) : undefined}
              >
                {renderChildren(p)}
              </CardBox>
            ))}
          </React.Fragment>
        );
      }

      const context =
        block.packageIndex !== undefined
          ? (ctx.packages[block.packageIndex] ?? pkg)
          : pkg;

      // A card pinned to a package doubles as its selection target — that is
      // how hand-styled plan rows (a highlighted annual beside a plain
      // monthly) become tappable without a products block.
      const pinned = block.packageIndex !== undefined && context !== undefined;
      return (
        <CardBox
          style={boxStyle(pinned && context!.packageId === ctx.selectedId)}
          fill={block.style?.fill}
          doc={doc}
          gradient={ctx.gradient}
          radius={block.style?.radius ?? (layout === "stack" ? undefined : 16)}
          onPress={pinned ? () => ctx.onSelect(context!.packageId) : undefined}
        >
          {renderChildren(context)}
        </CardBox>
      );
    }
  }
}

export function RevnixBlockPaywall(props: RevnixBlockPaywallProps) {
  const { doc, packages } = props;

  const [internalSelected, setInternalSelected] = React.useState<
    string | undefined
  >(undefined);
  const fallbackSelected =
    packages.find((p) => p.packageId === props.highlightPackageId)?.packageId ??
    packages[0]?.packageId;
  const selectedId =
    props.selectedPackageId ??
    (internalSelected !== undefined &&
    packages.some((p) => p.packageId === internalSelected)
      ? internalSelected
      : fallbackSelected);

  const select = (packageId: string) => {
    setInternalSelected(packageId);
    props.onSelectPackage?.(packageId);
  };

  const styleCtx: StyleContext = {
    doc,
    fontSize: DEFAULT_FONT_SIZE,
    fontFamilyMap: props.fontFamilyMap,
    onDiagnostic: props.onDiagnostic,
    paintsGradients: props.gradient !== undefined,
  };

  // The screen's own typography is the root of the inheritance chain, exactly
  // as the document's colors and font sit on the web renderer's screen div.
  const rootText: InheritedText = {
    color: doc.textColor,
    fontSize: DEFAULT_FONT_SIZE,
    fontFamilyName: doc.fontFamily,
  };

  const ctx: RenderContext = {
    doc,
    packages,
    selectedId,
    onSelect: select,
    onPurchase: () => {
      if (props.loading || !selectedId) return;
      props.onPurchase(selectedId);
    },
    onRestore: props.onRestore,
    onTerms: props.onTerms,
    onPrivacy: props.onPrivacy,
    onClose: props.onClose,
    footer: props.footer,
    heroImageUrl: props.heroImageUrl,
    gradient: props.gradient,
    onDiagnostic: props.onDiagnostic,
    style: styleCtx,
  };

  const children = doc.blocks.map((block) => (
    <Block
      key={block.id}
      block={block}
      ctx={ctx}
      pkg={packages.find((p) => p.packageId === selectedId) ?? packages[0]}
      inherited={rootText}
    />
  ));

  // REV-252: the renderer's own close, drawn only for a design that authors
  // none. Rendered as a sibling of the tree — outside the canvas scale — so
  // it keeps its tap size and its distance from the screen edge whatever the
  // device width does to the design.
  const fallbackClose =
    props.onClose && !hasCloseAction(doc.blocks) ? (
      <FallbackClose doc={doc} onPress={props.onClose} />
    ) : null;

  const [width, setWidth] = React.useState<number | null>(null);

  if (doc.layout === "canvas") {
    // Authored against the fixed device screen: lay the tree out at 1× and
    // scale the whole thing, so absolute placement inside stack containers
    // stays true at any width. RN scales about the centre, hence the
    // compensating translate — the design must grow from the top-left.
    const scale = width === null ? 1 : width / DESIGN_CANVAS.width;
    const scaledHeight = DESIGN_CANVAS.height * scale;
    return (
      <ScreenBackground
        doc={doc}
        gradient={props.gradient}
        blur={props.blur}
        onDiagnostic={props.onDiagnostic}
        style={[{ flex: 1 }, props.style]}
      >
        {/* The canvas keeps the aspect ratio it was designed at, so on a
            screen shorter than 852:393 it does not fit. Scrolling is what
            keeps the CTA and the legal links reachable there; on a taller
            screen there is nothing to scroll. */}
        <ScrollView
          contentContainerStyle={{
            height: width === null ? DESIGN_CANVAS.height : scaledHeight,
          }}
        >
          <View
            onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
            style={{ flex: 1, overflow: "hidden" }}
          >
            <View
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: DESIGN_CANVAS.width,
                height: DESIGN_CANVAS.height,
                opacity: width === null ? 0 : 1,
                transform: [
                  { translateX: -(DESIGN_CANVAS.width * (1 - scale)) / 2 },
                  { translateY: -(DESIGN_CANVAS.height * (1 - scale)) / 2 },
                  { scale },
                ],
              }}
            >
              {children}
            </View>
          </View>
        </ScrollView>
        {fallbackClose}
      </ScreenBackground>
    );
  }

  return (
    <ScreenBackground
      doc={doc}
      gradient={props.gradient}
      blur={props.blur}
      onDiagnostic={props.onDiagnostic}
      style={[{ flex: 1 }, props.style]}
    >
      <ScrollView
        contentContainerStyle={{
          gap: 12,
          paddingHorizontal: 20,
          paddingTop: 18,
          paddingBottom: 30,
        }}
      >
        {children}
      </ScrollView>
      {fallbackClose}
    </ScreenBackground>
  );
}
