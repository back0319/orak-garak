import type { GameClientPacket, GameConfig } from '@main-game/common';
import type { GameSocket } from '../../network/socketTypes';

export interface GameInstance {
  // Lifecycle
  initialize(config: GameConfig): void;
  start(): void;
  stop(): void;
  destroy(): void;

  // 게임별 클라이언트 패킷 처리
  handlePacket(
    socket: GameSocket,
    playerIndex: number,
    packet: GameClientPacket,
  ): void;
}
