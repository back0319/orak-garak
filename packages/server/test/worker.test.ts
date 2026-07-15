import { env, exports } from 'cloudflare:workers';
import { evictDurableObject, runDurableObjectAlarm } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Matter from 'matter-js';
import {
  GameType,
  FlappyBirdPacketType,
  FLAPPY_NETWORK_FPS,
  FLAPPY_PHYSICS,
  FLAPPY_PHYSICS_FRAME_MS,
  FLAPPY_PHYSICS_SUBSTEPS,
  RoomUpdateType,
  SystemPacketType,
  calculateFlappyRopeConnections,
  createFlappyPhysicsRuntime,
  destroyFlappyPhysicsRuntime,
  getDefaultConfig,
  resolveFlappyBirdPreset,
  snapshotFlappyBirds,
  stepFlappyBirdPhysics,
  type GameConfig,
  type FlappyBirdGamePreset,
} from '@main-game/common';
import {
  GameSession,
  type PersistedGameSession,
} from '../src/games/gameSession';
import type { GameSocket, GameTransport } from '../src/network/transport';
import { getSmoothingAlpha } from '../../client/src/game/scene/flappybirds/interpolation';
import {
  calculateInitialRemainingMs,
  calculateRemainingSeconds,
} from '../../client/src/game/utils/timerDeadline';
import { FixedStepClock } from '../src/games/instances/fixedStepClock';
import { FlappyBirdInstance } from '../src/games/instances/FlappyBirdInstance';

interface Packet {
  type: string;
  [key: string]: unknown;
}

class TestSocket {
  private readonly queued: Packet[] = [];
  private readonly waiters = new Map<string, Array<(packet: Packet) => void>>();

  constructor(readonly socket: WebSocket) {
    socket.accept();
    socket.addEventListener('message', (event) => {
      const packet = JSON.parse(String(event.data)) as Packet;
      const waiter = this.waiters.get(packet.type)?.shift();
      if (waiter) waiter(packet);
      else this.queued.push(packet);
    });
  }

  send(packet: Packet): void {
    this.socket.send(JSON.stringify(packet));
  }

  next(type: string): Promise<Packet> {
    const index = this.queued.findIndex((packet) => packet.type === type);
    if (index >= 0) return Promise.resolve(this.queued.splice(index, 1)[0]);
    return new Promise((resolve) => {
      const waiters = this.waiters.get(type) ?? [];
      waiters.push(resolve);
      this.waiters.set(type, waiters);
    });
  }

  has(type: string): boolean {
    return this.queued.some((packet) => packet.type === type);
  }

  close(): void {
    this.socket.close(1000, 'test complete');
  }
}

const sockets: TestSocket[] = [];

afterEach(() => {
  for (const socket of sockets.splice(0)) socket.close();
});

async function createRoom(): Promise<string> {
  const response = await exports.default.fetch(
    new Request('https://orak-garak.test/api/rooms', { method: 'POST' }),
  );
  expect(response.status).toBe(201);
  return ((await response.json()) as { roomId: string }).roomId;
}

async function openRoom(roomId: string): Promise<TestSocket> {
  const response = await exports.default.fetch(
    new Request(`https://orak-garak.test/ws/rooms/${roomId}`, {
      headers: { Upgrade: 'websocket', Origin: 'https://orak-garak.test' },
    }),
  );
  expect(response.status).toBe(101);
  const socket = new TestSocket(response.webSocket!);
  sockets.push(socket);
  return socket;
}

async function join(
  roomId: string,
  playerName: string,
  credentials: { playerId: string; resumeToken: string } | null = null,
): Promise<{ socket: TestSocket; accepted: Packet; room: Packet }> {
  const socket = await openRoom(roomId);
  socket.send({
    type: SystemPacketType.JOIN_ROOM,
    roomId,
    playerName,
    ...(credentials ?? {}),
  });
  const accepted = await socket.next(SystemPacketType.JOIN_ACCEPTED);
  const room = await socket.next(SystemPacketType.ROOM_UPDATE);
  return { socket, accepted, room };
}

