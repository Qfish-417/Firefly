import assert from "node:assert/strict";
import test from "node:test";

import { mapWithConcurrency } from "../src/index.ts";

test("results keep input order regardless of completion order", async () => {
  const results = await mapWithConcurrency([50, 10, 30, 0], 4, async (delay, index) => {
    await new Promise((resolve) => setTimeout(resolve, delay));
    return `${index}:${delay}`;
  });
  assert.deepEqual(results, ["0:50", "1:10", "2:30", "3:0"]);
});

test("no more than the configured number of operations run at once", async () => {
  let active = 0;
  let peak = 0;
  await mapWithConcurrency(Array.from({ length: 50 }, (_, index) => index), 4, async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active -= 1;
    return true;
  });
  assert.equal(peak <= 4, true, `peak concurrency was ${peak}`);
  assert.equal(peak > 1, true, "work should actually run in parallel");
});

test("the first failure propagates and no further work is started", async () => {
  let started = 0;
  await assert.rejects(
    () => mapWithConcurrency(Array.from({ length: 100 }, (_, index) => index), 2, async (item) => {
      started += 1;
      if (item === 3) throw new Error("boom");
      await new Promise((resolve) => setTimeout(resolve, 1));
      return item;
    }),
    /boom/u,
  );
  // Stops early rather than running all 100 items.
  assert.equal(started < 100, true, `started ${started} of 100`);
});

test("an empty input resolves without invoking the mapper", async () => {
  let calls = 0;
  const results = await mapWithConcurrency([], 4, async () => { calls += 1; return 1; });
  assert.deepEqual(results, []);
  assert.equal(calls, 0);
});

test("an invalid concurrency is refused", async () => {
  await assert.rejects(() => mapWithConcurrency([1], 0, async () => 1), /between 1 and 1000/u);
  await assert.rejects(() => mapWithConcurrency([1], 1.5, async () => 1), /between 1 and 1000/u);
  await assert.rejects(() => mapWithConcurrency([1], 5_000, async () => 1), /between 1 and 1000/u);
});
