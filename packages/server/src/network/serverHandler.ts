import {
  SystemPacketType,
  type ClientToServerPacket,
  RoomUpdatePacket,
  RoomUpdateType,
  GameConfigUpdatePacket,
  type LobbyChatHistoryPacket,
  type LobbyChatMessagePacket,
  toSocketPayload,
  isGameType,
} from '@main-game/common';
import type { GameSession } from '../games/gameSession';
import { roomRegistry } from '../rooms/roomRegistry';
import { customAlphabet } from 'nanoid';
import type { GameSocket, GameSocketServer } from './socketTypes';

// 커스텀 nanoid 생성기
const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
const generateRoomId = customAlphabet(alphabet, 10);

const lobbyChatRateLimits = new Map<string, number[]>();
const LOBBY_CHAT_WINDOW_MS = 5_000;
const LOBBY_CHAT_MAX_PER_WINDOW = 3;

function normalizePlayerName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/g, '');
  const length = Array.from(normalized).length;
  return length >= 1 && length <= 8 ? normalized : null;
}

function isValidRoomId(value: unknown): value is string {
  return (
    typeof value === 'string' && (value === '' || /^[a-z0-9]{10}$/.test(value))
  );
}

function normalizeLobbyChatMessage(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/\s+/g, ' ');
  const length = Array.from(normalized).length;
  return length >= 1 && length <= 100 ? normalized : null;
}

function consumeLobbyChatRateLimit(socketId: string): boolean {
  const now = Date.now();
  const recent = (lobbyChatRateLimits.get(socketId) ?? []).filter(
    (timestamp) => timestamp > now - LOBBY_CHAT_WINDOW_MS,
  );
  if (recent.length >= LOBBY_CHAT_MAX_PER_WINDOW) {
    lobbyChatRateLimits.set(socketId, recent);
    return false;
  }
  recent.push(now);
  lobbyChatRateLimits.set(socketId, recent);
  return true;
}

function emitLobbyChatHistory(socket: GameSocket, session: GameSession): void {
  const packet: LobbyChatHistoryPacket = {
    type: SystemPacketType.LOBBY_CHAT_HISTORY,
    messages: session.getLobbyChatHistory(),
  };
  socket.emit(SystemPacketType.LOBBY_CHAT_HISTORY, toSocketPayload(packet));
}

export function clearServerState(): void {
  roomRegistry.disposeAll();
  lobbyChatRateLimits.clear();
}

export function handleConnection(socket: GameSocket) {
  // 클라이언트 정보 추출
  const clientIP =
    (socket.handshake.headers['x-forwarded-for'] as string) ||
    socket.request?.socket?.remoteAddress ||
    'unknown';
  const userAgent = socket.handshake.headers['user-agent'] || 'unknown';
  const acceptLanguage =
    socket.handshake.headers['accept-language'] || 'unknown';
  const connectionTime = socket.handshake.time;

  // 이쁘게 로깅
  console.log('=====================================');
  console.log('[접속] 새 클라이언트 연결');
  console.log('-------------------------------------');
  console.log(`  Socket ID : ${socket.id}`);
  console.log(`  IP        : ${clientIP}`);
  console.log(`  User-Agent: ${userAgent}`);
  console.log(`  Language  : ${acceptLanguage}`);
  console.log(`  접속 시간  : ${connectionTime}`);
  console.log('=====================================');
  console.log('');
}

export function handleDisconnect(socketId: string) {
  lobbyChatRateLimits.delete(socketId);
  const roomId = roomRegistry.getPlayerRoom(socketId);
  if (!roomId) return;

  roomRegistry.releasePlayer(socketId, roomId);
  const session = roomRegistry.getSession(roomId);
  if (!session) return;

  session.removePlayer(socketId);
  if (session.players.size === 0) roomRegistry.scheduleCleanup(roomId);
}

