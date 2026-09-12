import { describe, expect, test } from "@jest/globals";
import { resolveColor, surfaceSolid } from "./color.js";
import type { PaywallBlockDoc } from "./types.js";

// The screen background's scrim. A scrim is a gradient that is transparent at
// one end on purpose — it is what lets a photo stay visible above the copy.
// The surface used to paint a solid "fallback" under EVERY gradient, taken
// from the gradient's first stop; for a scrim that stop is the dark end, so
// the fallback was a near-black sheet across the whole screen and the photo
// behind it never showed. These pin the rule that replaced it: a gradient
// that will be drawn gets nothing under it, and the solid is only for the
// case where the gradient cannot be drawn at all.

const doc: PaywallBlockDoc = {
  version: 1,
  background: "#060910",
  textColor: "#ffffff",
  accent: "#5CF2B0",
  accentInk: "#060910",
  blocks: [],
};

// The exact scrim the bug was found with: dark first stop, transparent last.
const DARK_FIRST =
  "linear-gradient(0deg, @bg/95 0%, @bg/85 22%, @bg/72 38%, @bg/55 50%, @bg/20 62%, transparent 72%)";
// The same scrim written the other way round.
const TRANSPARENT_FIRST =
  "linear-gradient(180deg, transparent 26%, @bg/20 38%, @bg/55 50%, @bg/72 62%, @bg/85 78%, @bg/95 100%)";

describe("what a surface paints under its fill", () => {
  test("a scrim that WILL be drawn gets nothing under it", () => {
    expect(surfaceSolid(resolveColor(DARK_FIRST, doc), true)).toBeUndefined();
    expect(surfaceSolid(resolveColor(TRANSPARENT_FIRST, doc), true)).toBeUndefined();
  });

  // The degraded path the solid exists for. Without a gradient renderer the
  // app still gets a colour rather than a hole — the old behaviour, kept.
  test("without a gradient renderer the first stop is still painted", () => {
    expect(surfaceSolid(resolveColor(DARK_FIRST, doc), false)).toBe(
      "rgba(6, 9, 16, 0.95)",
    );
    expect(surfaceSolid(resolveColor(TRANSPARENT_FIRST, doc), false)).toBe(
      "transparent",
    );
  });

  test("a plain colour is painted whether or not a gradient renderer exists", () => {
    expect(surfaceSolid(resolveColor("@bg", doc), true)).toBe("#060910");
    expect(surfaceSolid(resolveColor("@bg", doc), false)).toBe("#060910");
  });

  test("an opaque decorative gradient also gets nothing under it when drawn", () => {
    const opaque = "linear-gradient(180deg, #111820 0%, #07090C 100%)";
    expect(surfaceSolid(resolveColor(opaque, doc), true)).toBeUndefined();
    expect(surfaceSolid(resolveColor(opaque, doc), false)).toBe("#111820");
  });

  // A pattern's colours are stripe colours; spreading one over the box is a
  // wrong answer, not a degraded one — unchanged from before.
  test("a repeating pattern paints nothing in either case", () => {
    const stripes =
      "repeating-linear-gradient(180deg, transparent 0 33px, #E2D2B6 33px 34px)";
    expect(surfaceSolid(resolveColor(stripes, doc), true)).toBeUndefined();
    expect(surfaceSolid(resolveColor(stripes, doc), false)).toBeUndefined();
  });

  test("no fill, no solid", () => {
    expect(surfaceSolid(undefined, true)).toBeUndefined();
    expect(surfaceSolid(undefined, false)).toBeUndefined();
  });
});