describe('Orak Garak Worker', () => {
  it('reports health and creates lowercase 10 character room IDs', async () => {
    const health = await exports.default.fetch(
      'https://orak-garak.test/api/health',
    );
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({
      ok: true,
      service: 'orak-garak',
      runtime: 'cloudflare-workers',
    });

    expect(await createRoom()).toMatch(/^[a-z0-9]{10}$/);
  });

  it('rejects invalid room IDs and non-WebSocket room requests', async () => {
    const invalid = await exports.default.fetch(
      new Request('https://orak-garak.test/ws/rooms/INVALID'),
    );
    expect(invalid.status).toBe(400);

    const roomId = await createRoom();
    const upgradeRequired = await exports.default.fetch(
      new Request(`https://orak-garak.test/ws/rooms/${roomId}`),
    );
    expect(upgradeRequired.status).toBe(426);
  });

  it('keeps rooms isolated and assigns stable host/player order', async () => {
    const firstRoom = await createRoom();
    const secondRoom = await createRoom();
    const first = await join(firstRoom, '방장');
    const second = await join(secondRoom, '다른방');

    expect(first.room.roomId).toBe(firstRoom);
    expect(first.room.yourIndex).toBe(0);
    expect(second.room.roomId).toBe(secondRoom);
    expect((second.room.players as unknown[]).length).toBe(1);

    const guest = await join(firstRoom, '게스트');
    expect(guest.room.yourIndex).toBe(1);
    const hostUpdate = await first.socket.next(SystemPacketType.ROOM_UPDATE);
    expect(hostUpdate.updateType).toBe(RoomUpdateType.PLAYER_JOIN);
    expect((hostUpdate.players as unknown[]).length).toBe(2);
  });

  it('allows four players and rejects a fifth player', async () => {
    const roomId = await createRoom();
    for (let index = 0; index < 4; index += 1) {
      await join(roomId, `p${index}`);
    }

    const fifth = await openRoom(roomId);
    fifth.send({
      type: SystemPacketType.JOIN_ROOM,
      roomId,
      playerName: 'p5',
    });
    const rejection = await fifth.next(SystemPacketType.SYSTEM_MESSAGE);
    expect(rejection.message).toBe('방이 꽉 찼습니다.');
  });

  it('restores a player with its resume token across a Durable Object eviction', async () => {
    const roomId = await createRoom();
    const first = await join(roomId, '재접속');
    const credentials = {
      playerId: String(first.accepted.playerId),
      resumeToken: String(first.accepted.resumeToken),
    };
    const stub = env.GAME_ROOMS.getByName(roomId);
    await evictDurableObject(stub, { webSockets: 'hibernate' });
    const resumed = await join(roomId, '재접속', credentials);
    expect(resumed.accepted.resumed).toBe(true);
    expect(resumed.accepted.playerId).toBe(credentials.playerId);
    expect(resumed.room.yourIndex).toBe(0);
  });

  it('closes an oversized WebSocket frame', async () => {
    const roomId = await createRoom();
    const socket = await openRoom(roomId);
    const closed = new Promise<CloseEvent>((resolve) => {
      socket.socket.addEventListener('close', resolve, { once: true });
    });
    socket.socket.send('x'.repeat(16 * 1024 + 1));
    expect((await closed).code).toBe(1009);
  });

  it('promotes the next player to host when the current host leaves', () => {
    const transport: GameTransport = {
      sockets: { sockets: new Map() },
      to: () => ({ emit: () => undefined }),
      scheduleAlarm: async () => undefined,
      clearAlarm: async () => undefined,
    };
    const session = new GameSession(transport, 'abcdefghij');
    session.addPlayer('host', '방장');
    session.addPlayer('next', '다음');

    expect(session.isHost('host')).toBe(true);
    session.removePlayer('host');
    expect(session.isHost('next')).toBe(true);
  });

  it('closes a connection that exceeds the per-second message limit', async () => {
    const roomId = await createRoom();
    const joined = await join(roomId, '속도제한');
    const closed = new Promise<CloseEvent>((resolve) => {
      joined.socket.socket.addEventListener('close', resolve, { once: true });
    });

    for (let index = 0; index < 61; index += 1) {
      joined.socket.send({
        type: SystemPacketType.UPDATE_NUMBER,
        number: index,
      });
    }
    expect((await closed).code).toBe(1008);
  });

  it('finishes an Apple round through a Durable Object alarm', async () => {
    const roomId = await createRoom();
    const joined = await join(roomId, '알람');
    joined.socket.send({
      type: SystemPacketType.GAME_CONFIG_UPDATE_REQ,
      selectedGameType: GameType.APPLE_GAME,
      gameConfig: {
        gridCols: 20,
        gridRows: 10,
        minNumber: 1,
        maxNumber: 9,
        totalTime: 30,
        includeZero: false,
      },
    });
    await joined.socket.next(SystemPacketType.GAME_CONFIG_UPDATE);
    joined.socket.send({ type: SystemPacketType.GAME_START_REQ });
    const timerPacket = await joined.socket.next(SystemPacketType.SET_TIME);
    expect(timerPacket).toMatchObject({
      limitTime: 30,
      remainingMs: 30_000,
    });
    expect(timerPacket.endsAt).toBe(
      Number(timerPacket.serverStartTime) + 30_000,
    );

    // 조기 호출은 종료하지 않고 동일 deadline으로 다시 예약한다.
    expect(
      await runDurableObjectAlarm(env.GAME_ROOMS.getByName(roomId)),
    ).toBe(true);
    expect(joined.socket.has(SystemPacketType.TIME_END)).toBe(false);

    const endPacket = joined.socket.next(SystemPacketType.TIME_END);
    const dateSpy = vi
      .spyOn(Date, 'now')
      .mockReturnValue(Number(timerPacket.endsAt));
    const ran = await runDurableObjectAlarm(env.GAME_ROOMS.getByName(roomId));
    dateSpy.mockRestore();
    expect(ran).toBe(true);
    expect((await endPacket).results).toHaveLength(1);
  });

  it('returns an interrupted Flappy round to the lobby after an isolate restart', () => {
    const transport: GameTransport = {
      sockets: { sockets: new Map() },
      to: () => ({ emit: () => undefined }),
      scheduleAlarm: async () => undefined,
      clearAlarm: async () => undefined,
    };
    const snapshot: PersistedGameSession = {
      version: 1,
      selectedGameType: GameType.FLAPPY_BIRD,
      gameConfigs: [] as Array<[GameType, GameConfig]>,
      status: 'playing',
      players: [],
      activeGame: null,
    };
    const session = new GameSession(transport, 'abcdefghij');

    expect(session.restore(snapshot)).toEqual({ interrupted: true });
    expect(session.status).toBe('waiting');
  });
});

