import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { io as createClient, type Socket } from 'socket.io-client';
import {
  FlappyBirdPacketType,
  GameType,
  SystemPacketType,
  getDefaultConfig,
  type LobbyChatMessage,
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

    const countdown = waitForEvent<{ startsAt: number; countdownMs: number }>(
      socket,
      FlappyBirdPacketType.FLAPPY_START_COUNTDOWN,
    );
    const gameStart = waitForEvent<{
      ackTimeoutMs: number;
      inputGraceMs: number;
    }>(
      socket,
      FlappyBirdPacketType.FLAPPY_GAME_START,
    );
    socket.emit(FlappyBirdPacketType.FLAPPY_REQUEST_SYNC, {});
    const { startsAt, countdownMs } = await countdown;
    expect(startsAt - Date.now()).toBeGreaterThan(800);
    expect(countdownMs).toBe(1000);

    const { ackTimeoutMs, inputGraceMs } = await gameStart;
    expect(ackTimeoutMs).toBe(1000);
    expect(inputGraceMs).toBe(500);
    expect(worldPackets).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(worldPackets).toBe(0);

    socket.emit(FlappyBirdPacketType.FLAPPY_GAME_START_ACK, {});
    await new Promise((resolve) => setTimeout(resolve, inputGraceMs / 2));
    expect(worldPackets).toBe(0);

    await waitForEvent(
      socket,
      FlappyBirdPacketType.FLAPPY_WORLD_STATE,
      2500,
    );
    expect(worldPackets).toBeGreaterThan(0);
  });

  it('broadcasts lobby chat, keeps recent history, and rate limits spam', async () => {
    const url = await start();
    const host = await connect(url);
    sockets.push(host);

    const hostJoined = waitForEvent<RoomUpdatePacket>(
      host,
      SystemPacketType.ROOM_UPDATE,
    );
    const hostHistory = waitForEvent<{ messages: LobbyChatMessage[] }>(
      host,
      SystemPacketType.LOBBY_CHAT_HISTORY,
    );
    host.emit(SystemPacketType.JOIN_ROOM, {
      roomId: '',
      playerName: 'host',
    });
    const roomId = (await hostJoined).roomId;
    await expect(hostHistory).resolves.toEqual({ messages: [] });

    const guest = await connect(url);
    sockets.push(guest);
    const guestJoined = waitForEvent<RoomUpdatePacket>(
      guest,
      SystemPacketType.ROOM_UPDATE,
    );
    guest.emit(SystemPacketType.JOIN_ROOM, {
      roomId,
      playerName: 'guest',
    });
    await guestJoined;

    const hostMessage = waitForEvent<{ message: LobbyChatMessage }>(
      host,
      SystemPacketType.LOBBY_CHAT_MESSAGE,
    );
    const guestMessage = waitForEvent<{ message: LobbyChatMessage }>(
      guest,
      SystemPacketType.LOBBY_CHAT_MESSAGE,
    );
    host.emit(SystemPacketType.LOBBY_CHAT_SEND, {
      message: '  안녕하세요   모두  ',
    });

    const delivered = await hostMessage;
    expect(delivered.message).toMatchObject({
      playerName: 'host',
      message: '안녕하세요 모두',
    });
    await expect(guestMessage).resolves.toEqual(delivered);

    const lateGuest = await connect(url);
    sockets.push(lateGuest);
    const lateHistory = waitForEvent<{ messages: LobbyChatMessage[] }>(
      lateGuest,
      SystemPacketType.LOBBY_CHAT_HISTORY,
    );
    lateGuest.emit(SystemPacketType.JOIN_ROOM, {
      roomId,
      playerName: 'late',
    });
    await expect(lateHistory).resolves.toMatchObject({
      messages: [{ message: '안녕하세요 모두' }],
    });

    host.emit(SystemPacketType.LOBBY_CHAT_SEND, { message: '두 번째' });
    host.emit(SystemPacketType.LOBBY_CHAT_SEND, { message: '세 번째' });
    const rateLimited = waitForEvent<{ message: string }>(
      host,
      SystemPacketType.LOBBY_CHAT_ERROR,
    );
    host.emit(SystemPacketType.LOBBY_CHAT_SEND, { message: '네 번째' });
    await expect(rateLimited).resolves.toMatchObject({
      message: expect.stringContaining('너무 빠르게'),
    });
  });

  it('shows Flappy readiness until every player is ready', async () => {
    const url = await start();
    const host = await connect(url);
    const guest = await connect(url);
    sockets.push(host, guest);

    const hostJoined = waitForEvent<RoomUpdatePacket>(
      host,
      SystemPacketType.ROOM_UPDATE,
    );
    host.emit(SystemPacketType.JOIN_ROOM, {
      roomId: '',
      playerName: 'host',
    });
    const roomId = (await hostJoined).roomId;

    const guestJoined = waitForEvent<RoomUpdatePacket>(
      guest,
      SystemPacketType.ROOM_UPDATE,
    );
    guest.emit(SystemPacketType.JOIN_ROOM, {
      roomId,
      playerName: 'guest',
    });
    await guestJoined;

    const configured = waitForEvent(
      guest,
      SystemPacketType.GAME_CONFIG_UPDATE,
    );
    host.emit(SystemPacketType.GAME_CONFIG_UPDATE_REQ, {
      selectedGameType: GameType.FLAPPY_BIRD,
      gameConfig: getDefaultConfig(GameType.FLAPPY_BIRD),
    });
    await configured;

    const hostReadyScene = waitForEvent(host, SystemPacketType.READY_SCENE);
    const guestReadyScene = waitForEvent(guest, SystemPacketType.READY_SCENE);
    let worldPackets = 0;
    host.on(FlappyBirdPacketType.FLAPPY_WORLD_STATE, () => {
      worldPackets++;
    });
    host.emit(SystemPacketType.GAME_START_REQ, {});
    await Promise.all([hostReadyScene, guestReadyScene]);

    const hostStatus = waitForEvent<{ readyCount: number; totalPlayers: number }>(
      host,
      FlappyBirdPacketType.FLAPPY_READY_STATUS,
    );
    const guestStatus = waitForEvent<{ readyCount: number; totalPlayers: number }>(
      guest,
      FlappyBirdPacketType.FLAPPY_READY_STATUS,
    );
    host.emit(FlappyBirdPacketType.FLAPPY_REQUEST_SYNC, {});
    await expect(hostStatus).resolves.toEqual({ readyCount: 1, totalPlayers: 2 });
    await expect(guestStatus).resolves.toEqual({ readyCount: 1, totalPlayers: 2 });

    let countdownStarted = false;
    host.once(FlappyBirdPacketType.FLAPPY_START_COUNTDOWN, () => {
      countdownStarted = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(countdownStarted).toBe(false);

    const countdown = waitForEvent<{ startsAt: number; countdownMs: number }>(
      host,
      FlappyBirdPacketType.FLAPPY_START_COUNTDOWN,
    );
    const gameStart = waitForEvent<{
      ackTimeoutMs: number;
      inputGraceMs: number;
    }>(
      host,
      FlappyBirdPacketType.FLAPPY_GAME_START,
    );
    guest.emit(FlappyBirdPacketType.FLAPPY_REQUEST_SYNC, {});
    const countdownPacket = await countdown;
    expect(countdownPacket.startsAt - Date.now()).toBeGreaterThan(800);
    expect(countdownPacket.countdownMs).toBe(1000);

    const { inputGraceMs } = await gameStart;
    host.emit(FlappyBirdPacketType.FLAPPY_GAME_START_ACK, {});
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(worldPackets).toBe(0);

    const firstWorldState = waitForEvent(
      host,
      FlappyBirdPacketType.FLAPPY_WORLD_STATE,
    );
    guest.emit(FlappyBirdPacketType.FLAPPY_GAME_START_ACK, {});
    await new Promise((resolve) => setTimeout(resolve, inputGraceMs / 2));
    expect(worldPackets).toBe(0);
    await firstWorldState;
    expect(worldPackets).toBeGreaterThan(0);
  });

  it('lets only the host stop an active game and return everyone to the lobby', async () => {
    const url = await start();
    const host = await connect(url);
    const guest = await connect(url);
    sockets.push(host, guest);

    const hostJoined = waitForEvent<RoomUpdatePacket>(
      host,
      SystemPacketType.ROOM_UPDATE,
    );
    host.emit(SystemPacketType.JOIN_ROOM, { roomId: '', playerName: 'host' });
    const roomId = (await hostJoined).roomId;

    const guestJoined = waitForEvent<RoomUpdatePacket>(
      guest,
      SystemPacketType.ROOM_UPDATE,
    );
    guest.emit(SystemPacketType.JOIN_ROOM, { roomId, playerName: 'guest' });
    await guestJoined;

    const configured = waitForEvent(
      guest,
      SystemPacketType.GAME_CONFIG_UPDATE,
    );
    host.emit(SystemPacketType.GAME_CONFIG_UPDATE_REQ, {
      selectedGameType: GameType.APPLE_GAME,
      gameConfig: getDefaultConfig(GameType.APPLE_GAME),
    });
    await configured;

    const hostReady = waitForEvent(host, SystemPacketType.READY_SCENE);
    const guestReady = waitForEvent(guest, SystemPacketType.READY_SCENE);
    host.emit(SystemPacketType.GAME_START_REQ, {});
    await Promise.all([hostReady, guestReady]);

    let hostReturned = false;
    host.once(SystemPacketType.RETURN_TO_THE_LOBBY, () => {
      hostReturned = true;
    });
    guest.emit(SystemPacketType.RETURN_TO_THE_LOBBY_REQ, {});
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(hostReturned).toBe(false);

    const hostLobby = waitForEvent(host, SystemPacketType.RETURN_TO_THE_LOBBY);
    const guestLobby = waitForEvent(guest, SystemPacketType.RETURN_TO_THE_LOBBY);
    host.emit(SystemPacketType.RETURN_TO_THE_LOBBY_REQ, {});
    await Promise.all([hostLobby, guestLobby]);

    const restarted = waitForEvent(host, SystemPacketType.READY_SCENE);
    host.emit(SystemPacketType.GAME_START_REQ, {});
    await restarted;
  });
});
