import type { GameRoom } from './network/gameRoom';

export { GameRoom } from './network/gameRoom';

export interface Env {
  GAME_ROOMS: DurableObjectNamespace<GameRoom>;
}

const ROOM_ID_PATTERN = /^[a-z0-9]{10}$/;
const ROOM_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

function createRoomId(): string {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  return Array.from(
    bytes,
    (value) => ROOM_ALPHABET[value % ROOM_ALPHABET.length],
  ).join('');
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/api/health') {
      return Response.json({
        ok: true,
        service: 'orak-garak',
        runtime: 'cloudflare-workers',
      });
    }

    if (request.method === 'POST' && url.pathname === '/api/rooms') {
      return Response.json({ roomId: createRoomId() }, { status: 201 });
    }

    const match = url.pathname.match(/^\/ws\/rooms\/([^/]+)$/);
    if (request.method === 'GET' && match) {
      const roomId = match[1];
      if (!ROOM_ID_PATTERN.test(roomId)) {
        return Response.json({ error: 'invalid_room_id' }, { status: 400 });
      }
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
        return Response.json(
          { error: 'websocket_upgrade_required' },
          { status: 426 },
        );
      }

      const origin = request.headers.get('Origin');
      if (origin) {
        try {
          if (new URL(origin).host !== url.host) {
            return Response.json(
              { error: 'origin_not_allowed' },
              { status: 403 },
            );
          }
        } catch {
          return Response.json(
            { error: 'origin_not_allowed' },
            { status: 403 },
          );
        }
      }

      return env.GAME_ROOMS.getByName(roomId).fetch(request);
    }

    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
