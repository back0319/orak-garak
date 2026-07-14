import {
  FlappyBirdPacketType,
  SystemPacketType,
  type JoinAcceptedPacket,
  type JoinRoomPacket,
  type ServerPacket,
} from '../../../common/src';
import { handleServerPacket } from './clientHandler';
import { useGameStore } from '../store/gameStore';

type EventCallback = (data: any) => void;

export interface GameClientSocket {
  on(event: string, callback: EventCallback): this;
  off(event: string, callback?: EventCallback): this;
  emit(event: string, data?: unknown): boolean;
}

class NativeSocketAdapter implements GameClientSocket {
  private readonly listeners = new Map<string, Set<EventCallback>>();

  constructor(private readonly manager: SocketManager) {}

  on(event: string, callback: EventCallback): this {
    const callbacks = this.listeners.get(event) ?? new Set<EventCallback>();
    callbacks.add(callback);
    this.listeners.set(event, callbacks);
    return this;
  }

  off(event: string, callback?: EventCallback): this {
    if (!callback) {
      this.listeners.delete(event);
      return this;
    }
    this.listeners.get(event)?.delete(callback);
    return this;
  }

  emit(event: string, data?: unknown): boolean {
    const payload = data && typeof data === 'object' ? data : {};
    this.manager.send({ type: event, ...payload } as ServerPacket);
    return true;
  }

  dispatch(event: string, data: unknown): void {
    for (const callback of this.listeners.get(event) ?? []) callback(data);
  }
}

interface RoomCredentials {
  playerId: string;
  resumeToken: string;
}

class SocketManager {
  private socket: WebSocket | null = null;
  private roomId = '';
  private playerName = '';
  private intentionallyClosed = false;
  private reconnectStartedAt = 0;
  private reconnectAttempt = 0;
  private reconnectTimer: number | null = null;
  private joinResolve: (() => void) | null = null;
  private joinReject: ((error: Error) => void) | null = null;
  private readonly adapter = new NativeSocketAdapter(this);

  async joinRoom(roomId: string, playerName: string): Promise<string> {
    const normalizedName = playerName.replace(/\s/g, '').slice(0, 8);
    if (!normalizedName) throw new Error('닉네임은 1자 이상이어야 합니다.');

    this.disconnect(false);
    this.intentionallyClosed = false;
    this.playerName = normalizedName;
    this.roomId = roomId || (await this.createRoom());
    this.reconnectStartedAt = Date.now();
    this.reconnectAttempt = 0;

    await new Promise<void>((resolve, reject) => {
      this.joinResolve = resolve;
      this.joinReject = reject;
      this.openSocket();
    });
    return this.roomId;
  }

  send(packet: ServerPacket): void {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      console.warn(
        '[SocketManager] WebSocket이 연결되지 않아 패킷을 보낼 수 없습니다.',
      );
      return;
    }
    this.socket.send(JSON.stringify(packet));
  }

  disconnect(clearRoom = true): void {
    this.intentionallyClosed = true;
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close(1000, 'Client disconnect');
    this.socket = null;
    if (clearRoom) {
      this.roomId = '';
      this.playerName = '';
    }
  }

  getId(): string | null {
    return this.readCredentials()?.playerId ?? null;
  }

  getSocket(): GameClientSocket {
    return this.adapter;
  }

  private async createRoom(): Promise<string> {
    const response = await fetch('/api/rooms', { method: 'POST' });
    if (!response.ok) throw new Error('방을 만들지 못했습니다.');
    const body = (await response.json()) as { roomId?: string };
    if (!body.roomId) throw new Error('서버가 방 ID를 반환하지 않았습니다.');
    return body.roomId;
  }

  private openSocket(): void {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(
      `${protocol}//${window.location.host}/ws/rooms/${this.roomId}`,
    );
    this.socket = socket;

    socket.addEventListener('open', () => {
      const credentials = this.readCredentials();
      const joinPacket: JoinRoomPacket = {
        type: SystemPacketType.JOIN_ROOM,
        roomId: this.roomId,
        playerName: this.playerName,
        ...credentials,
      };
      socket.send(JSON.stringify(joinPacket));
    });

    socket.addEventListener('message', (event) => {
      let packet: ServerPacket;
      try {
        packet = JSON.parse(String(event.data)) as ServerPacket;
      } catch {
        console.warn('[SocketManager] JSON이 아닌 서버 메시지를 무시했습니다.');
        return;
      }

      if (packet.type === SystemPacketType.JOIN_ACCEPTED) {
        this.acceptJoin(packet as JoinAcceptedPacket);
      } else if (
        packet.type === SystemPacketType.SYSTEM_MESSAGE &&
        this.joinReject
      ) {
        this.joinReject(new Error(packet.message));
        this.clearJoinPromise();
        this.intentionallyClosed = true;
        socket.close(1008, 'Join rejected');
      }

      const { type, ...payload } = packet;
      this.adapter.dispatch(type, payload);
      if (type === FlappyBirdPacketType.FLAPPY_WORLD_STATE) {
        this.adapter.dispatch('update_positions', payload);
      } else if (type === FlappyBirdPacketType.FLAPPY_SCORE_UPDATE) {
        this.adapter.dispatch('score_update', payload);
      } else if (type === FlappyBirdPacketType.FLAPPY_GAME_OVER) {
        this.adapter.dispatch('game_over', payload);
      }
      handleServerPacket(packet);
    });

    socket.addEventListener('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (!this.intentionallyClosed) this.scheduleReconnect();
    });

    socket.addEventListener('error', () => socket.close());
  }

  private acceptJoin(packet: JoinAcceptedPacket): void {
    sessionStorage.setItem(
      this.credentialsKey(),
      JSON.stringify({
        playerId: packet.playerId,
        resumeToken: packet.resumeToken,
      }),
    );
    this.reconnectAttempt = 0;
    this.reconnectStartedAt = 0;
    this.joinResolve?.();
    this.clearJoinPromise();
  }

  private scheduleReconnect(): void {
    if (this.reconnectStartedAt === 0) this.reconnectStartedAt = Date.now();
    const elapsed = Date.now() - this.reconnectStartedAt;
    if (!this.roomId || elapsed >= 15_000) {
      this.joinReject?.(new Error('서버 연결에 실패했습니다.'));
      this.clearJoinPromise();
      const store = useGameStore.getState();
      store.setConnectionError({
        message: '15초 안에 재접속하지 못해 첫 화면으로 돌아왔습니다.',
      });
      store.setScreen('landing');
      return;
    }

    const delay = Math.min(500 * 2 ** this.reconnectAttempt, 4_000);
    this.reconnectAttempt += 1;
    this.reconnectTimer = window.setTimeout(() => this.openSocket(), delay);
  }

  private credentialsKey(): string {
    return `orak-garak:room:${this.roomId}`;
  }

  private readCredentials(): RoomCredentials | undefined {
    if (!this.roomId) return undefined;
    try {
      const stored = sessionStorage.getItem(this.credentialsKey());
      return stored ? (JSON.parse(stored) as RoomCredentials) : undefined;
    } catch {
      return undefined;
    }
  }

  private clearJoinPromise(): void {
    this.joinResolve = null;
    this.joinReject = null;
  }
}

export const socketManager = new SocketManager();
