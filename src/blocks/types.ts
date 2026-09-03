// The paywall block model — a portable description of a designed paywall.
//
// A block paywall is a TREE of styled elements: the screen owns a background
// and a list of blocks; every block carries its own style. The dashboard's
// builder authors this tree and publishes it on the paywall config as
// `blocks`, where it takes precedence over the classic `template` layouts.
//
// This file mirrors revnix-app's src/lib/paywall-blocks/types.ts one-for-one.
// The two must stay in lockstep: the dashboard preview and this SDK renderer
// are two interpreters of the SAME document, and a field only one side knows
// is a design that ships looking different from the design that was approved.

/** Per-block visual style. Everything optional — a block renders sensibly
 *  with no style at all. Sizes are px numbers; colors are any CSS color, or
 *  a palette token (see `resolveColor`). */
import type { PaywallBackground } from "./background.js";

export type {
  BackgroundFit,
  BackgroundImage,
  BackgroundLayers,
  BackgroundOverlay,
  PaywallBackground,
  PaywallBackgroundSpec,
} from "./background.js";

export interface BlockStyle {
  fill?: string;
  /** Sizing for an image or repeating-gradient `fill` (CSS background-size).
   *  RN paints `fill` as a flat colour, so tiled washes do not survive the
   *  trip and this is ignored. */
  fillSize?: string;
  textColor?: string;
  /** 0–100, like the dashboard's opacity inputs. */
  opacity?: number;
  borderColor?: string;
  borderWidth?: number;
  /** Per-side rules, as a CSS border shorthand ("1px solid @text/12"). */
  borderTop?: string;
  borderRight?: string;
  borderBottom?: string;
  borderLeft?: string;
  radius?: number;
  padding?: number;
  paddingX?: number;
  paddingY?: number;
  /** Per-side padding wins over the shorthands above. */
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  /** px numbers, or "auto" — the designs centre and bottom-pin with it. */
  margin?: number;
  marginTop?: number | "auto";
  marginRight?: number | "auto";
  marginBottom?: number | "auto";
  marginLeft?: number | "auto";
  fontSize?: number;
  fontWeight?: number;
  /** A design font family name (e.g. "Newsreader"). Renders only when the
   *  host app has that font registered — see `fontFamilyMap`. */
  fontFamily?: string;
  fontStyle?: "normal" | "italic";
  align?: "left" | "center" | "right";
  /** In em, like CSS. Converted to points against the block's font size. */
  letterSpacing?: number;
  /** Unitless multiplier, like CSS. Converted to points. */
  lineHeight?: number;
  textTransform?: "none" | "uppercase";
  decoration?: "none" | "underline" | "line-through";
  /** Line-breaking preference. No RN equivalent — ignored. */
  textWrap?: "balance" | "pretty";
  /** Keep the copy on one line. */
  nowrap?: boolean;
  /** Gap between a container's children. */
  gap?: number;
  /** px number, or a percentage string ("78%") for proportional boxes. */
  height?: number | string;
  minHeight?: number;
  /** px number, or a percentage string ("50%"). */
  width?: number | string;
  maxWidth?: number | string;
  /** Width-to-height ratio; "16/9" strings are parsed. */
  aspectRatio?: number | string;
  /** flex-grow inside a row/column container. */
  flex?: number;
  /** flex-shrink; 0 stops a row item from being squashed. */
  shrink?: number;
  /** flex-basis in px — carousel cards and side rails are sized by basis,
   *  and collapse to nothing without it. */
  basis?: number;
  /** Let a row wrap onto more lines. */
  wrap?: boolean;
  /** Main-axis distribution for row/column containers. */
  justify?: "start" | "center" | "end" | "between";
  /** Cross-axis alignment for row/column containers. */
  items?: "start" | "center" | "end" | "baseline" | "stretch";
  /** Cross-axis alignment for THIS block, overriding the container's
   *  `items` — how a design opts one chip out of a stretched row. */
  selfAlign?: "start" | "center" | "end" | "baseline" | "stretch";
  /** Raw CSS box-shadow. Approximated by a soft RN shadow. */
  shadow?: string;
  /** backdrop-filter blur radius in px (glass cards). RN has no backdrop
   *  filter; the translucent `fill` carries the effect on its own. */
  blur?: number;
  /** Raw CSS filter. No RN equivalent — ignored. */
  filter?: string;
  /** Raw CSS clip-path (starbursts, ticket notches). No RN equivalent —
   *  ignored, so the shape renders as its uncut box. */
  clipPath?: string;
  rotate?: number;
  /** CSS `translate` ("-50% 0"), which the designs pair with a 50% offset to
   *  centre a pinned badge. RN transforms take points, not percentages, so a
   *  percentage translate is ignored; a px one is applied. */
  translate?: string;
  /** Placement inside a `stack` container. `inset` fills the stack; the
   *  individual offsets pin an edge. Ignored outside a stack. */
  inset?: boolean;
  /** px numbers, or percentage strings ("50%") for proportional pinning. */
  top?: number | string;
  right?: number | string;
  bottom?: number | string;
  left?: number | string;
  zIndex?: number;
  overflow?: "hidden" | "visible";
}