export function handleClientPacket(
  io: GameSocketServer,
  socket: GameSocket,
  packet: ClientToServerPacket,
) {
  try {
    console.log(
      '[Server] handleClientPacket received packet type:',
      packet.type,
    );

    // JOIN_ROOM 처리
    if (packet.type === SystemPacketType.JOIN_ROOM) {
      const playerName = normalizePlayerName(packet.playerName);
      if (!playerName || !isValidRoomId(packet.roomId)) {
        socket.emit(SystemPacketType.SYSTEM_MESSAGE, {
          message: '닉네임 또는 방 코드가 올바르지 않습니다.',
        });
        return;
      }
      void joinPlayerToGame(io, socket, packet.roomId, playerName).catch(
        (error) => {
          console.error('[Server] Unexpected room join failure:', error);
          if (socket.connected) {
            socket.emit(SystemPacketType.SYSTEM_MESSAGE, {
              message: '방 참여에 실패했습니다.',
            });
          }
        },
      );
      return;
    }

    const roomId = roomRegistry.getPlayerRoom(socket.id);
    if (!roomId) {
      console.log(`[Server] roomId 없음 - socket.id: ${socket.id}`);
      return;
    }

    const session = roomRegistry.getSession(roomId);
    if (!session) {
      console.log(`[Server] session 없음 - roomId: ${roomId}`);
      return;
    }

    // System 패킷 처리
    switch (packet.type) {
      case SystemPacketType.LOBBY_CHAT_SEND: {
        if (session.status !== 'waiting') {
          socket.emit(SystemPacketType.LOBBY_CHAT_ERROR, {
            message: '채팅은 로비에서만 사용할 수 있습니다.',
          });
          break;
        }

        const message = normalizeLobbyChatMessage(packet.message);
        if (!message) {
          socket.emit(SystemPacketType.LOBBY_CHAT_ERROR, {
            message: '메시지는 1자 이상 100자 이하로 입력해주세요.',
          });
          break;
        }

        if (!consumeLobbyChatRateLimit(socket.id)) {
          socket.emit(SystemPacketType.LOBBY_CHAT_ERROR, {
            message:
              '메시지를 너무 빠르게 보내고 있어요. 잠시 후 다시 시도해주세요.',
          });
          break;
        }

        const chatMessage = session.addLobbyChatMessage(socket.id, message);
        if (!chatMessage) break;
        const chatPacket: LobbyChatMessagePacket = {
          type: SystemPacketType.LOBBY_CHAT_MESSAGE,
          message: chatMessage,
        };
        session.broadcastPacket(chatPacket);
        break;
      }

      case SystemPacketType.GAME_START_REQ: {
        if (session.isHost(socket.id)) {
          console.log(`[Server] Host ${socket.id} starting game`);
          session.startGame();
        } else {
          const playerExists = !!session.players.get(socket.id);
          console.log(
            `[Server] Start denied: ${playerExists ? 'not order 0' : 'player not found'}`,
          );
          socket.emit(SystemPacketType.SYSTEM_MESSAGE, {
            message: '방장만 게임을 시작할 수 있습니다.',
          });
        }
        break;
      }

      case SystemPacketType.GAME_CONFIG_UPDATE_REQ:
        // Only host may update game config
        if (!session.isHost(socket.id)) {
          socket.emit(SystemPacketType.SYSTEM_MESSAGE, {
            message: '방장만 게임 설정을 변경할 수 있습니다.',
          });
          break;
        }
        if (!isGameType(packet.selectedGameType)) {
          socket.emit(SystemPacketType.SYSTEM_MESSAGE, {
            message: '지원하지 않는 게임입니다.',
          });
          break;
        }
        session.updateGameConfig(packet.selectedGameType, packet.gameConfig);
        break;

      case SystemPacketType.RETURN_TO_THE_LOBBY_REQ:
        session.returnToLobby(socket.id);
        break;

      case SystemPacketType.REPLAY_REQ:
        session.handleReplayRequest(socket.id);
        break;

      default:
        // 시스템 패킷이 아니면 현재 게임 인스턴스로 전달한다.
        session.handleGamePacket(socket, packet);
        break;
    }
  } catch (error) {
    console.error(`[Server] Error handling packet ${packet.type}:`, error);
  }
}

const MAX_PLAYERS_PER_ROOM = 4;

async function claimAndJoinSocket(
  socket: GameSocket,
  roomId: string,
): Promise<boolean> {
  if (!roomRegistry.claimPlayer(socket.id, roomId, MAX_PLAYERS_PER_ROOM)) {
    const alreadyJoined = roomRegistry.getPlayerRoom(socket.id) !== undefined;
    socket.emit(SystemPacketType.SYSTEM_MESSAGE, {
      message: alreadyJoined ? '이미 방에 참여 중입니다.' : 'Room is full',
    });
    if (!alreadyJoined) socket.disconnect();
    return false;
  }

  try {
    await socket.join(roomId);
  } catch (error) {
    console.error(`[Server] Failed to join room ${roomId}:`, error);
    roomRegistry.releasePlayer(socket.id, roomId);
    if (socket.connected) {
      socket.emit(SystemPacketType.SYSTEM_MESSAGE, {
        message: '방 참여에 실패했습니다.',
      });
    }
    return false;
  }

  if (!socket.connected) {
    roomRegistry.releasePlayer(socket.id, roomId);
    return false;
  }
  return true;
}

