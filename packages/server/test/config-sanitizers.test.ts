import { describe, expect, it } from 'vitest';
import {
  CONFIG_LIMITS,
  DEFAULT_APPLE_GAME_RENDER_CONFIG,
  DEFAULT_MINESWEEPER_PRESET,
  GameType,
  getDefaultConfig,
  isGameType,
  resolveMineSweeperPreset,
  sanitizeForApple,
  sanitizeGameConfig,
  type MineSweeperGamePreset,
} from '@main-game/common';

describe('game config sanitizers', () => {
  it('recognizes only known game types', () => {
    expect(isGameType(GameType.MINESWEEPER)).toBe(true);
    expect(isGameType('SNAKE')).toBe(false);
    expect(isGameType(undefined)).toBe(false);
  });

  it('clamps manual Minesweeper values so a host cannot allocate a huge board', () => {
    const preset = sanitizeGameConfig(GameType.MINESWEEPER, undefined, {
      mapSize: 'manual',
      manualCols: 1_000_000,
      manualRows: -5,
      difficulty: 'impossible',
      manualMineRatio: 5,
      timeLimit: 'manual',
      manualTime: 99_999,
    }) as MineSweeperGamePreset;

    const resolved = resolveMineSweeperPreset(preset);
    expect(resolved.gridCols).toBe(CONFIG_LIMITS.mineSweeperManualCols.max);
    expect(resolved.gridRows).toBe(CONFIG_LIMITS.mineSweeperManualRows.min);
    expect(resolved.mineRatio).toBe(
      CONFIG_LIMITS.mineSweeperManualMineRatio.max,
    );
    expect(resolved.totalTime).toBe(CONFIG_LIMITS.mineSweeperManualTime.max);
    expect(preset.difficulty).toBe(DEFAULT_MINESWEEPER_PRESET.difficulty);
  });

  it('falls back to defaults for malformed Flappy and Minesweeper payloads', () => {
    expect(sanitizeGameConfig(GameType.FLAPPY_BIRD, undefined, null)).toEqual(
      getDefaultConfig(GameType.FLAPPY_BIRD),
    );
    expect(
      sanitizeGameConfig(GameType.MINESWEEPER, undefined, 'not-an-object'),
    ).toEqual(DEFAULT_MINESWEEPER_PRESET);
  });

  it('drops manual Flappy values unless the matching preset is manual', () => {
    const preset = sanitizeGameConfig(GameType.FLAPPY_BIRD, undefined, {
      pipeSpeed: 'fast',
      manualSpeed: 100,
      pipeSpacing: 'manual',
      manualSpacing: 99_999,
    });
    expect(preset).toMatchObject({
      pipeSpeed: 'fast',
      pipeSpacing: 'manual',
      manualSpacing: CONFIG_LIMITS.flappyManualSpacing.max,
    });
    expect(preset).not.toHaveProperty('manualSpeed');
  });

  it('lets Apple turn "include zero" back off', () => {
    const withZero = sanitizeForApple(DEFAULT_APPLE_GAME_RENDER_CONFIG, {
      ...DEFAULT_APPLE_GAME_RENDER_CONFIG,
      minNumber: 0,
      includeZero: true,
    });
    const withoutZero = sanitizeForApple(withZero, {
      ...withZero,
      minNumber: 1,
      includeZero: false,
    });
    expect(withoutZero).toMatchObject({ minNumber: 1, includeZero: false });
  });
});