describe('Authoritative game rendering', () => {
  it('uses frame-time independent smoothing', () => {
    const oneFrame = getSmoothingAlpha(1000 / 60);
    expect(oneFrame).toBeCloseTo(0.3, 5);
    const twoFrames = 1 - (1 - oneFrame) ** 2;
    expect(getSmoothingAlpha(1000 / 30)).toBeCloseTo(twoFrames, 5);
  });

  it('derives timers from a monotonic deadline instead of callback counts', () => {
    const remainingMs = calculateInitialRemainingMs(
      30,
      { remainingMs: 30_000, receivedAt: 1_000 },
      1_250,
      50_000,
    );
    expect(remainingMs).toBe(29_750);
    expect(calculateRemainingSeconds(30_000, 29_999)).toBeCloseTo(0.001, 5);
    expect(calculateRemainingSeconds(30_000, 30_000)).toBe(0);
  });

  it('uses the original five Matter substeps and 60Hz snapshots', () => {
    expect(FLAPPY_PHYSICS_SUBSTEPS).toBe(5);
    expect(FLAPPY_NETWORK_FPS).toBe(60);
  });
});

describe('Flappy server input sequencing', () => {
  it('matches the original Matter update order for 600 ticks', () => {
    const resolved = resolveFlappyBirdPreset(
      getDefaultConfig(GameType.FLAPPY_BIRD) as FlappyBirdGamePreset,
    );
    const actual = createFlappyPhysicsRuntime(4, resolved.connectAll);
    const reference = createFlappyPhysicsRuntime(4, resolved.connectAll);
    const actualLastFlaps = [0, 0, 0, 0];
    const referenceLastFlaps = [0, 0, 0, 0];
    const connections = calculateFlappyRopeConnections(4, resolved.connectAll);

    const clampCeiling = (birds: readonly Matter.Body[]) => {
      for (const bird of birds) {
        if (bird.position.y - FLAPPY_PHYSICS.BIRD_HEIGHT / 2 > 0) continue;
        Matter.Body.setPosition(bird, {
          x: bird.position.x,
          y: FLAPPY_PHYSICS.BIRD_HEIGHT / 2,
        });
        if (bird.velocity.y < 0) {
          Matter.Body.setVelocity(bird, { x: bird.velocity.x, y: 0 });
        }
      }
    };

    const originalStep = (tick: number) => {
      for (let index = 0; index < reference.birds.length; index += 1) {
        const bird = reference.birds[index];
        const baseForwardSpeed = resolved.pipeSpeed * 1.5;
        const framesSinceFlap = tick - referenceLastFlaps[index];
        const noFlapPenalty = framesSinceFlap > 30 ? 0.97 : 0.995;
        const velocityX =
          bird.velocity.x < baseForwardSpeed
            ? bird.velocity.x + 0.05
            : bird.velocity.x * noFlapPenalty;
        Matter.Body.setVelocity(bird, { x: velocityX, y: bird.velocity.y });
      }

      for (const [indexA, indexB] of connections) {
        const birdA = reference.birds[indexA];
        const birdB = reference.birds[indexB];
        const dx = birdB.position.x - birdA.position.x;
        const dy = birdB.position.y - birdA.position.y;
        const distance = Math.hypot(dx, dy);
        if (distance === 0 || distance <= resolved.ropeLength) continue;
        const nx = dx / distance;
        const ny = dy / distance;
        const correction = (distance - resolved.ropeLength) / 2;
        Matter.Body.setPosition(birdA, {
          x: birdA.position.x + nx * correction,
          y: birdA.position.y + ny * correction,
        });
        Matter.Body.setPosition(birdB, {
          x: birdB.position.x - nx * correction,
          y: birdB.position.y - ny * correction,
        });
        const separatingSpeed =
          (birdB.velocity.x - birdA.velocity.x) * nx +
          (birdB.velocity.y - birdA.velocity.y) * ny;
        if (separatingSpeed > 0) {
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

      for (const bird of reference.birds) {
        const angle = Math.max(-30, Math.min(90, bird.velocity.y * 10));
        Matter.Body.setAngle(bird, angle * (Math.PI / 180));
      }
      for (let substep = 0; substep < 5; substep += 1) {
        Matter.Engine.update(reference.engine, FLAPPY_PHYSICS_FRAME_MS / 5);
        clampCeiling(reference.birds);
      }
    };

    for (let tick = 1; tick <= 600; tick += 1) {
      if (tick % 24 === 1) {
        const playerIndex = Math.floor(tick / 24) % 4;
        const velocity = { x: 1.25 + playerIndex * 0.1, y: -7.2 };
        Matter.Body.setVelocity(actual.birds[playerIndex], velocity);
        Matter.Body.setVelocity(reference.birds[playerIndex], velocity);
        actualLastFlaps[playerIndex] = tick;
        referenceLastFlaps[playerIndex] = tick;
      }

      stepFlappyBirdPhysics({
        runtime: actual,
        tick,
        lastFlapTicks: actualLastFlaps,
        config: resolved,
        onSubstep: () => {
          clampCeiling(actual.birds);
          return true;
        },
      });
      originalStep(tick);
    }

    const actualBirds = snapshotFlappyBirds(actual.birds);
    const referenceBirds = snapshotFlappyBirds(reference.birds);
    for (let index = 0; index < actualBirds.length; index += 1) {
      expect(actualBirds[index].x).toBeCloseTo(referenceBirds[index].x, 2);
      expect(actualBirds[index].y).toBeCloseTo(referenceBirds[index].y, 2);
      expect(actualBirds[index].vx).toBeCloseTo(referenceBirds[index].vx, 2);
      expect(actualBirds[index].vy).toBeCloseTo(referenceBirds[index].vy, 2);
      expect(actualBirds[index].angle).toBeCloseTo(
        referenceBirds[index].angle,
        2,
      );
    }
    destroyFlappyPhysicsRuntime(actual);
    destroyFlappyPhysicsRuntime(reference);
  });

  it('clamps an upward-moving bird to the ceiling without ending the round', () => {
    const socket: GameSocket = {
      id: 'p0',
      emit: () => undefined,
      to: () => ({ emit: () => undefined }),
      disconnect: () => undefined,
    };
    const transport: GameTransport = {
      sockets: { sockets: new Map([['p0', socket]]) },
      to: () => ({ emit: () => undefined }),
      scheduleAlarm: async () => undefined,
      clearAlarm: async () => undefined,
    };
    const session = new GameSession(transport, 'abcdefghij');
    session.addPlayer('p0', '첫째');
    const game = new FlappyBirdInstance(session);
    game.initialize(
      getDefaultConfig(GameType.FLAPPY_BIRD) as FlappyBirdGamePreset,
    );
    const internal = game as unknown as {
      birds: Matter.Body[];
      checkCollisions: () => boolean;
    };
    const bird = internal.birds[0];
    Matter.Body.setPosition(bird, { x: bird.position.x, y: 1 });
    Matter.Body.setVelocity(bird, { x: bird.velocity.x, y: -5 });

    expect(internal.checkCollisions()).toBe(true);
    expect(bird.position.y).toBe(FLAPPY_PHYSICS.BIRD_HEIGHT / 2);
    expect(bird.velocity.y).toBe(0);
    expect(session.status).not.toBe('ended');
    game.destroy();
  });

  it('keeps two authoritative birds within the original rope constraint', () => {
    const socketsById = new Map<string, GameSocket>();
    for (const id of ['p0', 'p1']) {
      socketsById.set(id, {
        id,
        emit: () => undefined,
        to: () => ({ emit: () => undefined }),
        disconnect: () => undefined,
      });
    }
    const transport: GameTransport = {
      sockets: { sockets: socketsById },
      to: () => ({ emit: () => undefined }),
      scheduleAlarm: async () => undefined,
      clearAlarm: async () => undefined,
    };
    const session = new GameSession(transport, 'abcdefghij');
    session.addPlayer('p0', '첫째');
    session.addPlayer('p1', '둘째');
    const game = new FlappyBirdInstance(session);
    game.initialize(
      getDefaultConfig(GameType.FLAPPY_BIRD) as FlappyBirdGamePreset,
    );
    const internal = game as unknown as {
      birds: Matter.Body[];
      physicsUpdate: () => void;
      ropeLength: number;
    };
    const sequences = [0, 0];
    let maxDistance = 0;

    for (let tick = 0; tick < 120; tick += 1) {
      if (tick % 8 === 0) {
        const playerIndex = (tick / 8) % 2;
        game.handlePacket(socketsById.get(`p${playerIndex}`)!, playerIndex, {
          type: FlappyBirdPacketType.FLAPPY_JUMP,
          inputSeq: ++sequences[playerIndex],
        });
      }
      internal.physicsUpdate();
      if (internal.birds.length < 2) break;
      maxDistance = Math.max(
        maxDistance,
        Math.hypot(
          internal.birds[1].position.x - internal.birds[0].position.x,
          internal.birds[1].position.y - internal.birds[0].position.y,
        ),
      );
    }

    expect(maxDistance).toBeLessThanOrEqual(internal.ropeLength + 5);
    game.destroy();
  });

  it('ignores duplicate and reversed inputs and keeps player acks isolated', () => {
    const emitted: Array<{ event: string; data: unknown }> = [];
    const broadcasts: Array<{ event: string; data: unknown }> = [];
    const socket: GameSocket = {
      id: 'p0',
      emit: (event, data) => emitted.push({ event, data }),
      to: () => ({
        emit: (event, data) => broadcasts.push({ event, data }),
      }),
      disconnect: () => undefined,
    };
    const transport: GameTransport = {
      sockets: { sockets: new Map([['p0', socket]]) },
      to: () => ({
        emit: (event, data) => broadcasts.push({ event, data }),
      }),
      scheduleAlarm: async () => undefined,
      clearAlarm: async () => undefined,
    };
    const session = new GameSession(transport, 'abcdefghij');
    session.addPlayer('p0', '첫째');
    session.addPlayer('p1', '둘째');
    const game = new FlappyBirdInstance(session);
    game.initialize(
      getDefaultConfig(GameType.FLAPPY_BIRD) as FlappyBirdGamePreset,
    );

    game.handlePacket(socket, 0, {
      type: FlappyBirdPacketType.FLAPPY_JUMP,
      inputSeq: 2,
    });
    game.handlePacket(socket, 0, {
      type: FlappyBirdPacketType.FLAPPY_REQUEST_SYNC,
    });
    const firstSync = emitted.at(-1)!.data as {
      lastProcessedInputSeqs: number[];
      birds: Array<{ vy: number }>;
      roundId: string;
    };

    expect(broadcasts.at(-1)).toMatchObject({
      event: FlappyBirdPacketType.FLAPPY_INPUT_APPLIED,
      data: { playerIndex: 0, inputSeq: 2, applyTick: 1 },
    });

    game.handlePacket(socket, 0, {
      type: FlappyBirdPacketType.FLAPPY_JUMP,
      inputSeq: 2,
    });
    game.handlePacket(socket, 0, {
      type: FlappyBirdPacketType.FLAPPY_JUMP,
      inputSeq: 1,
    });
    game.handlePacket(socket, 0, {
      type: FlappyBirdPacketType.FLAPPY_JUMP,
      inputSeq: 3,
      roundId: 'previous-round',
    });
    game.handlePacket(socket, 0, {
      type: FlappyBirdPacketType.FLAPPY_REQUEST_SYNC,
    });
    const duplicateSync = emitted.at(-1)!.data as {
      lastProcessedInputSeqs: number[];
      birds: Array<{ vy: number }>;
    };

    expect(firstSync.lastProcessedInputSeqs).toEqual([2, 0]);
    expect(duplicateSync.lastProcessedInputSeqs).toEqual([2, 0]);
    expect(duplicateSync.birds[0].vy).toBe(firstSync.birds[0].vy);

    game.handlePacket(socket, 0, {
      type: FlappyBirdPacketType.FLAPPY_CLOCK_PING,
      clientSentAt: 1234,
      roundId: firstSync.roundId,
    });
    expect(emitted.at(-1)).toMatchObject({
      event: FlappyBirdPacketType.FLAPPY_CLOCK_PONG,
      data: {
        clientSentAt: 1234,
        roundId: firstSync.roundId,
        serverTick: 0,
      },
    });
    game.destroy();
  });

  it('runs physics near 60Hz while broadcasting no more than 60 snapshots', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const broadcasts: Array<{ event: string; data: unknown }> = [];
    const emitted: Array<{ event: string; data: unknown }> = [];
    const socket: GameSocket = {
      id: 'p0',
      emit: (event, data) => emitted.push({ event, data }),
      to: () => ({ emit: () => undefined }),
      disconnect: () => undefined,
    };
    const transport: GameTransport = {
      sockets: { sockets: new Map([['p0', socket]]) },
      to: () => ({
        emit: (event, data) => broadcasts.push({ event, data }),
      }),
      scheduleAlarm: async () => undefined,
      clearAlarm: async () => undefined,
    };
    const session = new GameSession(transport, 'abcdefghij');
    session.addPlayer('p0', '첫째');
    const game = new FlappyBirdInstance(session);
    game.initialize(
      getDefaultConfig(GameType.FLAPPY_BIRD) as FlappyBirdGamePreset,
    );
    game.start();

    vi.advanceTimersByTime(1_000);
    game.handlePacket(socket, 0, {
      type: FlappyBirdPacketType.FLAPPY_REQUEST_SYNC,
    });
    const sync = emitted.at(-1)!.data as { tick: number };
    const snapshots = broadcasts.filter(
      (packet) => packet.event === FlappyBirdPacketType.FLAPPY_WORLD_STATE,
    );

    expect(sync.tick).toBeGreaterThanOrEqual(59);
    expect(sync.tick).toBeLessThanOrEqual(60);
    expect(snapshots.length).toBeGreaterThanOrEqual(59);
    expect(snapshots.length).toBeLessThanOrEqual(60);
    game.destroy();
    vi.useRealTimers();
  });
});

describe('Flappy fixed-step scheduling', () => {
  it('runs three 60Hz physics steps after a 50ms runtime stall', () => {
    const clock = new FixedStepClock(1000 / 60, 6);
    clock.reset(1_000);

    expect(clock.advance(1_050)).toEqual({ steps: 3, droppedMs: 0 });
    expect(clock.advance(1_100)).toEqual({ steps: 3, droppedMs: 0 });
  });

  it('caps catch-up work after a long runtime stall', () => {
    const clock = new FixedStepClock(1000 / 60, 6);
    clock.reset(1_000);

    const result = clock.advance(1_500);
    expect(result.steps).toBe(6);
    expect(result.droppedMs).toBeCloseTo(400, 5);
    expect(clock.advance(1_550).steps).toBe(3);
  });
});