/** What tapping a block does. Omitted means the block is decoration.
 *
 *  A FIELD on the existing block types rather than a new block type, so an
 *  SDK older than this one drops it and still renders the element exactly as
 *  it does today — a design carrying a close chip degrades to inert rather
 *  than losing the chip, which is what a new block type would have cost. */
/** REV-262: draw a block only while its plan card is (or is not) the selected
 *  one. Ignored outside a package card — a root block is always drawn. */
export type BlockVisibility = "selected" | "unselected";

export type BlockAction = "close";

export interface TextBlock {
  id: string;
  type: "text";
  text: string;
  /** Tapping this block dismisses the paywall. See BlockAction. */
  action?: BlockAction;
  style?: BlockStyle;
  /** REV-262: merged over `style`, field by field, while the block sits in a
   *  selected plan card (a pinned or repeated card whose package is the
   *  selected one, or any descendant of such a card). */
  selectedStyle?: BlockStyle;
  visibility?: BlockVisibility;
}

export interface ImageBlock {
  id: string;
  type: "image";
  /** Empty falls back to the config's hero image, then to a blank slot. */
  url?: string;
  shape?: "rect" | "circle";
  fit?: "cover" | "contain";
  placeholder?: string;
  /** Tapping this block dismisses the paywall. See BlockAction. */
  action?: BlockAction;
  style?: BlockStyle;
  /** REV-262: merged over `style`, field by field, while the block sits in a
   *  selected plan card (a pinned or repeated card whose package is the
   *  selected one, or any descendant of such a card). */
  selectedStyle?: BlockStyle;
  visibility?: BlockVisibility;
}

export interface ListBlock {
  id: string;
  type: "list";
  items: Array<{ icon?: string; title: string; description?: string }>;
  /** Icon color; defaults to the screen accent. */
  iconColor?: string;
  style?: BlockStyle;
  /** REV-262: merged over `style`, field by field, while the block sits in a
   *  selected plan card (a pinned or repeated card whose package is the
   *  selected one, or any descendant of such a card). */
  selectedStyle?: BlockStyle;
  visibility?: BlockVisibility;
}

/** Renders the attached offering's packages as selectable cards. */
export interface ProductsBlock {
  id: string;
  type: "products";
  direction?: "column" | "row";
  titleTpl?: string;
  priceTpl?: string;
  highlightSub?: string;
  badgeText?: string;
  cardStyle?: BlockStyle;
  highlightStyle?: BlockStyle;
  style?: BlockStyle;
  /** REV-262: merged over `style`, field by field, while the block sits in a
   *  selected plan card (a pinned or repeated card whose package is the
   *  selected one, or any descendant of such a card). */
  selectedStyle?: BlockStyle;
  visibility?: BlockVisibility;
}

export interface ButtonBlock {
  id: string;
  type: "button";
  label: string;
  /** `close` turns this button into a dismiss ("Not now") instead of the
   *  purchase CTA, which is what a button means by default. */
  action?: BlockAction;
  style?: BlockStyle;
  /** REV-262: merged over `style`, field by field, while the block sits in a
   *  selected plan card (a pinned or repeated card whose package is the
   *  selected one, or any descendant of such a card). */
  selectedStyle?: BlockStyle;
  visibility?: BlockVisibility;
}

