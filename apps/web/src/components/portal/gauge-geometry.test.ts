import { test } from "node:test";
import assert from "node:assert/strict";
import { formatGaugePercentage, gaugeGeometry, gaugePoint, gaugeStatus } from "./gauge-geometry.ts";

test("the arc runs from the left end, over the top, to the right end", () => {
  assert.deepEqual(gaugePoint(0), { x: 20, y: 100 });
  assert.deepEqual(gaugePoint(0.5), { x: 100, y: 20 });
  assert.deepEqual(gaugePoint(1), { x: 180, y: 100 });
});

test("the filled arc ends at the percentage, and never beyond the gauge", () => {
  const half = gaugeGeometry(50, 75);
  assert.deepEqual(half.end, { x: 100, y: 20 });
  assert.equal(half.value, "M 20 100 A 80 80 0 0 1 100 20");
  assert.deepEqual(gaugeGeometry(100, 75).end, { x: 180, y: 100 });
  assert.deepEqual(gaugeGeometry(140, 75).end, { x: 180, y: 100 }, "clamped at 100%");
  assert.deepEqual(gaugeGeometry(-5, 75).end, { x: 20, y: 100 }, "clamped at 0%");
});

test("no attendance draws no reading at all — not a false 0%", () => {
  const none = gaugeGeometry(null, 75);
  assert.equal(none.value, null);
  assert.equal(none.end, null);
  assert.equal(formatGaugePercentage(null), "—");
  // A true 0% shows where the reading is, with nothing filled.
  const zero = gaugeGeometry(0, 75);
  assert.equal(zero.value, null);
  assert.deepEqual(zero.end, { x: 20, y: 100 });
});

test("the minimum is marked where the institution set it", () => {
  const { threshold } = gaugeGeometry(80, 75);
  // 75% of the way round: the tick crosses the arc there, inside to outside.
  const on = gaugePoint(0.75);
  assert.ok(Math.abs((threshold.from.x + threshold.to.x) / 2 - on.x) < 0.1);
  assert.ok(Math.abs((threshold.from.y + threshold.to.y) / 2 - on.y) < 0.1);
});

test("the reading is said in words, on the same ladder as every other attendance figure", () => {
  assert.deepEqual(gaugeStatus(null, 75), { tone: "neutral", label: "No classes recorded yet" });
  assert.deepEqual(gaugeStatus(75, 75), { tone: "positive", label: "At or above the 75% minimum" });
  assert.deepEqual(gaugeStatus(92.3, 75), { tone: "positive", label: "At or above the 75% minimum" });
  // rateTone: below the minimum but at least two thirds of it is a warning…
  assert.equal(gaugeStatus(60, 75).tone, "warning");
  assert.equal(gaugeStatus(50, 75).tone, "warning");
  // …and below two thirds is serious.
  assert.equal(gaugeStatus(49.9, 75).tone, "negative");
  assert.equal(gaugeStatus(60, 75).label, "Below the 75% minimum");
  assert.equal(gaugeStatus(80, 82.5).label, "Below the 82.5% minimum");
  assert.equal(formatGaugePercentage(81.8), "81.8%");
  assert.equal(formatGaugePercentage(100), "100.0%");
});
