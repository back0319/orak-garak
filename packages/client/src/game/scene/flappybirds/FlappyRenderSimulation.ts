import type { BirdPosition } from '../../types/flappybird.types';

const PHYSICS_FRAME_MS = 1000 / 60;
const MAX_CATCH_UP_STEPS = 8;
const MAX_EXTRAPOLATION_MS = 100;
const NETWORK_STALL_MS = 250;
const RECONCILIATION_RATE = 1000 / 110;
const ANGLE_RECONCILIATION_RATE = 1000 / 100;
const HARD_SNAP_DISTANCE = 180;
const DEFAULT_VERTICAL_ACCELERATION = 0.75;
const CLOCK_SAMPLE_COUNT = 20;

interface SimulatedBird extends BirdPosition {
  accelerationY: number;
}

function cloneBird(
  bird: BirdPosition,
  accelerationY = DEFAULT_VERTICAL_ACCELERATION,
): SimulatedBird {
  return { ...bird, accelerationY };
}

function smoothingAlpha(deltaMs: number, responseRate: number): number {
  return 1 - Math.exp((-responseRate * deltaMs) / 1000);
}

function integrate(bird: SimulatedBird, frameScale = 1): void {
  bird.x += bird.velocityX * frameScale;
  bird.y +=
    bird.velocityY * frameScale +
    0.5 * bird.accelerationY * frameScale * frameScale;
  bird.velocityY += bird.accelerationY * frameScale;
  bird.angle = Math.max(-30, Math.min(90, bird.velocityY * 10));
}

