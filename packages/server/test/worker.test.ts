import { env, exports } from 'cloudflare:workers';
import { evictDurableObject, runDurableObjectAlarm } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GameType,
  FlappyBirdPacketType,
  RoomUpdateType,
  SystemPacketType,
  applyDeterministicFlappyJump,
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
import {
  getPredictionFrames,
  getSmoothingAlpha,
} from '../../client/src/game/scene/flappybirds/interpolation';
import { FlappyRenderSimulation } from '../../client/src/game/scene/flappybirds/FlappyRenderSimulation';
import type { BirdPosition } from '../../client/src/game/types/flappybird.types';
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
    joined.socket.send({ type: SystemPacketType.GAME_START_REQ });
    await joined.socket.next(SystemPacketType.SET_TIME);

    const endPacket = joined.socket.next(SystemPacketType.TIME_END);
    const ran = await runDurableObjectAlarm(env.GAME_ROOMS.getByName(roomId));
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

describe('Flappy rendering interpolation', () => {
  it('predicts between 20Hz snapshots but caps long network stalls', () => {
    expect(getPredictionFrames(50)).toBeCloseTo(3, 5);
    expect(getPredictionFrames(100)).toBeCloseTo(6, 5);
    expect(getPredictionFrames(500)).toBeCloseTo(6, 5);
  });

  it('uses frame-time independent smoothing', () => {
    const oneFrame = getSmoothingAlpha(1000 / 60);
    const twoFrames = 1 - (1 - oneFrame) ** 2;
    expect(getSmoothingAlpha(1000 / 30)).toBeCloseTo(twoFrames, 5);
  });
});

