import { GameInstance } from './GameInstance';
import {
  type AppleGameRenderConfig,
  DEFAULT_APPLE_GAME_RENDER_CONFIG,
  GameType,
  AppleGamePacketType,
  type DropCellIndexPacket,
  type SetFieldPacket,
  type SetTimePacket,
  SystemPacketType,
  type TimeEndPacket,
  type UpdateScorePacket,
  type UpdateDragAreaPacket,
  type PlayerData,
  type ReportCard,
  toSocketPayload,
  type GameClientPacket,
} from '@main-game/common';
import { GameSession } from '../gameSession';
import type { GameSocket } from '../../network/socketTypes';

export class AppleGameInstance implements GameInstance {
  private apples: number[] = [];
  private removedIndices: Set<number> = new Set();
  private timerTimeout: NodeJS.Timeout | null = null;
  private timeLeft: number = 0;
  private endsAt = 0;
  private finished = false;

  private session: GameSession;

  constructor(session: GameSession) {
    this.session = session;
  }

  // 기존 gameSession.ts에서 Apple 전용 로직 이동
  initialize(config: AppleGameRenderConfig): void {
    this.timeLeft = config.totalTime;
    this.finished = false;
    this.removedIndices.clear();
    this.generateField(config);
  }

  start(): void {
    // TODO 중복?
    const applied = this.getAppliedAppleConfig();
    this.timeLeft = applied.totalTime;
    this.removedIndices.clear();
    this.session.players.forEach((p) => {
      p.reportCard.score = 0;
    });

    // Generate Apples
    console.log('[appleGameInstance/start] generateField');
    this.generateField(applied);

    // Broadcast Field
    const setFieldPacket: SetFieldPacket = {
      type: AppleGamePacketType.SET_FIELD,
      apples: this.apples,
    };
    console.log('[appleGameInstance/start] setfield');
    this.session.broadcastPacket(setFieldPacket);

    // Broadcast Time
    this.endsAt = Date.now() + this.timeLeft * 1000;
    const setTimePacket: SetTimePacket = {
      type: SystemPacketType.SET_TIME,
      limitTime: this.timeLeft,
      serverStartTime: this.endsAt - this.timeLeft * 1000,
      endsAt: this.endsAt,
      remainingMs: this.timeLeft * 1000,
    };
    this.session.broadcastPacket(setTimePacket);

    // 점수 초기화 알리기 (Snapshot)
    this.broadcastScoreboard();

    // Start Timer
    console.log('...Game timer');
    this.startTimer();
    console.log('...Game Started!');
  }

  stop(): void {
    if (this.timerTimeout) {
      clearTimeout(this.timerTimeout);
      this.timerTimeout = null;
    }
  }

  destroy(): void {
    this.stop();
  }

  handlePacket(
    socket: GameSocket,
    _playerIndex: number,
    packet: GameClientPacket,
  ): void {
    switch (packet.type) {
      case AppleGamePacketType.DRAWING_DRAG_AREA: {
        const { startX, startY, endX, endY } = packet;
        if (![startX, startY, endX, endY].every(Number.isFinite)) return;

        // 드래그 중인 영역은 본인을 제외한 방 인원에게 그대로 중계한다.
        const updatePacket: UpdateDragAreaPacket = {
          type: AppleGamePacketType.UPDATE_DRAG_AREA,
          playerIndex: this.session.getIndex(socket.id),
          startX,
          startY,
          endX,
          endY,
        };
        socket
          .to(this.session.roomId)
          .emit(
            AppleGamePacketType.UPDATE_DRAG_AREA,
            toSocketPayload(updatePacket),
          );
        break;
      }
      case AppleGamePacketType.CONFIRM_DRAG_AREA:
        this.handleDragConfirm(socket.id, packet.indices);
        break;
    }
  }

  // initialize defaults for game configs so lobby has a baseline
  // private initDefaults() {
  //   if (!this.gameConfigs.has(GameType.APPLE_GAME)) {
  //     const defaultCfg: GameConfig = {
  //       mapSize: MapSize.MEDIUM,
  //       time: APPLE_GAME_CONFIG.totalTime,
  //       generation: 0,
  //       zero: APPLE_GAME_CONFIG.includeZero,
  //     } as GameConfig;
  //     this.gameConfigs.set(GameType.APPLE_GAME, defaultCfg);
  //   }
  // }
  private generateField(cfg?: AppleGameRenderConfig) {
    const used = cfg ?? this.getAppliedAppleConfig();
    // todo MapSize로부터 grid 얻는 공통 코드 두기
    const count = used.gridCols * used.gridRows;
    const minNumber = used.includeZero ? 0 : used.minNumber;
    this.apples = Array.from(
      { length: count },
      () =>
        Math.floor(Math.random() * (used.maxNumber - minNumber + 1)) +
        minNumber,
    );
  }

