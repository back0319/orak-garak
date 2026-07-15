// 색상 보간 함수
function lerpColor(a: number[], b: number[], t: number): number[] {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

function rgbToHex([r, g, b]: number[]): number {
  return (r << 16) + (g << 8) + b;
}
import Phaser from 'phaser';
import timerPrefab from './TimerPrefab';
import AppleGameManager from '../scene/apple/AppleGameManager';
import {
  calculateInitialRemainingMs,
  calculateRemainingSeconds,
  type TimerTiming,
} from './timerDeadline';

/** 타이머 이벤트 타입 */
export const TimerEvents = {
  TICK: 'timer:tick',
  COMPLETE: 'timer:complete',
} as const;

export default class TimerSystem {
  private readonly scene: Phaser.Scene;
  private readonly timerPrefab: timerPrefab;
  private readonly appleGameManager?: AppleGameManager;

  private totalTime = 0;
  private remainingTime = 0;

  private deadlineTimestamp = 0;

  private updateIntervalId?: number; // setInterval ID (비활성 창에서도 동작)
  private lastSecond = -1; // 초 단위 변화 감지용
  private isFinished = false;

  // Visibility change 감지
  private visibilityChangeHandler?: () => void;

  constructor(
    scene: Phaser.Scene,
    timerPrefabInstance: timerPrefab,
    appleGameManager?: AppleGameManager,
  ) {
    this.scene = scene;
    this.timerPrefab = timerPrefabInstance;
    this.appleGameManager = appleGameManager;

    // 씬 종료 시 자동 정리
    this.scene.events.once(Phaser.Scenes.Events.SHUTDOWN, this.destroy, this);

    // 탭 전환 감지 (visibility change)
    this.setupVisibilityListener();
  }

  /** Visibility change 리스너 설정 */
  private setupVisibilityListener(): void {
    this.visibilityChangeHandler = () => {
      if (document.hidden) {
        // 탭이 비활성화됨
        console.log('⏸️ 탭 비활성화 - 타이머 계속 실행 중');
      } else {
        // 탭이 다시 활성화됨 - 타이머 동기화
        if (!this.isFinished) {
          this.syncTimer();
          console.log('▶️ 탭 활성화 - 타이머 동기화 완료');
        }
      }
    };
    document.addEventListener('visibilitychange', this.visibilityChangeHandler);
  }

  /** 타이머 동기화 (탭 전환 후 복귀 시) */
  private syncTimer(): void {
    this.remainingTime = calculateRemainingSeconds(
      this.deadlineTimestamp,
      performance.now(),
    );

    // 바 스케일 즉시 업데이트
    const ratio = this.ratio;
    this.timerPrefab.setBarScale(ratio);

    // 색상 업데이트
    this.updateBarColor();

    console.log(`🔄 타이머 동기화: ${this.remainingTime.toFixed(1)}초 남음`);
  }

  /** 전체 시간을 설정하고 타이머를 시작합니다. */
  start(totalSeconds: number, timing?: TimerTiming | number): void {
    this.stop();
    if (totalSeconds <= 0) {
      this.finish();
      return;
    }

    this.totalTime = totalSeconds;
    this.isFinished = false;

    const monotonicNow = performance.now();
    const normalizedTiming =
      typeof timing === 'number' ? { serverStartTime: timing } : timing;
    const initialRemainingMs = calculateInitialRemainingMs(
      totalSeconds,
      normalizedTiming,
      monotonicNow,
      Date.now(),
    );
    this.deadlineTimestamp = monotonicNow + initialRemainingMs;
    this.remainingTime = initialRemainingMs / 1000;
    this.lastSecond = Math.ceil(this.remainingTime);

    // 초기 상태 - 바를 현재 비율로 설정
    this.timerPrefab.setBarScale(this.ratio);
    this.updateBarColor();

    // setInterval 사용 (비활성 창에서도 동작)
    // Phaser의 time.addEvent는 비활성 창에서 throttle됨
    this.updateIntervalId = window.setInterval(() => {
      this.update();
    }, 16); // ~60fps

    console.log(
      `⏱️ 타이머 시작: ${totalSeconds}초 (초기 남은 시간: ${this.remainingTime.toFixed(1)}초)`,
    );
  }

  /** 콜백 지연과 무관하게 monotonic deadline에서 남은 시간을 계산합니다. */
  private update(): void {
    if (this.isFinished) return;

    this.remainingTime = calculateRemainingSeconds(
      this.deadlineTimestamp,
      performance.now(),
    );

    // 바 스케일 업데이트
    const ratio = this.ratio;
    this.timerPrefab.setBarScale(ratio);

    // 초 단위로 변화했을 때만 이벤트 발생 및 색상 변경
    const currentSecond = Math.ceil(this.remainingTime);
    if (currentSecond !== this.lastSecond) {
      this.lastSecond = currentSecond;
      this.scene.events.emit(TimerEvents.TICK, this.remainingTime);
      this.updateBarColor();
    }

    // 타이머 종료 체크
    if (this.remainingTime <= 0) {
      this.onTimerComplete();
    }
  }

  /** 타이머 바 색상 업데이트 */
  private updateBarColor(): void {
    const green = [63, 164, 37]; // #3fa425
    const yellow = [255, 204, 0]; // #ffcc00
    const red = [255, 51, 51]; // #ff3333
    let color: number[];

    if (this.ratio > 0.4) {
      // green → yellow (1 ~ 0.4)
      const t = (this.ratio - 0.4) / 0.6;
      color = lerpColor(green, yellow, 1 - t);
    } else {
      // yellow → red (0.4 ~ 0)
      const t = this.ratio / 0.4;
      color = lerpColor(yellow, red, 1 - t);
    }
    this.timerPrefab.getBar().fillColor = rgbToHex(color);
  }

  /** 타이머 완료 처리 */
  private onTimerComplete(): void {
    if (this.isFinished) return;

    this.finish();
    console.log('⏱️ 타이머 종료! 시간이 모두 소진되었습니다.');
  }

  /** 서버 종료 패킷을 받았을 때 UI를 즉시 0으로 고정합니다. */
  finish(): void {
    this.remainingTime = 0;
    this.isFinished = true;
    this.stop();
    this.timerPrefab.setBarScale(0);
    this.updateBarColor();
    this.scene.events.emit(TimerEvents.TICK, 0);
  }

  /** 타이머 정지 */
  stop(): void {
    if (this.updateIntervalId !== undefined) {
      window.clearInterval(this.updateIntervalId);
      this.updateIntervalId = undefined;
    }
  }

  /** 시스템 정리 */
  destroy(): void {
    this.stop();

    // Visibility change 리스너 제거
    if (this.visibilityChangeHandler) {
      document.removeEventListener(
        'visibilitychange',
        this.visibilityChangeHandler,
      );
      this.visibilityChangeHandler = undefined;
    }

    this.scene.events.off(Phaser.Scenes.Events.SHUTDOWN, this.destroy, this);
  }

  // Getters
  get remaining(): number {
    return this.remainingTime;
  }
  get total(): number {
    return this.totalTime;
  }
  get finished(): boolean {
    return this.isFinished;
  }
  get ratio(): number {
    return this.totalTime > 0 ? this.remainingTime / this.totalTime : 0;
  }
}
