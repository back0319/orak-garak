import { createServer, type Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import type { ServerPacket } from '@main-game/common';
import {
  handleClientPacket,
  handleConnection,
  handleDisconnect,
} from './network/serverHandler';

const DEFAULT_ORIGINS = [
  'https://orak-garak.vercel.app',
  'http://localhost:5173',
];

export function isAllowedOrigin(origin?: string): boolean {
  if (!origin) return true;

  const configured = (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  if ([...DEFAULT_ORIGINS, ...configured].includes(origin)) {
    return true;
  }

  return /^https:\/\/orak-garak(?:-[a-z0-9-]+)*\.vercel\.app$/.test(origin);
}

export interface GameServer {
  httpServer: HttpServer;
  io: Server;
}

export function createGameServer(): GameServer {
  const httpServer = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          ok: true,
          service: 'orak-garak-server',
          timestamp: new Date().toISOString(),
        }),
      );
      return;
    }

    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'not_found' }));
  });

  const io = new Server(httpServer, {
    cors: {
      origin(origin, callback) {
        callback(
          isAllowedOrigin(origin) ? null : new Error('origin_not_allowed'),
          isAllowedOrigin(origin),
        );
      },
      methods: ['GET', 'POST'],
    },
    transports: ['websocket'],
    maxHttpBufferSize: 16 * 1024,
  });

  io.on('connection', (socket: Socket) => {
    handleConnection(socket);
    const recentMessages: number[] = [];

    socket.onAny((eventName, data) => {
      const now = Date.now();
      while (recentMessages.length > 0 && recentMessages[0] < now - 1000) {
        recentMessages.shift();
      }

      if (recentMessages.length >= 120) {
        socket.emit('SYSTEM_MESSAGE', {
          message: '메시지 전송 속도가 너무 빠릅니다.',
        });
        socket.disconnect(true);
        return;
      }

      recentMessages.push(now);
      const packet = { type: eventName, ...data } as ServerPacket;
      handleClientPacket(io, socket, packet);
    });

    socket.on('disconnect', () => {
      handleDisconnect(socket.id);
    });
  });

  return { httpServer, io };
}

export async function startGameServer(
  port = Number(process.env.PORT) || 3000,
): Promise<GameServer> {
  const server = createGameServer();

  await new Promise<void>((resolve, reject) => {
    server.httpServer.once('error', reject);
    server.httpServer.listen(port, '0.0.0.0', () => {
      server.httpServer.off('error', reject);
      resolve();
    });
  });

  console.log(`Game server listening on port ${port}`);
  return server;
}

if (!process.env.VITEST) {
  void startGameServer().then((server) => {
    let closing = false;

    const shutdown = async (signal: string) => {
      if (closing) return;
      closing = true;
      console.log(`Received ${signal}, shutting down`);
      server.io.disconnectSockets(true);
      await new Promise<void>((resolve) =>
        server.httpServer.close(() => resolve()),
      );
      process.exit(0);
    };

    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
  });
}
