// You can write more code here

/* START OF COMPILED CODE */

import Phaser from 'phaser';
import { getSocket, isMockMode } from '../../network/socketService';
import type { GameClientSocket } from '../../../network/socket';
import { socketManager } from '../../../network/socket';
import { MockSocket } from '../../network/MockSocket';
import { MineSweeperMockCore } from '../../physics/MineSweeperMockCore';
import { GAME_WIDTH, GAME_HEIGHT } from '../../config/gameConfig';
import { CONSTANTS } from '../../types/common';
import TileManager from './TileManager';
import TimerPrefab from '../../utils/TimerPrefab';
import TimerSystem from '../../utils/TimerSystem';
import {
  TileState,
  type TileUpdateEvent,
  type GameInitEvent,
  type ScoreUpdateEvent,
  type PlayerId,
  type MineSweeperGamePreset,
  type ResolvedMineSweeperConfig,
  DEFAULT_MINESWEEPER_PRESET,
  resolveMineSweeperPreset,
} from '../../types/minesweeper.types';
import { MineSweeperPacketType } from '../../../../../common/src/packets';
import type {
  MSGameInitPacket,
  MSTileUpdatePacket,
  MSScoreUpdatePacket,
  MSGameEndPacket,
} from '../../../../../common/src/minesweeperPackets';
import { useGameStore } from '../../../store/gameStore';

// 플레이어 데이터 인터페이스
interface PlayerData {
  id: string;
  name: string;
  score: number;
  color: string;
}

export default class MineSweeperScene extends Phaser.Scene {
  // 그리드 설정 (프리셋에서 resolve)
  private gameConfig: ResolvedMineSweeperConfig = resolveMineSweeperPreset(
    DEFAULT_MINESWEEPER_PRESET,
  );

  // 네트워크
  private socket!: GameClientSocket | MockSocket;
  private mockServerCore?: MineSweeperMockCore;

  // 타일 매니저
  private tileManager!: TileManager;

  // 타이머 관련
  private timerPrefab!: TimerPrefab;
  private timerSystem!: TimerSystem;
  private unsubscribeGameTime?: () => void;

  // 플레이어 관련
  private playerCount: number = 4;
  private players: PlayerData[] = [];
  private currentPlayerIndex: number = 0;
  private myPlayerId: PlayerId = 'id_1';
  private isManualPlayerSwitch: boolean = false; // 수동 플레이어 전환 여부 (테스트용)

  // 남은 지뢰 수
  private remainingMines: number = 0;

  // 플레이어별 깃발 개수 추적
  private flagCounts: Record<string, number> = {};

  // 클릭 불가 상태 (지뢰 클릭 시 페널티)
  private isClickDisabled: boolean = false;
  private clickDisabledTimer?: Phaser.Time.TimerEvent;
  private readonly CLICK_DISABLE_DURATION: number = 3000; // 3초

  // UI 컨테이너
  private gameContainer!: Phaser.GameObjects.Container;

  // 서버 이벤트 리스너 정리용
  private serverEventCleanup: (() => void)[] = [];

  constructor() {
    super('MineSweeperScene');

    /* START-USER-CTR-CODE */
    // Write your code here.
    /* END-USER-CTR-CODE */
  }

  editorCreate(): void {
    const ratio = window.__GAME_RATIO || 1;

    // 게임 전체 컨테이너 생성
    this.gameContainer = this.add.container(0, 0);
    this.gameContainer.setSize(GAME_WIDTH * ratio, GAME_HEIGHT * ratio);

    // 배경
    const background = this.add.rectangle(
      0,
      0,
      GAME_WIDTH * ratio,
      GAME_HEIGHT * ratio,
    );
    background.setOrigin(0, 0);
    background.isFilled = true;
    background.fillColor = 0x2c3e50;
    this.gameContainer.add(background);

    this.events.emit('scene-awake');
  }

  /* START-USER-CODE */

