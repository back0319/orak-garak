import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'socket.io';
import type { GameSession } from '../src/games/gameSession';
import {
  RoomRegistry,
  type RoomRegistryClock,
} from '../src/rooms/roomRegistry';

interface FakeSession {
  players: Map<string, never>;
  dispose: ReturnType<typeof vi.fn>;
}

function createHarness(
  options: {
    emptyRoomTtlMs?: () => number;
    clock?: RoomRegistryClock;
  } = {},
) {
  const sessions = new Map<string, FakeSession>();
  const registry = new RoomRegistry({
    ...options,
    createSession: (_io, roomId) => {
      const session: FakeSession = {
        players: new Map<string, never>(),
        dispose: vi.fn(),
      };
      sessions.set(roomId, session);
      return session as unknown as GameSession;
    },
  });

  return {
    registry,
    sessions,
    io: {} as Server,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('RoomRegistry', () => {
  it('owns session creation and rejects duplicate room IDs', () => {
    const { registry, io } = createHarness();

    const session = registry.createSession(io, 'room-one');

    expect(registry.getSession('room-one')).toBe(session);
    expect(() => registry.createSession(io, 'room-one')).toThrow(
      'Room already exists: room-one',
    );
  });

  it('claims each player atomically and releases only the expected room', () => {
    const { registry, io } = createHarness();
    registry.createSession(io, 'room-one');
    registry.createSession(io, 'room-two');

    expect(registry.claimPlayer('player', 'room-one')).toBe(true);
    expect(registry.claimPlayer('player', 'room-two')).toBe(false);
    expect(registry.getPlayerRoom('player')).toBe('room-one');
    expect(registry.releasePlayer('player', 'room-two')).toBe(false);
    expect(registry.releasePlayer('player', 'room-one')).toBe(true);
    expect(registry.getPlayerRoom('player')).toBeUndefined();

    expect(registry.claimPlayer('one', 'room-one', 2)).toBe(true);
    expect(registry.claimPlayer('two', 'room-one', 2)).toBe(true);
    expect(registry.claimPlayer('three', 'room-one', 2)).toBe(false);
  });

  it('cancels cleanup when an empty room is reclaimed', async () => {
    vi.useFakeTimers();
    const { registry, sessions, io } = createHarness({
      emptyRoomTtlMs: () => 100,
    });
    registry.createSession(io, 'room-one');

    expect(registry.scheduleCleanup('room-one')).toBe(true);
    expect(registry.cancelCleanup('room-one')).toBe(true);
    await vi.advanceTimersByTimeAsync(100);

    expect(registry.getSession('room-one')).toBeDefined();
    expect(sessions.get('room-one')?.dispose).not.toHaveBeenCalled();
  });

  it('disposes an unclaimed empty room once when its TTL expires', async () => {
    vi.useFakeTimers();
    const { registry, sessions, io } = createHarness({
      emptyRoomTtlMs: () => 100,
    });
    registry.createSession(io, 'room-one');

    expect(registry.claimPlayer('player', 'room-one')).toBe(true);
    expect(registry.scheduleCleanup('room-one')).toBe(false);
    expect(registry.releasePlayer('player', 'room-one')).toBe(true);
    expect(registry.scheduleCleanup('room-one')).toBe(true);
    expect(registry.scheduleCleanup('room-one')).toBe(false);

    await vi.advanceTimersByTimeAsync(100);
    expect(registry.getSession('room-one')).toBeUndefined();
    expect(sessions.get('room-one')?.dispose).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(sessions.get('room-one')?.dispose).toHaveBeenCalledTimes(1);
  });

  it('ignores a stale cleanup callback after the room ID is reused', () => {
    const callbacks: Array<() => void> = [];
    const clock: RoomRegistryClock = {
      setTimeout(callback) {
        callbacks.push(callback);
        return callbacks.length as unknown as NodeJS.Timeout;
      },
      clearTimeout() {},
    };
    const { registry, sessions, io } = createHarness({
      emptyRoomTtlMs: () => 100,
      clock,
    });
    const previous = registry.createSession(io, 'room-one');
    const previousDispose = sessions.get('room-one')?.dispose;
    registry.scheduleCleanup('room-one');
    registry.disposeRoom('room-one', previous);

    const replacement = registry.createSession(io, 'room-one');
    const replacementDispose = sessions.get('room-one')?.dispose;
    callbacks[0]();

    expect(registry.getSession('room-one')).toBe(replacement);
    expect(previousDispose).toHaveBeenCalledTimes(1);
    expect(replacementDispose).not.toHaveBeenCalled();
  });

  it('disposes every room and clears player claims and timers', async () => {
    vi.useFakeTimers();
    const { registry, sessions, io } = createHarness({
      emptyRoomTtlMs: () => 100,
    });
    registry.createSession(io, 'room-one');
    registry.createSession(io, 'room-two');
    registry.claimPlayer('player', 'room-one');
    registry.scheduleCleanup('room-two');

    registry.disposeAll();
    await vi.advanceTimersByTimeAsync(100);

    expect(registry.getSession('room-one')).toBeUndefined();
    expect(registry.getSession('room-two')).toBeUndefined();
    expect(registry.getPlayerRoom('player')).toBeUndefined();
    expect(sessions.get('room-one')?.dispose).toHaveBeenCalledTimes(1);
    expect(sessions.get('room-two')?.dispose).toHaveBeenCalledTimes(1);
  });
});
