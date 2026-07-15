import { env, exports } from 'cloudflare:workers';
import { evictDurableObject, runDurableObjectAlarm } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GameType,
  FlappyBirdPacketType,
  RoomUpdateType,
  SystemPacketType,
  getDefaultConfig,
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
  const bird = (overrides: Partial<BirdPosition> = {}): BirdPosition => ({
    playerId: '0',
    x: 100,
    y: 200,
    velocityX: 4,
    velocityY: 0,
    angle: 0,
    ...overrides,
  });

  it('advances at render frequency between server snapshots', () => {
    const simulation = new FlappyRenderSimulation();
    simulation.reset([bird()], 0);

    const first = simulation.update(1000 / 60)[0];
    expect(first.x).toBeCloseTo(104, 4);
    expect(first.y).toBeGreaterThan(200);
    const firstY = first.y;

    const second = simulation.update(1000 / 60)[0];
    expect(second.x).toBeCloseTo(108, 4);
    expect(second.y).toBeGreaterThan(firstY);
  });

  it('samples motion on every high-refresh render frame', () => {
    const simulation = new FlappyRenderSimulation();
    simulation.reset([bird({ velocityY: -8 })], 0);

    const firstY = simulation.update(1000 / 120, 1000 / 120)[0].y;
    const secondY = simulation.update(1000 / 120, 1000 / 60)[0].y;
    const thirdY = simulation.update(1000 / 120, 1000 / 40)[0].y;

    expect(firstY).toBeLessThan(200);
    expect(secondY).toBeLessThan(firstY);
    expect(thirdY).toBeLessThan(secondY);
  });

  it('does not freeze when a 20Hz snapshot is briefly delayed', () => {
    const simulation = new FlappyRenderSimulation();
    simulation.reset([bird()], 0);
    simulation.applySnapshot(0, [bird()], [0], 0, 0, true);

    const at100ms = simulation.update(100, 100)[0].x;
    const at150ms = simulation.update(50, 150)[0].x;

    expect(at100ms).toBeGreaterThan(100);
    expect(at150ms).toBeGreaterThan(at100ms);
  });

  it('applies the local jump before the next server packet arrives', () => {
    const simulation = new FlappyRenderSimulation();
    simulation.reset([bird()], 0);
    simulation.applyLocalJump(0, 1, -10);

    const next = simulation.update(1000 / 60)[0];
    expect(next.y).toBeLessThan(200);
    expect(next.velocityY).toBeLessThan(0);
  });

  it('reconciles small server errors and snaps impossible divergence', () => {
    const simulation = new FlappyRenderSimulation();
    simulation.reset([bird()], 0);
    simulation.update(1000 / 60);

    simulation.applySnapshot(3, [bird({ x: 110, y: 205 })], [0], 0, 50);
    expect(simulation.getBirds()[0].x).not.toBe(110);

    simulation.applySnapshot(6, [bird({ x: 500, y: 500 })], [0], 0, 100);
    expect(simulation.getBirds()[0].x).toBe(500);
    expect(simulation.getBirds()[0].y).toBe(500);
  });

  it('does not let a stale ack cancel a newer local jump', () => {
    const simulation = new FlappyRenderSimulation();
    simulation.reset([bird()], 0);
    simulation.applyLocalJump(0, 2, -10);
    simulation.update(1000 / 60, 16.67);

    simulation.applySnapshot(3, [bird({ y: 202, velocityY: 1 })], [1], 0, 50);
    const afterStaleAck = simulation.update(1000 / 60, 66.67)[0];
    expect(afterStaleAck.velocityY).toBeLessThan(0);
    expect(afterStaleAck.y).toBeLessThan(200);
  });

  it('smoothly converges once the latest local input is acknowledged', () => {
    const acknowledged = new FlappyRenderSimulation();
    const pending = new FlappyRenderSimulation();
    for (const simulation of [acknowledged, pending]) {
      simulation.reset([bird()], 0);
      simulation.applyLocalJump(0, 1, -10);
      simulation.update(1000 / 60, 16.67);
    }

    acknowledged.applySnapshot(
      3,
      [bird({ y: 160, velocityY: -8 })],
      [1],
      0,
      50,
    );
    pending.applySnapshot(3, [bird({ y: 160, velocityY: -8 })], [0], 0, 50);
    const corrected = acknowledged.update(1000 / 60, 66.67)[0];
    const unacknowledged = pending.update(1000 / 60, 66.67)[0];
    const authorityYAfterFrame = 160 - 8 + 0.5 * 0.75;

    expect(corrected.y).not.toBe(authorityYAfterFrame);
    expect(Math.abs(corrected.y - authorityYAfterFrame)).toBeLessThan(
      Math.abs(unacknowledged.y - authorityYAfterFrame),
    );
  });

  it('predicts remote birds to the minimum-delay clock without a display buffer', () => {
    const simulation = new FlappyRenderSimulation();
    simulation.reset([bird()], 0);
    simulation.applySnapshot(0, [bird()], [0], -1, 1_000, true);
    simulation.applySnapshot(3, [bird({ x: 112 })], [0], -1, 1_070, true);

    expect(simulation.getBirds()[0].x).toBeGreaterThan(112);
    expect(simulation.getBirds()[0].x).toBeLessThanOrEqual(136);
  });

  it('hard resynchronizes instead of catching up an entire long frame stall', () => {
    const simulation = new FlappyRenderSimulation();
    simulation.reset([bird()], 0);
    const afterStall = simulation.update(300, 300)[0];

    expect(afterStall.x).toBe(100);
    expect(afterStall.y).toBe(200);
  });
});

describe('Flappy server input sequencing', () => {
  it('ignores duplicate and reversed inputs and keeps player acks isolated', () => {
    const emitted: Array<{ event: string; data: unknown }> = [];
    const socket: GameSocket = {
      id: 'p0',
      emit: (event, data) => emitted.push({ event, data }),
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
    };

    game.handlePacket(socket, 0, {
      type: FlappyBirdPacketType.FLAPPY_JUMP,
      inputSeq: 2,
    });
    game.handlePacket(socket, 0, {
      type: FlappyBirdPacketType.FLAPPY_JUMP,
      inputSeq: 1,
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
    game.destroy();
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
