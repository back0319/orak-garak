import Matter from 'matter-js';
import { GameInstance } from './GameInstance';
import {
  FlappyBirdGamePreset,
  resolveFlappyBirdPreset,
  FLAPPY_PHYSICS,
  FLAPPY_PHYSICS_FPS,
  FLAPPY_NETWORK_FPS,
  FLAPPY_PHYSICS_FRAME_MS,
  createFlappyPhysicsRuntime,
  destroyFlappyPhysicsRuntime,
  snapshotFlappyBirds,
  applyDeterministicFlappyJump,
  stepFlappyBirdPhysics,
  calculateFlappyRopeConnections,
  FlappyBirdPacketType,
  FlappyScoreUpdatePacket,
  FlappyGameOverPacket,
  FlappyWorldStatePacket,
  FlappySyncStatePacket,
  FlappyInputAppliedPacket,
  FlappyClockPongPacket,
  FlappyPipeData,
} from '@main-game/common';
import { GameSession } from '../gameSession';
import type { GameSocket } from '../../network/transport';
import { FixedStepClock } from './fixedStepClock';

// 상수 추출
const {
  BIRD_WIDTH,
  BIRD_HEIGHT,
  GAME_WIDTH,
  GAME_HEIGHT,
  FLAPPY_GROUND_Y,
  GAME_CENTER_X,
  CATEGORY_GROUND,
} = FLAPPY_PHYSICS;

/** 서버 내부용 파이프 데이터 (통과 추적 포함) */
interface InternalPipeData extends FlappyPipeData {
  passed: boolean;
  passedPlayers: number[];
}

export class FlappyBirdInstance implements GameInstance {
  // Matter.js
  private engine: Matter.Engine;
  private world: Matter.World;
  private birds: Matter.Body[] = [];
  private ground: Matter.Body | null = null;

  // 게임 상태
  private score: number = 0;
  private isRunning: boolean = false;
  private isGameOverState: boolean = false;
  private physicsTick: number = 0;
  private lastGameOverData: {
    reason: 'pipe_collision' | 'ground_collision';
    collidedPlayerIndex: number;
  } | null = null;
  private roundId: string = '';
  private physicsSeed: number = 0;

  // 파이프 관리
  private pipes: InternalPipeData[] = [];
  private nextPipeId: number = 0;

  // 플레이어 추적
  private lastFlapTicks: number[] = [];
  private lastProcessedInputSeqs: number[] = [];

  // 밧줄 물리
  private ropeConnections: [number, number][] = [];

  // 설정 값 (initialize에서 설정)
  private pipeWidth: number = 120;
  private pipeGap: number = 200;
  private pipeSpacing: number = 400;
  private pipeSpeed: number = 1.5;
  private flapBoostBase: number = 0.3;
  private flapBoostRandom: number = 0.7;
  private ropeLength: number = 100;
  private connectAll: boolean = false;

  // 루프 관리
  private updateInterval: ReturnType<typeof setInterval> | null = null;
  private readonly MAX_CATCH_UP_STEPS = 6;
  private readonly loopClock = new FixedStepClock(
    FLAPPY_PHYSICS_FRAME_MS,
    this.MAX_CATCH_UP_STEPS,
  );
  private lastBroadcastTick: number = 0;

  private session: GameSession;

  constructor(session: GameSession) {
    this.session = session;

    // Matter.js 엔진 생성
    const runtime = createFlappyPhysicsRuntime(0, false);
    this.engine = runtime.engine;
    this.birds = runtime.birds;
    this.world = this.engine.world;
  }