function nowMs(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

/**
 * 20Hz 권위 스냅샷 사이를 60Hz로 예측한다. 내 입력은 ack 전까지 보호하고,
 * ack 뒤에는 짧은 감쇠 보정으로 서버 궤도에 복귀한다.
 */
export class FlappyRenderSimulation {
  private renderBirds: SimulatedBird[] = [];
  private displayBirds: SimulatedBird[] = [];
  private guideBirds: SimulatedBird[] = [];
  private previousSnapshot: BirdPosition[] = [];
  private previousTick: number | null = null;
  private localPlayerIndex = -1;
  private latestLocalInputSeq = 0;
  private lastAckedLocalInputSeq = 0;
  private accumulatorMs = 0;
  private lastSnapshotReceivedAt: number | null = null;
  private clockOffsets: number[] = [];

  reset(birds: BirdPosition[] = [], tick: number | null = null): void {
    this.renderBirds = birds.map((bird) => cloneBird(bird));
    this.displayBirds = birds.map((bird) => cloneBird(bird));
    this.guideBirds = birds.map((bird) => cloneBird(bird));
    this.previousSnapshot = birds.map((bird) => ({ ...bird }));
    this.previousTick = tick;
    this.localPlayerIndex = -1;
    this.latestLocalInputSeq = 0;
    this.lastAckedLocalInputSeq = 0;
    this.accumulatorMs = 0;
    this.lastSnapshotReceivedAt = null;
    this.clockOffsets = [];
  }

  applySnapshot(
    tick: number,
    birds: BirdPosition[],
    lastProcessedInputSeqs: readonly number[] = [],
    localPlayerIndex = -1,
    receivedAt = nowMs(),
    force = false,
  ): void {
    const tickDelta =
      this.previousTick === null ? 0 : Math.max(0, tick - this.previousTick);
    const networkGap =
      this.lastSnapshotReceivedAt === null
        ? 0
        : receivedAt - this.lastSnapshotReceivedAt;
    const mustReset =
      force ||
      this.renderBirds.length !== birds.length ||
      this.displayBirds.length !== birds.length ||
      this.guideBirds.length !== birds.length;

    this.localPlayerIndex = localPlayerIndex;
    this.observeServerClock(tick, receivedAt);
    this.lastSnapshotReceivedAt = receivedAt;

    if (mustReset) {
      const predicted = birds.map((bird) => cloneBird(bird));
      const predictionFrames = this.getPredictionFrames(tick, receivedAt);
      for (const bird of predicted) integrate(bird, predictionFrames);
      this.renderBirds = predicted.map((bird) => ({ ...bird }));
      this.displayBirds = predicted.map((bird) => ({ ...bird }));
      this.guideBirds = predicted.map((bird) => ({ ...bird }));
      this.previousSnapshot = birds.map((bird) => ({ ...bird }));
      this.previousTick = tick;
      this.lastAckedLocalInputSeq =
        lastProcessedInputSeqs[localPlayerIndex] ?? 0;
      return;
    }

    const predictionFrames = this.getPredictionFrames(tick, receivedAt);

    for (let index = 0; index < birds.length; index++) {
      const snapshot = birds[index];
      const previous = this.previousSnapshot[index];
      const render = this.renderBirds[index];
      const oldGuide = this.guideBirds[index];
      let accelerationY = oldGuide.accelerationY;

      if (previous && tickDelta > 0) {
        const observedAcceleration =
          (snapshot.velocityY - previous.velocityY) / tickDelta;
        if (observedAcceleration >= -0.1 && observedAcceleration <= 1.5) {
          accelerationY = accelerationY * 0.6 + observedAcceleration * 0.4;
        }
      }

      const authority = cloneBird(snapshot, accelerationY);
      integrate(authority, predictionFrames);

      const ack = lastProcessedInputSeqs[index] ?? 0;
      const isLocal = index === localPlayerIndex;
      if (isLocal)
        this.lastAckedLocalInputSeq = Math.max(
          this.lastAckedLocalInputSeq,
          ack,
        );
      const protectsLocalJump =
        isLocal && this.lastAckedLocalInputSeq < this.latestLocalInputSeq;

      if (protectsLocalJump) {
        oldGuide.x = authority.x;
        oldGuide.velocityX = authority.velocityX;
        continue;
      }

      Object.assign(oldGuide, authority);
      const error = Math.hypot(authority.x - render.x, authority.y - render.y);
      if (error > HARD_SNAP_DISTANCE || networkGap > NETWORK_STALL_MS) {
        Object.assign(render, authority);
        Object.assign(this.displayBirds[index], authority);
      }
    }

    this.previousSnapshot = birds.map((bird) => ({ ...bird }));
    this.previousTick = tick;
  }

  applyLocalJump(
    playerIndex: number,
    inputSeq: number,
    velocityY: number,
  ): void {
    const render = this.renderBirds[playerIndex];
    const display = this.displayBirds[playerIndex];
    const guide = this.guideBirds[playerIndex];
    if (!render || !display || !guide || !Number.isSafeInteger(inputSeq))
      return;

    this.localPlayerIndex = playerIndex;
    this.latestLocalInputSeq = Math.max(this.latestLocalInputSeq, inputSeq);
    render.velocityY = velocityY;
    render.angle = -30;
    display.y = render.y;
    display.velocityY = velocityY;
    display.angle = -30;
    guide.y = render.y;
    guide.velocityY = velocityY;
    guide.angle = -30;
  }

  update(deltaMs: number, currentTime = nowMs()): readonly BirdPosition[] {
    const safeDelta = Math.max(0, deltaMs);
    if (safeDelta > NETWORK_STALL_MS) {
      this.accumulatorMs = 0;
      for (let index = 0; index < this.renderBirds.length; index++) {
        Object.assign(this.renderBirds[index], this.guideBirds[index]);
        Object.assign(this.displayBirds[index], this.guideBirds[index]);
      }
      return this.displayBirds;
    }

    this.accumulatorMs += Math.min(
      safeDelta,
      PHYSICS_FRAME_MS * MAX_CATCH_UP_STEPS,
    );
    let steps = 0;
    while (
      this.accumulatorMs + 0.001 >= PHYSICS_FRAME_MS &&
      steps < MAX_CATCH_UP_STEPS
    ) {
      this.step(PHYSICS_FRAME_MS, currentTime);
      this.accumulatorMs -= PHYSICS_FRAME_MS;
      steps += 1;
    }

    if (steps === MAX_CATCH_UP_STEPS) this.accumulatorMs = 0;
    this.sampleDisplay(currentTime);
    return this.displayBirds;
  }

  getBirds(): readonly BirdPosition[] {
    return this.displayBirds;
  }

  private step(deltaMs: number, currentTime: number): void {
    const snapshotAge =
      this.lastSnapshotReceivedAt === null
        ? 0
        : currentTime - this.lastSnapshotReceivedAt;
    const localInputPending =
      this.lastAckedLocalInputSeq < this.latestLocalInputSeq;
    const positionAlpha = smoothingAlpha(deltaMs, RECONCILIATION_RATE);
    const angleAlpha = smoothingAlpha(deltaMs, ANGLE_RECONCILIATION_RATE);

    for (let index = 0; index < this.renderBirds.length; index++) {
      const render = this.renderBirds[index];
      const guide = this.guideBirds[index];
      const isLocal = index === this.localPlayerIndex;
      const protectsLocalJump = isLocal && localInputPending;
      const renderMayAdvance =
        this.lastSnapshotReceivedAt === null ||
        snapshotAge <= NETWORK_STALL_MS ||
        protectsLocalJump;
      const guideMayAdvance =
        this.lastSnapshotReceivedAt === null ||
        snapshotAge <= MAX_EXTRAPOLATION_MS ||
        protectsLocalJump;

      if (renderMayAdvance) integrate(render);
      if (guideMayAdvance) integrate(guide);

      // 패킷이 잠깐 늦을 때 guide를 멈춘 좌표로 끌어당기면 100ms마다
      // 화면이 멎어 보인다. 신선한 guide에 대해서만 보정하고, 그 사이에는
      // 마지막 속도로 계속 그린 뒤 다음 스냅샷에서 부드럽게 복귀한다.
      if (guideMayAdvance) {
        render.x += (guide.x - render.x) * positionAlpha;
        render.velocityX +=
          (guide.velocityX - render.velocityX) * positionAlpha;

        if (!protectsLocalJump) {
          render.y += (guide.y - render.y) * positionAlpha;
          render.velocityY +=
            (guide.velocityY - render.velocityY) * positionAlpha;
          render.angle += (guide.angle - render.angle) * angleAlpha;
        }
      }
    }
  }

  /**
   * 고정 물리 스텝 사이의 남은 시간을 화면 전용 상태에 외삽한다.
   * 시뮬레이션 판정에는 영향을 주지 않으면서 60/120Hz RAF 모두에서
   * 매 렌더 프레임 좌표가 연속적으로 변한다.
   */
  private sampleDisplay(currentTime: number): void {
    const snapshotAge =
      this.lastSnapshotReceivedAt === null
        ? 0
        : currentTime - this.lastSnapshotReceivedAt;
    const localInputPending =
      this.lastAckedLocalInputSeq < this.latestLocalInputSeq;
    const frameFraction = Math.min(
      1,
      Math.max(0, this.accumulatorMs / PHYSICS_FRAME_MS),
    );

    for (let index = 0; index < this.renderBirds.length; index++) {
      const display = this.displayBirds[index];
      const render = this.renderBirds[index];
      Object.assign(display, render);

      const isLocal = index === this.localPlayerIndex;
      const mayPreview =
        this.lastSnapshotReceivedAt === null ||
        snapshotAge <= NETWORK_STALL_MS ||
        (isLocal && localInputPending);
      if (mayPreview && frameFraction > 0) {
        integrate(display, frameFraction);
      }
    }
  }

  private observeServerClock(tick: number, receivedAt: number): void {
    const offset = receivedAt - tick * PHYSICS_FRAME_MS;
    this.clockOffsets.push(offset);
    if (this.clockOffsets.length > CLOCK_SAMPLE_COUNT)
      this.clockOffsets.shift();
  }

  private getPredictionFrames(tick: number, receivedAt: number): number {
    if (this.clockOffsets.length === 0) return 0;
    const minimumOffset = Math.min(...this.clockOffsets);
    const estimatedServerTick = (receivedAt - minimumOffset) / PHYSICS_FRAME_MS;
    const predictionMs = Math.min(
      MAX_EXTRAPOLATION_MS,
      Math.max(0, (estimatedServerTick - tick) * PHYSICS_FRAME_MS),
    );
    return predictionMs / PHYSICS_FRAME_MS;
  }
}
