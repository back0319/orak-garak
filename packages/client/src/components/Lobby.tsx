import { useState, useEffect } from 'react';
import 'nes.css/css/nes.min.css';
import '../assets/fonts/Font.css';
import './Lobby.css';
// import type { Game, GameSettings } from '../game/types/common';
import type { AppleGamePreset } from '../game/types/AppleGamePreset';
import type {
  FlappyBirdGamePreset,
  PipeGapPreset,
  PipeWidthPreset,
  PipeSpacingPreset,
  PipeSpeedPreset,
  RopeLengthPreset,
} from '../../../common/src/config';
import type { LobbyPlayer, Game, GameSettings } from '../game/types/common';
import type {
  MineSweeperGamePreset,
  MapSizePreset,
  DifficultyPreset,
  TimeLimit,
} from '../game/types/minesweeperPresets';
import { CONSTANTS } from '../game/types/common';
import SoundSetting from './SoundSetting';
import { useGameStore } from '../store/gameStore';
import { SystemPacketType } from '../../../common/src/packets';
import {
  MapSize,
  GameType,
  MAP_SIZE_TO_GRID,
} from '../../../common/src/config.ts';
import type { AppleGameRenderConfig } from '../../../common/src/config.ts';
import { socketManager } from '../network/socket';
import type { PlayerData } from '../../../common/src/common-type';

export interface LobbyProps {
  players: PlayerData[];
  onGameStart: (gameType: string, preset: unknown) => void;
}
import { useSFXContext } from '../contexts/SFXContext';
import { GAME_DESCRIPTIONS } from '../constants/gameDescriptions';
import faviconIcon from '../assets/icons/favicon.png';

const {
  PLAYER_COLORS,
  MAX_PLAYERS,
  TOOLTIP_DURATION,
  MIN_TIME_LIMIT,
  MAX_TIME_LIMIT,
  DEFAULT_TIME_LIMIT,
} = CONSTANTS;