  initialize(config: FlappyBirdGamePreset): void {
    // 프리셋을 실제 값으로 변환
    const resolved = resolveFlappyBirdPreset(config);
    const playerCount = this.session.players.size;

    // 기존 객체 제거
    destroyFlappyPhysicsRuntime({ engine: this.engine, birds: this.birds });
    this.score = 0;
    this.isGameOverState = false;
    this.lastGameOverData = null;
    this.pipes = [];
    this.nextPipeId = 0;
    this.lastFlapTicks = Array.from({ length: playerCount }, () => 0);
    this.lastProcessedInputSeqs = Array.from({ length: playerCount }, () => 0);
    this.physicsTick = 0;
    this.lastBroadcastTick = 0;
    this.roundId = crypto.randomUUID();
    this.physicsSeed = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;

    // 설정 적용
    this.pipeSpeed = resolved.pipeSpeed;
    this.pipeSpacing = resolved.pipeSpacing;
    this.pipeGap = resolved.pipeGap;
    this.pipeWidth = resolved.pipeWidth;
    this.flapBoostBase = resolved.flapBoostBase;
    this.flapBoostRandom = resolved.flapBoostRandom;
    this.ropeLength = resolved.ropeLength;
    this.connectAll = resolved.connectAll;

    console.log(
      `[FlappyBirdInstance] 설정 적용: speed=${resolved.pipeSpeed}, spacing=${resolved.pipeSpacing}, gap=${resolved.pipeGap}, width=${resolved.pipeWidth}, ropeLength=${resolved.ropeLength}, connectAll=${resolved.connectAll}`,
    );

    const runtime = createFlappyPhysicsRuntime(playerCount, this.connectAll);
    this.engine = runtime.engine;
    this.world = runtime.engine.world;
    this.birds = runtime.birds;

    // 바닥은 충돌 판정용 좌표를 표현하며 실제 Matter 충돌은 비활성화한다.
    this.createGround();

    // 밧줄 연결 쌍 계산
    this.ropeConnections = calculateFlappyRopeConnections(
      playerCount,
      this.connectAll,
    );

    console.log(
      `[FlappyBirdInstance] 게임 초기화 완료 (플레이어: ${playerCount}, 밧줄 연결: ${this.ropeConnections.map((c) => `${c[0]}-${c[1]}`).join(', ')})`,
    );
  }

  start(): void {
    if (this.isRunning) return;

    this.isRunning = true;
    this.session.status = 'playing';
    this.loopClock.reset(Date.now());

    this.updateInterval = setInterval(
      () => this.runScheduledUpdate(Date.now()),
      1000 / FLAPPY_PHYSICS_FPS,
    );

    console.log('[FlappyBirdInstance] 게임 시작');
  }

  stop(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
    this.isRunning = false;
    console.log('[FlappyBirdInstance] 게임 정지');
  }

  destroy(): void {
    this.stop();

    destroyFlappyPhysicsRuntime({ engine: this.engine, birds: this.birds });

    this.birds = [];
    this.pipes = [];
    this.score = 0;
    this.nextPipeId = 0;
    this.isGameOverState = false;
    this.ground = null;
    this.lastFlapTicks = [];
    this.lastProcessedInputSeqs = [];
    this.roundId = '';
    this.physicsSeed = 0;

    console.log('[FlappyBirdInstance] 정리 완료');
  }

  serialize(): unknown {
    // A running physics loop is intentionally not persisted. The room restores
    // to the lobby after an isolate restart instead of resuming a divergent sim.
    return null;
  }

  restore(_snapshot: unknown): void {
    this.isRunning = false;
  }

  handlePacket(socket: GameSocket, playerIndex: number, packet: any): void {
    switch (packet.type) {
      case FlappyBirdPacketType.FLAPPY_JUMP:
        this.handleJump(playerIndex, packet.inputSeq, packet.roundId);
        break;
      case FlappyBirdPacketType.FLAPPY_CLOCK_PING:
        this.handleClockPing(socket, packet.clientSentAt, packet.roundId);
        break;
      case FlappyBirdPacketType.FLAPPY_REQUEST_SYNC:
        this.handleSyncRequest(socket);
        break;
    }
  }

