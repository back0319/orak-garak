import type { Server } from 'socket.io';
import { GameSession } from '../games/gameSession';

const DEFAULT_EMPTY_ROOM_TTL_MS = 60 * 60 * 1000;

export interface RoomRegistryClock {
  setTimeout(callback: () => void, delayMs: number): NodeJS.Timeout;
  clearTimeout(timer: NodeJS.Timeout): void;
}

export interface RoomRegistryOptions {
  createSession?: (io: Server, roomId: string) => GameSession;
  emptyRoomTtlMs?: () => number;
  clock?: RoomRegistryClock;
}

const systemClock: RoomRegistryClock = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer),
};

function getConfiguredEmptyRoomTtlMs(): number {
  const configured = Number(process.env.EMPTY_ROOM_TTL_MS);
  return Number.isFinite(configured) && configured >= 0
    ? configured
    : DEFAULT_EMPTY_ROOM_TTL_MS;
}

export class RoomRegistry {
  private readonly sessions = new Map<string, GameSession>();
  private readonly playerRooms = new Map<string, string>();
  private readonly cleanupTimers = new Map<string, NodeJS.Timeout>();
  private readonly createGameSession: (
    io: Server,
    roomId: string,
  ) => GameSession;
  private readonly emptyRoomTtlMs: () => number;
  private readonly clock: RoomRegistryClock;

  constructor(options: RoomRegistryOptions = {}) {
    this.createGameSession =
      options.createSession ?? ((io, roomId) => new GameSession(io, roomId));
    this.emptyRoomTtlMs = options.emptyRoomTtlMs ?? getConfiguredEmptyRoomTtlMs;
    this.clock = options.clock ?? systemClock;
  }

  public hasSession(roomId: string): boolean {
    return this.sessions.has(roomId);
  }

  public getSession(roomId: string): GameSession | undefined {
    return this.sessions.get(roomId);
  }

  public createSession(io: Server, roomId: string): GameSession {
    if (!roomId) throw new Error('Room ID is required');
    if (this.sessions.has(roomId)) {
      throw new Error(`Room already exists: ${roomId}`);
    }

    const session = this.createGameSession(io, roomId);
    this.sessions.set(roomId, session);
    return session;
  }

  public getPlayerRoom(playerId: string): string | undefined {
    return this.playerRooms.get(playerId);
  }

  public claimPlayer(
    playerId: string,
    roomId: string,
    maxPlayers = Number.POSITIVE_INFINITY,
  ): boolean {
    if (
      !this.sessions.has(roomId) ||
      this.playerRooms.has(playerId) ||
      this.countClaimedPlayers(roomId) >= maxPlayers
    ) {
      return false;
    }
    this.playerRooms.set(playerId, roomId);
    return true;
  }

  public releasePlayer(playerId: string, expectedRoomId?: string): boolean {
    const roomId = this.playerRooms.get(playerId);
    if (!roomId || (expectedRoomId && roomId !== expectedRoomId)) return false;
    this.playerRooms.delete(playerId);
    return true;
  }

  public scheduleCleanup(roomId: string): boolean {
    if (this.cleanupTimers.has(roomId)) return false;

    const session = this.sessions.get(roomId);
    if (!session || session.players.size > 0 || this.hasClaimedPlayer(roomId)) {
      return false;
    }

    const timer = this.clock.setTimeout(() => {
      if (this.cleanupTimers.get(roomId) !== timer) return;
      this.cleanupTimers.delete(roomId);

      const current = this.sessions.get(roomId);
      if (
        current === session &&
        current.players.size === 0 &&
        !this.hasClaimedPlayer(roomId)
      ) {
        this.disposeRoom(roomId, session);
      }
    }, this.emptyRoomTtlMs());
    this.cleanupTimers.set(roomId, timer);
    return true;
  }

  public cancelCleanup(roomId: string): boolean {
    const timer = this.cleanupTimers.get(roomId);
    if (!timer) return false;
    this.clock.clearTimeout(timer);
    this.cleanupTimers.delete(roomId);
    return true;
  }

  public disposeRoom(roomId: string, expectedSession?: GameSession): boolean {
    const session = this.sessions.get(roomId);
    if (!session || (expectedSession && session !== expectedSession)) {
      return false;
    }

    this.cancelCleanup(roomId);
    try {
      session.dispose();
    } finally {
      this.sessions.delete(roomId);
      for (const [playerId, playerRoomId] of this.playerRooms) {
        if (playerRoomId === roomId) this.playerRooms.delete(playerId);
      }
    }
    return true;
  }

  public disposeAll(): void {
    for (const timer of this.cleanupTimers.values()) {
      this.clock.clearTimeout(timer);
    }
    this.cleanupTimers.clear();

    for (const session of this.sessions.values()) session.dispose();
    this.sessions.clear();
    this.playerRooms.clear();
  }

  private hasClaimedPlayer(roomId: string): boolean {
    return this.countClaimedPlayers(roomId) > 0;
  }

  private countClaimedPlayers(roomId: string): number {
    let count = 0;
    for (const playerRoomId of this.playerRooms.values()) {
      if (playerRoomId === roomId) count++;
    }
    return count;
  }
}

export const roomRegistry = new RoomRegistry();
