export interface TimerTiming {
  serverStartTime?: number;
  endsAt?: number;
  remainingMs?: number;
  receivedAt?: number;
}

export function calculateInitialRemainingMs(
  totalSeconds: number,
  timing: TimerTiming | undefined,
  monotonicNow: number,
  wallClockNow: number,
): number {
  const totalMs = Math.max(0, totalSeconds * 1000);

  if (timing?.remainingMs !== undefined) {
    const timeSinceReceipt = Math.max(
      0,
      monotonicNow - (timing.receivedAt ?? monotonicNow),
    );
    return Math.max(0, Math.min(totalMs, timing.remainingMs - timeSinceReceipt));
  }

  if (timing?.endsAt !== undefined) {
    return Math.max(0, Math.min(totalMs, timing.endsAt - wallClockNow));
  }

  if (timing?.serverStartTime !== undefined) {
    return Math.max(
      0,
      Math.min(totalMs, totalMs - (wallClockNow - timing.serverStartTime)),
    );
  }

  return totalMs;
}

export function calculateRemainingSeconds(
  deadline: number,
  monotonicNow: number,
): number {
  return Math.max(0, (deadline - monotonicNow) / 1000);
}
