export interface PacketEmitter {
  emit(event: string, data: unknown): void;
}

export interface GameSocket extends PacketEmitter {
  readonly id: string;
  to(roomId: string): PacketEmitter;
  disconnect(): void;
}

export interface GameTransport {
  readonly sockets: {
    sockets: Map<string, GameSocket>;
  };
  to(roomId: string): PacketEmitter;
  scheduleAlarm(timestamp: number): Promise<void>;
  clearAlarm(): Promise<void>;
}