  create() {
    console.log('[MineSweeperScene] create 메서드 시작');

    // 소켓 연결
    this.socket = getSocket();

    // 기존 소켓 이벤트 정리
    this.socket.off('game_init');
    this.socket.off('tile_update');
    this.socket.off('score_update');
    this.events.off('updatePlayers');

    this.editorCreate();

    // 타이머 생성
    this.createTimer();

    // 타일 매니저 생성 및 초기화
    this.tileManager = new TileManager(this, this.gameContainer, {
      gridCols: this.gameConfig.gridCols,
      gridRows: this.gameConfig.gridRows,
      mineCount: this.gameConfig.mineCount,
    });
    this.tileManager.initialize();

    // 소켓 이벤트 리스너 설정
    this.setupSocketListeners();

    // 플레이어 업데이트 이벤트 리스너
    this.setupEventListeners();

    // 기본 플레이어 초기화 (Mock 모드에서 색상이 필요함)
    if (this.players.length === 0) {
      this.players = Array.from({ length: this.playerCount }, (_, i) => ({
        id: `id_${i + 1}`,
        name: `Player ${i + 1}`,
        score: 0,
        color: CONSTANTS.PLAYER_COLORS[i] || '#ffffff',
      }));
      this.tileManager.setPlayerColors(this.players);
      console.log('[MineSweeperScene] 기본 플레이어 초기화 및 색상 설정 완료');
    }

    // Mock 모드인 경우 MockServerCore 생성
    if (isMockMode() && this.socket instanceof MockSocket) {
      this.setupMockServer();
    } else {
      // 서버 모드: 씬 로딩 완료 후 현재 게임 상태 동기화 요청
      this.requestGameSync();
    }

    // 준비 완료 신호
    this.events.emit('scene-ready');

    // 키보드 입력 설정
    // this.setupKeyboardInput();

    // 마우스 입력 설정
    this.setupMouseInput();

    // gameStore 구독 설정 (타이머 시작을 위해)
    this.subscribeToGameStore();

    // 씬 종료 시 구독 해제
    this.events.once('shutdown', () => {
      this.unsubscribeGameTime?.();
    });

    console.log(
      `[MineSweeperScene] 생성 완료: ${this.gameConfig.gridCols}x${this.gameConfig.gridRows} 그리드, 지뢰 ${this.gameConfig.mineCount}개`,
    );
  }

  /**
   * 서버에 현재 게임 상태 동기화 요청
   * 씬 로딩이 완료된 후 호출하여 놓친 업데이트를 받아옴
   */
  private requestGameSync(): void {
    console.log('[MineSweeperScene] 게임 상태 동기화 요청');
    this.socket.emit(MineSweeperPacketType.MS_REQUEST_SYNC, {});
  }

  /**
   * gameStore 구독 설정 (타이머 시작용)
   */
  private subscribeToGameStore(): void {
    let previousGameTime: number | null = null;

    // SET_TIME 패킷 수신 시 타이머 시작
    this.unsubscribeGameTime = useGameStore.subscribe((state) => {
      const gameTime = state.gameTime;

      // 씬이 파괴되었거나 비활성 상태면 무시
      if (!this.scene || !this.sys || !this.sys.game) {
        return;
      }

      // gameTime이 변경되었을 때만 처리
      if (gameTime && gameTime !== previousGameTime) {
        console.log(`[MineSweeperScene] ⏱️ SET_TIME 수신: ${gameTime}초`);
        this.startTimer(gameTime);
        previousGameTime = gameTime;
      }
    });
  }

  /**
   * 타이머 생성 (사과게임과 동일한 위치)
   */
  private createTimer(): void {
    const ratio = window.__GAME_RATIO || 1;
    const canvasWidth = this.sys.game.canvas.width;
    const canvasHeight = this.sys.game.canvas.height;
    const timerBarMarginTop = 50 * ratio;
    const timerBarMarginBottom = 50 * ratio;
    const timerBarCanvasHeight =
      canvasHeight - timerBarMarginTop - timerBarMarginBottom;
    // 타이머 위치를 사과게임과 동일하게 설정
    const timerBarWidth = 22 * ratio;
    const timerBarMarginRight = 30 * ratio;
    const timerBarX = canvasWidth - timerBarMarginRight - timerBarWidth / 2;
    const timerBarY = timerBarMarginTop + timerBarCanvasHeight;

    this.timerPrefab = new TimerPrefab(
      this,
      timerBarX,
      timerBarY,
      timerBarCanvasHeight,
    );

    // 타이머를 컨테이너에 추가
    this.gameContainer.add(this.timerPrefab);

    console.log('[MineSweeperScene] 타이머 생성 완료');
  }

  /**
   * 타이머 시작 (SET_TIME 패킷에서 호출)
   */
  private startTimer(gameTime: number): void {
    this.timerSystem = new TimerSystem(this, this.timerPrefab);

    // 서버 시작 시간 가져오기 (사과게임과 동일한 방식)
    const serverStartTime = useGameStore.getState().serverStartTime;
    this.timerSystem.start(gameTime, serverStartTime || undefined);

    // 타이머 완료 이벤트 리스너 등록
    this.events.once('timer:complete', () => {
      this.onGameEnd();
    });

    console.log(
      `[MineSweeperScene] 타이머 시작: ${gameTime}초, 서버시작시간: ${serverStartTime}`,
    );
  }