export interface LinksBlock {
  id: string;
  type: "links";
  showRestore?: boolean;
  showTerms?: boolean;
  showPrivacy?: boolean;
  termsUrl?: string;
  privacyUrl?: string;
  style?: BlockStyle;
  /** REV-262: merged over `style`, field by field, while the block sits in a
   *  selected plan card (a pinned or repeated card whose package is the
   *  selected one, or any descendant of such a card). */
  selectedStyle?: BlockStyle;
  visibility?: BlockVisibility;
}

export interface LineBlock {
  id: string;
  type: "line";
  style?: BlockStyle;
  /** REV-262: merged over `style`, field by field, while the block sits in a
   *  selected plan card (a pinned or repeated card whose package is the
   *  selected one, or any descendant of such a card). */
  selectedStyle?: BlockStyle;
  visibility?: BlockVisibility;
}

export interface SpacerBlock {
  id: string;
  type: "spacer";
  /** Grows to push what follows to the bottom. */
  flex?: boolean;
  style?: BlockStyle;
  /** REV-262: merged over `style`, field by field, while the block sits in a
   *  selected plan card (a pinned or repeated card whose package is the
   *  selected one, or any descendant of such a card). */
  selectedStyle?: BlockStyle;
  visibility?: BlockVisibility;
}

/** The one container block. `layout` picks how children are placed: column /
 *  row are flex lines, `stack` layers them (children position with
 *  style.inset or the edge offsets), and `grid` is an N-column grid. */
export interface CardBlock {
  id: string;
  type: "card";
  layout?: "column" | "row" | "stack" | "grid";
  /** Renders this container once per package in the attached offering. Its
   *  subtree reads the package through tag variables. */
  repeat?: "packages";
  /** "This card describes package N of the offering". A card whose index the
   *  offering does not reach is hidden. */
  packageIndex?: number;
  /** grid only; defaults to 2. */
  columns?: number;
  /** grid only — a CSS track list ("1fr 60px 66px"). */
  gridColumns?: string;
  children: PaywallBlock[];
  style?: BlockStyle;
  /** REV-262: merged over `style`, field by field, while the block sits in a
   *  selected plan card (a pinned or repeated card whose package is the
   *  selected one, or any descendant of such a card). */
  selectedStyle?: BlockStyle;
  visibility?: BlockVisibility;
}

export type PaywallBlock =
  | TextBlock
  | ImageBlock
  | ListBlock
  | ProductsBlock
  | ButtonBlock
  | LinksBlock
  | LineBlock
  | SpacerBlock
  | CardBlock;

/** The published document: screen palette plus the block tree. */
export interface PaywallBlockDoc {
  version: number;
  /** "canvas" designs are authored against a fixed device screen and scale as
   *  a whole; "flow" designs lay out in a scrolling column. */
  layout?: "canvas" | "flow";
  /** Any CSS color or gradient string — or the layered form with a photo
   *  and scrim (see ./background.ts). */
  background: PaywallBackground;
  textColor: string;
  accent: string;
  accentInk: string;
  fontFamily?: string;
  blocks: PaywallBlock[];
}

/** The device screen `canvas` designs are authored against. */
export const DESIGN_CANVAS = { width: 393, height: 852 } as const;

/** Does this tree author a dismiss affordance that is CERTAIN to render?
 *
 *  The renderer draws its own close button only when this is false, so a
 *  design written before close existed becomes dismissible without being
 *  edited, and a design that DOES author a close chip never shows two. The
 *  same predicate is implemented in every Revnix SDK — keep them identical.
 *
 *  Conditional containers are deliberately not searched: a `repeat` card
 *  renders once per package (none, when the offering is empty) and a
 *  `packageIndex` card is hidden when the offering does not reach that index,
 *  so a close authored inside one MIGHT not appear. Counting it would
 *  suppress the fallback and leave the customer with no way out — the exact
 *  bug this feature exists to fix. Two close buttons is merely ugly, so the
 *  tie breaks toward always having one. */
export function hasCloseAction(blocks: PaywallBlock[]): boolean {
  return blocks.some((b) =>
    // A close the design only draws in one selection state (`visibility`)
    // must not suppress the fallback chip — the other state would have none.
    b.visibility !== undefined
      ? false
      : b.type === "card"
        ? b.repeat === undefined &&
          b.packageIndex === undefined &&
          hasCloseAction(b.children)
        : (b.type === "text" || b.type === "image" || b.type === "button") &&
          b.action === "close"
  );
}
