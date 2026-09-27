import {
  GameType,
  getDefaultConfig,
  sanitizeForApple,
  type AppleGameRenderConfig,
  type FlappyBirdGamePreset,
  type GameConfig,
  type PipeGapPreset,
  type PipeSpacingPreset,
  type PipeSpeedPreset,
  type PipeWidthPreset,
  type RopeLengthPreset,
} from './config';
import {
  DEFAULT_MINESWEEPER_PRESET,
  type DifficultyPreset,
  type MapSizePreset,
  type MineSweeperGamePreset,
  type TimeLimit,
} from './minesweeperPackets';

// 클라이언트 입력 제한과 같은 범위를 서버에서도 강제한다.
export const CONFIG_LIMITS = {
  flappyManualSpeed: { min: 0.5, max: 5 },
  flappyManualSpacing: { min: 200, max: 1200 },
  mineSweeperManualCols: { min: 10, max: 60 },
  mineSweeperManualRows: { min: 8, max: 40 },
  mineSweeperManualMineRatio: { min: 0.05, max: 0.5 },
  mineSweeperManualTime: { min: 30, max: 300 },
} as const;

type Range = { readonly min: number; readonly max: number };

const GAME_TYPES = Object.values(GameType) as readonly string[];

export function isGameType(value: unknown): value is GameType {
  return typeof value === 'string' && GAME_TYPES.includes(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function pickOption<T extends string | number>(
  value: unknown,
  options: readonly T[],
  fallback: T,
): T {
  return options.includes(value as T) ? (value as T) : fallback;
}

function clampOptional(value: unknown, range: Range): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(range.max, Math.max(range.min, value));
}

function clampOptionalInt(value: unknown, range: Range): number | undefined {
  const clamped = clampOptional(value, range);
  return clamped === undefined ? undefined : Math.round(clamped);
}

export function sanitizeFlappyBirdPreset(raw: unknown): FlappyBirdGamePreset {
  const input = asRecord(raw);
  const defaults = getDefaultConfig(
    GameType.FLAPPY_BIRD,
  ) as FlappyBirdGamePreset;

  const pipeSpeed = pickOption<PipeSpeedPreset>(
    input.pipeSpeed,
    ['slow', 'normal', 'fast', 'manual'],
    defaults.pipeSpeed,
  );
  const pipeSpacing = pickOption<PipeSpacingPreset>(
    input.pipeSpacing,
    ['narrow', 'normal', 'wide', 'manual'],
    defaults.pipeSpacing,
  );
  const manualSpeed = clampOptional(
    input.manualSpeed,
    CONFIG_LIMITS.flappyManualSpeed,
  );
  const manualSpacing = clampOptionalInt(
    input.manualSpacing,
    CONFIG_LIMITS.flappyManualSpacing,
  );

  return {
    pipeSpeed,
    ...(pipeSpeed === 'manual' && manualSpeed !== undefined
      ? { manualSpeed }
      : {}),
    pipeSpacing,
    ...(pipeSpacing === 'manual' && manualSpacing !== undefined
      ? { manualSpacing }
      : {}),
    pipeGap: pickOption<PipeGapPreset>(
      input.pipeGap,
      ['narrow', 'normal', 'wide'],
      defaults.pipeGap,
    ),
    pipeWidth: pickOption<PipeWidthPreset>(
      input.pipeWidth,
      ['narrow', 'normal', 'wide'],
      defaults.pipeWidth,
    ),
    ropeLength: pickOption<RopeLengthPreset>(
      input.ropeLength,
      ['short', 'normal', 'long'],
      defaults.ropeLength ?? 'normal',
    ),
    connectAll:
      typeof input.connectAll === 'boolean'
        ? input.connectAll
        : (defaults.connectAll ?? false),
  };
}

export function sanitizeMineSweeperPreset(raw: unknown): MineSweeperGamePreset {
  const input = asRecord(raw);
  const defaults = DEFAULT_MINESWEEPER_PRESET;

  const mapSize = pickOption<MapSizePreset>(
    input.mapSize,
    ['small', 'medium', 'large', 'manual'],
    defaults.mapSize,
  );
  const timeLimit = pickOption<TimeLimit>(
    input.timeLimit,
    [120, 180, 240, 'manual'],
    defaults.timeLimit,
  );
  const manualCols = clampOptionalInt(
    input.manualCols,
    CONFIG_LIMITS.mineSweeperManualCols,
  );
  const manualRows = clampOptionalInt(
    input.manualRows,
    CONFIG_LIMITS.mineSweeperManualRows,
  );
  const manualMineRatio = clampOptional(
    input.manualMineRatio,
    CONFIG_LIMITS.mineSweeperManualMineRatio,
  );
  const manualTime = clampOptionalInt(
    input.manualTime,
    CONFIG_LIMITS.mineSweeperManualTime,
  );

  return {
    mapSize,
    ...(mapSize === 'manual' && manualCols !== undefined ? { manualCols } : {}),
    ...(mapSize === 'manual' && manualRows !== undefined ? { manualRows } : {}),
    difficulty: pickOption<DifficultyPreset>(
      input.difficulty,
      ['easy', 'normal', 'hard'],
      defaults.difficulty,
    ),
    ...(manualMineRatio !== undefined ? { manualMineRatio } : {}),
    timeLimit,
    ...(timeLimit === 'manual' ? { manualTime: manualTime ?? 180 } : {}),
  };
}

/** 클라이언트가 보낸 게임 설정을 서버가 저장해도 안전한 형태로 정규화한다. */
export function sanitizeGameConfig(
  gameType: GameType,
  existing: GameConfig | undefined,
  raw: unknown,
): GameConfig {
  switch (gameType) {
    case GameType.APPLE_GAME:
      return sanitizeForApple(
        existing as AppleGameRenderConfig | undefined,
        raw,
      );
    case GameType.FLAPPY_BIRD:
      return sanitizeFlappyBirdPreset(raw);
    case GameType.MINESWEEPER:
      return sanitizeMineSweeperPreset(raw);
  }
}
