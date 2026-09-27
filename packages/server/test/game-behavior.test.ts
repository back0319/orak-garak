import Matter from 'matter-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AppleGamePacketType,
  DEFAULT_APPLE_GAME_RENDER_CONFIG,
  FlappyBirdPacketType,
  GameType,
  MineSweeperPacketType,
  SystemPacketType,
  TileState,
  getDefaultConfig,
  type FlappyBirdGamePreset,
  type PlayerState,
  type ServerToClientPacket,
  type MSGameEndPacket,
  type SetTimePacket,
} from '@main-game/common';
import type { GameSession } from '../src/games/gameSession';
import { AppleGameInstance } from '../src/games/instances/AppleGameInstance';
import { FlappyBirdInstance } from '../src/games/instances/FlappyBirdInstance';
import { MineSweeperInstance } from '../src/games/instances/MineSweeperInstance';

function player(id: string): PlayerState {
  return {
    id,
    playerName: id,
    color: '#209cee',
    reportCard: { score: 0 },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('restored original game behavior', () => {
  it('runs five Matter substeps per 60 Hz Flappy tick and clamps the ceiling', () => {
    const packets: ServerToClientPacket[] = [];
    const fakeSession = {
      players: new Map([
        ['one', player('one')],
        ['two', { ...player('two'), color: '#e76e55' }],
      ]),
      status: 'waiting',
      broadcastPacket: (packet: ServerToClientPacket) => packets.push(packet),
      stopGame: vi.fn(),
    } as unknown as GameSession;

    const game = new FlappyBirdInstance(fakeSession);
    game.initialize(
      getDefaultConfig(GameType.FLAPPY_BIRD) as FlappyBirdGamePreset,
    );

    const internal = game as unknown as {
      birds: Matter.Body[];
      physicsUpdate(): void;
      handleGameOver(
        reason: 'pipe_collision' | 'ground_collision',
        playerIndex: number,
      ): void;
      ropeLength: number;
      updateInterval: ReturnType<typeof setInterval> | null;
    };
    const update = vi.spyOn(Matter.Engine, 'update');

    Matter.Body.setPosition(internal.birds[0], { x: 250, y: -10 });
    Matter.Body.setVelocity(internal.birds[0], { x: 0, y: -5 });
    Matter.Body.setPosition(internal.birds[1], { x: 340, y: -10 });
    Matter.Body.setVelocity(internal.birds[1], { x: 0, y: -5 });

    internal.physicsUpdate();

    expect(update).toHaveBeenCalledTimes(5);
    expect(internal.birds[0].position.y).toBeGreaterThanOrEqual(20);
    expect(internal.birds[0].velocity.y).toBeGreaterThanOrEqual(0);
    expect(internal.birds[0].velocity.y).toBeLessThan(0.3);
    expect(
      packets.filter(
        (packet) => packet.type === FlappyBirdPacketType.FLAPPY_WORLD_STATE,
      ),
    ).toHaveLength(1);

    update.mockClear();
    Matter.Body.setPosition(internal.birds[0], { x: 250, y: 300 });
    Matter.Body.setPosition(internal.birds[1], { x: 750, y: 300 });
    internal.physicsUpdate();
    expect(update).toHaveBeenCalledTimes(5);
    expect(
      Matter.Vector.magnitude(
        Matter.Vector.sub(
          internal.birds[1].position,
          internal.birds[0].position,
        ),
      ),
    ).toBeLessThanOrEqual(internal.ropeLength + 1);

    game.start();
    expect(internal.updateInterval).not.toBeNull();
    internal.handleGameOver('pipe_collision', 0);
    internal.handleGameOver('pipe_collision', 0);
    expect(
      packets.filter(
        (packet) => packet.type === FlappyBirdPacketType.FLAPPY_GAME_OVER,
      ),
    ).toHaveLength(1);
    game.destroy();
    expect(internal.updateInterval).toBeNull();
  });

  it('ends a 30-second Apple round once and not before the deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T00:00:00Z'));

    const packets: ServerToClientPacket[] = [];
    const session = {
      selectedGameType: GameType.APPLE_GAME,
      status: 'playing',
      players: new Map([['one', player('one')]]),
      gameConfigs: new Map(),
      broadcastPacket: (packet: ServerToClientPacket) => packets.push(packet),
      stopGame: vi.fn(),
      getIndex: () => 0,
      roomId: 'testroom00',
    } as unknown as GameSession;

    const game = new AppleGameInstance(session);
    const config = {
      ...DEFAULT_APPLE_GAME_RENDER_CONFIG,
      totalTime: 30,
    };
    session.gameConfigs.set(GameType.APPLE_GAME, config);
    game.initialize(config);
    game.start();

    const timePacket = packets.find(
      (packet) => packet.type === SystemPacketType.SET_TIME,
    );
    expect(timePacket).toMatchObject({
      limitTime: 30,
      remainingMs: 30_000,
    });

    await vi.advanceTimersByTimeAsync(29_999);
    expect(
      packets.filter((packet) => packet.type === SystemPacketType.TIME_END),
    ).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(
      packets.filter((packet) => packet.type === SystemPacketType.TIME_END),
    ).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(
      packets.filter((packet) => packet.type === SystemPacketType.TIME_END),
    ).toHaveLength(1);
    expect(
      packets.some((packet) => packet.type === AppleGamePacketType.SET_FIELD),
    ).toBe(true);
    expect(session.stopGame).toHaveBeenCalledTimes(1);
    expect(
      (
        game as unknown as {
          timerTimeout: ReturnType<typeof setTimeout> | null;
        }
      ).timerTimeout,
    ).toBeNull();
  });

  it('uses the shared timer contract and ends Minesweeper exactly once', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T00:00:00Z'));

    const packets: ServerToClientPacket[] = [];
    const stopGame = vi.fn();
    const session = {
      selectedGameType: GameType.MINESWEEPER,
      status: 'playing',
      players: new Map([['one', player('one')]]),
      roomId: 'testroom00',
      broadcastPacket: (packet: ServerToClientPacket) => packets.push(packet),
      stopGame,
    } as unknown as GameSession;

    const game = new MineSweeperInstance(session);
    game.initialize(getDefaultConfig(GameType.MINESWEEPER));
    game.start();

    const setTime = packets.find(
      (packet): packet is SetTimePacket =>
        packet.type === SystemPacketType.SET_TIME,
    );
    expect(setTime).toBeDefined();
    if (!setTime) throw new Error('Missing SET_TIME packet');
    expect(setTime).toMatchObject({
      limitTime: expect.any(Number),
      serverStartTime: Date.now(),
      remainingMs: expect.any(Number),
      endsAt: expect.any(Number),
    });
    expect(setTime.endsAt - setTime.serverStartTime).toBe(setTime.remainingMs);

    (
      game as unknown as { triggerGameEnd(reason: 'timeout'): void }
    ).triggerGameEnd('timeout');
    (
      game as unknown as { triggerGameEnd(reason: 'timeout'): void }
    ).triggerGameEnd('timeout');

    const end = packets.find(
      (packet): packet is MSGameEndPacket =>
        packet.type === MineSweeperPacketType.MS_GAME_END,
    );

    expect(end).toBeDefined();
    expect(end?.tiles.flat()).not.toHaveLength(0);
    expect(
      end?.tiles.flat().every((tile) => tile.state === TileState.REVEALED),
    ).toBe(true);
    expect(end?.tiles.flat().some((tile) => tile.isMine)).toBe(true);
    expect(
      packets.filter(
        (packet) => packet.type === MineSweeperPacketType.MS_GAME_END,
      ),
    ).toHaveLength(1);
    expect(stopGame).toHaveBeenCalledTimes(1);
    expect(
      (
        game as unknown as {
          timerInterval: ReturnType<typeof setInterval> | null;
        }
      ).timerInterval,
    ).toBeNull();

    game.destroy();
  });

  it('rejects duplicate or out-of-range Apple indices', () => {
    const packets: ServerToClientPacket[] = [];
    const session = {
      selectedGameType: GameType.APPLE_GAME,
      status: 'playing',
      players: new Map([['one', player('one')]]),
      gameConfigs: new Map(),
      broadcastPacket: (packet: ServerToClientPacket) => packets.push(packet),
      stopGame: vi.fn(),
      getIndex: () => 0,
      roomId: 'testroom00',
    } as unknown as GameSession;

    const game = new AppleGameInstance(session);
    game.initialize(DEFAULT_APPLE_GAME_RENDER_CONFIG);
    const internal = game as unknown as { apples: number[] };
    internal.apples[0] = 5;
    internal.apples[1] = 5;

    game.handleDragConfirm('one', [0, 0]);
    game.handleDragConfirm('one', [0, internal.apples.length]);
    game.handleDragConfirm('one', [0, 1.5]);
    game.handleDragConfirm('one', 'nope');
    expect(session.players.get('one')?.reportCard.score).toBe(0);

    game.handleDragConfirm('one', [0, 1]);
    expect(session.players.get('one')?.reportCard.score).toBe(2);
  });
});