  /**
   * 클라이언트 씬 로딩 완료 후 동기화 요청 처리
   * 현재 게임 상태를 해당 클라이언트에게 전송
   */
  private handleSyncRequest(socket: GameSocket): void {
    // 현재 새 위치 정보
    const birds = snapshotFlappyBirds(this.birds);

    // 현재 파이프 정보
    const pipes: FlappyPipeData[] = this.pipes.map((pipe) => ({
      id: pipe.id,
      x: pipe.x,
      gapY: pipe.gapY,
      width: pipe.width,
      gap: pipe.gap,
    }));

    // 카메라 X 계산
    let cameraX = 250;
    if (this.birds.length > 0) {
      let totalX = 0;
      for (const bird of this.birds) {
        totalX += bird.position.x;
      }
      cameraX = totalX / this.birds.length;
    }

    const syncPacket: FlappySyncStatePacket = {
      type: FlappyBirdPacketType.FLAPPY_SYNC_STATE,
      tick: this.physicsTick,
      birds,
      pipes,
      cameraX,
      score: this.score,
      isGameOver: this.isGameOverState,
      lastProcessedInputSeqs: [...this.lastProcessedInputSeqs],
      roundId: this.roundId,
      physicsSeed: this.physicsSeed,
      lastFlapTicks: [...this.lastFlapTicks],
      gameOverData: this.lastGameOverData ?? undefined,
    };

    // 요청한 클라이언트에게만 전송
    const { type, ...payload } = syncPacket;
    socket.emit(type, payload);

    console.log(
      `[FlappyBirdInstance] 동기화 응답 전송 (gameOver: ${this.isGameOverState}, score: ${this.score})`,
    );
  }

  // ========== 물리 생성 메서드 ==========

  private createGround(): void {
    this.ground = Matter.Bodies.rectangle(
      GAME_CENTER_X,
      FLAPPY_GROUND_Y + 500,
      GAME_WIDTH,
      1000,
      {
        isStatic: true,
        label: 'ground',
        collisionFilter: {
          category: CATEGORY_GROUND,
          mask: 0, // 물리 충돌 비활성화 - checkCollisions에서 처리
        },
      },
    );

    Matter.World.add(this.world, this.ground);
  }

  // ========== 게임 루프 ==========

  private runScheduledUpdate(nowMs: number): void {
    const { steps } = this.loopClock.advance(nowMs);

    for (let step = 0; step < steps; step++) {
      this.physicsUpdate();
      if (!this.isRunning) return;
    }

    // 물리는 60Hz로 처리하되 네트워크는 최신 상태만 최대 20Hz로 보낸다.
    const networkStep = FLAPPY_PHYSICS_FPS / FLAPPY_NETWORK_FPS;
    if (steps > 0 && this.physicsTick - this.lastBroadcastTick >= networkStep) {
      this.lastBroadcastTick = this.physicsTick;
      this.broadcastWorldState();
    }
  }

  private physicsUpdate(): void {
    this.physicsTick++;

    // 1. 파이프 업데이트
    this.updatePipes();

    stepFlappyBirdPhysics({
      runtime: { engine: this.engine, birds: this.birds },
      tick: this.physicsTick,
      lastFlapTicks: this.lastFlapTicks,
      config: {
        pipeSpeed: this.pipeSpeed,
        ropeLength: this.ropeLength,
        connectAll: this.connectAll,
      },
      onSubstep: () => this.checkCollisions(),
    });
  }

  private updatePipes(): void {
    if (this.isGameOverState) return;

    // 새들의 평균 X 위치 계산 (카메라 기준점)
    let avgBirdX = 250;
    if (this.birds.length > 0) {
      let totalX = 0;
      for (const bird of this.birds) {
        totalX += bird.position.x;
      }
      avgBirdX = totalX / this.birds.length;
    }

    // 화면 밖 파이프 제거
    this.pipes = this.pipes.filter((pipe) => pipe.x > avgBirdX - GAME_WIDTH);

    // 카메라 뷰 범위 계산
    const viewRight = avgBirdX + (GAME_WIDTH * 3) / 4;
    const spawnAhead = GAME_WIDTH;
    const targetX = viewRight + spawnAhead;

    // 파이프 생성
    let maxPipeX =
      this.pipes.length > 0
        ? Math.max(...this.pipes.map((p) => p.x))
        : avgBirdX - GAME_WIDTH / 4;

    while (maxPipeX < targetX) {
      const newPipeX =
        this.pipes.length === 0
          ? viewRight + this.pipeSpacing
          : maxPipeX + this.pipeSpacing;
      this.createPipe(newPipeX);
      maxPipeX = newPipeX;
    }
  }

  private createPipe(x: number): void {
    const minGapY = GAME_HEIGHT * 0.1;
    const maxGapY = GAME_HEIGHT * 0.5;
    const gapY = minGapY + Math.random() * (maxGapY - minGapY);

    const pipe: InternalPipeData = {
      id: this.nextPipeId++,
      x,
      gapY,
      width: this.pipeWidth,
      gap: this.pipeGap,
      passed: false,
      passedPlayers: [],
    };

    this.pipes.push(pipe);
  }

