import { MockSocket } from './MockSocket';
import { socketManager, type GameClientSocket } from '../../network/socket';

/**
 * 환경 변수 기반 소켓 팩토리
 * Mock 모드와 실제 서버 모드를 자동으로 전환합니다.
 */

const USE_MOCK = import.meta.env.VITE_USE_MOCK_SERVER === 'true';

let mockSocketInstance: MockSocket | null = null;

/**
 * 소켓 인스턴스 가져오기 (싱글톤)
 * 실제 서버 모드에서는 socketManager의 소켓을 사용
 */
export function getSocket(): GameClientSocket | MockSocket {
  if (USE_MOCK) {
    if (!mockSocketInstance) {
      console.log('[SocketService] Mock 모드로 실행 중');
      mockSocketInstance = new MockSocket();
    }
    return mockSocketInstance;
  } else {
    // 실제 서버 모드: socketManager의 소켓 사용 (방에 참가한 소켓)
    return socketManager.getSocket();
  }
}

/**
 * 소켓 연결 해제
 */
export function disconnectSocket() {
  if (mockSocketInstance) {
    mockSocketInstance = null;
  }
  // 실제 서버 모드에서는 socketManager가 관리하므로 여기서는 처리하지 않음
}

/**
 * Mock 모드 여부 확인
 */
export function isMockMode(): boolean {
  return USE_MOCK;
}
