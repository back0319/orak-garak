import type { BirdPosition, PlayerId } from '../../types/flappybird.types';
import type {
  FlappyBirdData,
  ResolvedFlappyBirdConfig,
} from '../../../../../common/src';
import {
  FLAPPY_PHYSICS_FRAME_MS,
  applyDeterministicFlappyJump,
  createFlappyPhysicsRuntime,
  destroyFlappyPhysicsRuntime,
  restoreFlappyBirds,
  snapshotFlappyBirds,
  stepFlappyBirdPhysics,
} from '../../../../../common/src';

const MAX_CATCH_UP_STEPS = 8;
const NETWORK_STALL_MS = 250;
const HISTORY_TICKS = 30;
const CORRECTION_TIME_MS = 150;
const MAX_CORRECTION_PER_60HZ_FRAME = 2;
const REJECT_AFTER_SNAPSHOTS = 3;
const CLOCK_SAMPLE_COUNT = 8;

interface VisualOffset {
  x: number;
  y: number;
}

interface ScheduledInput {
  playerIndex: number;
  inputSeq: number;
  applyTick: number;
  accepted: boolean;
  preApplied: boolean;
  missedSnapshots: number;
}

interface HistoryState {
  tick: number;
  birds: FlappyBirdData[];
  lastFlapTicks: number[];
}

interface ClockSample {
  rttMs: number;
  receivedAt: number;
  estimatedTickAtReceive: number;
}

export interface FlappySnapshot {
  tick: number;
  birds: BirdPosition[];
  lastProcessedInputSeqs?: readonly number[];
  lastFlapTicks?: readonly number[];
  localPlayerIndex?: number;
  roundId?: string;
  physicsSeed?: number;
  config: ResolvedFlappyBirdConfig;
  receivedAt?: number;
  force?: boolean;
}

export interface FlappyAppliedInput {
  roundId: string;
  playerIndex: number;
  inputSeq: number;
  applyTick: number;
}