  // ========== 충돌 감지 ==========

  private checkCollisions(): boolean {
    for (let i = 0; i < this.birds.length; i++) {
      const bird = this.birds[i];
      if (bird.isStatic) continue;

      // 1. 바닥 충돌
      const birdBottom = bird.position.y + BIRD_HEIGHT / 2;
      if (birdBottom >= FLAPPY_GROUND_Y) {
        Matter.Body.setPosition(bird, {
          x: bird.position.x,
          y: FLAPPY_GROUND_Y - BIRD_HEIGHT / 2,
        });
        Matter.Body.setVelocity(bird, { x: 0, y: 0 });
        Matter.Body.setStatic(bird, true);
        Matter.Body.setAngle(bird, Math.PI / 2);
        this.handleGameOver('ground_collision', i);
        return false;
      }

      // 2. 천장 충돌 (죽지 않고 막기만)
      if (bird.position.y - BIRD_HEIGHT / 2 <= 0) {
        Matter.Body.setPosition(bird, {
          x: bird.position.x,
          y: BIRD_HEIGHT / 2,
        });
        if (bird.velocity.y < 0) {
          Matter.Body.setVelocity(bird, { x: bird.velocity.x, y: 0 });
        }
      }

      // 3. 왼쪽 벽 충돌 (죽지 않고 막기만)
      if (bird.position.x - BIRD_WIDTH / 2 <= 0) {
        Matter.Body.setPosition(bird, {
          x: BIRD_WIDTH / 2,
          y: bird.position.y,
        });
        if (bird.velocity.x < 0) {
          Matter.Body.setVelocity(bird, { x: 0, y: bird.velocity.y });
        }
      }

      // 4. 파이프 충돌
      const birdX = bird.position.x;
      const birdY = bird.position.y;
      const hitboxSize = 36;
      const halfHitbox = hitboxSize / 2;

      for (const pipe of this.pipes) {
        const halfPipeW = pipe.width / 2;
        const pipeLeft = pipe.x - halfPipeW;
        const pipeRight = pipe.x + halfPipeW;

        // X축 충돌 체크
        if (birdX + halfHitbox < pipeLeft || birdX - halfHitbox > pipeRight) {
          continue;
        }

        const gapTop = pipe.gapY - pipe.gap / 2;
        const gapBottom = pipe.gapY + pipe.gap / 2;

        // Y축 충돌: 새가 갭 밖에 있으면 충돌
        if (birdY - halfHitbox < gapTop || birdY + halfHitbox > gapBottom) {
          this.handleGameOver('pipe_collision', i);
          return false;
        }

        // 통과 판정
        if (!pipe.passedPlayers.includes(i) && birdX - halfHitbox > pipe.x) {
          pipe.passedPlayers.push(i);

          // 모든 플레이어가 통과했을 때만 점수 증가
          if (pipe.passedPlayers.length === this.birds.length && !pipe.passed) {
            pipe.passed = true;
            this.score++;

            const scorePacket: FlappyScoreUpdatePacket = {
              type: FlappyBirdPacketType.FLAPPY_SCORE_UPDATE,
              score: this.score,
            };
            this.session.broadcastPacket(scorePacket);

            console.log(`[FlappyBirdInstance] 점수 업데이트: ${this.score}`);
          }
        }
      }
    }
    return true;
  }

  // ========== 게임 오버 ==========

