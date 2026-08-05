export const assessmentContractVersion = "solar-assessment-v1";
export const accessibilityLabel = "Estimated solar output by local hour";

export function solarOutputKw({ hour, capacityKw }) {
  if (!Number.isFinite(hour) || !Number.isFinite(capacityKw) || capacityKw < 0) {
    throw new TypeError("hour and non-negative capacityKw are required");
  }
  if (hour <= 6 || hour >= 18) {
    return 0;
  }
  const daylightProgress = ((hour - 6) / 12) * Math.PI;
  return capacityKw * Math.sin(daylightProgress);
}
