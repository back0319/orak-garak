import type { BirdPosition } from '../../types/flappybird.types';

const PHYSICS_FRAME_MS = 1000 / 60;
const MAX_RENDER_DELTA_MS = 50;
const POSITION_CORRECTION_RATE = 10;
const ANGLE_CORRECTION_RATE = 14;
const HARD_SNAP_DISTANCE = 160;
const DEFAULT_VERTICAL_ACCELERATION = 0.75;

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

function integrate(bird: SimulatedBird, frameScale: number): void {
  bird.x += bird.velocityX * frameScale;
  bird.y +=
    bird.velocityY * frameScale +
    0.5 * bird.accelerationY * frameScale * frameScale;
  bird.velocityY += bird.accelerationY * frameScale;
}

/**
 * 서버 판정과 별개로 렌더 좌표를 매 프레임 진행시키는 작은 클라이언트 시뮬레이터.
 * 서버 스냅샷은 guide를 갱신하고, render는 시간 기반 보정으로 따라간다.
 */
export class FlappyRenderSimulation {
  private renderBirds: SimulatedBird[] = [];
  private guideBirds: SimulatedBird[] = [];
  private previousSnapshot: BirdPosition[] = [];
  private previousTick: number | null = null;

  reset(birds: BirdPosition[] = [], tick: number | null = null): void {
    this.renderBirds = birds.map((bird) => cloneBird(bird));
    this.guideBirds = birds.map((bird) => cloneBird(bird));
    this.previousSnapshot = birds.map((bird) => ({ ...bird }));
    this.previousTick = tick;
  }

  applySnapshot(tick: number, birds: BirdPosition[], force = false): void {
    const tickDelta =
      this.previousTick === null ? 0 : Math.max(0, tick - this.previousTick);
    const mustReset =
      force ||
      this.renderBirds.length !== birds.length ||
      this.guideBirds.length !== birds.length;

    if (mustReset) {
      this.reset(birds, tick);
      return;
    }

    for (let index = 0; index < birds.length; index++) {
      const snapshot = birds[index];
      const previous = this.previousSnapshot[index];
      const render = this.renderBirds[index];
      const guide = this.guideBirds[index];

      let accelerationY = guide.accelerationY;
      if (previous && tickDelta > 0) {
        const observedAcceleration =
          (snapshot.velocityY - previous.velocityY) / tickDelta;
        // 점프 입력은 큰 음수 변화이므로 중력 추정에서 제외한다.
        if (observedAcceleration >= -0.1 && observedAcceleration <= 1.5) {
          accelerationY = accelerationY * 0.6 + observedAcceleration * 0.4;
        }
      }

      Object.assign(guide, snapshot, { accelerationY });

      const errorX = snapshot.x - render.x;
      const errorY = snapshot.y - render.y;
      if (Math.hypot(errorX, errorY) > HARD_SNAP_DISTANCE) {
        Object.assign(render, snapshot, { accelerationY });
      } else {
        // 위치는 update()에서 부드럽게 맞추고, 권위 속도만 즉시 반영한다.
        render.velocityX = snapshot.velocityX;
        render.velocityY = snapshot.velocityY;
        render.accelerationY = accelerationY;
      }
    }

    this.previousSnapshot = birds.map((bird) => ({ ...bird }));
    this.previousTick = tick;
  }

  applyLocalJump(playerIndex: number, velocityY: number): void {
    const render = this.renderBirds[playerIndex];
    const guide = this.guideBirds[playerIndex];
    if (!render || !guide) {
      return;
    }

    render.velocityY = velocityY;
    render.angle = -30;
    guide.y = render.y;
    guide.velocityY = velocityY;
    guide.angle = -30;
  }

  update(deltaMs: number): readonly BirdPosition[] {
    const boundedDelta = Math.min(
      MAX_RENDER_DELTA_MS,
      Math.max(0, deltaMs),
    );
    const frameScale = boundedDelta / PHYSICS_FRAME_MS;
    const positionAlpha = smoothingAlpha(
      boundedDelta,
      POSITION_CORRECTION_RATE,
    );
    const angleAlpha = smoothingAlpha(boundedDelta, ANGLE_CORRECTION_RATE);

    for (let index = 0; index < this.renderBirds.length; index++) {
      const render = this.renderBirds[index];
      const guide = this.guideBirds[index];
      integrate(render, frameScale);
      integrate(guide, frameScale);

      render.x += (guide.x - render.x) * positionAlpha;
      render.y += (guide.y - render.y) * positionAlpha;
      render.angle += (guide.angle - render.angle) * angleAlpha;
    }

    return this.renderBirds;
  }

  getBirds(): readonly BirdPosition[] {
    return this.renderBirds;
  }
}