  /**
   * 게임 종료 처리
   */
  private onGameEnd(): void {
    console.log('[MineSweeperScene] 게임 종료 - 타이머 완료');

    if (isMockMode() && this.mockServerCore) {
      // Mock 모드: 클라이언트에서 직접 정산
      console.log('[MineSweeperScene] Mock 모드 - 깃발 기반 최종 정산 시작');
      const scoreUpdates = this.mockServerCore.calculateFinalScores();

      // 정산 결과 로그
      for (const [playerId, update] of scoreUpdates.entries()) {
        console.log(
          `[MineSweeperScene] ${playerId} 최종 정산: ${update.scoreChange > 0 ? '+' : ''}${update.scoreChange}점 (정답 깃발: ${update.correctFlags}, 오답 깃발: ${update.incorrectFlags})`,
        );
      }

      // 점수 업데이트 이벤트가 처리될 시간을 주기 위해 약간의 딜레이 후 게임 종료
      setTimeout(() => {
        this.emitGameEnd(scoreUpdates);
      }, 100);
    } else {
      // 실제 서버 모드: 서버에 타임업 알림
      console.log('[MineSweeperScene] 서버 모드 - game_time_up 이벤트 전송');
      this.socket.emit('game_time_up', {
        timestamp: Date.now(),
      });
      // 서버에서 final_settlement와 game_end 이벤트를 보낼 것임
      // 여기서는 아무것도 하지 않음 (서버 응답 대기)
    }
  }

  /**
   * 게임 종료 이벤트 발생
   * @param flagStats 플레이어별 깃발 통계 (correctFlags, totalFlags)
   */
  private emitGameEnd(
    flagStats?: Map<string, { correctFlags: number; incorrectFlags: number }>,
  ): void {
    // 플레이어 데이터에 playerIndex와 깃발 통계 추가
    const playersWithIndex = this.players.map((player, index) => {
      const stats = flagStats?.get(player.id);
      return {
        ...player,
        playerIndex: index,
        correctFlags: stats?.correctFlags ?? 0,
        totalFlags: (stats?.correctFlags ?? 0) + (stats?.incorrectFlags ?? 0),
      };
    });

    // React로 게임 종료 이벤트 전달
    this.events.emit('gameEnd', { players: playersWithIndex });
    console.log('🎮 게임 종료! React로 이벤트 전달', playersWithIndex);
  }

  // /**
  //  * 키보드 입력 설정
  //  */
  // private setupKeyboardInput(): void {

  //   // 1-4 키로 플레이어 전환 (Mock 모드 테스트용)
  //   if (isMockMode()) {
  //     this.input.keyboard?.on('keydown-ONE', () => {
  //       this.switchPlayer(0);
  //     });

  //     this.input.keyboard?.on('keydown-TWO', () => {
  //       this.switchPlayer(1);
  //     });

  //     this.input.keyboard?.on('keydown-THREE', () => {
  //       this.switchPlayer(2);
  //     });

  //     this.input.keyboard?.on('keydown-FOUR', () => {
  //       this.switchPlayer(3);
  //     });
  //   }

  //   console.log(
  //     '[MineSweeperScene] 키보드 입력 설정 완료 (D: 디버그 모드, 1-4: 플레이어 전환)',
  //   );
  // }

  /**
   * 플레이어 전환 (테스트용)
   */
  private switchPlayer(playerIndex: number): void {
    if (playerIndex >= 0 && playerIndex < this.playerCount) {
      this.currentPlayerIndex = playerIndex;
      this.isManualPlayerSwitch = true; // 수동 전환 플래그 설정

      // 실제 플레이어 ID 사용 (players 배열에서 가져옴)
      if (this.players[playerIndex]) {
        this.myPlayerId = this.players[playerIndex].id as PlayerId;
      } else {
        this.myPlayerId = `id_${playerIndex + 1}` as PlayerId;
      }

      // 플레이어 색상 정보 표시
      const playerColor = this.players[playerIndex]?.color || 'unknown';
      console.log(`[MineSweeperScene] 플레이어 색상: ${playerColor}`);
    }
  }