describe('Flappy client render simulation', () => {
  const preset = getDefaultConfig(GameType.FLAPPY_BIRD) as FlappyBirdGamePreset;
  const config = resolveFlappyBirdPreset(preset);
  const seed = 0x5eed1234;
  const roundId = 'round-test';

  function initialBirds(playerCount = 1): BirdPosition[] {
    const runtime = createFlappyPhysicsRuntime(playerCount, config.connectAll);
    const birds = snapshotFlappyBirds(runtime.birds).map((bird, index) => ({
      playerId: String(index),
      x: bird.x,
      y: bird.y,
      velocityX: bird.vx,
      velocityY: bird.vy,
      angle: bird.angle,
    }));
    destroyFlappyPhysicsRuntime(runtime);
    return birds;
  }

  function initialize(simulation: FlappyRenderSimulation): BirdPosition[] {
    const birds = initialBirds();
    simulation.applySnapshot({
      tick: 0,
      birds,
      lastProcessedInputSeqs: [0],
      lastFlapTicks: [0],
      localPlayerIndex: 0,
      roundId,
      physicsSeed: seed,
      config,
      receivedAt: 0,
      force: true,
    });
    return birds;
  }

  it('keeps shared Matter physics deterministic for 600 ticks', () => {
    const left = createFlappyPhysicsRuntime(4, true);
    const right = createFlappyPhysicsRuntime(4, true);
    const leftFlaps = [0, 0, 0, 0];
    const rightFlaps = [0, 0, 0, 0];
    const sequences = [0, 0, 0, 0];

    for (let tick = 1; tick <= 600; tick += 1) {
      for (let playerIndex = 0; playerIndex < 4; playerIndex += 1) {
        if (tick % (37 + playerIndex * 5) !== 0) continue;
        const inputSeq = ++sequences[playerIndex];
        applyDeterministicFlappyJump(
          left.birds,
          playerIndex,
          inputSeq,
          seed,
          config,
        );
        applyDeterministicFlappyJump(
          right.birds,
          playerIndex,
          inputSeq,
          seed,
          config,
        );
        leftFlaps[playerIndex] = tick - 1;
        rightFlaps[playerIndex] = tick - 1;
      }
      stepFlappyBirdPhysics({
        runtime: left,
        tick,
        lastFlapTicks: leftFlaps,
        config: { ...config, connectAll: true },
      });
      stepFlappyBirdPhysics({
        runtime: right,
        tick,
        lastFlapTicks: rightFlaps,
        config: { ...config, connectAll: true },
      });
    }

    const leftBirds = snapshotFlappyBirds(left.birds);
    const rightBirds = snapshotFlappyBirds(right.birds);
    for (let index = 0; index < leftBirds.length; index += 1) {
      for (const field of ['x', 'y', 'vx', 'vy', 'angle'] as const) {
        expect(
          Math.abs(leftBirds[index][field] - rightBirds[index][field]),
        ).toBeLessThan(0.01);
      }
    }
    destroyFlappyPhysicsRuntime(left);
    destroyFlappyPhysicsRuntime(right);
  });

  it('keeps y unchanged on the input frame and rises on the next RAF', () => {
    const simulation = new FlappyRenderSimulation();
    initialize(simulation);
    const before = simulation.getBirds()[0].y;

    simulation.applyLocalJump(0, 1);

    expect(simulation.getBirds()[0].y).toBe(before);
    expect(simulation.update(1000 / 60, 1000 / 60)[0].y).toBeLessThan(before);
  });

  it('does not apply a locally predicted jump twice when its ack arrives early', () => {
    const simulation = new FlappyRenderSimulation();
    const birds = initialize(simulation);
    const authority = createFlappyPhysicsRuntime(1, false, [
      {
        x: birds[0].x,
        y: birds[0].y,
        vx: birds[0].velocityX,
        vy: birds[0].velocityY,
        angle: birds[0].angle,
      },
    ]);

    simulation.applyLocalJump(0, 1);
    simulation.applyInputApplied({
      roundId,
      playerIndex: 0,
      inputSeq: 1,
      applyTick: 1,
    });
    const predicted = simulation.update(1000 / 60, 1000 / 60)[0];

    applyDeterministicFlappyJump(authority.birds, 0, 1, seed, config);
    stepFlappyBirdPhysics({
      runtime: authority,
      tick: 1,
      lastFlapTicks: [0],
      config,
    });
    const expected = snapshotFlappyBirds(authority.birds)[0];
    expect(predicted.y).toBeCloseTo(expected.y, 2);
    expect(predicted.velocityY).toBeCloseTo(expected.vy, 2);
    destroyFlappyPhysicsRuntime(authority);
  });

  it('stays within 1px of authority half a second after a jump', () => {
    const simulation = new FlappyRenderSimulation();
    const birds = initialize(simulation);
    const authority = createFlappyPhysicsRuntime(1, false, [
      {
        x: birds[0].x,
        y: birds[0].y,
        vx: birds[0].velocityX,
        vy: birds[0].velocityY,
        angle: birds[0].angle,
      },
    ]);
    simulation.applyLocalJump(0, 1);
    applyDeterministicFlappyJump(authority.birds, 0, 1, seed, config);

    for (let tick = 1; tick <= 30; tick += 1) {
      simulation.update(1000 / 60, (tick * 1000) / 60);
      stepFlappyBirdPhysics({
        runtime: authority,
        tick,
        lastFlapTicks: [0],
        config,
      });
    }
    const predicted = simulation.getBirds()[0];
    const expected = snapshotFlappyBirds(authority.birds)[0];
    expect(Math.abs(predicted.y - expected.y)).toBeLessThan(1);
    destroyFlappyPhysicsRuntime(authority);
  });

  it('hard resynchronizes after a long inactive frame', () => {
    const simulation = new FlappyRenderSimulation();
    const birds = initialize(simulation);
    const afterStall = simulation.update(300, 300)[0];

    expect(afterStall.x).toBe(birds[0].x);
    expect(afterStall.y).toBe(birds[0].y);
  });
});

describe('Flappy server input sequencing', () => {
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

  it('runs physics near 60Hz while broadcasting no more than 20 snapshots', () => {
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
    expect(snapshots.length).toBeGreaterThanOrEqual(19);
    expect(snapshots.length).toBeLessThanOrEqual(20);
    game.destroy();
    vi.useRealTimers();
  });
});

describe('Flappy fixed-step scheduling', () => {
  it('runs three 60Hz physics steps for each 20Hz network interval', () => {
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