  // todo 없어도 되는 것 아님?
  private getAppliedAppleConfig(): AppleGameRenderConfig {
    const stored = this.session.gameConfigs.get(GameType.APPLE_GAME) as
      | AppleGameRenderConfig
      | undefined;
    return stored ?? DEFAULT_APPLE_GAME_RENDER_CONFIG;
  }

  private startTimer() {
    if (this.timerTimeout) clearTimeout(this.timerTimeout);
    console.log('[GameSession] Timer started with', this.timeLeft, 'seconds');
    const schedule = () => {
      const remaining = this.endsAt - Date.now();
      if (remaining <= 0) {
        this.finishGame();
        return;
      }
      this.timerTimeout = setTimeout(schedule, remaining);
    };
    schedule();
  }

  private finishGame() {
    // 이미 게임이 종료된 상태면 중복 처리 방지
    if (this.finished || this.session.status === 'ended') {
      console.log('[AppleGameInstance] 게임이 이미 종료됨 - finishGame 무시');
      return;
    }

    this.finished = true;
    this.stop();

    this.session.stopGame();

    console.log('게임 끝남. 결과: ');
    for (const [id, player] of this.session.players) {
      console.log(`- ${player.playerName} (${id}): ${player.reportCard.score}`);
    }
    // Calculate Rank
    const results: PlayerData[] = Array.from(this.session.players.values())
      .map(({ id, playerName, color, reportCard }) => ({
        id,
        playerName,
        color,
        reportCard,
      }))
      .sort((a, b) => b.reportCard.score - a.reportCard.score);

    const endPacket: TimeEndPacket = {
      type: SystemPacketType.TIME_END,
      results,
    };
    this.session.broadcastPacket(endPacket);
  }

  /** 정수·범위·중복을 검사해 같은 사과를 여러 번 세는 요청을 막는다. */
  private normalizeIndices(rawIndices: unknown): number[] | null {
    if (!Array.isArray(rawIndices) || rawIndices.length === 0) return null;
    const unique = new Set<number>();
    for (const index of rawIndices) {
      if (
        !Number.isInteger(index) ||
        index < 0 ||
        index >= this.apples.length ||
        unique.has(index)
      ) {
        return null;
      }
      unique.add(index);
    }
    return [...unique];
  }

  public handleDragConfirm(playerId: string, rawIndices: unknown) {
    const indices = this.normalizeIndices(rawIndices);
    if (!indices) return;

    // Check if any index is already removed (Race condition check)
    const alreadyTaken = indices.some((idx) => this.removedIndices.has(idx));
    if (alreadyTaken) {
      // Ignore request
      return;
    }

    // Validate sum
    const sum = indices.reduce((acc, idx) => acc + (this.apples[idx] || 0), 0);
    if (sum === 10) {
      // Update State
      indices.forEach((idx) => this.removedIndices.add(idx));

      const player = this.session.players.get(playerId);
      if (player) {
        const addedScore = indices.length;
        player.reportCard.score += addedScore;
        console.log(
          '[GameSession] Player',
          playerId,
          'scored',
          addedScore,
          'points. total score:',
          player.reportCard.score,
        );

        const winnerIndex = this.session.getIndex(playerId);
        if (winnerIndex === -1) {
          console.error(
            '[GameSession] Cannot find winner index for playerId',
            playerId,
          );
        }
        const dropCellIndexPacket: DropCellIndexPacket = {
          type: AppleGamePacketType.DROP_CELL_INDEX,
          winnerIndex: winnerIndex,
          indices: indices,
          totalScore: player.reportCard.score,
        };
        this.session.broadcastPacket(dropCellIndexPacket);

        // 점수 변경 시 UPDATE_SCORE 전송 (사운드 재생용)
        this.broadcastScoreboard();
      }
    }
  }

  private broadcastScoreboard() {
    const scoreboard: ReportCard[] = Array.from(
      this.session.players.values(),
    ).map((p) => p.reportCard);

    const updateScorePacket: UpdateScorePacket = {
      type: SystemPacketType.UPDATE_SCORE,
      scoreboard,
    };
    this.session.broadcastPacket(updateScorePacket);
  }
}