  /**
   * 마우스 입력 설정
   */
  private setupMouseInput(): void {
    // 마우스 클릭 이벤트 리스너
    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      // 타일 위치 가져오기
      const tilePos = this.tileManager.getTileAtPosition(pointer.x, pointer.y);

      if (!tilePos) {
        return; // 그리드 밖 클릭
      }

      const { row, col } = tilePos;

      // 좌클릭: 타일 열기
      if (pointer.leftButtonDown()) {
        this.handleTileClick(row, col, false);
      }
      // 우클릭: 깃발 토글
      else if (pointer.rightButtonDown()) {
        this.handleTileClick(row, col, true);
      }
    });

    // 우클릭 컨텍스트 메뉴 방지
    this.input.mouse?.disableContextMenu();

    console.log(
      '[MineSweeperScene] 마우스 입력 설정 완료 (좌클릭: 열기, 우클릭: 깃발)',
    );
  }

  /**
   * 타일 클릭 처리
   */
  private handleTileClick(
    row: number,
    col: number,
    isRightClick: boolean,
  ): void {
    // 클릭 불가 상태면 무시
    if (this.isClickDisabled) {
      console.log('[MineSweeperScene] 클릭 불가 상태 - 클릭 무시');
      return;
    }

    if (isRightClick) {
      // 우클릭: 깃발 토글
      this.sendToggleFlag(row, col);
      console.log(`[MineSweeperScene] 깃발 토글 요청: (${row}, ${col})`);
    } else {
      // 좌클릭: 타일 열기
      this.sendRevealTile(row, col);
      console.log(`[MineSweeperScene] 타일 열기 요청: (${row}, ${col})`);
    }
  }

  /**
   * 타일 열기 요청 전송
   */
  private sendRevealTile(row: number, col: number): void {
    if (isMockMode()) {
      // Mock 모드: 기존 이벤트 사용
      this.socket.emit('reveal_tile', {
        playerId: this.myPlayerId,
        row,
        col,
      });
    } else {
      // 서버 모드: 새 패킷 타입 사용
      this.socket.emit(MineSweeperPacketType.MS_REVEAL_TILE, { row, col });
    }
  }

  /**
   * 깃발 토글 요청 전송
   */
  private sendToggleFlag(row: number, col: number): void {
    if (isMockMode()) {
      // Mock 모드: 기존 이벤트 사용
      this.socket.emit('toggle_flag', {
        playerId: this.myPlayerId,
        row,
        col,
      });
    } else {
      // 서버 모드: 새 패킷 타입 사용
      this.socket.emit(MineSweeperPacketType.MS_TOGGLE_FLAG, { row, col });
    }
  }

  /**
   * 클릭 불가 상태 활성화 (지뢰 클릭 페널티)
   */
  private activateClickDisable(): void {
    // 이미 비활성화 상태면 타이머만 리셋
    if (this.clickDisabledTimer) {
      this.clickDisabledTimer.destroy();
    }

    this.isClickDisabled = true;

    // 커서를 not-allowed로 변경
    this.input.setDefaultCursor('not-allowed');

    // 3초 후 클릭 가능 상태로 복귀
    this.clickDisabledTimer = this.time.delayedCall(
      this.CLICK_DISABLE_DURATION,
      () => {
        this.isClickDisabled = false;

        // 커서를 기본으로 복원 (CSS 기본 커서 적용)
        this.input.setDefaultCursor('');

        console.log('[MineSweeperScene] 클릭 가능 상태로 복귀');
      },
    );
  }

  /**
   * Mock 서버 설정
   */
  private setupMockServer(): void {
    // 기존 MockServerCore 파괴
    if (this.mockServerCore) {
      this.mockServerCore.destroy();
    }

    this.mockServerCore = new MineSweeperMockCore(this.socket as MockSocket);

    // 플레이어 수 설정
    this.mockServerCore.setPlayerCount(this.playerCount);

    // 설정 적용
    this.mockServerCore.setConfig({
      gridCols: this.gameConfig.gridCols,
      gridRows: this.gameConfig.gridRows,
      mineCount: this.gameConfig.mineCount,
    });

    // 게임 초기화
    this.mockServerCore.initialize();

    console.log('[MineSweeperScene] Mock 모드로 실행 중');
  }

  /**
   * 소켓 이벤트 리스너 설정
   */
  private setupSocketListeners(): void {
    // Mock 모드와 서버 모드 모두 지원
    const isServerMode = !isMockMode();

    // ========== Mock 모드 이벤트 (기존 호환) ==========
    if (!isServerMode) {
      this.setupMockEventListeners();
    }

    // ========== 서버 모드 이벤트 (새 패킷 타입) ==========
    if (isServerMode) {
      this.setupServerEventListeners();
    }

    // 깃발 카운트 업데이트 이벤트 (공통)
    this.socket.on('flagCountUpdate', (data: Record<string, number>) => {
      console.log('[MineSweeperScene] flagCountUpdate 수신:', data);
      this.events.emit('flagCountUpdate', data);
    });
  }

  /**
   * Mock 모드 이벤트 리스너 (기존 호환)
   */
  private setupMockEventListeners(): void {
    // 게임 초기화 이벤트
    this.socket.on('game_init', (data: GameInitEvent) => {
      console.log('[MineSweeperScene] game_init 수신:', data);
      this.handleGameInit(data);
    });

    // 타일 업데이트 이벤트
    this.socket.on(
      'tile_update',
      (data: TileUpdateEvent & { isSequentialReveal?: boolean }) => {
        this.handleTileUpdate(data);
      },
    );

    // 점수 업데이트 이벤트
    this.socket.on('score_update', (data: ScoreUpdateEvent) => {
      console.log('[MineSweeperScene] score_update 수신:', data);
      this.handleScoreUpdate(data);
    });

    // 게임 종료 이벤트
    this.socket.on('game_end', (data: any) => {
      console.log('[MineSweeperScene] game_end 수신:', data);
      this.handleGameEnd(data);
    });
  }

  /**
   * 서버 모드 이벤트 리스너 (새 패킷 타입)
   * clientHandler에서 CustomEvent를 발생시키므로 window.addEventListener 사용
   */
  private setupServerEventListeners(): void {
    // MS_GAME_INIT: 게임 초기화
    const handleGameInit = (e: Event) => {
      const data = (e as CustomEvent<MSGameInitPacket>).detail;
      console.log('[MineSweeperScene] MS_GAME_INIT 수신:', data);
      this.handleGameInit({
        config: data.config,
        tiles: data.tiles,
        players: data.players,
        remainingMines: data.remainingMines,
        timestamp: data.timestamp,
      });
    };
    window.addEventListener('ms:game_init', handleGameInit);
    this.serverEventCleanup.push(() =>
      window.removeEventListener('ms:game_init', handleGameInit),
    );

    // MS_TILE_UPDATE: 타일 상태 업데이트
    const handleTileUpdate = (e: Event) => {
      const data = (e as CustomEvent<MSTileUpdatePacket>).detail;
      console.log('[MineSweeperScene] MS_TILE_UPDATE 수신:', data);
      this.handleTileUpdate({
        tiles: data.tiles.map((t) => ({
          row: t.row,
          col: t.col,
          state: t.state,
          isMine: t.isMine,
          adjacentMines: t.adjacentMines,
          revealedBy: t.revealedBy ?? null,
          flaggedBy: t.flaggedBy ?? null,
          distance: t.distance,
        })),
        remainingMines: data.remainingMines,
        timestamp: data.timestamp,
        isSequentialReveal: data.isSequentialReveal,
      });
    };
    window.addEventListener('ms:tile_update', handleTileUpdate);
    this.serverEventCleanup.push(() =>
      window.removeEventListener('ms:tile_update', handleTileUpdate),
    );

    // MS_SCORE_UPDATE: 점수 업데이트
    const handleScoreUpdate = (e: Event) => {
      const data = (e as CustomEvent<MSScoreUpdatePacket>).detail;
      console.log('[MineSweeperScene] MS_SCORE_UPDATE 수신:', data);
      this.handleScoreUpdate({
        playerId: data.playerId,
        scoreChange: data.scoreChange,
        newScore: data.newScore,
        position: data.position ?? { row: 0, col: 0 },
        reason: data.reason as 'safe_tile' | 'flood_fill' | 'mine_hit',
        timestamp: data.timestamp,
      });
    };
    window.addEventListener('ms:score_update', handleScoreUpdate);
    this.serverEventCleanup.push(() =>
      window.removeEventListener('ms:score_update', handleScoreUpdate),
    );

    // MS_REMAINING_MINES: 남은 지뢰 수 업데이트
    const handleRemainingMines = (e: Event) => {
      const data = (e as CustomEvent<any>).detail;
      console.log('[MineSweeperScene] MS_REMAINING_MINES 수신:', data);
      this.remainingMines = data.remainingMines;
      this.events.emit('remainingMinesUpdate', this.remainingMines);
    };
    window.addEventListener('ms:remaining_mines', handleRemainingMines);
    this.serverEventCleanup.push(() =>
      window.removeEventListener('ms:remaining_mines', handleRemainingMines),
    );

    // MS_GAME_END: 게임 종료
    const handleGameEnd = (e: Event) => {
      const data = (e as CustomEvent<MSGameEndPacket>).detail;
      console.log('[MineSweeperScene] MS_GAME_END 수신:', data);
      this.handleGameEnd({
        reason: data.reason,
        results: data.results,
        timestamp: data.timestamp,
      });
    };
    window.addEventListener('ms:game_end', handleGameEnd);
    this.serverEventCleanup.push(() =>
      window.removeEventListener('ms:game_end', handleGameEnd),
    );
  }

  /**
   * 게임 초기화 처리
   */
  private handleGameInit(data: GameInitEvent): void {
    // 서버에서 받은 타일 데이터로 TileManager 동기화
    if (data.tiles && this.tileManager) {
      this.tileManager.syncTilesFromServer(data.tiles);
    }

    // 남은 지뢰 수 초기화
    if (data.remainingMines !== undefined) {
      this.remainingMines = data.remainingMines;
      this.events.emit('remainingMinesUpdate', this.remainingMines);
      console.log(
        `[MineSweeperScene] 초기 남은 지뢰 수: ${this.remainingMines}`,
      );
    }

    // 플레이어 데이터 업데이트 (서버에서 받은 경우)
    if (data.players && data.players.length > 0) {
      this.players = data.players.map((p, index) => ({
        id: p.playerId,
        name: p.playerName,
        score: p.score,
        color: p.playerColor || CONSTANTS.PLAYER_COLORS[index] || '#ffffff',
      }));
      this.tileManager.setPlayerColors(this.players);
      console.log('[MineSweeperScene] 플레이어 데이터 업데이트:', this.players);

      // 플레이어별 깃발 개수 초기화 및 emit
      this.flagCounts = {};
      for (const p of data.players) {
        this.flagCounts[p.playerId] = p.flagsPlaced || 0;
      }
      this.events.emit('flagCountUpdate', { ...this.flagCounts });
      console.log('[MineSweeperScene] 초기 깃발 개수:', this.flagCounts);
    }
  }

  /**
   * 타일 업데이트 처리
   */
  private handleTileUpdate(
    data: TileUpdateEvent & { isSequentialReveal?: boolean; tiles: any[] },
  ): void {
    // 순차적 열기 여부와 관계없이 먼저 깃발 개수 변경 감지
    let flagCountChanged = false;
    for (const tileUpdate of data.tiles) {
      const currentTile = this.tileManager.getTile(
        tileUpdate.row,
        tileUpdate.col,
      );
      const prevState = currentTile?.state;
      const prevFlaggedBy = currentTile?.flaggedBy;

      // 깃발 상태 변경 감지 및 카운트 업데이트
      if (tileUpdate.state === TileState.FLAGGED && tileUpdate.flaggedBy) {
        // 깃발 설치 (이전에 깃발이 없었던 경우에만)
        if (prevState !== TileState.FLAGGED) {
          this.flagCounts[tileUpdate.flaggedBy] =
            (this.flagCounts[tileUpdate.flaggedBy] || 0) + 1;
          flagCountChanged = true;
        }
      } else if (
        prevState === TileState.FLAGGED &&
        tileUpdate.state !== TileState.FLAGGED &&
        prevFlaggedBy
      ) {
        // 깃발 해제 (이전에 깃발이 있었던 경우 - 타일이 열릴 때 포함)
        this.flagCounts[prevFlaggedBy] = Math.max(
          0,
          (this.flagCounts[prevFlaggedBy] || 0) - 1,
        );
        flagCountChanged = true;
      }
    }

    // 깃발 개수 변경 시 이벤트 emit
    if (flagCountChanged) {
      this.events.emit('flagCountUpdate', { ...this.flagCounts });
      console.log('[MineSweeperScene] flagCountUpdate emit:', this.flagCounts);
    }

    // 순차적 열기(파동) 플래그가 있고, 거리 정보가 포함된 경우 클라이언트에서 애니메이션 처리
    if (
      data.isSequentialReveal &&
      data.tiles.length > 1 &&
      'distance' in data.tiles[0]
    ) {
      // 거리 정보가 포함된 타일 배열로 순차 애니메이션
      this.tileManager.revealTilesSequentially(
        data.tiles as Array<{
          row: number;
          col: number;
          state: any;
          adjacentMines?: number;
          isMine?: boolean;
          revealedBy?: string | null;
          flaggedBy?: string | null;
          distance: number;
        }>,
        50, // 50ms 간격
      );
    } else {
      // 일반 업데이트 (즉시 반영)
      let hasNonMineTile = false;
      let hasMineTile = false;

      for (const tileUpdate of data.tiles) {
        const isMine = this.tileManager.updateTileState(
          tileUpdate.row,
          tileUpdate.col,
          tileUpdate.state,
          tileUpdate.adjacentMines,
          tileUpdate.isMine,
          tileUpdate.revealedBy,
          tileUpdate.flaggedBy,
        );

        // 지뢰가 아닌 타일이 열렸는지 확인
        if (!isMine && tileUpdate.state === TileState.REVEALED) {
          hasNonMineTile = true;
        }

        // 지뢰 타일이 열렸는지 확인 (내가 연 타일만)
        if (
          tileUpdate.isMine &&
          tileUpdate.state === TileState.REVEALED &&
          tileUpdate.revealedBy === this.getMyPlayerId()
        ) {
          hasMineTile = true;
        }
      }

      // 지뢰가 아닌 타일이 열렸을 때만 타일 열기 사운드 이벤트 발생
      if (hasNonMineTile) {
        this.events.emit('minesweeperTileReveal');
      }

      // 내가 지뢰를 열었으면 클릭 불가 상태 활성화
      if (hasMineTile) {
        this.activateClickDisable();
      }
    }

    // 남은 지뢰 수 업데이트
    if (data.remainingMines !== undefined) {
      this.remainingMines = data.remainingMines;
      this.events.emit('remainingMinesUpdate', this.remainingMines);
      console.log(
        `[MineSweeperScene] 남은 지뢰 수 업데이트: ${this.remainingMines}`,
      );
    }
  }

  /**
   * 점수 업데이트 처리
   */
  private handleScoreUpdate(data: ScoreUpdateEvent): void {
    // 로컬 플레이어 점수 업데이트
    const playerIndex = this.players.findIndex((p) => p.id === data.playerId);
    const player = playerIndex !== -1 ? this.players[playerIndex] : null;
    if (player) {
      player.score = data.newScore;

      // React UI에 점수 업데이트 알림
      this.events.emit('scoreUpdate', {
        playerIndex,
        playerId: data.playerId,
        scoreChange: data.scoreChange,
        newScore: data.newScore,
        reason: data.reason,
      });

      console.log(
        `[MineSweeperScene] ${data.playerId} 점수: ${data.scoreChange > 0 ? '+' : ''}${data.scoreChange} (총: ${data.newScore}) - ${data.reason}`,
      );
    }
  }

  /**
   * 게임 종료 처리
   */
  private handleGameEnd(data: any): void {
    // 타이머 정지
    if (this.timerSystem) {
      this.timerSystem.destroy();
    }

    // 승리로 인한 종료인 경우 메시지 표시
    if (data.reason === 'win') {
      console.log(
        '[MineSweeperScene] 🎉 게임 승리! 모든 안전한 타일을 열었습니다!',
      );
    }

    // 서버에서 받은 최종 플레이어 데이터로 업데이트 및 깃발 통계 추출
    const flagStats = new Map<
      string,
      { correctFlags: number; incorrectFlags: number }
    >();

    // results 형식 (서버 모드) 또는 players 형식 (Mock 모드) 처리
    const playerResults = data.results || data.players;

    if (playerResults) {
      playerResults.forEach((serverPlayer: any) => {
        const localPlayer = this.players.find(
          (p) => p.id === serverPlayer.id || p.id === serverPlayer.playerId,
        );
        if (localPlayer) {
          localPlayer.score = serverPlayer.score;
        }

        // 깃발 통계 추출
        const playerId = serverPlayer.id || serverPlayer.playerId;
        if (playerId) {
          flagStats.set(playerId, {
            correctFlags: serverPlayer.correctFlags ?? 0,
            incorrectFlags:
              (serverPlayer.totalFlags ?? 0) - (serverPlayer.correctFlags ?? 0),
          });
        }
      });
    }

    // 게임 종료 처리 (깃발 통계 포함)
    this.emitGameEnd(flagStats);
  }

  /**
   * 현재 플레이어 ID 가져오기
   */
  private getMyPlayerId(): PlayerId {
    if (isMockMode()) {
      return this.myPlayerId;
    } else {
      return (socketManager.getId() ?? this.myPlayerId) as PlayerId;
    }
  }

  /**
   * 이벤트 리스너 설정 (React에서 수신)
   */
  private setupEventListeners(): void {
    // 타일 열기 사운드 이벤트 리스너
    this.events.on('minesweeperTileReveal', () => {
      // TileManager에서 발생한 이벤트를 GameContainer로 전달
      console.log(
        '[MineSweeperScene] minesweeperTileReveal 이벤트 수신 및 재전송',
      );
    });

    // 지뢰 폭발 사운드 이벤트 리스너
    this.events.on('minesweeperMineExplode', () => {
      // TileManager에서 발생한 이벤트를 GameContainer로 전달
      console.log(
        '[MineSweeperScene] minesweeperMineExplode 이벤트 수신 및 재전송',
      );
    });

    this.events.on(
      'updatePlayers',
      (data: {
        playerCount?: number;
        players?: PlayerData[];
        currentPlayerIndex?: number;
        preset?: MineSweeperGamePreset;
      }) => {
        console.log('[MineSweeperScene] updatePlayers 이벤트 수신:', data);

        // 플레이어 수 업데이트
        if (data.playerCount !== undefined) {
          this.playerCount = data.playerCount;
        }
        if (data.players !== undefined && data.players.length > 0) {
          // common PlayerData를 로컬 PlayerData로 변환
          this.players = data.players.map((p: any) => ({
            id: p.id || '',
            name: p.playerName || p.name || '',
            score: p.reportCard?.score ?? p.score ?? 0,
            color: p.color || '#ffffff',
          }));
        }
        // 수동 플레이어 전환이 아닌 경우에만 currentPlayerIndex 업데이트
        // (Mock 모드에서 1-4키로 플레이어 전환 시에만 해당)
        if (
          data.currentPlayerIndex !== undefined &&
          !this.isManualPlayerSwitch
        ) {
          this.currentPlayerIndex = data.currentPlayerIndex;

          // 현재 플레이어 ID 설정
          if (this.players[this.currentPlayerIndex]) {
            this.myPlayerId = this.players[this.currentPlayerIndex].id;
          }
        }

        // 플레이어 색상 기본값 설정
        if (this.players.length === 0) {
          this.players = Array.from({ length: this.playerCount }, (_, i) => ({
            id: `id_${i + 1}`,
            name: `Player ${i + 1}`,
            score: 0,
            color: CONSTANTS.PLAYER_COLORS[i] || '#ffffff',
          }));
        }

        // 프리셋 적용
        if (data.preset) {
          const newConfig = resolveMineSweeperPreset(data.preset);
          console.log('[MineSweeperScene] 새 프리셋 적용:', newConfig);

          // 설정이 변경되었는지 확인
          const configChanged =
            newConfig.gridCols !== this.gameConfig.gridCols ||
            newConfig.gridRows !== this.gameConfig.gridRows ||
            newConfig.mineCount !== this.gameConfig.mineCount;

          const timeChanged = newConfig.totalTime !== this.gameConfig.totalTime;

          if (configChanged) {
            this.gameConfig = newConfig;

            // 타일 매니저 재생성
            if (this.tileManager) {
              this.tileManager.destroy();
            }
            this.tileManager = new TileManager(this, this.gameContainer, {
              gridCols: this.gameConfig.gridCols,
              gridRows: this.gameConfig.gridRows,
              mineCount: this.gameConfig.mineCount,
            });
            this.tileManager.initialize();
            this.tileManager.setPlayerColors(this.players);

            // Mock 모드에서 서버 코어도 동일한 설정으로 재초기화
            if (isMockMode() && this.socket instanceof MockSocket) {
              this.setupMockServer();
            }

            console.log(
              `[MineSweeperScene] 그리드 재생성: ${this.gameConfig.gridCols}x${this.gameConfig.gridRows}, 지뢰 ${this.gameConfig.mineCount}개`,
            );
          }

          // 타이머 재시작 (시간이 변경된 경우)
          if (timeChanged) {
            this.gameConfig = newConfig;
            if (this.timerSystem) {
              this.timerSystem.destroy();
            }
            this.startTimer(this.gameConfig.totalTime);
            console.log(
              `[MineSweeperScene] 타이머 재시작: ${this.gameConfig.totalTime}초`,
            );
          }
        }

        // TileManager에 플레이어 색상 전달
        if (this.tileManager) {
          this.tileManager.setPlayerColors(this.players);
        }

        console.log(
          `[MineSweeperScene] 플레이어 ${this.playerCount}명 설정 완료`,
        );
      },
    );
  }

  /**
   * 타일 매니저 가져오기
   */
  public getTileManager(): TileManager {
    return this.tileManager;
  }

  /**
   * 남은 지뢰 수 가져오기
   */
  public getRemainingMines(): number {
    return this.remainingMines;
  }

  /**
   * 씬 종료 시 정리
   */
  shutdown() {
    console.log('[MineSweeperScene] shutdown 호출됨');

    // 클릭 불가 타이머 정리
    if (this.clickDisabledTimer) {
      this.clickDisabledTimer.destroy();
      this.clickDisabledTimer = undefined;
    }

    // Mock 서버 코어 정리
    if (this.mockServerCore) {
      this.mockServerCore.destroy();
      this.mockServerCore = undefined;

      // MockSocket에서 serverCore 참조 제거
      if (this.socket instanceof MockSocket) {
        this.socket.clearServerCore();
      }
    }

    // 타이머 시스템 정리
    if (this.timerSystem) {
      this.timerSystem.destroy();
    }

    // 타일 매니저 정리
    if (this.tileManager) {
      this.tileManager.destroy();
    }

    // 소켓 이벤트 리스너 제거 (Mock 모드)
    this.socket.off('game_init');
    this.socket.off('tile_update');
    this.socket.off('score_update');
    this.socket.off('flagCountUpdate');
    this.socket.off('game_end');

    // 서버 모드 이벤트 리스너 제거 (CustomEvent)
    this.serverEventCleanup.forEach((cleanup) => cleanup());
    this.serverEventCleanup = [];

    this.events.off('updatePlayers');

    // 키보드 이벤트 리스너 제거
    this.input.keyboard?.off('keydown-D');
    this.input.keyboard?.off('keydown-ONE');
    this.input.keyboard?.off('keydown-TWO');
    this.input.keyboard?.off('keydown-THREE');
    this.input.keyboard?.off('keydown-FOUR');

    // 마우스 이벤트 리스너 제거
    this.input.off('pointerdown');
    console.log('[MineSweeperScene] shutdown 완료');
  }

  /* END-USER-CODE */
}

/* END OF COMPILED CODE */

// You can write more code here

// Named export
export { MineSweeperScene };
