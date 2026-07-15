import Matter from 'matter-js';
import type { FlappyBirdData } from './common-type';
import type { ResolvedFlappyBirdConfig } from './config';
import { FLAPPY_PHYSICS } from './config';

export const FLAPPY_PHYSICS_FPS = 60;
export const FLAPPY_NETWORK_FPS = 20;
export const FLAPPY_PHYSICS_SUBSTEPS = 2;
export const FLAPPY_PHYSICS_FRAME_MS = 1000 / FLAPPY_PHYSICS_FPS;

export interface FlappyPhysicsRuntime {
  engine: Matter.Engine;
  birds: Matter.Body[];
}

export interface FlappyPhysicsSnapshot {
  birds: FlappyBirdData[];
  lastFlapTicks: number[];
}

function hashInput(
  seed: number,
  playerIndex: number,
  inputSeq: number,
  salt: number,
): number {
  let value =
    (seed ^
      Math.imul(playerIndex + 1, 0x9e3779b1) ^
      Math.imul(inputSeq, 0x85ebca6b) ^
      Math.imul(salt + 1, 0xc2b2ae35)) >>>
    0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return value >>> 0;
}

function deterministicUnit(
  seed: number,
  playerIndex: number,
  inputSeq: number,
  salt: number,
): number {
  return hashInput(seed, playerIndex, inputSeq, salt) / 0x1_0000_0000;
}

export function calculateFlappyBirdPositions(
  count: number,
  connectAll: boolean,
): { x: number; y: number }[] {
  const centerX = 300;
  const centerY = 350;
  const spacing = 80;

  if (!connectAll || count < 3) {
    return Array.from({ length: count }, (_, index) => ({
      x: 250 + index * 90,
      y: 300 + index * 3,
    }));
  }

  if (count === 3) {
    return [
      { x: centerX, y: centerY - spacing * 0.6 },
      { x: centerX - spacing, y: centerY + spacing * 0.4 },
      { x: centerX + spacing, y: centerY + spacing * 0.4 },
    ];
  }

  if (count === 4) {
    return [
      { x: centerX, y: centerY - spacing },
      { x: centerX - spacing, y: centerY },
      { x: centerX, y: centerY + spacing },
      { x: centerX + spacing, y: centerY },
    ];
  }

  return Array.from({ length: count }, (_, index) => {
    const angle = (2 * Math.PI * index) / count - Math.PI / 2;
    return {
      x: centerX + spacing * Math.cos(angle),
      y: centerY + spacing * Math.sin(angle),
    };
  });
}

export function calculateFlappyRopeConnections(
  playerCount: number,
  connectAll: boolean,
): [number, number][] {
  if (playerCount < 2) return [];

  const connections: [number, number][] = [];
  for (let index = 0; index < playerCount - 1; index++) {
    connections.push([index, index + 1]);
  }
  if (connectAll && playerCount >= 3) {
    connections.push([playerCount - 1, 0]);
  }
  return connections;
}

export function createFlappyPhysicsRuntime(
  playerCount: number,
  connectAll: boolean,
  initialBirds?: readonly FlappyBirdData[],
): FlappyPhysicsRuntime {
  const engine = Matter.Engine.create({
    gravity: { x: 0, y: FLAPPY_PHYSICS.GRAVITY_Y },
    enableSleeping: false,
    positionIterations: 10,
    velocityIterations: 10,
  });
  const positions = calculateFlappyBirdPositions(playerCount, connectAll);
  const birds = positions.map((position, index) => {
    const initial = initialBirds?.[index];
    const bird = Matter.Bodies.rectangle(
      initial?.x ?? position.x,
      initial?.y ?? position.y,
      FLAPPY_PHYSICS.BIRD_WIDTH,
      FLAPPY_PHYSICS.BIRD_HEIGHT,
      {
        chamfer: { radius: 10 },
        density: 0.001,
        restitution: 0.2,
        friction: 0.1,
        frictionAir: 0.05,
        label: 'bird',
        collisionFilter: {
          category: FLAPPY_PHYSICS.CATEGORY_BIRD,
          mask:
            FLAPPY_PHYSICS.CATEGORY_BIRD |
            FLAPPY_PHYSICS.CATEGORY_PIPE |
            FLAPPY_PHYSICS.CATEGORY_GROUND,
        },
      },
    );
    if (initial) {
      Matter.Body.setVelocity(bird, { x: initial.vx, y: initial.vy });
      Matter.Body.setAngle(bird, initial.angle * (Math.PI / 180));
    }
    return bird;
  });
  Matter.World.add(engine.world, birds);
  return { engine, birds };
}

export function destroyFlappyPhysicsRuntime(
  runtime: FlappyPhysicsRuntime,
): void {
  Matter.World.clear(runtime.engine.world, false);
  Matter.Engine.clear(runtime.engine);
  runtime.birds.length = 0;
}

export function snapshotFlappyBirds(
  birds: readonly Matter.Body[],
): FlappyBirdData[] {
  return birds.map((bird) => ({
    x: bird.position.x,
    y: bird.position.y,
    vx: bird.velocity.x,
    vy: bird.velocity.y,
    angle: bird.angle * (180 / Math.PI),
  }));
}

