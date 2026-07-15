const SERVER_PHYSICS_FRAME_MS = 1000 / 60;
const MAX_EXTRAPOLATION_MS = 100;
// 원본의 프레임당 0.3 보간을 60Hz 기준으로 시간 독립적으로 변환한다.
const POSITION_RESPONSE_RATE = -Math.log(0.7) * 60;

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
