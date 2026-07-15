import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { io as createClient, type Socket } from 'socket.io-client';
import {
  FlappyBirdPacketType,
  GameType,
  SystemPacketType,
  getDefaultConfig,
  type RoomUpdatePacket,
} from '@main-game/common';
import { createGameServer, type GameServer } from '../src/index';
import { clearServerState } from '../src/network/serverHandler';

function waitForEvent<T>(
  socket: Socket,
  event: string,
  timeoutMs = 3000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for ${event}`)),
      timeoutMs,
    );
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

async function connect(url: string): Promise<Socket> {
  const socket = createClient(url, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
  });
  await waitForEvent(socket, 'connect');
  return socket;
}

describe('Socket.IO game server', () => {
  let server: GameServer | undefined;
  const sockets: Socket[] = [];

  beforeEach(() => clearServerState());

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.disconnect();
    if (server) {
      server.io.close();
      await new Promise<void>((resolve) => server?.httpServer.close(() => resolve()));
      server = undefined;
    }
    clearServerState();
  });

  async function start(): Promise<string> {
    server = createGameServer();
    await new Promise<void>((resolve) =>
      server?.httpServer.listen(0, '127.0.0.1', () => resolve()),
    );
    const address = server.httpServer.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    return `http://127.0.0.1:${address.port}`;
  }

  it('serves health and keeps rooms isolated with a four-player limit', async () => {
    const url = await start();
    const health = await fetch(`${url}/health`);
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({
      ok: true,
      service: 'orak-garak-server',
    });

    const first = await connect(url);
    sockets.push(first);
    const firstRoomUpdate = waitForEvent<RoomUpdatePacket>(
      first,
      SystemPacketType.ROOM_UPDATE,
    );
    first.emit(SystemPacketType.JOIN_ROOM, {
      roomId: '',
      playerName: 'one',
    });
    const roomId = (await firstRoomUpdate).roomId;
    expect(roomId).toMatch(/^[a-z0-9]{10}$/);

    const isolated = await connect(url);
    sockets.push(isolated);
    const isolatedUpdate = waitForEvent<RoomUpdatePacket>(
      isolated,
      SystemPacketType.ROOM_UPDATE,
    );
    isolated.emit(SystemPacketType.JOIN_ROOM, {
      roomId: '',
      playerName: 'other',
    });
    expect((await isolatedUpdate).roomId).not.toBe(roomId);

    for (let index = 2; index <= 4; index++) {
      const socket = await connect(url);
      sockets.push(socket);
      const update = waitForEvent<RoomUpdatePacket>(
        socket,
        SystemPacketType.ROOM_UPDATE,
      );
      socket.emit(SystemPacketType.JOIN_ROOM, {
        roomId,
        playerName: `p${index}`,
      });
      expect((await update).players).toHaveLength(index);
    }

    const fifth = await connect(url);
    sockets.push(fifth);
    const rejection = waitForEvent<{ message: string }>(
      fifth,
      SystemPacketType.SYSTEM_MESSAGE,
    );
    fifth.emit(SystemPacketType.JOIN_ROOM, {
      roomId,
      playerName: 'fifth',
    });
    await expect(rejection).resolves.toMatchObject({ message: 'Room is full' });
  });

  it('waits for the Flappy scene before the one-second countdown', async () => {
    const url = await start();
    const socket = await connect(url);
    sockets.push(socket);

    const joined = waitForEvent<RoomUpdatePacket>(
      socket,
      SystemPacketType.ROOM_UPDATE,
    );
    socket.emit(SystemPacketType.JOIN_ROOM, {
      roomId: '',
      playerName: 'solo',
    });
    await joined;

    const configured = waitForEvent(
      socket,
      SystemPacketType.GAME_CONFIG_UPDATE,
    );
    socket.emit(SystemPacketType.GAME_CONFIG_UPDATE_REQ, {
      selectedGameType: GameType.FLAPPY_BIRD,
      gameConfig: getDefaultConfig(GameType.FLAPPY_BIRD),
    });
    await configured;

    let worldPackets = 0;
    socket.on(FlappyBirdPacketType.FLAPPY_WORLD_STATE, () => {
      worldPackets++;
    });

    const ready = waitForEvent(socket, SystemPacketType.READY_SCENE);
    socket.emit(SystemPacketType.GAME_START_REQ, {});
    await ready;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(worldPackets).toBe(0);

    const countdown = waitForEvent<{ startsAt: number }>(
      socket,
      FlappyBirdPacketType.FLAPPY_START_COUNTDOWN,
    );
    socket.emit(FlappyBirdPacketType.FLAPPY_REQUEST_SYNC, {});
    const { startsAt } = await countdown;
    expect(startsAt - Date.now()).toBeGreaterThan(800);

    await waitForEvent(
      socket,
      FlappyBirdPacketType.FLAPPY_WORLD_STATE,
      2500,
    );
    expect(worldPackets).toBeGreaterThan(0);
  });
});
