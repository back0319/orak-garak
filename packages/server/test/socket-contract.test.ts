import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  AppleGamePacketType,
  CLIENT_TO_SERVER_EVENT_NAMES,
  FlappyBirdPacketType,
  MineSweeperPacketType,
  SERVER_TO_CLIENT_EVENT_NAMES,
  SystemPacketType,
  fromServerSocketPayload,
  toSocketPayload,
  type ClientToServerEvents,
  type ClientToServerPacket,
  type ServerToClientEvents,
  type ServerToClientPacket,
  type SetTimePacket,
} from '@main-game/common';

describe('Socket.IO directional contract', () => {
  it('classifies every public event in exactly one direction', () => {
    const clientEvents = new Set<string>(CLIENT_TO_SERVER_EVENT_NAMES);
    const serverEvents = new Set<string>(SERVER_TO_CLIENT_EVENT_NAMES);
    const allDeclaredEvents = new Set<string>([
      ...Object.values(SystemPacketType),
      ...Object.values(AppleGamePacketType),
      ...Object.values(FlappyBirdPacketType),
      ...Object.values(MineSweeperPacketType),
    ]);

    expect(
      [...clientEvents].filter((eventName) => serverEvents.has(eventName)),
    ).toEqual([]);
    expect(new Set([...clientEvents, ...serverEvents])).toEqual(
      allDeclaredEvents,
    );
  });

  it('keeps the runtime event lists exhaustive with the packet unions', () => {
    expectTypeOf<(typeof CLIENT_TO_SERVER_EVENT_NAMES)[number]>().toEqualTypeOf<
      ClientToServerPacket['type']
    >();
    expectTypeOf<(typeof SERVER_TO_CLIENT_EVENT_NAMES)[number]>().toEqualTypeOf<
      ServerToClientPacket['type']
    >();
  });

  it('maps event names to payloads without a duplicated type field', () => {
    expectTypeOf<
      Parameters<ClientToServerEvents[SystemPacketType.JOIN_ROOM]>[0]
    >().toEqualTypeOf<{ roomId: string; playerName: string }>();
    expectTypeOf<
      Parameters<ServerToClientEvents[SystemPacketType.SET_TIME]>[0]
    >().toEqualTypeOf<Omit<SetTimePacket, 'type'>>();

    const packet: SetTimePacket = {
      type: SystemPacketType.SET_TIME,
      limitTime: 30,
      serverStartTime: 100,
      endsAt: 30_100,
      remainingMs: 30_000,
    };
    const payload = toSocketPayload(packet);

    expect(payload).toEqual({
      limitTime: 30,
      serverStartTime: 100,
      endsAt: 30_100,
      remainingMs: 30_000,
    });
    expect(fromServerSocketPayload(SystemPacketType.SET_TIME, payload)).toEqual(
      packet,
    );
  });
});
