// REV-262: the selection half of the designed-paywall render contract v2
// (revnix/cto-review/2026-09-03-paywall-render-contract-v2.md), kept pure so
// the wire fixture can be walked without React Native.
//
// Mirrors revnix-app's src/lib/paywall-blocks/selection.ts: the dashboard
// preview and this renderer must agree on which package is "selected", what
// a block looks like in that state and whether it is drawn at all.

import type {
  BlockStyle,
  CardBlock,
  PaywallBlock,
  PaywallBlockDoc,
} from "./types.js";
import { DESIGN_CANVAS } from "./types.js";
import { resolveTags } from "./tags.js";
import type { RevnixPaywallPackage } from "../ui/RevnixPaywall.js";

/** Where a block sits: inside the selected plan card, inside another plan
 *  card, or outside any plan card (undefined). */
export type SelectionContext = "selected" | "unselected" | undefined;

/** The package a designed paywall is showing as chosen: the host's choice,
 *  then the renderer's own after a tap, then the design's highlight, then the
 *  first package — each only when the offering actually carries it. */
export function selectedPackageId(
  packages: ReadonlyArray<{ packageId: string }>,
  ...candidates: Array<string | undefined>
): string | undefined {
  for (const id of candidates) {
    if (id !== undefined && packages.some((p) => p.packageId === id)) return id;
  }
  return packages[0]?.packageId;
}

/** The context a package-bearing card opens for itself and its subtree. */
export function packageContext(
  pkg: { packageId: string } | undefined,
  selectedId: string | undefined
): SelectionContext {
  if (pkg === undefined) return undefined;
  return pkg.packageId === selectedId ? "selected" : "unselected";
}

/** `selectedStyle` merged over `style` while selected; `style` otherwise. */
export function effectiveStyle(
  block: PaywallBlock,
  context: SelectionContext
): BlockStyle | undefined {
  if (context === "selected" && block.selectedStyle) {
    return { ...block.style, ...block.selectedStyle };
  }
  return block.style;
}

/** Whether a block is drawn. Outside any plan card every block is drawn,
 *  whatever `visibility` says — a root block can never disappear. */
export function isVisible(
  block: PaywallBlock,
  context: SelectionContext
): boolean {
  if (block.visibility === undefined || context === undefined) return true;
  return (block.visibility === "selected") === (context === "selected");
}

/** Canvas designs are authored at 393×852 and scaled by width, capped so a
 *  tablet or a landscape phone shows a centred phone-sized design instead of
 *  a blown-up one. */
export const CANVAS_MAX_WIDTH = 480;

export interface CanvasMetrics {
  scale: number;
  /** Horizontal offset of the scaled design inside the viewport. */
  left: number;
  /** Height of the laid-out design in DESIGN units. */
  designHeight: number;
  /** Height of the scaled design in viewport points. */
  scaledHeight: number;
  /** Whether the design is taller than the viewport and must scroll. */
  overflows: boolean;
}

export function canvasMetrics(
  viewportWidth: number,
  viewportHeight: number | null
): CanvasMetrics {
  const scale = Math.min(viewportWidth, CANVAS_MAX_WIDTH) / DESIGN_CANVAS.width;
  const left = (viewportWidth - DESIGN_CANVAS.width * scale) / 2;
  const designHeight =
    viewportHeight === null
      ? DESIGN_CANVAS.height
      : Math.max(DESIGN_CANVAS.height, viewportHeight / scale);
  const scaledHeight = designHeight * scale;
  const overflows =
    viewportHeight !== null && DESIGN_CANVAS.height * scale > viewportHeight + 1;
  return { scale, left, designHeight, scaledHeight, overflows };
}

export interface ResolvedBlock {
  block: PaywallBlock;
  context: SelectionContext;
  visible: boolean;
  style: BlockStyle | undefined;
  /** Resolved copy for text and button blocks. */
  text?: string;
}

/** Walk a document exactly the way the renderer does — pinned cards judge
 *  their own context, repeat cards yield one entry per package (keyed
 *  `id@packageId`), hidden subtrees are not entered — and report what every
 *  block resolves to. The wire fixture test reads this. */
export function resolveBlocks(
  doc: PaywallBlockDoc,
  packages: RevnixPaywallPackage[],
  selectedId: string | undefined
): Map<string, ResolvedBlock> {
  const out = new Map<string, ResolvedBlock>();
  const root = packages.find((p) => p.packageId === selectedId) ?? packages[0];
  const visit = (
    block: PaywallBlock,
    inherited: SelectionContext,
    pkg: RevnixPaywallPackage | undefined,
    key: string
  ) => {
    if (block.type === "card" && block.repeat === "packages") {
      const list = packages.length ? packages : [undefined];
      for (const p of list) {
        visitCard(block, packageContext(p, selectedId) ?? inherited, p ?? pkg, `${key}@${p?.packageId ?? "-"}`);
      }
      return;
    }
    if (block.type === "card" && block.packageIndex !== undefined) {
      const own = packages[block.packageIndex];
      if (own === undefined) return; // dropped: the offering does not reach it
      visitCard(block, packageContext(own, selectedId), own, key);
      return;
    }
    const context = inherited;
    const visible = isVisible(block, context);
    const entry: ResolvedBlock = { block, context, visible, style: effectiveStyle(block, context) };
    if (block.type === "text") entry.text = resolveTags(block.text, pkg, packages);
    if (block.type === "button") entry.text = resolveTags(block.label, pkg, packages);
    out.set(key, entry);
    if (visible && block.type === "card") {
      for (const child of (block as CardBlock).children) visit(child, context, pkg, child.id);
    }
  };
  const visitCard = (
    block: CardBlock,
    context: SelectionContext,
    pkg: RevnixPaywallPackage | undefined,
    key: string
  ) => {
    const visible = isVisible(block, context);
    out.set(key, { block, context, visible, style: effectiveStyle(block, context) });
    if (!visible) return;
    for (const child of block.children) visit(child, context, pkg, child.id);
  };
  for (const b of doc.blocks) visit(b, undefined, root, b.id);
  return out;
}
