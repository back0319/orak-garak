import { DurableObject } from 'cloudflare:workers';
import {
  AppleGamePacketType,
  FlappyBirdPacketType,
  MineSweeperPacketType,
  RoomUpdateType,
  SystemPacketType,
  type GameConfigUpdatePacket,
  type JoinAcceptedPacket,
  type RoomUpdatePacket,
  type ServerPacket,
} from '@main-game/common';
import { GameSession, type PersistedGameSession } from '../games/gameSession';
import type { Env } from '../index';
import type { GameSocket, GameTransport, PacketEmitter } from './transport';

const MAX_PLAYERS = 4;
const MAX_FRAME_BYTES = 16 * 1024;
const MAX_MESSAGES_PER_SECOND = 60;
const RECONNECT_GRACE_MS = 15_000;
const EMPTY_ROOM_TTL_MS = 60 * 60 * 1000;
const ROOM_ID_PATTERN = /^[a-z0-9]{10}$/;

interface SocketAttachment {
  connectionId: string;
  playerId?: string;
  windowStartedAt: number;
  messageCount: number;
}

interface PlayerCredential {
  playerId: string;
  resumeToken: string;
}

interface PersistedRoom {
  version: 1;
  roomId: string;
  session: PersistedGameSession;
  credentials: PlayerCredential[];
}

class DurableSocket implements GameSocket {
  constructor(
    public readonly id: string,
    private readonly webSocket: WebSocket,
    private readonly transport: DurableRoomTransport,
  ) {}

  emit(event: string, data: unknown): void {
    this.transport.send(this.webSocket, event, data);
  }

  to(_roomId: string): PacketEmitter {
    return {
      emit: (event, data) => this.transport.broadcast(event, data, this.id),
    };
  }

  disconnect(): void {
    this.webSocket.close(1008, 'Disconnected by room server');
  }

  isFor(webSocket: WebSocket): boolean {
    return this.webSocket === webSocket;
  }
}

class DurableRoomTransport implements GameTransport {
  readonly sockets = { sockets: new Map<string, DurableSocket>() };

  constructor(private readonly ctx: DurableObjectState) {}

  to(_roomId: string): PacketEmitter {
    return { emit: (event, data) => this.broadcast(event, data) };
  }

  attach(playerId: string, webSocket: WebSocket): DurableSocket {
    const previous = this.sockets.sockets.get(playerId);
    if (previous && !previous.isFor(webSocket)) {
      previous.disconnect();
    }
    const socket = new DurableSocket(playerId, webSocket, this);
    this.sockets.sockets.set(playerId, socket);
    return socket;
  }

  detach(playerId: string, webSocket: WebSocket): void {
    const socket = this.sockets.sockets.get(playerId);
    if (socket?.isFor(webSocket)) {
      this.sockets.sockets.delete(playerId);
    }
  }

  send(webSocket: WebSocket, event: string, data: unknown): void {
    if (webSocket.readyState !== WebSocket.OPEN) return;
    const payload = data && typeof data === 'object' ? data : { value: data };
    webSocket.send(JSON.stringify({ type: event, ...payload }));
  }

  broadcast(event: string, data: unknown, exceptPlayerId?: string): void {
    for (const [playerId, socket] of this.sockets.sockets) {
      if (playerId !== exceptPlayerId) socket.emit(event, data);
    }
  }

  scheduleAlarm(timestamp: number): Promise<void> {
    return this.ctx.storage.setAlarm(timestamp);
  }

  async clearAlarm(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
  }
}

export class GameRoom extends DurableObject<Env> {
  private readonly transport: DurableRoomTransport;
  private roomId = '';
  private session: GameSession | null = null;
  private credentials = new Map<string, string>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.transport = new DurableRoomTransport(ctx);