/** 난이도 색상 (쉬움/보통/어려움) */
const DIFFICULTY_COLORS = {
  easy: '#4CAF50',
  normal: '#FF9800',
  hard: '#F44336',
} as const;
function Lobby({ players, onGameStart }: LobbyProps) {
  const { playSFX } = useSFXContext();
  // 게임 리스트
  const [games] = useState<Game[]>([
    { id: 'apple', name: '다같이 사과 게임', thumbnail: '🍎' },
    { id: 'flappy', name: '다같이 플래피 버드', thumbnail: '🐦' },
    { id: 'minesweeper', name: '다같이 지뢰찾기', thumbnail: '💣' },
  ]);

  const [selectedGame, setSelectedGame] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<{
    show: boolean;
    message: string;
    type: 'success' | 'error';
  }>({ show: false, message: '', type: 'success' });
  const [showButtonTooltip, setShowButtonTooltip] = useState(false);
  const [showTimeLimitTooltip, setShowTimeLimitTooltip] = useState<
    Record<string, boolean>
  >({});
  // 직접 입력 중인 값 (문자열로 관리)
  const [localTimeInput, setLocalTimeInput] = useState<Record<string, string>>(
    {},
  );

  // 각 게임의 설정 (기본값)
  const [gameSettings, setGameSettings] = useState<
    Record<string, GameSettings>
  >({
    apple: {
      mapSize: 'normal',
      timeLimit: 120,
      appleRange: '1-9',
      includeZero: false,
    },
    flappy: {
      pipeGap: 'normal', // 상하 파이프 간격
      pipeWidth: 'normal', // 파이프 넓이
      pipeSpacing: 'normal', // 좌우 파이프 간격
      pipeSpeed: 'normal', // 이동 속도
      ropeLength: 'normal', // 밧줄 길이
      connectAll: false, // 모두 묶기
    },
    minesweeper: {
      mapSize: 'medium',
      timeLimit: 180,
      mineRatio: 'normal', // easy: 10%, normal: 20%, hard: 30%
    },
  });

  // 방장 여부 확인 (myselfIndex가 변경될 때마다 리렌더링)
  const myselfIndex = useGameStore((s) => s.myselfIndex);
  const isHost = myselfIndex === 0;
  const isDisabled = !isHost;

  const handleSelectGame = (gameId: string) => {
    playSFX('buttonClick');
    setSelectedGame(gameId);
    // send current settings to server
    const settings = gameSettings[gameId];
    sendGameConfigUpdate(gameId, settings);
  };

  const handleSettingChange = (
    gameId: string,
    setting: keyof GameSettings,
    value: string | number | boolean,
  ) => {
    setGameSettings((prev) => {
      const updated = {
        ...prev,
        [gameId]: { ...prev[gameId], [setting]: value },
      };
      // send updated settings to server immediately
      sendGameConfigUpdate(gameId, updated[gameId]);
      return updated;
    });
  };

  // 시간 입력 완료 시 호출 (blur/Enter)
  const commitTimeLimit = (gameId: string, defaultValue: number) => {
    const localValue = localTimeInput[gameId];
    const numValue = localValue ? parseInt(localValue) : -1;

    let finalValue: number;
    if (!localValue) {
      finalValue = defaultValue;
    } else if (numValue < MIN_TIME_LIMIT || numValue > MAX_TIME_LIMIT) {
      showTimeLimitTooltipForGame(gameId);
      finalValue = defaultValue;
    } else {
      finalValue = numValue;
    }

    // 로컬 상태 초기화
    setLocalTimeInput((prev) => ({ ...prev, [gameId]: '' }));

    // 상태 업데이트 및 패킷 전송
    handleSettingChange(gameId, 'timeLimit', finalValue);
  };

  // Build and send GAME_CONFIG_UPDATE_REQ according to current settings
  const sendGameConfigUpdate = (
    gameId: string,
    settings: GameSettings | undefined,
  ) => {
    if (!settings) return;

    let selectedGameType = GameType.APPLE_GAME;
    // todo gameId 자체가 GameType이면 굳이 이런 분기 로직 없이 selectedGameType = gameId 가능
    if (gameId === 'apple') selectedGameType = GameType.APPLE_GAME;
    else if (gameId === 'flappy') selectedGameType = GameType.FLAPPY_BIRD;
    else if (gameId === 'minesweeper') selectedGameType = GameType.MINESWEEPER;

    if (gameId === 'apple') {
      const s = settings as GameSettings;

      // MapSize → grid 변환
      let mapSizeEnum = MapSize.MEDIUM;
      if (s.mapSize === 'small') mapSizeEnum = MapSize.SMALL;
      else if (s.mapSize === 'large') mapSizeEnum = MapSize.LARGE;

      const grid = MAP_SIZE_TO_GRID[mapSizeEnum];

      // time 계산
      const timeVal =
        typeof s.timeLimit === 'number' && s.timeLimit !== -1
          ? s.timeLimit
          : DEFAULT_TIME_LIMIT;

      // AppleGameRenderConfig 직접 생성
      const appleCfg: AppleGameRenderConfig = {
        gridCols: grid.cols,
        gridRows: grid.rows,
        minNumber: s.includeZero ? 0 : 1,
        maxNumber: s.appleRange === '1-5' ? 5 : 9,
        totalTime: timeVal,
        includeZero: !!s.includeZero,
      };

      const packet = {
        type: SystemPacketType.GAME_CONFIG_UPDATE_REQ,
        selectedGameType,
        gameConfig: appleCfg,
      } as const;

      socketManager.send(packet);
      return;
    }

    if (gameId === 'flappy') {
      const s = settings as GameSettings;

      const flappyPreset: FlappyBirdGamePreset = {
        pipeGap: (s.pipeGap || 'normal') as PipeGapPreset,
        pipeWidth: (s.pipeWidth || 'normal') as PipeWidthPreset,
        pipeSpacing: (s.pipeSpacing || 'normal') as PipeSpacingPreset,
        pipeSpeed: (s.pipeSpeed || 'normal') as PipeSpeedPreset,
        ropeLength: (s.ropeLength || 'normal') as RopeLengthPreset,
        connectAll: s.connectAll ?? false,
      };

      const packet = {
        type: SystemPacketType.GAME_CONFIG_UPDATE_REQ,
        selectedGameType,
        gameConfig: flappyPreset,
      } as const;

      socketManager.send(packet);
      return;
    }

    if (gameId === 'minesweeper') {
      const s = settings as GameSettings;

      // difficulty 변환 (mineRatio)
      let difficulty: DifficultyPreset = 'normal';
      if (s.mineRatio === 'easy') difficulty = 'easy';
      else if (s.mineRatio === 'hard') difficulty = 'hard';

      // timeLimit === -1이면 "직접 입력" 선택 상태이므로 서버에 패킷 전송하지 않음
      if (s.timeLimit === -1) {
        return;
      }

      // timeLimit 변환
      const timeVal = typeof s.timeLimit === 'number' ? s.timeLimit : 180;

      const minesweeperPreset: MineSweeperGamePreset = {
        mapSize: (s.mapSize || 'medium') as MapSizePreset,
        difficulty,
        timeLimit: [120, 180, 240].includes(timeVal)
          ? (timeVal as TimeLimit)
          : 'manual',
        manualTime: ![120, 180, 240].includes(timeVal) ? timeVal : undefined,
      };

      const packet = {
        type: SystemPacketType.GAME_CONFIG_UPDATE_REQ,
        selectedGameType,
        gameConfig: minesweeperPreset,
      } as const;

      socketManager.send(packet);
      return;
    }
  };

  const showTooltip = (
    message: string,
    type: 'success' | 'error' = 'success',
  ) => {
    setTooltip({ show: true, message, type });
    setTimeout(() => {
      setTooltip({ show: false, message: '', type: 'success' });
    }, TOOLTIP_DURATION);
  };

  const showTimeLimitTooltipForGame = (gameId: string) => {
    setShowTimeLimitTooltip((prev) => ({ ...prev, [gameId]: true }));
    setTimeout(() => {
      setShowTimeLimitTooltip((prev) => ({ ...prev, [gameId]: false }));
    }, TOOLTIP_DURATION);
  };

  const handleCopyLink = () => {
    const roomId = useGameStore.getState().roomId;

    if (!roomId) {
      showTooltip('방 ID를 가져올 수 없습니다', 'error');
      return;
    }

    const inviteLink = `${window.location.origin}/invite/${roomId}`;
    navigator.clipboard.writeText(inviteLink);
    showTooltip('초대 링크가 복사되었습니다!', 'success');
  };

  const handleStartGame = () => {
    if (!selectedGame) {
      showTooltip('게임을 선택해주세요!', 'error');
      return;
    }

    // 사과 게임: gameStore.gameConfig를 사용하므로 별도 프리셋 불필요
    if (selectedGame === 'apple') {
      onGameStart('apple', null);
    } else if (selectedGame === 'flappy') {
      const settings = gameSettings.flappy;

      const preset: FlappyBirdGamePreset = {
        pipeGap: (settings.pipeGap || 'normal') as PipeGapPreset,
        pipeWidth: (settings.pipeWidth || 'normal') as PipeWidthPreset,
        pipeSpacing: (settings.pipeSpacing || 'normal') as PipeSpacingPreset,
        pipeSpeed: (settings.pipeSpeed || 'normal') as PipeSpeedPreset,
        ropeLength: (settings.ropeLength || 'normal') as RopeLengthPreset,
        connectAll: settings.connectAll ?? false,
      };
      onGameStart('flappy', preset);
    } else if (selectedGame === 'minesweeper') {
      const settings = gameSettings.minesweeper;

      // mapSize 변환
      let mapSize: MapSizePreset = 'medium';
      if (settings.mapSize === 'small') mapSize = 'small';
      else if (settings.mapSize === 'medium') mapSize = 'medium';
      else if (settings.mapSize === 'large') mapSize = 'large';

      // difficulty 변환 (mineRatio)
      let difficulty: DifficultyPreset = 'normal';
      if (settings.mineRatio === 'easy') difficulty = 'easy';
      else if (settings.mineRatio === 'normal') difficulty = 'normal';
      else if (settings.mineRatio === 'hard') difficulty = 'hard';

      const preset: MineSweeperGamePreset = {
        mapSize,
        difficulty,
        timeLimit:
          settings.timeLimit === -1
            ? 'manual'
            : (settings.timeLimit as TimeLimit),
        manualTime:
          settings.timeLimit === -1 ||
          ![120, 180, 240].includes(settings.timeLimit || 0)
            ? settings.timeLimit
            : undefined,
      };

      onGameStart('minesweeper', preset);
    }
  };

  // React to server-provided game config updates
  const serverSelectedGame = useGameStore((s) => s.selectedGameType);
  const serverGameConfig = useGameStore((s) => s.gameConfig);

  useEffect(() => {
    if (!serverSelectedGame || !serverGameConfig) return;

    // Map common GameType to local game id
    if (serverSelectedGame === ('APPLE_GAME' as unknown as GameType)) {
      // schedule selection update to avoid synchronous setState in effect
      setTimeout(() => setSelectedGame('apple'));

      const cfg = serverGameConfig as AppleGameRenderConfig;

      // gridCols/gridRows → mapSize 역변환 (UI 표시용)
      let mapSize: 'small' | 'normal' | 'large' = 'normal';
      if (cfg.gridCols === 16 && cfg.gridRows === 8) mapSize = 'small';
      else if (cfg.gridCols === 30 && cfg.gridRows === 15) mapSize = 'large';
      // 그 외는 normal (20x10)

      // maxNumber → appleRange 역변환
      const appleRange: '1-9' | '1-5' = cfg.maxNumber === 5 ? '1-5' : '1-9';

      // 입력 중이면 timeLimit은 덮어쓰지 않음
      const isEditingAppleTime =
        localTimeInput['apple'] !== undefined && localTimeInput['apple'] !== '';

      setTimeout(() => {
        setGameSettings((prev) => ({
          ...prev,
          apple: {
            ...prev.apple,
            mapSize,
            timeLimit: isEditingAppleTime
              ? prev.apple.timeLimit
              : cfg.totalTime,
            appleRange,
            includeZero: cfg.includeZero,
          },
        }));
      });
    } else if (serverSelectedGame === ('FLAPPY_BIRD' as unknown as GameType)) {
      setTimeout(() => setSelectedGame('flappy'));

      const cfg = serverGameConfig as FlappyBirdGamePreset;

      setTimeout(() => {
        setGameSettings((prev) => ({
          ...prev,
          flappy: {
            ...prev.flappy,
            pipeGap: cfg.pipeGap || 'normal',
            pipeWidth: cfg.pipeWidth || 'normal',
            pipeSpacing: cfg.pipeSpacing || 'normal',
            pipeSpeed: cfg.pipeSpeed || 'normal',
            ropeLength: cfg.ropeLength || 'normal',
            connectAll: cfg.connectAll ?? false,
          },
        }));
      });
    } else if (serverSelectedGame === ('MINESWEEPER' as unknown as GameType)) {
      setTimeout(() => setSelectedGame('minesweeper'));

      const cfg = serverGameConfig as MineSweeperGamePreset;

      // 입력 중이면 timeLimit은 덮어쓰지 않음
      const isEditingMinesweeperTime =
        localTimeInput['minesweeper'] !== undefined &&
        localTimeInput['minesweeper'] !== '';

      // timeLimit 역변환
      const timeLimit =
        cfg.timeLimit === 'manual'
          ? (cfg.manualTime ?? 180)
          : (cfg.timeLimit as number);

      // difficulty → mineRatio 역변환
      const mineRatio = cfg.difficulty || 'normal';

      setTimeout(() => {
        setGameSettings((prev) => ({
          ...prev,
          minesweeper: {
            ...prev.minesweeper,
            mapSize: cfg.mapSize || 'medium',
            timeLimit: isEditingMinesweeperTime
              ? prev.minesweeper.timeLimit
              : timeLimit,
            mineRatio,
          },
        }));
      });
    }
  }, [serverSelectedGame, serverGameConfig]);

  // 빈 슬롯 생성
  const emptySlots = Array(MAX_PLAYERS - players.length).fill(null);

  return (
    <div className="lobby-container">
      <div className="lobby-header">
        <img src={faviconIcon} alt="favicon" className="lobby-title-icon" />
        <h1 className="nes-text is-primary lobby-title">다같이 오락가락</h1>
      </div>

      <div className="lobby-content">
        {/* 왼쪽: 플레이어 리스트 */}
        <div className="lobby-left">
          <div className="nes-container is-rounded player-section">
            <h2 className="section-title">플레이어</h2>
            <div className="player-list">
              {players.map((player, index) => (
                <div
                  key={`player-${index}`}
                  className="player-item"
                  style={{ borderColor: player.color }}
                >
                  <div
                    className="player-color-indicator"
                    style={{ backgroundColor: player.color }}
                  />
                  <span className="player-name">{player.playerName}</span>
                  {index == 0 && (
                    <span className="player-host-badge">방장</span>
                  )}
                </div>
              ))}
              {emptySlots.map((_, index) => (
                <div key={`empty-${index}`} className="player-item empty">
                  <div className="player-color-indicator empty" />
                  <span className="player-name">대기 중...</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* 오른쪽: 게임 리스트 */}
        <div className="lobby-right">
          <div className="nes-container is-rounded game-section">
            <div className="section-header">
              <h2 className="section-title">게임 선택</h2>
              <div className="difficulty-legend">
                <span className="legend-label">난이도:</span>
                <span style={{ color: DIFFICULTY_COLORS.easy }}>쉬움</span>
                <span style={{ color: DIFFICULTY_COLORS.normal }}>보통</span>
                <span style={{ color: DIFFICULTY_COLORS.hard }}>어려움</span>
              </div>
            </div>
            <div className="game-list">
              {/* 이거 map 이어야 함? */}
              {games.map((game) => {
                const settings = gameSettings[game.id];

                return (
                  // 이거 다 컴포넌트로 분리 가능한 거 아님?
                  <div
                    key={game.id}
                    className={`game-item ${
                      selectedGame === game.id ? 'selected' : ''
                    } ${
                      selectedGame && selectedGame !== game.id ? 'dimmed' : ''
                    } ${isDisabled ? 'disabled' : ''}`}
                    onClick={() => !isDisabled && handleSelectGame(game.id)}
                  >
                    {isDisabled && (
                      <span className="game-item-tooltip">
                        방장만 게임을 선택할 수 있습니다
                      </span>
                    )}
                    <div className="game-thumbnail">{game.thumbnail}</div>
                    <div className="game-info">
                      <div className="game-name-row">
                        <h3 className="game-name">{game.name}</h3>
                        {GAME_DESCRIPTIONS[game.id] && (
                          <span className="game-description">
                            {GAME_DESCRIPTIONS[game.id]}
                          </span>
                        )}
                      </div>
                      {game.id === 'apple' ? (
                        <div
                          className="settings-edit"
                          onClick={(e) => {
                            if (selectedGame !== game.id) {
                              playSFX('buttonClick');
                              handleSelectGame(game.id);
                            }
                            e.stopPropagation();
                          }}
                        >
                          <div className="setting-item">
                            <label>맵 크기:</label>
                            <div className="nes-select is-small">
                              <select
                                value={settings.mapSize}
                                onChange={(e) =>
                                  handleSettingChange(
                                    game.id,
                                    'mapSize',
                                    e.target.value,
                                  )
                                }
                                onFocus={() => handleSelectGame(game.id)}
                                style={{
                                  color:
                                    settings.mapSize === 'large'
                                      ? DIFFICULTY_COLORS.easy
                                      : settings.mapSize === 'normal'
                                        ? DIFFICULTY_COLORS.normal
                                        : DIFFICULTY_COLORS.hard,
                                }}
                              >
                                <option
                                  value="large"
                                  style={{ color: DIFFICULTY_COLORS.easy }}
                                >
                                  큼 (30x15)
                                </option>
                                <option
                                  value="normal"
                                  style={{ color: DIFFICULTY_COLORS.normal }}
                                >
                                  보통 (20x10)
                                </option>
                                <option
                                  value="small"
                                  style={{ color: DIFFICULTY_COLORS.hard }}
                                >
                                  작음 (16x8)
                                </option>
                              </select>
                            </div>
                          </div>
                          <div className="setting-item time-limit-setting">
                            <label>제한 시간:</label>
                            {settings.timeLimit === -1 ||
                            (![180, 120, 90].includes(
                              settings.timeLimit || 0,
                            ) &&
                              settings.timeLimit !== undefined) ? (
                              <input
                                type="number"
                                value={
                                  localTimeInput[game.id] !== undefined &&
                                  localTimeInput[game.id] !== ''
                                    ? localTimeInput[game.id]
                                    : settings.timeLimit === -1
                                      ? ''
                                      : settings.timeLimit
                                }
                                onChange={(e) => {
                                  // 로컬 상태만 업데이트, 패킷 전송 없음
                                  setLocalTimeInput((prev) => ({
                                    ...prev,
                                    [game.id]: e.target.value,
                                  }));
                                }}
                                onFocus={() => {
                                  // 현재 값으로 로컬 상태 초기화
                                  setLocalTimeInput((prev) => ({
                                    ...prev,
                                    [game.id]:
                                      settings.timeLimit === -1
                                        ? ''
                                        : String(settings.timeLimit),
                                  }));
                                }}
                                onClick={(e) => e.stopPropagation()}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    commitTimeLimit(
                                      game.id,
                                      DEFAULT_TIME_LIMIT,
                                    );
                                    e.currentTarget.blur();
                                  }
                                }}
                                className="nes-input is-small"
                                placeholder="초"
                                min={MIN_TIME_LIMIT}
                                max={MAX_TIME_LIMIT}
                                autoFocus
                                onBlur={() => {
                                  commitTimeLimit(game.id, DEFAULT_TIME_LIMIT);
                                }}
                              />
                            ) : (
                              <div className="nes-select is-small is-compact">
                                <select
                                  value={settings.timeLimit}
                                  onChange={(e) => {
                                    const val = parseInt(e.target.value);
                                    handleSettingChange(
                                      game.id,
                                      'timeLimit',
                                      val,
                                    );
                                  }}
                                  onFocus={() => handleSelectGame(game.id)}
                                  style={{
                                    color:
                                      settings.timeLimit === 180
                                        ? DIFFICULTY_COLORS.easy
                                        : settings.timeLimit === 120
                                          ? DIFFICULTY_COLORS.normal
                                          : DIFFICULTY_COLORS.hard,
                                  }}
                                >
                                  <option
                                    value={180}
                                    style={{ color: DIFFICULTY_COLORS.easy }}
                                  >
                                    180초
                                  </option>
                                  <option
                                    value={120}
                                    style={{ color: DIFFICULTY_COLORS.normal }}
                                  >
                                    120초
                                  </option>
                                  <option
                                    value={90}
                                    style={{ color: DIFFICULTY_COLORS.hard }}
                                  >
                                    90초
                                  </option>
                                  <option value={-1}>직접 입력</option>
                                </select>
                              </div>
                            )}
                            {showTimeLimitTooltip[game.id] && (
                              <div className="time-limit-tooltip">
                                제한 시간은 30-300초 사이로 설정해주세요
                              </div>
                            )}
                          </div>
                          <div className="setting-item">
                            <label>사과 생성:</label>
                            <div className="nes-select is-small is-compact">
                              <select
                                value={settings.appleRange}
                                onChange={(e) =>
                                  handleSettingChange(
                                    game.id,
                                    'appleRange',
                                    e.target.value,
                                  )
                                }
                                onFocus={() => handleSelectGame(game.id)}
                                style={{
                                  color:
                                    settings.appleRange === '1-9'
                                      ? DIFFICULTY_COLORS.normal
                                      : DIFFICULTY_COLORS.hard,
                                }}
                              >
                                <option
                                  value="1-9"
                                  style={{ color: DIFFICULTY_COLORS.normal }}
                                >
                                  1-9
                                </option>
                                <option
                                  value="1-5"
                                  style={{ color: DIFFICULTY_COLORS.hard }}
                                >
                                  1-5
                                </option>
                              </select>
                            </div>
                          </div>
                          <div className="setting-item">
                            <label>0 생성:</label>
                            <div className="radio-group">
                              <label className="nes-pointer">
                                <input
                                  type="radio"
                                  className="nes-radio"
                                  name={`includeZero-${game.id}`}
                                  checked={!settings.includeZero}
                                  onChange={() =>
                                    handleSettingChange(
                                      game.id,
                                      'includeZero',
                                      false,
                                    )
                                  }
                                  onFocus={() => handleSelectGame(game.id)}
                                />
                                <span
                                  style={{ color: DIFFICULTY_COLORS.normal }}
                                >
                                  X
                                </span>
                              </label>
                              <label className="nes-pointer">
                                <input
                                  type="radio"
                                  className="nes-radio"
                                  name={`includeZero-${game.id}`}
                                  checked={settings.includeZero}
                                  onChange={() =>
                                    handleSettingChange(
                                      game.id,
                                      'includeZero',
                                      true,
                                    )
                                  }
                                  onFocus={() => handleSelectGame(game.id)}
                                />
                                <span style={{ color: DIFFICULTY_COLORS.hard }}>
                                  O
                                </span>
                              </label>
                            </div>
                          </div>
                        </div>
                      ) : game.id === 'flappy' ? (
                        <div
                          className="settings-edit settings-flappy"
                          onClick={(e) => {
                            if (selectedGame !== game.id) {
                              playSFX('buttonClick');
                              handleSelectGame(game.id);
                            }
                            e.stopPropagation();
                          }}
                        >
                          <div className="setting-item">
                            <label>상하 간격:</label>
                            <div className="nes-select is-small">
                              <select
                                value={settings.pipeGap}
                                onChange={(e) =>
                                  handleSettingChange(
                                    game.id,
                                    'pipeGap',
                                    e.target.value,
                                  )
                                }
                                onFocus={() => handleSelectGame(game.id)}
                                style={{
                                  color:
                                    settings.pipeGap === 'wide'
                                      ? DIFFICULTY_COLORS.easy
                                      : settings.pipeGap === 'normal'
                                        ? DIFFICULTY_COLORS.normal
                                        : DIFFICULTY_COLORS.hard,
                                }}
                              >
                                <option
                                  value="wide"
                                  style={{ color: DIFFICULTY_COLORS.easy }}
                                >
                                  넓음
                                </option>
                                <option
                                  value="normal"
                                  style={{ color: DIFFICULTY_COLORS.normal }}
                                >
                                  보통
                                </option>
                                <option
                                  value="narrow"
                                  style={{ color: DIFFICULTY_COLORS.hard }}
                                >
                                  좁음
                                </option>
                              </select>
                            </div>
                          </div>
                          <div className="setting-item">
                            <label>좌우 간격:</label>
                            <div className="nes-select is-small">
                              <select
                                value={settings.pipeSpacing}
                                onChange={(e) =>
                                  handleSettingChange(
                                    game.id,
                                    'pipeSpacing',
                                    e.target.value,
                                  )
                                }
                                onFocus={() => handleSelectGame(game.id)}
                                style={{
                                  color:
                                    settings.pipeSpacing === 'wide'
                                      ? DIFFICULTY_COLORS.easy
                                      : settings.pipeSpacing === 'normal'
                                        ? DIFFICULTY_COLORS.normal
                                        : DIFFICULTY_COLORS.hard,
                                }}
                              >
                                <option
                                  value="wide"
                                  style={{ color: DIFFICULTY_COLORS.easy }}
                                >
                                  넓음
                                </option>
                                <option
                                  value="normal"
                                  style={{ color: DIFFICULTY_COLORS.normal }}
                                >
                                  보통
                                </option>
                                <option
                                  value="narrow"
                                  style={{ color: DIFFICULTY_COLORS.hard }}
                                >
                                  좁음
                                </option>
                              </select>
                            </div>
                          </div>
                          <div className="setting-item">
                            <label>파이프 두께:</label>
                            <div className="nes-select is-small">
                              <select
                                value={settings.pipeWidth}
                                onChange={(e) =>
                                  handleSettingChange(
                                    game.id,
                                    'pipeWidth',
                                    e.target.value,
                                  )
                                }
                                onFocus={() => handleSelectGame(game.id)}
                                style={{
                                  color:
                                    settings.pipeWidth === 'narrow'
                                      ? DIFFICULTY_COLORS.easy
                                      : settings.pipeWidth === 'normal'
                                        ? DIFFICULTY_COLORS.normal
                                        : DIFFICULTY_COLORS.hard,
                                }}
                              >
                                <option
                                  value="narrow"
                                  style={{ color: DIFFICULTY_COLORS.easy }}
                                >
                                  좁음
                                </option>
                                <option
                                  value="normal"
                                  style={{ color: DIFFICULTY_COLORS.normal }}
                                >
                                  보통
                                </option>
                                <option
                                  value="wide"
                                  style={{ color: DIFFICULTY_COLORS.hard }}
                                >
                                  넓음
                                </option>
                              </select>
                            </div>
                          </div>
                          <div className="setting-item">
                            <label>이동 속도:</label>
                            <div className="nes-select is-small">
                              <select
                                value={settings.pipeSpeed}
                                onChange={(e) =>
                                  handleSettingChange(
                                    game.id,
                                    'pipeSpeed',
                                    e.target.value,
                                  )
                                }
                                onFocus={() => handleSelectGame(game.id)}
                                style={{
                                  color:
                                    settings.pipeSpeed === 'slow'
                                      ? DIFFICULTY_COLORS.easy
                                      : settings.pipeSpeed === 'normal'
                                        ? DIFFICULTY_COLORS.normal
                                        : DIFFICULTY_COLORS.hard,
                                }}
                              >
                                <option
                                  value="slow"
                                  style={{ color: DIFFICULTY_COLORS.easy }}
                                >
                                  느림
                                </option>
                                <option
                                  value="normal"
                                  style={{ color: DIFFICULTY_COLORS.normal }}
                                >
                                  보통
                                </option>
                                <option
                                  value="fast"
                                  style={{ color: DIFFICULTY_COLORS.hard }}
                                >
                                  빠름
                                </option>
                              </select>
                            </div>
                          </div>
                          <div className="setting-item">
                            <label>줄 길이:</label>
                            <div className="nes-select is-small">
                              <select
                                value={settings.ropeLength}
                                onChange={(e) =>
                                  handleSettingChange(
                                    game.id,
                                    'ropeLength',
                                    e.target.value,
                                  )
                                }
                                onFocus={() => handleSelectGame(game.id)}
                                style={{
                                  color:
                                    settings.ropeLength === 'long'
                                      ? DIFFICULTY_COLORS.easy
                                      : settings.ropeLength === 'normal'
                                        ? DIFFICULTY_COLORS.normal
                                        : DIFFICULTY_COLORS.hard,
                                }}
                              >
                                <option
                                  value="long"
                                  style={{ color: DIFFICULTY_COLORS.easy }}
                                >
                                  짧음
                                </option>
                                <option
                                  value="normal"
                                  style={{ color: DIFFICULTY_COLORS.normal }}
                                >
                                  보통
                                </option>
                                <option
                                  value="short"
                                  style={{ color: DIFFICULTY_COLORS.hard }}
                                >
                                  긺
                                </option>
                              </select>
                            </div>
                          </div>

                          {/* 모두 묶기 라디오 */}
                          <div className="setting-item">
                            <label>모두 묶기:</label>
                            <div className="radio-group">
                              <label className="nes-pointer">
                                <input
                                  type="radio"
                                  className="nes-radio"
                                  name={`connectAll-${game.id}`}
                                  checked={!settings.connectAll}
                                  onChange={() =>
                                    handleSettingChange(
                                      game.id,
                                      'connectAll',
                                      false,
                                    )
                                  }
                                  onFocus={() => handleSelectGame(game.id)}
                                />
                                <span
                                  style={{ color: DIFFICULTY_COLORS.normal }}
                                >
                                  X
                                </span>
                              </label>
                              <label className="nes-pointer">
                                <input
                                  type="radio"
                                  className="nes-radio"
                                  name={`connectAll-${game.id}`}
                                  checked={settings.connectAll ?? false}
                                  onChange={() =>
                                    handleSettingChange(
                                      game.id,
                                      'connectAll',
                                      true,
                                    )
                                  }
                                  onFocus={() => handleSelectGame(game.id)}
                                />
                                <span style={{ color: DIFFICULTY_COLORS.easy }}>
                                  O
                                </span>
                              </label>
                            </div>
                          </div>
                        </div>
                      ) : game.id === 'minesweeper' ? (
                        <div
                          className="settings-edit"
                          onClick={(e) => {
                            if (selectedGame !== game.id) {
                              playSFX('buttonClick');
                              handleSelectGame(game.id);
                            }
                            e.stopPropagation();
                          }}
                        >
                          <div className="setting-item">
                            <label>맵 크기:</label>
                            <div className="nes-select is-small">
                              <select
                                value={settings.mapSize}
                                onChange={(e) =>
                                  handleSettingChange(
                                    game.id,
                                    'mapSize',
                                    e.target.value,
                                  )
                                }
                                onFocus={() => handleSelectGame(game.id)}
                                style={{
                                  color:
                                    settings.mapSize === 'large'
                                      ? DIFFICULTY_COLORS.easy
                                      : settings.mapSize === 'medium'
                                        ? DIFFICULTY_COLORS.normal
                                        : DIFFICULTY_COLORS.hard,
                                }}
                              >
                                <option
                                  value="large"
                                  style={{ color: DIFFICULTY_COLORS.easy }}
                                >
                                  큼 (50x30)
                                </option>
                                <option
                                  value="medium"
                                  style={{ color: DIFFICULTY_COLORS.normal }}
                                >
                                  보통 (45x27)
                                </option>
                                <option
                                  value="small"
                                  style={{ color: DIFFICULTY_COLORS.hard }}
                                >
                                  작음 (30x18)
                                </option>
                              </select>
                            </div>
                          </div>
                          <div className="setting-item time-limit-setting">
                            <label>제한 시간:</label>
                            {settings.timeLimit === -1 ||
                            (![240, 180, 120].includes(
                              settings.timeLimit || 0,
                            ) &&
                              settings.timeLimit !== undefined) ? (
                              <input
                                type="number"
                                value={
                                  localTimeInput[game.id] !== undefined &&
                                  localTimeInput[game.id] !== ''
                                    ? localTimeInput[game.id]
                                    : settings.timeLimit === -1
                                      ? ''
                                      : settings.timeLimit
                                }
                                onChange={(e) => {
                                  // 로컬 상태만 업데이트, 패킷 전송 없음
                                  setLocalTimeInput((prev) => ({
                                    ...prev,
                                    [game.id]: e.target.value,
                                  }));
                                }}
                                onFocus={() => {
                                  // 현재 값으로 로컬 상태 초기화
                                  setLocalTimeInput((prev) => ({
                                    ...prev,
                                    [game.id]:
                                      settings.timeLimit === -1
                                        ? ''
                                        : String(settings.timeLimit),
                                  }));
                                }}
                                onClick={(e) => e.stopPropagation()}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    commitTimeLimit(game.id, 180);
                                    e.currentTarget.blur();
                                  }
                                }}
                                className="nes-input is-small"
                                placeholder="초"
                                min={MIN_TIME_LIMIT}
                                max={MAX_TIME_LIMIT}
                                autoFocus
                                onBlur={() => {
                                  commitTimeLimit(game.id, 180);
                                }}
                              />
                            ) : (
                              <div className="nes-select is-small is-compact">
                                <select
                                  value={settings.timeLimit}
                                  onChange={(e) => {
                                    const val = parseInt(e.target.value);
                                    handleSettingChange(
                                      game.id,
                                      'timeLimit',
                                      val,
                                    );
                                  }}
                                  onFocus={() => handleSelectGame(game.id)}
                                  style={{
                                    color:
                                      settings.timeLimit === 240
                                        ? DIFFICULTY_COLORS.easy
                                        : settings.timeLimit === 180
                                          ? DIFFICULTY_COLORS.normal
                                          : DIFFICULTY_COLORS.hard,
                                  }}
                                >
                                  <option
                                    value={240}
                                    style={{ color: DIFFICULTY_COLORS.easy }}
                                  >
                                    240초
                                  </option>
                                  <option
                                    value={180}
                                    style={{ color: DIFFICULTY_COLORS.normal }}
                                  >
                                    180초
                                  </option>
                                  <option
                                    value={120}
                                    style={{ color: DIFFICULTY_COLORS.hard }}
                                  >
                                    120초
                                  </option>
                                  <option value={-1}>직접 입력</option>
                                </select>
                              </div>
                            )}
                            {showTimeLimitTooltip[game.id] && (
                              <div className="time-limit-tooltip">
                                제한 시간은 30-300초 사이로 설정해주세요
                              </div>
                            )}
                          </div>
                          <div className="setting-item">
                            <label>지뢰 비율:</label>
                            <div className="nes-select is-small is-compact">
                              <select
                                value={settings.mineRatio}
                                onChange={(e) =>
                                  handleSettingChange(
                                    game.id,
                                    'mineRatio',
                                    e.target.value,
                                  )
                                }
                                onFocus={() => handleSelectGame(game.id)}
                                style={{
                                  color:
                                    settings.mineRatio === 'easy'
                                      ? DIFFICULTY_COLORS.easy
                                      : settings.mineRatio === 'normal'
                                        ? DIFFICULTY_COLORS.normal
                                        : DIFFICULTY_COLORS.hard,
                                }}
                              >
                                <option
                                  value="easy"
                                  style={{ color: DIFFICULTY_COLORS.easy }}
                                >
                                  10%
                                </option>
                                <option
                                  value="normal"
                                  style={{ color: DIFFICULTY_COLORS.normal }}
                                >
                                  20%
                                </option>
                                <option
                                  value="hard"
                                  style={{ color: DIFFICULTY_COLORS.hard }}
                                >
                                  30%
                                </option>
                              </select>
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div
                          className="settings-edit settings-empty nes-pointer"
                          onClick={(e) => {
                            if (selectedGame !== game.id) {
                              handleSelectGame(game.id);
                            }
                            e.stopPropagation();
                          }}
                        >
                          <span className="settings-placeholder">
                            설정 준비 중
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* 툴팁 */}
      {tooltip.show && (
        <div className={`lobby-tooltip ${tooltip.type}`}>{tooltip.message}</div>
      )}

      {/* 소리 설정 */}
      <div
        style={{
          position: 'fixed',
          bottom: '20px',
          right: '20px',
          zIndex: 1000,
        }}
      >
        <SoundSetting />
      </div>

      {/* 하단: 버튼들 */}
      <div className="lobby-footer">
        <div className="button-wrapper">
          <button
            className="nes-btn"
            onClick={() => {
              playSFX('buttonClick');
              handleCopyLink();
            }}
            onMouseEnter={() => playSFX('buttonHover')}
          >
            <i className="nes-icon is-small link"></i>
            초대 링크 복사
          </button>
          {isHost && players.length === 1 && (
            <div className="button-tooltip invite-tooltip">
              {'친구를 초대하거나 혼자 게임을 시작하세요'}
            </div>
          )}
        </div>
        <div
          className="button-wrapper"
          onMouseEnter={() => {
            playSFX('buttonHover');
            if (!selectedGame || isDisabled) {
              setShowButtonTooltip(true);
            }
          }}
          onMouseLeave={() => setShowButtonTooltip(false)}
        >
          <button
            className="nes-btn is-primary"
            onClick={() => {
              playSFX('buttonClick');
              handleStartGame();
            }}
            disabled={!selectedGame || isDisabled}
          >
            게임 시작
          </button>
          {showButtonTooltip && !isHost && (
            <div className="button-tooltip">
              {'방장만 게임을 시작할 수 있습니다.'}
            </div>
          )}
          {showButtonTooltip && isHost && !selectedGame && (
            <div className="button-tooltip">{'게임을 선택해주세요'}</div>
          )}
        </div>
      </div>
    </div>
  );
}

export default Lobby;
