import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from '@main-game/common';
import type { Server, Socket } from 'socket.io';

export type GameSocketServer = Server<
  ClientToServerEvents,
  ServerToClientEvents
>;

export type GameSocket = Socket<ClientToServerEvents, ServerToClientEvents>;