function nowMs(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

function toCommonBirds(birds: readonly BirdPosition[]): FlappyBirdData[] {
  return birds.map((bird) => ({
    x: bird.x,
    y: bird.y,
    vx: bird.velocityX,
    vy: bird.velocityY,
    angle: bird.angle,
  }));
}

function inputKey(playerIndex: number, inputSeq: number): string {
  return `${playerIndex}:${inputSeq}`;
}

function reduceOffset(value: number, deltaMs: number): number {
  const magnitude = Math.abs(value);
  if (magnitude < 0.001) return 0;
  const exponentialReduction =
    magnitude * (1 - Math.exp(-deltaMs / CORRECTION_TIME_MS));
  const maxReduction =
    MAX_CORRECTION_PER_60HZ_FRAME * (deltaMs / FLAPPY_PHYSICS_FRAME_MS);
  const nextMagnitude = Math.max(
    0,
    magnitude - Math.min(exponentialReduction, maxReduction),
  );
  return Math.sign(value) * nextMagnitude;
}

/**
 * 서버와 동일한 Matter.js 물리를 60Hz로 실행하고, 권위 snapshot은 tick
 * 단위 rewind/replay에만 사용한다. 화면에는 위치 offset만 단조 감쇠해
 * snapshot 도착 시 물리 속도가 뒤집히거나 좌표가 순간이동하지 않는다.
 */
export class FlappyRenderSimulation {
  private runtime: ReturnType<typeof createFlappyPhysicsRuntime> | null = null;
  private config: ResolvedFlappyBirdConfig | null = null;
  private tick = 0;
  private physicsSeed = 0;
  private roundId = '';
  private localPlayerIndex = -1;
  private lastFlapTicks: number[] = [];
  private accumulatorMs = 0;
  private frameFraction = 0;
  private displayBirds: BirdPosition[] = [];
  private visualOffsets: VisualOffset[] = [];
  private scheduledInputs = new Map<string, ScheduledInput>();
  private history = new Map<number, HistoryState>();
  private clockSamples: ClockSample[] = [];
  private clockAnchor: { clientTime: number; serverTick: number } | null = null;
  private needsHardSync = false;

  reset(): void {
    if (this.runtime) destroyFlappyPhysicsRuntime(this.runtime);
    this.runtime = null;
    this.config = null;
    this.tick = 0;
    this.physicsSeed = 0;
    this.roundId = '';
    this.localPlayerIndex = -1;
    this.lastFlapTicks = [];
    this.accumulatorMs = 0;
    this.frameFraction = 0;
    this.displayBirds = [];
    this.visualOffsets = [];
    this.scheduledInputs.clear();
    this.history.clear();
    this.clockSamples = [];
    this.clockAnchor = null;
    this.needsHardSync = false;
  }

  getRoundId(): string {
    return this.roundId;
  }

  applySnapshot(snapshot: FlappySnapshot): void {
    const receivedAt = snapshot.receivedAt ?? nowMs();
    const birds = toCommonBirds(snapshot.birds);
    const roundChanged = Boolean(
      snapshot.roundId && this.roundId && snapshot.roundId !== this.roundId,
    );
    const mustInitialize =
      snapshot.force ||
      this.needsHardSync ||
      roundChanged ||
      !this.runtime ||
      this.runtime.birds.length !== birds.length ||
      !this.config;

    this.localPlayerIndex = snapshot.localPlayerIndex ?? this.localPlayerIndex;
    this.roundId = snapshot.roundId ?? this.roundId;
    this.physicsSeed = snapshot.physicsSeed ?? this.physicsSeed;
    this.config = snapshot.config;

    if (mustInitialize) {
      if (roundChanged) {
        this.clockSamples = [];
        this.clockAnchor = null;
      }
      this.initializeFromSnapshot(snapshot.tick, birds, snapshot.lastFlapTicks);
      this.clockAnchor ??= {
        clientTime: receivedAt,
        serverTick: snapshot.tick,
      };
      this.needsHardSync = false;
      return;
    }

    const oldDisplay = this.copyDisplay();
    const replayUntil = Math.max(this.tick, snapshot.tick);
    const acknowledged =
      snapshot.lastProcessedInputSeqs?.[this.localPlayerIndex] ?? 0;

    for (const [key, input] of this.scheduledInputs) {
      if (input.accepted && input.applyTick <= snapshot.tick) {
        this.scheduledInputs.delete(key);
        continue;
      }
      if (
        input.playerIndex === this.localPlayerIndex &&
        input.inputSeq <= acknowledged
      ) {
        this.scheduledInputs.delete(key);
        continue;
      }
      if (
        !input.accepted &&
        input.playerIndex === this.localPlayerIndex &&
        snapshot.tick >= input.applyTick
      ) {
        input.missedSnapshots += 1;
        if (input.missedSnapshots >= REJECT_AFTER_SNAPSHOTS) {
          this.scheduledInputs.delete(key);
          continue;
        }
        if (input.applyTick <= snapshot.tick)
          input.applyTick = snapshot.tick + 1;
      }
      input.preApplied = false;
    }

    this.restoreAtTick(snapshot.tick, birds, snapshot.lastFlapTicks);
    while (this.tick < replayUntil) this.stepNextTick();
    this.preserveDisplay(oldDisplay);
  }

  applyInputApplied(input: FlappyAppliedInput): void {
    if (!this.runtime || !this.config) return;
    if (this.roundId && input.roundId !== this.roundId) return;

    const key = inputKey(input.playerIndex, input.inputSeq);
    const existing = this.scheduledInputs.get(key);
    if (existing) {
      const alreadyAppliedAtSameBoundary =
        existing.preApplied && existing.applyTick === input.applyTick;
      existing.applyTick = input.applyTick;
      existing.accepted = true;
      existing.preApplied = alreadyAppliedAtSameBoundary;
      existing.missedSnapshots = 0;

      if (!alreadyAppliedAtSameBoundary) {
        const replayBaseTick =
          input.applyTick <= this.tick ? input.applyTick - 1 : this.tick;
        this.replayFromHistory(replayBaseTick);
        return;
      }
    } else {
      this.scheduledInputs.set(key, {
        ...input,
        accepted: true,
        preApplied: false,
        missedSnapshots: 0,
      });
    }

    if (input.applyTick <= this.tick)
      this.replayFromHistory(input.applyTick - 1);
  }

  applyLocalJump(playerIndex: number, inputSeq: number): void {
    if (!this.runtime || !this.config || !Number.isSafeInteger(inputSeq))
      return;
    const applyTick = this.tick + 1;
    const applied = applyDeterministicFlappyJump(
      this.runtime.birds,
      playerIndex,
      inputSeq,
      this.physicsSeed,
      this.config,
    );
    if (!applied) return;

    this.lastFlapTicks[playerIndex] = this.tick;
    this.scheduledInputs.set(inputKey(playerIndex, inputSeq), {
      playerIndex,
      inputSeq,
      applyTick,
      accepted: false,
      preApplied: true,
      missedSnapshots: 0,
    });
    // 위치는 건드리지 않는다. displayBirds도 다음 RAF update 전까지 유지되므로
    // 입력 프레임에서는 y가 그대로이고 다음 프레임부터 새 velocity로 상승한다.
  }

  observeClockPong(
    clientSentAt: number,
    serverTick: number,
    receivedAt = nowMs(),
    roundId?: string,
  ): void {
    if (roundId && this.roundId && roundId !== this.roundId) return;
    const rttMs = Math.max(0, receivedAt - clientSentAt);
    this.clockSamples.push({
      rttMs,
      receivedAt,
      estimatedTickAtReceive: serverTick + rttMs / 2 / FLAPPY_PHYSICS_FRAME_MS,
    });
    if (this.clockSamples.length > CLOCK_SAMPLE_COUNT)
      this.clockSamples.shift();
    const best = this.clockSamples.reduce((minimum, sample) =>
      sample.rttMs < minimum.rttMs ? sample : minimum,
    );
    this.clockAnchor = {
      clientTime: receivedAt,
      serverTick:
        best.estimatedTickAtReceive +
        (receivedAt - best.receivedAt) / FLAPPY_PHYSICS_FRAME_MS,
    };
  }

  update(deltaMs: number, currentTime = nowMs()): readonly BirdPosition[] {
    if (!this.runtime || !this.config) return this.displayBirds;
    const safeDelta = Math.max(0, deltaMs);
    if (safeDelta > NETWORK_STALL_MS) {
      this.needsHardSync = true;
      this.accumulatorMs = 0;
      this.frameFraction = 0;
      this.refreshDisplay();
      return this.displayBirds;
    }

    let targetTick = this.tick;
    if (this.clockAnchor) {
      const desiredTick =
        this.clockAnchor.serverTick +
        (currentTime - this.clockAnchor.clientTime) / FLAPPY_PHYSICS_FRAME_MS;
      targetTick = Math.max(this.tick, Math.floor(desiredTick));
      this.frameFraction = Math.max(0, Math.min(1, desiredTick - targetTick));
    } else {
      this.accumulatorMs += Math.min(
        safeDelta,
        FLAPPY_PHYSICS_FRAME_MS * MAX_CATCH_UP_STEPS,
      );
      targetTick =
        this.tick + Math.floor(this.accumulatorMs / FLAPPY_PHYSICS_FRAME_MS);
    }

    let steps = 0;
    while (this.tick < targetTick && steps < MAX_CATCH_UP_STEPS) {
      this.stepNextTick();
      steps += 1;
      if (!this.clockAnchor) this.accumulatorMs -= FLAPPY_PHYSICS_FRAME_MS;
    }
    if (!this.clockAnchor) {
      this.frameFraction = Math.max(
        0,
        Math.min(1, this.accumulatorMs / FLAPPY_PHYSICS_FRAME_MS),
      );
    }

    this.decayVisualOffsets(safeDelta);
    this.refreshDisplay();
    return this.displayBirds;
  }

  getBirds(): readonly BirdPosition[] {
    this.refreshDisplay();
    return this.displayBirds;
  }

  private initializeFromSnapshot(
    tick: number,
    birds: readonly FlappyBirdData[],
    lastFlapTicks: readonly number[] = [],
  ): void {
    if (this.runtime) destroyFlappyPhysicsRuntime(this.runtime);
    this.runtime = createFlappyPhysicsRuntime(
      birds.length,
      this.config?.connectAll ?? false,
      birds,
    );
    this.tick = tick;
    this.lastFlapTicks = Array.from(
      { length: birds.length },
      (_, index) => lastFlapTicks[index] ?? 0,
    );
    this.visualOffsets = birds.map(() => ({ x: 0, y: 0 }));
    this.scheduledInputs.clear();
    this.history.clear();
    this.accumulatorMs = 0;
    this.frameFraction = 0;
    this.saveHistory();
    this.refreshDisplay();
  }

  private restoreAtTick(
    tick: number,
    birds: readonly FlappyBirdData[],
    lastFlapTicks: readonly number[] = [],
  ): void {
    if (!this.runtime) return;
    restoreFlappyBirds(this.runtime.birds, birds);
    this.tick = tick;
    this.lastFlapTicks = Array.from(
      { length: birds.length },
      (_, index) => lastFlapTicks[index] ?? 0,
    );
    this.history.clear();
    this.saveHistory();
  }

  private stepNextTick(): void {
    if (!this.runtime || !this.config) return;
    const nextTick = this.tick + 1;
    const inputs = [...this.scheduledInputs.values()]
      .filter((input) => input.applyTick === nextTick)
      .sort((a, b) =>
        a.playerIndex === b.playerIndex
          ? a.inputSeq - b.inputSeq
          : a.playerIndex - b.playerIndex,
      );
    for (const input of inputs) {
      if (input.preApplied) {
        input.preApplied = false;
        continue;
      }
      applyDeterministicFlappyJump(
        this.runtime.birds,
        input.playerIndex,
        input.inputSeq,
        this.physicsSeed,
        this.config,
      );
      this.lastFlapTicks[input.playerIndex] = nextTick - 1;
    }

    stepFlappyBirdPhysics({
      runtime: this.runtime,
      tick: nextTick,
      lastFlapTicks: this.lastFlapTicks,
      config: this.config,
    });
    this.tick = nextTick;
    this.saveHistory();
  }

  private replayFromHistory(baseTick: number): void {
    if (!this.runtime) return;
    const base = this.history.get(baseTick);
    if (!base) return;
    const oldDisplay = this.copyDisplay();
    const replayUntil = this.tick;
    for (const input of this.scheduledInputs.values()) input.preApplied = false;
    restoreFlappyBirds(this.runtime.birds, base.birds);
    this.lastFlapTicks = [...base.lastFlapTicks];
    this.tick = base.tick;
    this.history.clear();
    this.saveHistory();
    while (this.tick < replayUntil) this.stepNextTick();
    this.preserveDisplay(oldDisplay);
  }

  private saveHistory(): void {
    if (!this.runtime) return;
    this.history.set(this.tick, {
      tick: this.tick,
      birds: snapshotFlappyBirds(this.runtime.birds),
      lastFlapTicks: [...this.lastFlapTicks],
    });
    const oldestTick = this.tick - HISTORY_TICKS;
    for (const tick of this.history.keys()) {
      if (tick < oldestTick) this.history.delete(tick);
    }
  }

  private copyDisplay(): BirdPosition[] {
    this.refreshDisplay();
    return this.displayBirds.map((bird) => ({ ...bird }));
  }

  private preserveDisplay(previous: readonly BirdPosition[]): void {
    if (!this.runtime) return;
    const raw = snapshotFlappyBirds(this.runtime.birds);
    this.visualOffsets = raw.map((bird, index) => ({
      x:
        (previous[index]?.x ?? bird.x) -
        (bird.x + bird.vx * this.frameFraction),
      y:
        (previous[index]?.y ?? bird.y) -
        (bird.y + bird.vy * this.frameFraction),
    }));
    this.refreshDisplay();
  }

  private decayVisualOffsets(deltaMs: number): void {
    for (let index = 0; index < this.visualOffsets.length; index++) {
      const hasPendingLocalInput = [...this.scheduledInputs.values()].some(
        (input) => !input.accepted && input.playerIndex === index,
      );
      if (hasPendingLocalInput) continue;
      const offset = this.visualOffsets[index];
      offset.x = reduceOffset(offset.x, deltaMs);
      offset.y = reduceOffset(offset.y, deltaMs);
    }
  }

  private refreshDisplay(): void {
    if (!this.runtime) return;
    const raw = snapshotFlappyBirds(this.runtime.birds);
    this.displayBirds = raw.map((bird, index) => {
      const offset = this.visualOffsets[index] ?? { x: 0, y: 0 };
      return {
        playerId: String(index) as PlayerId,
        x: bird.x + bird.vx * this.frameFraction + offset.x,
        y: bird.y + bird.vy * this.frameFraction + offset.y,
        velocityX: bird.vx,
        velocityY: bird.vy,
        angle: Math.max(-30, Math.min(90, bird.vy * 10)),
      };
    });
  }
}