    ctx.blockConcurrencyWhile(async () => {
      const persisted = await ctx.storage.get<PersistedRoom>('room');
      if (!persisted) return;

      this.roomId = persisted.roomId;
      this.session = new GameSession(this.transport, this.roomId);
      this.credentials = new Map(
        persisted.credentials.map(({ playerId, resumeToken }) => [
          playerId,
          resumeToken,
        ]),
      );

      for (const webSocket of ctx.getWebSockets()) {
        const attachment =
          webSocket.deserializeAttachment() as SocketAttachment | null;
        if (attachment?.playerId) {
          this.transport.attach(attachment.playerId, webSocket);
        }
      }

      const { interrupted } = this.session.restore(persisted.session);
      if (interrupted) {
        this.transport.broadcast(SystemPacketType.GAME_INTERRUPTED, {
          reason: 'server_restart',
          message: '게임 서버가 재시작되어 로비로 돌아왔습니다.',
        });
        await this.persist();
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const roomId = url.pathname.split('/').at(-1) ?? '';
    if (!ROOM_ID_PATTERN.test(roomId)) {
      return Response.json({ error: 'invalid_room_id' }, { status: 400 });
    }
    if (!this.session) {
      this.roomId = roomId;
      this.session = new GameSession(this.transport, roomId);
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const attachment: SocketAttachment = {
      connectionId: crypto.randomUUID(),
      windowStartedAt: Date.now(),
      messageCount: 0,
    };
    server.serializeAttachment(attachment);
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(
    webSocket: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    const byteLength =
      typeof message === 'string'
        ? new TextEncoder().encode(message).byteLength
        : message.byteLength;
    if (byteLength > MAX_FRAME_BYTES) {
      webSocket.close(1009, 'Frame too large');
      return;
    }

    const attachment = (webSocket.deserializeAttachment() ?? {
      connectionId: crypto.randomUUID(),
      windowStartedAt: Date.now(),
      messageCount: 0,
    }) as SocketAttachment;

    const now = Date.now();
    if (now - attachment.windowStartedAt >= 1000) {
      attachment.windowStartedAt = now;
      attachment.messageCount = 0;
    }
    attachment.messageCount += 1;
    webSocket.serializeAttachment(attachment);
    if (attachment.messageCount > MAX_MESSAGES_PER_SECOND) {
      webSocket.close(1008, 'Message rate exceeded');
      return;
    }

    let packet: ServerPacket;
    try {
      const text =
        typeof message === 'string'
          ? message
          : new TextDecoder().decode(message);
      packet = JSON.parse(text) as ServerPacket;
      if (!packet || typeof packet.type !== 'string')
        throw new Error('Invalid packet');
    } catch {
      this.sendSystemMessage(webSocket, '잘못된 메시지 형식입니다.');
      return;
    }

    if (packet.type === SystemPacketType.JOIN_ROOM) {
      await this.join(webSocket, attachment, packet);
      return;
    }

    if (!attachment.playerId || !this.session) {
      this.sendSystemMessage(webSocket, '먼저 방에 참가해주세요.');
      return;
    }
    const socket = this.transport.sockets.sockets.get(attachment.playerId);
    if (!socket) {
      this.sendSystemMessage(webSocket, '연결 정보를 찾을 수 없습니다.');
      return;
    }

    this.handlePacket(socket, packet);
    if (this.shouldPersist(packet)) await this.persist();
  }

  async webSocketClose(webSocket: WebSocket): Promise<void> {
    const attachment =
      webSocket.deserializeAttachment() as SocketAttachment | null;
    const playerId = attachment?.playerId;
    if (!playerId || !this.session) return;

    this.transport.detach(playerId, webSocket);
    setTimeout(() => {
      void this.removeDisconnectedPlayer(playerId);
    }, RECONNECT_GRACE_MS);
  }

  webSocketError(webSocket: WebSocket): void {
    void this.webSocketClose(webSocket);
  }

  async alarm(): Promise<void> {
    if (!this.session) {
      await this.ctx.storage.deleteAll();
      return;
    }
    if (this.session.getPlayerCount() === 0) {
      await this.ctx.storage.deleteAll();
      this.credentials.clear();
      return;
    }
    this.session.handleAlarm();
    await this.persist();
  }

  private async join(
    webSocket: WebSocket,
    attachment: SocketAttachment,
    packet: Extract<ServerPacket, { type: SystemPacketType.JOIN_ROOM }>,
  ): Promise<void> {
    if (!this.session || packet.roomId !== this.roomId) {
      this.sendSystemMessage(webSocket, '방 주소가 올바르지 않습니다.');
      webSocket.close(1008, 'Room mismatch');
      return;
    }

    const playerName = packet.playerName?.replace(/\s/g, '');
    if (!playerName || playerName.length > 8) {
      this.sendSystemMessage(
        webSocket,
        '닉네임은 1자 이상 8자 이하여야 합니다.',
      );
      return;
    }

    const canResume = Boolean(
      packet.playerId &&
      packet.resumeToken &&
      this.credentials.get(packet.playerId) === packet.resumeToken &&
      this.session.players.has(packet.playerId),
    );

    if (!canResume && this.session.status !== 'waiting') {
      this.sendSystemMessage(
        webSocket,
        '게임이 진행 중이어서 참가할 수 없습니다.',
      );
      webSocket.close(1008, 'Game in progress');
      return;
    }
    if (!canResume && this.session.getPlayerCount() >= MAX_PLAYERS) {
      this.sendSystemMessage(webSocket, '방이 꽉 찼습니다.');
      webSocket.close(1008, 'Room full');
      return;
    }

    const playerId = canResume ? packet.playerId! : crypto.randomUUID();
    const resumeToken = canResume ? packet.resumeToken! : crypto.randomUUID();
    if (!canResume) {
      this.session.addPlayer(playerId, playerName);
      this.credentials.set(playerId, resumeToken);
    }

    attachment.playerId = playerId;
    webSocket.serializeAttachment(attachment);
    const socket = this.transport.attach(playerId, webSocket);

    const accepted: JoinAcceptedPacket = {
      type: SystemPacketType.JOIN_ACCEPTED,
      roomId: this.roomId,
      playerId,
      resumeToken,
      resumed: canResume,
    };
    socket.emit(accepted.type, accepted);

    const roomUpdate: RoomUpdatePacket = {
      type: SystemPacketType.ROOM_UPDATE,
      players: this.session.getPlayers(),
      updateType: RoomUpdateType.INIT_ROOM,
      yourIndex: this.session.getIndex(playerId),
      roomId: this.roomId,
    };
    socket.emit(roomUpdate.type, roomUpdate);

    if (!canResume) {
      this.session.updateRemainingPlayers(playerId, RoomUpdateType.PLAYER_JOIN);
    }
    const config = this.session.gameConfigs.get(this.session.selectedGameType);
    if (config) {
      const configPacket: GameConfigUpdatePacket = {
        type: SystemPacketType.GAME_CONFIG_UPDATE,
        selectedGameType: this.session.selectedGameType,
        gameConfig: config,
      };
      socket.emit(configPacket.type, configPacket);
    }

    console.log(
      JSON.stringify({
        event: canResume ? 'player_resumed' : 'player_joined',
        roomId: this.roomId,
      }),
    );
    await this.persist();
  }

  private handlePacket(socket: GameSocket, packet: ServerPacket): void {
    if (!this.session) return;
    switch (packet.type) {
      case SystemPacketType.GAME_START_REQ:
        if (this.session.isHost(socket.id)) this.session.startGame();
        else
          this.sendSystemMessageToSocket(
            socket,
            '방장만 게임을 시작할 수 있습니다.',
          );
        return;
      case SystemPacketType.GAME_CONFIG_UPDATE_REQ:
        if (this.session.isHost(socket.id)) {
          this.session.updateGameConfig(
            packet.selectedGameType,
            packet.gameConfig,
          );
        } else {
          this.sendSystemMessageToSocket(
            socket,
            '방장만 게임 설정을 변경할 수 있습니다.',
          );
        }
        return;
      case SystemPacketType.RETURN_TO_THE_LOBBY_REQ:
        this.session.returnToLobby(socket.id);
        return;
      case SystemPacketType.REPLAY_REQ:
        this.session.handleReplayRequest(socket.id);
        return;
    }

    if (
      packet.type.startsWith('APPLE_') ||
      packet.type.startsWith('FLAPPY_') ||
      packet.type.startsWith('MS_')
    ) {
      this.session.handleGamePacket(socket, packet);
    }
  }

  private shouldPersist(packet: ServerPacket): boolean {
    return ![
      AppleGamePacketType.DRAWING_DRAG_AREA,
      FlappyBirdPacketType.FLAPPY_JUMP,
      FlappyBirdPacketType.FLAPPY_REQUEST_SYNC,
      MineSweeperPacketType.MS_REQUEST_SYNC,
    ].includes(packet.type as never);
  }

  private async removeDisconnectedPlayer(playerId: string): Promise<void> {
    if (!this.session || this.transport.sockets.sockets.has(playerId)) return;
    if (!this.session.players.has(playerId)) return;

    const wasPlaying = this.session.status === 'playing';
    this.session.removePlayer(playerId);
    this.credentials.delete(playerId);
    if (wasPlaying) {
      this.transport.broadcast(SystemPacketType.GAME_INTERRUPTED, {
        reason: 'player_left',
        message: '플레이어가 연결을 종료해 로비로 돌아왔습니다.',
      });
    }
    await this.persist();
    if (this.session.getPlayerCount() === 0) {
      await this.ctx.storage.setAlarm(Date.now() + EMPTY_ROOM_TTL_MS);
    }
  }

  private sendSystemMessage(webSocket: WebSocket, message: string): void {
    this.transport.send(webSocket, SystemPacketType.SYSTEM_MESSAGE, {
      message,
    });
  }

  private sendSystemMessageToSocket(socket: GameSocket, message: string): void {
    socket.emit(SystemPacketType.SYSTEM_MESSAGE, { message });
  }

  private async persist(): Promise<void> {
    if (!this.session || !this.roomId) return;
    const snapshot: PersistedRoom = {
      version: 1,
      roomId: this.roomId,
      session: this.session.serialize(),
      credentials: Array.from(this.credentials, ([playerId, resumeToken]) => ({
        playerId,
        resumeToken,
      })),
    };
    await this.ctx.storage.put('room', snapshot);
  }
}
