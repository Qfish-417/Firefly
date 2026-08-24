import assert from "node:assert/strict";
import test from "node:test";

import { lineBlocks, type PdfTextItem } from "../src/index.ts";

function item(text: string, x: number, y: number, width: number, height: number): PdfTextItem {
  return { str: text, transform: [height, 0, 0, height, x, y], width, height };
}

test("items on the same baseline collapse into one ordered line", () => {
  const blocks = lineBlocks([
    item("world", 40, 700, 30, 12),
    item("hello", 10, 700, 25, 12),
    item("second", 10, 680, 30, 12),
  ], 1);

  assert.equal(blocks.length, 2);
  assert.equal(blocks[0]?.text, "hello world");
  assert.equal(blocks[1]?.text, "second");
  assert.equal(blocks[0]?.region_id, "page-1-line-1");
});

test("a line bbox spans the union of its items", () => {
  const blocks = lineBlocks([
    item("a", 10, 700, 20, 12),
    item("b", 50, 700, 30, 12),
  ], 2);

  const bbox = blocks[0]?.bbox;
  assert.ok(bbox);
  assert.equal(bbox[0], 10);              // min x1
  assert.equal(bbox[1], 700);             // min y1
  assert.equal(bbox[2], 80 - 10);         // width: max x2 - min x1
  assert.equal(bbox[3], 712 - 700);       // height: max y2 - min y1
});

test("an item joins the nearest candidate line, not merely the first match", () => {
  // The tall item is within tolerance of both preceding heads; it belongs with the closer one.
  const blocks = lineBlocks([
    item("A", 0, 100, 1, 12),
    item("B", 5, 96, 1, 2),
    item("C", 9, 95, 1, 30),
  ], 1);

  const withC = blocks.find((block) => block.text.includes("C"));
  assert.ok(withC);
  assert.equal(withC.text.includes("B"), true, "C should group with the nearer baseline B");
  assert.equal(withC.text.includes("A"), false);
});

test("many items on one line do not overflow the stack when computing bounds", () => {
  const items = Array.from({ length: 200_000 }, (_, index) => item("x", index, 500, 1, 10));
  const blocks = lineBlocks(items, 1);
  assert.equal(blocks.length, 1);
  const bbox = blocks[0]?.bbox;
  assert.ok(bbox);
  assert.equal(bbox[0], 0);
  assert.equal(bbox[2], 200_000);
});

test("a page of distinct baselines is grouped in linear time", () => {
  // The previous implementation scanned every known line per item; 20k lines took ~0.5s.
  const items = Array.from({ length: 20_000 }, (_, index) => item("x", 0, 1_000_000 - index * 50, 1, 10));
  const startedAt = performance.now();
  const blocks = lineBlocks(items, 1);
  const elapsed = performance.now() - startedAt;
  assert.equal(blocks.length, 20_000);
  assert.ok(elapsed < 2_000, `grouping took ${elapsed.toFixed(0)}ms`);
});

test("blank items are dropped before grouping", () => {
  const blocks = lineBlocks([item("   ", 0, 700, 10, 12), item("kept", 20, 700, 10, 12)], 1);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]?.text, "kept");
});
