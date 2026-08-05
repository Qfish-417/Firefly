export const assessmentContractVersion = "solar-assessment-v1";
export const accessibilityLabel = "Estimated solar output by local hour";

// Deliberate 1.2.0 defect: output incorrectly stays constant through the night.
export function solarOutputKw({ hour, capacityKw }) {
  if (!Number.isFinite(hour) || !Number.isFinite(capacityKw) || capacityKw < 0) {
    throw new TypeError("hour and non-negative capacityKw are required");
  }
  return capacityKw;
}