export async function joinPlayerToGame(
  io: GameSocketServer,
  socket: GameSocket,
  roomId: string,
  playerName: string,
) {
  if (roomRegistry.getPlayerRoom(socket.id)) {
    socket.emit(SystemPacketType.SYSTEM_MESSAGE, {
      message: '이미 방에 참여 중입니다.',
    });
    return;
  }

  const isCreatingRoom = roomId === '';
  if (isCreatingRoom) {
    do {
      roomId = generateRoomId();
    } while (roomRegistry.hasSession(roomId));
  }

  console.log(
    `[Server] Player ${playerName} (${socket.id}) joining room ${roomId}`,
  );

  let session = roomRegistry.getSession(roomId);

  if (!isCreatingRoom && !session) {
    socket.emit(SystemPacketType.SYSTEM_MESSAGE, {
      message: '존재하지 않는 방입니다.',
    });
    return;
  }

  if (session && session.status !== 'waiting') {
    const message =
      session.status === 'playing'
        ? '게임이 이미 진행 중입니다.'
        : '게임이 아직 종료되지 않았습니다.';
    socket.emit(SystemPacketType.SYSTEM_MESSAGE, {
      message,
    });
    socket.disconnect();
    return;
  }

  let createdSession = false;
  if (!session) {
    session = roomRegistry.createSession(io, roomId);
    createdSession = true;
    console.log(`Created new Game Session for ${roomId}`);
  } else {
    const socketRoomSize = io.sockets.adapter.rooms.get(roomId)?.size ?? 0;
    if (socketRoomSize >= MAX_PLAYERS_PER_ROOM) {
      socket.emit(SystemPacketType.SYSTEM_MESSAGE, { message: 'Room is full' });
      socket.disconnect();
      return;
    }
    if (session.getPlayerCount() >= MAX_PLAYERS_PER_ROOM) {
      socket.emit(SystemPacketType.SYSTEM_MESSAGE, {
        message: '방이 꽉 찼습니다.',
      });
      socket.disconnect();
      return;
    }
    roomRegistry.cancelCleanup(roomId);
  }

  const joined = await claimAndJoinSocket(socket, roomId);
  if (!joined) {
    if (createdSession) {
      roomRegistry.disposeRoom(roomId, session);
    } else if (session.players.size === 0) {
      roomRegistry.scheduleCleanup(roomId);
    }
    return;
  }

  session.addPlayer(socket.id, playerName);

  const roomUpdatePacket2Player: RoomUpdatePacket = {
    type: SystemPacketType.ROOM_UPDATE,
    players: session.getPlayers(),
    updateType: createdSession
      ? RoomUpdateType.INIT_ROOM
      : RoomUpdateType.PLAYER_JOIN,
    yourIndex: session.getIndex(socket.id),
    roomId,
  };
  socket.emit(
    SystemPacketType.ROOM_UPDATE,
    toSocketPayload(roomUpdatePacket2Player),
  );
  emitLobbyChatHistory(socket, session);
  console.log(
    `[Server] Sent ROOM_UPDATE (${roomUpdatePacket2Player.updateType}) to ${socket.id}`,
  );

  // 방 생성자를 포함한 모든 입장자가 서버의 현재 게임 설정을 기준으로 로비를 그린다.
  emitCurrentGameConfig(socket, session);

  if (!createdSession) {
    session.updateRemainingPlayers(socket.id, RoomUpdateType.PLAYER_JOIN);
  }
}

function emitCurrentGameConfig(socket: GameSocket, session: GameSession): void {
  const gameConfig = session.gameConfigs.get(session.selectedGameType);
  if (!gameConfig) return;

  const configPacket: GameConfigUpdatePacket = {
    type: SystemPacketType.GAME_CONFIG_UPDATE,
    selectedGameType: session.selectedGameType,
    gameConfig,
  };
  socket.emit(
    SystemPacketType.GAME_CONFIG_UPDATE,
    toSocketPayload(configPacket),
  );
}
