import assert from "node:assert/strict";
import test from "node:test";

import { runSupervisedLoop } from "../src/supervised-loop.ts";

test("an infrastructure failure keeps the loop alive and backs off exponentially", async () => {
  const controller = new AbortController();
  const waits: number[] = [];
  const observed: number[] = [];
  let cycles = 0;

  await runSupervisedLoop(
    async () => {
      cycles += 1;
      if (cycles <= 3) throw new Error(`claim failed ${cycles}`);
      if (cycles === 4) controller.abort();
    },
    {
      signal: controller.signal,
      interval_ms: 5,
      initial_backoff_ms: 10,
      max_backoff_ms: 25,
      observe_error: (_error, failures) => observed.push(failures),
      wait: async (milliseconds) => {
        waits.push(milliseconds);
      },
    },
  );

  assert.equal(cycles, 4);
  assert.deepEqual(observed, [1, 2, 3]);
  // 10 -> 20 -> capped at 25; the loop never exits on a cycle error.
  assert.deepEqual(waits, [10, 20, 25]);
});

test("a successful cycle resets the backoff to the idle interval", async () => {
  const controller = new AbortController();
  const waits: number[] = [];
  let cycles = 0;

  await runSupervisedLoop(
    async () => {
      cycles += 1;
      if (cycles === 1) throw new Error("transient");
      if (cycles === 3) controller.abort();
    },
    {
      signal: controller.signal,
      interval_ms: 7,
      initial_backoff_ms: 10,
      observe_error: () => undefined,
      wait: async (milliseconds) => {
        waits.push(milliseconds);
      },
    },
  );

  assert.deepEqual(waits, [10, 7]);
});

test("an already aborted signal runs no cycle", async () => {
  const controller = new AbortController();
  controller.abort();
  let cycles = 0;

  await runSupervisedLoop(
    async () => {
      cycles += 1;
    },
    {
      signal: controller.signal,
      interval_ms: 1,
      observe_error: () => undefined,
      wait: async () => undefined,
    },
  );

  assert.equal(cycles, 0);
});

test("misordered intervals fail closed", async () => {
  const controller = new AbortController();
  await assert.rejects(
    runSupervisedLoop(async () => undefined, {
      signal: controller.signal,
      interval_ms: 1,
      initial_backoff_ms: 100,
      max_backoff_ms: 10,
      observe_error: () => undefined,
    }),
    /positive and ordered/,
  );
});
