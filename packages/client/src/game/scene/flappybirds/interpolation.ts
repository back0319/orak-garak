const SERVER_PHYSICS_FRAME_MS = 1000 / 60;
const MAX_EXTRAPOLATION_MS = 100;
const POSITION_RESPONSE_RATE = 24;

export function getPredictionFrames(snapshotAgeMs: number): number {
  const boundedAge = Math.min(MAX_EXTRAPOLATION_MS, Math.max(0, snapshotAgeMs));
  return boundedAge / SERVER_PHYSICS_FRAME_MS;
}

export function getSmoothingAlpha(
  deltaMs: number,
  responseRate = POSITION_RESPONSE_RATE,
): number {
  const boundedDelta = Math.min(50, Math.max(0, deltaMs));
  return 1 - Math.exp((-responseRate * boundedDelta) / 1000);
}