  private handleGameOver(
    reason: 'pipe_collision' | 'ground_collision',
    playerIndex: number,
  ): void {
    if (this.isGameOverState) return;

    this.isGameOverState = true;

    // 게임 오버 데이터 저장 (동기화 요청 시 사용)
    this.lastGameOverData = { reason, collidedPlayerIndex: playerIndex };

    // ❗ 중요: stopGame() 호출 전에 birds 데이터를 먼저 수집 (stopGame이 destroy를 호출하면 this.birds가 초기화됨)
    const birds = snapshotFlappyBirds(this.birds);

    // 카메라 X 위치 계산 (새들의 평균 X 위치 기준)
    const avgX =
      this.birds.reduce((sum, bird) => sum + bird.position.x, 0) /
      this.birds.length;
    const cameraX = avgX - 300; // 화면 너비의 1/4 지점에 새가 위치하도록

    // 패킷을 먼저 전송한 후 게임을 정지해야 함
    // (stopGame에서 destroy가 호출되어 this.score가 0으로 초기화되기 때문)
    const gameOverPacket: FlappyGameOverPacket = {
      type: FlappyBirdPacketType.FLAPPY_GAME_OVER,
      reason,
      finalScore: this.score,
      collidedPlayerIndex: playerIndex,
      birds,
      cameraX,
      roundId: this.roundId,
    };

    // 패킷 전송 후 게임 정지 (이 순서가 중요!)
    this.session.broadcastPacket(gameOverPacket);
    console.log(
      `[FlappyBirdInstance] 게임 오버: ${reason} (Player ${playerIndex}), birds: ${birds.length}, cameraX: ${cameraX}`,
    );

    this.session.stopGame();
  }

  // ========== 입력 처리 ==========

  private handleJump(
    playerIndex: number,
    inputSeq: unknown,
    packetRoundId?: string,
  ): void {
    if (this.isGameOverState) return;
    if (packetRoundId && packetRoundId !== this.roundId) return;

    if (!Number.isSafeInteger(inputSeq) || (inputSeq as number) <= 0) return;

    const sequence = inputSeq as number;
    if (sequence <= (this.lastProcessedInputSeqs[playerIndex] ?? 0)) return;

    const applyTick = this.physicsTick + 1;
    const applied = applyDeterministicFlappyJump(
      this.birds,
      playerIndex,
      sequence,
      this.physicsSeed,
      {
        flapBoostBase: this.flapBoostBase,
        flapBoostRandom: this.flapBoostRandom,
      },
    );
    if (!applied) return;

    this.lastFlapTicks[playerIndex] = this.physicsTick;
    this.lastProcessedInputSeqs[playerIndex] = sequence;
    const appliedPacket: FlappyInputAppliedPacket = {
      type: FlappyBirdPacketType.FLAPPY_INPUT_APPLIED,
      roundId: this.roundId,
      playerIndex,
      inputSeq: sequence,
      applyTick,
    };
    this.session.broadcastPacket(appliedPacket);
  }

  private handleClockPing(
    socket: GameSocket,
    clientSentAt: unknown,
    packetRoundId?: string,
  ): void {
    if (!Number.isFinite(clientSentAt)) return;
    if (packetRoundId && packetRoundId !== this.roundId) return;

    const pong: FlappyClockPongPacket = {
      type: FlappyBirdPacketType.FLAPPY_CLOCK_PONG,
      roundId: this.roundId,
      clientSentAt: clientSentAt as number,
      serverTick: this.physicsTick,
    };
    const { type, ...payload } = pong;
    socket.emit(type, payload);
  }

  // ========== 브로드캐스트 ==========

  private broadcastWorldState(): void {
    // 카메라 X 계산 (새들 평균 위치)
    let cameraX = 250;
    if (this.birds.length > 0) {
      let totalX = 0;
      for (const bird of this.birds) {
        totalX += bird.position.x;
      }
      cameraX = totalX / this.birds.length;
    }

    // FlappyBirdData로 변환
    const birds = snapshotFlappyBirds(this.birds);

    // FlappyPipeData로 변환 (내부 추적 필드 제거)
    const pipes: FlappyPipeData[] = this.pipes.map((pipe) => ({
      id: pipe.id,
      x: pipe.x,
      gapY: pipe.gapY,
      width: pipe.width,
      gap: pipe.gap,
    }));

    const worldStatePacket: FlappyWorldStatePacket = {
      type: FlappyBirdPacketType.FLAPPY_WORLD_STATE,
      tick: this.physicsTick,
      birds,
      pipes,
      cameraX,
      lastProcessedInputSeqs: [...this.lastProcessedInputSeqs],
      roundId: this.roundId,
      physicsSeed: this.physicsSeed,
      lastFlapTicks: [...this.lastFlapTicks],
    };

    this.session.broadcastPacket(worldStatePacket);
  }
}
