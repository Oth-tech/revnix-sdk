import { describe, expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CANVAS_MAX_WIDTH,
  canvasMetrics,
  effectiveStyle,
  isVisible,
  resolveBlocks,
  selectedPackageId,
} from "./selection.js";
import { hasCloseAction } from "./types.js";
import type { PaywallBlockDoc, TextBlock } from "./types.js";
import type { RevnixPaywallPackage } from "../ui/RevnixPaywall.js";

// `paywall-selection-wire.json` is the shared render-contract fixture; every
// SDK carries a byte-identical copy of revnix-app/tests/fixtures/.
const wire = JSON.parse(
  readFileSync(join(__dirname, "paywall-selection-wire.json"), "utf8")
) as {
  doc: PaywallBlockDoc;
  packages: RevnixPaywallPackage[];
  cases: Array<{
    name: string;
    selected: string | null;
    highlight: string | null;
    styles: Record<string, Record<string, unknown>>;
    visible: string[];
    hidden: string[];
    texts: Record<string, string>;
  }>;
};

describe("render contract v2: selection (wire fixture)", () => {
  for (const c of wire.cases) {
    test(c.name, () => {
      const selectedId = selectedPackageId(
        wire.packages,
        c.selected ?? undefined,
        undefined,
        c.highlight ?? undefined
      );
      const seen = resolveBlocks(wire.doc, wire.packages, selectedId);
      for (const [id, expected] of Object.entries(c.styles)) {
        const style = (seen.get(id)?.style ?? {}) as Record<string, unknown>;
        for (const [k, v] of Object.entries(expected)) {
          expect([id, k, style[k]]).toEqual([id, k, v]);
        }
      }
      for (const id of c.visible) expect([id, seen.get(id)?.visible]).toEqual([id, true]);
      for (const id of c.hidden) {
        const node = seen.get(id);
        expect([id, node === undefined || node.visible === false]).toEqual([id, true]);
      }
      for (const [id, text] of Object.entries(c.texts)) {
        expect([id, seen.get(id)?.text]).toEqual([id, text]);
      }
    });
  }

  test("the selected package: host → own tap → highlight → first, each only if offered", () => {
    const pk = wire.packages;
    expect(selectedPackageId(pk, "yearly", "monthly", "monthly")).toBe("yearly");
    expect(selectedPackageId(pk, "gone", "monthly", "yearly")).toBe("monthly");
    expect(selectedPackageId(pk, undefined, undefined, "yearly")).toBe("yearly");
    expect(selectedPackageId(pk, undefined, undefined, "gone")).toBe("monthly");
    expect(selectedPackageId([], "yearly")).toBeUndefined();
  });

  test("a root-level block ignores visibility and selectedStyle", () => {
    const root = wire.doc.blocks.find((b) => b.id === "root-hidden") as TextBlock;
    expect(isVisible(root, undefined)).toBe(true);
    const styled: TextBlock = { id: "x", type: "text", text: "", style: { textColor: "#111" }, selectedStyle: { textColor: "#fff" } };
    expect(effectiveStyle(styled, undefined)).toEqual({ textColor: "#111" });
    expect(effectiveStyle(styled, "selected")).toEqual({ textColor: "#fff" });
  });

  test("a conditional close never suppresses the fallback chip", () => {
    expect(
      hasCloseAction([{ id: "x", type: "text", text: "×", action: "close", visibility: "selected" }])
    ).toBe(false);
    expect(hasCloseAction([{ id: "x", type: "text", text: "×", action: "close" }])).toBe(true);
  });
});

describe("render contract v2: canvas metrics", () => {
  test("a phone scales by width and fills a taller viewport", () => {
    const m = canvasMetrics(393, 900);
    expect(m.scale).toBe(1);
    expect(m.left).toBe(0);
    expect(m.designHeight).toBe(900);
    expect(m.overflows).toBe(false);
  });
  test("a shorter viewport overflows and scrolls", () => {
    const m = canvasMetrics(393, 700);
    expect(m.designHeight).toBe(852);
    expect(m.overflows).toBe(true);
  });
  test("a tablet caps the scale and centres the design", () => {
    const m = canvasMetrics(1024, 1366);
    expect(m.scale).toBeCloseTo(CANVAS_MAX_WIDTH / 393, 6);
    expect(m.left).toBeCloseTo((1024 - 480) / 2, 6);
    expect(m.designHeight).toBeCloseTo(1366 / m.scale, 6);
  });
});
