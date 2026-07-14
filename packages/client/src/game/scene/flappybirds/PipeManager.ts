import Phaser from 'phaser';
import PipePrefab from './PipePrefab';
import type { PipeData } from '../../types/flappybird.types';
import { getSmoothingAlpha } from './interpolation';

interface PipeMotion {
  targetX: number;
  receivedAt: number;
  velocityPerMs: number;
}

const MAX_PIPE_EXTRAPOLATION_MS = 100;

/**
 * 파이프 관리 매니저
 * 서버로부터 받은 파이프 데이터를 기반으로 렌더링합니다.
 */
export default class PipeManager {
  private scene: Phaser.Scene;
  private pipeObjects: Map<string, PipePrefab> = new Map();
  private pipeMotions: Map<string, PipeMotion> = new Map();
  private screenHeight: number;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
    this.screenHeight = scene.cameras.main.height;
  }

  /**
   * 서버로부터 받은 파이프 데이터로 업데이트합니다.
   */
  updateFromServer(serverPipes: PipeData[]): void {
    const receivedAt = performance.now();
    const serverPipeIds = new Set(serverPipes.map((p) => p.id));

    // 서버에 없는 파이프 제거
    for (const [id, pipeObj] of this.pipeObjects.entries()) {
      if (!serverPipeIds.has(id)) {
        pipeObj.destroy();
        this.pipeObjects.delete(id);
        this.pipeMotions.delete(id);
      }
    }

    // 서버 파이프 데이터로 업데이트 또는 생성
    for (const pipeData of serverPipes) {
      let pipeObj = this.pipeObjects.get(pipeData.id);

      if (!pipeObj) {
        pipeObj = this.createPipeFromData(pipeData);
        this.pipeObjects.set(pipeData.id, pipeObj);
        this.pipeMotions.set(pipeData.id, {
          targetX: pipeData.x,
          receivedAt,
          velocityPerMs: 0,
        });
      } else {
        const previousMotion = this.pipeMotions.get(pipeData.id);
        const elapsed = previousMotion
          ? receivedAt - previousMotion.receivedAt
          : 0;
        const velocityPerMs =
          previousMotion && elapsed > 0
            ? (pipeData.x - previousMotion.targetX) / elapsed
            : (previousMotion?.velocityPerMs ?? 0);

        this.pipeMotions.set(pipeData.id, {
          targetX: pipeData.x,
          receivedAt,
          velocityPerMs,
        });
      }
    }
  }

  /** 서버의 20Hz 위치 사이를 화면 주사율에 맞춰 부드럽게 렌더링합니다. */
  update(deltaMs: number): void {
    const now = performance.now();
    const alpha = getSmoothingAlpha(deltaMs);

    for (const [id, pipeObj] of this.pipeObjects.entries()) {
      const motion = this.pipeMotions.get(id);
      if (!motion) continue;

      const age = Math.min(
        MAX_PIPE_EXTRAPOLATION_MS,
        Math.max(0, now - motion.receivedAt),
      );
      const predictedX = motion.targetX + motion.velocityPerMs * age;
      pipeObj.x = Phaser.Math.Linear(pipeObj.x, predictedX, alpha);
    }
  }

  private createPipeFromData(pipeData: PipeData): PipePrefab {
    const pipe = new PipePrefab(this.scene, pipeData.x, 0);
    this.scene.add.existing(pipe);
    this.setPipeGap(pipe, pipeData);
    return pipe;
  }

  private setPipeGap(pipe: PipePrefab, pipeData: PipeData): void {
    pipe.setFromServerData(
      pipeData.gapY,
      pipeData.gap,
      pipeData.width,
      this.screenHeight,
    );
  }

  destroy(): void {
    for (const pipe of this.pipeObjects.values()) {
      pipe.destroy();
    }
    this.pipeObjects.clear();
    this.pipeMotions.clear();
  }

  getPipes(): PipePrefab[] {
    return Array.from(this.pipeObjects.values());
  }
}
