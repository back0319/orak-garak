export interface FixedStepAdvance {
  steps: number;
  droppedMs: number;
}

/**
 * Wall-clock 시간을 고정 물리 스텝으로 변환한다.
 * 긴 런타임 정지 뒤에는 제한된 횟수만 따라잡아 spiral of death를 막는다.
 */
export class FixedStepClock {
  private accumulatorMs = 0;
  private lastUpdateAtMs: number | null = null;

  constructor(
    private readonly stepMs: number,
    private readonly maxCatchUpSteps: number,
  ) {
    if (stepMs <= 0 || maxCatchUpSteps < 1) {
      throw new Error('Invalid fixed-step clock configuration');
    }
  }

  reset(nowMs: number): void {
    this.accumulatorMs = 0;
    this.lastUpdateAtMs = nowMs;
  }

  advance(nowMs: number): FixedStepAdvance {
    if (this.lastUpdateAtMs === null) {
      this.reset(nowMs);
      return { steps: 0, droppedMs: 0 };
    }

    const elapsedMs = Math.max(0, nowMs - this.lastUpdateAtMs);
    this.lastUpdateAtMs = nowMs;

    const maxElapsedMs = this.stepMs * this.maxCatchUpSteps;
    const acceptedMs = Math.min(elapsedMs, maxElapsedMs);
    this.accumulatorMs = Math.min(
      this.accumulatorMs + acceptedMs,
      maxElapsedMs,
    );

    const epsilon = this.stepMs * 1e-9;
    const steps = Math.min(
      this.maxCatchUpSteps,
      Math.floor((this.accumulatorMs + epsilon) / this.stepMs),
    );
    this.accumulatorMs = Math.max(0, this.accumulatorMs - steps * this.stepMs);

    return {
      steps,
      droppedMs: Math.max(0, elapsedMs - acceptedMs),
    };
  }
}
