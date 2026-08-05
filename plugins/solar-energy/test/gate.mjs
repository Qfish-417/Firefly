import assert from "node:assert/strict";

import {
  accessibilityLabel,
  assessmentContractVersion,
  solarOutputKw,
} from "../src/daylight.mjs";

const gate = process.argv[2];
const gates = {
  physics_invariants() {
    assert.equal(solarOutputKw({ hour: 0, capacityKw: 10 }), 0);
    assert.equal(solarOutputKw({ hour: 6, capacityKw: 10 }), 0);
    assert.equal(solarOutputKw({ hour: 12, capacityKw: 10 }), 10);
    assert.equal(solarOutputKw({ hour: 18, capacityKw: 10 }), 0);
    assert.equal(solarOutputKw({ hour: 23, capacityKw: 10 }), 0);
  },
  assessment_invariance() {
    assert.equal(assessmentContractVersion, "solar-assessment-v1");
  },
  accessibility() {
    assert.ok(accessibilityLabel.length >= 20);
  },
  historical_replay() {
    const expected = [0, Math.SQRT1_2, 1, Math.SQRT1_2, 0];
    const actual = [6, 9, 12, 15, 18].map((hour) =>
      solarOutputKw({ hour, capacityKw: 1 }),
    );
    actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-9));
  },
};

if (!(gate in gates)) {
  console.error(JSON.stringify({ gate, status: "failed", error: "unknown gate" }));
  process.exitCode = 2;
} else {
  try {
    gates[gate]();
    console.log(JSON.stringify({ gate, status: "passed" }));
  } catch (error) {
    console.error(
      JSON.stringify({
        gate,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exitCode = 1;
  }
}