export function restoreFlappyBirds(
  birds: readonly Matter.Body[],
  snapshots: readonly FlappyBirdData[],
): void {
  for (let index = 0; index < birds.length; index++) {
    const bird = birds[index];
    const snapshot = snapshots[index];
    if (!bird || !snapshot) continue;
    Matter.Body.setStatic(bird, false);
    Matter.Body.setPosition(bird, { x: snapshot.x, y: snapshot.y });
    Matter.Body.setVelocity(bird, { x: snapshot.vx, y: snapshot.vy });
    Matter.Body.setAngle(bird, snapshot.angle * (Math.PI / 180));
    Matter.Body.setAngularVelocity(bird, 0);
    bird.force.x = 0;
    bird.force.y = 0;
  }
}

export function applyDeterministicFlappyJump(
  birds: readonly Matter.Body[],
  playerIndex: number,
  inputSeq: number,
  physicsSeed: number,
  config: Pick<ResolvedFlappyBirdConfig, 'flapBoostBase' | 'flapBoostRandom'>,
): boolean {
  const bird = birds[playerIndex];
  if (!bird || !Number.isSafeInteger(inputSeq) || inputSeq <= 0) return false;

  const horizontalRandom = deterministicUnit(
    physicsSeed,
    playerIndex,
    inputSeq,
    0,
  );
  const verticalRandom = deterministicUnit(
    physicsSeed,
    playerIndex,
    inputSeq,
    1,
  );
  const extraBoost =
    config.flapBoostBase + horizontalRandom * config.flapBoostRandom;
  const verticalJitter =
    (verticalRandom - 0.5) *
    Math.abs(FLAPPY_PHYSICS.FLAP_VELOCITY) *
    FLAPPY_PHYSICS.FLAP_VERTICAL_JITTER_RATIO;

  Matter.Body.setVelocity(bird, {
    x: bird.velocity.x + extraBoost,
    y: FLAPPY_PHYSICS.FLAP_VELOCITY + verticalJitter,
  });
  Matter.Body.setAngularVelocity(bird, 0);
  return true;
}

function enforceRopeConstraint(
  birds: readonly Matter.Body[],
  ropeConnections: readonly [number, number][],
  ropeLength: number,
): void {
  for (const [indexA, indexB] of ropeConnections) {
    const birdA = birds[indexA];
    const birdB = birds[indexB];
    if (!birdA || !birdB) continue;

    const dx = birdB.position.x - birdA.position.x;
    const dy = birdB.position.y - birdA.position.y;
    const distance = Math.hypot(dx, dy);
    if (distance === 0 || distance <= ropeLength) continue;

    const nx = dx / distance;
    const ny = dy / distance;
    const correction = (distance - ropeLength) / 2;
    Matter.Body.setPosition(birdA, {
      x: birdA.position.x + nx * correction,
      y: birdA.position.y + ny * correction,
    });
    Matter.Body.setPosition(birdB, {
      x: birdB.position.x - nx * correction,
      y: birdB.position.y - ny * correction,
    });

    const relVx = birdB.velocity.x - birdA.velocity.x;
    const relVy = birdB.velocity.y - birdA.velocity.y;
    const separatingSpeed = relVx * nx + relVy * ny;
    if (separatingSpeed <= 0) continue;

    const adjust = separatingSpeed / 2;
    Matter.Body.setVelocity(birdA, {
      x: birdA.velocity.x + nx * adjust,
      y: birdA.velocity.y + ny * adjust,
    });
    Matter.Body.setVelocity(birdB, {
      x: birdB.velocity.x - nx * adjust,
      y: birdB.velocity.y - ny * adjust,
    });
  }
}

export function stepFlappyBirdPhysics(options: {
  runtime: FlappyPhysicsRuntime;
  tick: number;
  lastFlapTicks: readonly number[];
  config: Pick<
    ResolvedFlappyBirdConfig,
    'pipeSpeed' | 'ropeLength' | 'connectAll'
  >;
  onSubstep?: () => boolean;
}): boolean {
  const { runtime, tick, lastFlapTicks, config, onSubstep } = options;
  const ropeConnections = calculateFlappyRopeConnections(
    runtime.birds.length,
    config.connectAll,
  );

  for (let index = 0; index < runtime.birds.length; index++) {
    const bird = runtime.birds[index];
    if (bird.isStatic) continue;

    const baseForwardSpeed = config.pipeSpeed * 1.5;
    const framesSinceFlap = tick - (lastFlapTicks[index] ?? 0);
    const noFlapPenalty = framesSinceFlap > 30 ? 0.97 : 0.995;
    const velocityX =
      bird.velocity.x < baseForwardSpeed
        ? bird.velocity.x + 0.05
        : bird.velocity.x * noFlapPenalty;
    Matter.Body.setVelocity(bird, { x: velocityX, y: bird.velocity.y });
  }

  enforceRopeConstraint(runtime.birds, ropeConnections, config.ropeLength);
  for (const bird of runtime.birds) {
    if (bird.isStatic) continue;
    const angle = Math.max(-30, Math.min(90, bird.velocity.y * 10));
    Matter.Body.setAngle(bird, angle * (Math.PI / 180));
  }

  const substepMs = FLAPPY_PHYSICS_FRAME_MS / FLAPPY_PHYSICS_SUBSTEPS;
  for (let substep = 0; substep < FLAPPY_PHYSICS_SUBSTEPS; substep++) {
    Matter.Engine.update(runtime.engine, substepMs);
    if (onSubstep && !onSubstep()) return false;
  }
  return true;
}
