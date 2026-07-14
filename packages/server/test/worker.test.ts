import { env, exports } from 'cloudflare:workers';
import { evictDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GameType,
  RoomUpdateType,
  SystemPacketType,
  type GameConfig,
} from '@main-game/common';
import {
  GameSession,
  type PersistedGameSession,
} from '../src/games/gameSession';
import type { GameTransport } from '../src/network/transport';

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
