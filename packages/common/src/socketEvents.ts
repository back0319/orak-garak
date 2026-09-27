import {
  AppleGamePacketType,
  FlappyBirdPacketType,
  MineSweeperPacketType,
  SystemPacketType,
  type ConfirmDragAreaPacket,
  type DrawingDragAreaPacket,
  type DropCellIndexPacket,
  type FlappyGameOverPacket,
  type FlappyGameStartAckPacket,
  type FlappyGameStartPacket,
  type FlappyJumpPacket,
  type FlappyReadyStatusPacket,
  type FlappyRequestSyncPacket,
  type FlappyScoreUpdatePacket,
  type FlappyStartCountdownPacket,
  type FlappySyncStatePacket,
  type FlappyWorldStatePacket,
  type GameConfigUpdatePacket,
  type GameConfigUpdateReqPacket,
  type GameStartReqPacket,
  type JoinRoomPacket,
  type LobbyChatErrorPacket,
  type LobbyChatHistoryPacket,
  type LobbyChatMessagePacket,
  type LobbyChatSendPacket,
  type ReadyScenePacket,
  type ReplayReqPacket,
  type ReturnToTheLobbyPacket,
  type ReturnToTheLobbyReqPacket,
  type RoomUpdatePacket,
  type SetFieldPacket,
  type SetTimePacket,
  type SystemMessagePacket,
  type TimeEndPacket,
  type UpdateDragAreaPacket,
  type UpdateNumberPacket,
  type UpdateScorePacket,
} from './packets';
import type {
  MSGameEndPacket,
  MSGameInitPacket,
  MSRemainingMinesPacket,
  MSRequestSyncPacket,
  MSRevealTilePacket,
  MSScoreUpdatePacket,
  MSTileUpdatePacket,
  MSToggleFlagPacket,
} from './minesweeperPackets';

export type ClientToServerPacket =
  | JoinRoomPacket
  | LobbyChatSendPacket
  | GameConfigUpdateReqPacket
  | GameStartReqPacket
  | ReturnToTheLobbyReqPacket
  | ReplayReqPacket
  | ConfirmDragAreaPacket
  | DrawingDragAreaPacket
  | FlappyJumpPacket
  | FlappyRequestSyncPacket
  | FlappyGameStartAckPacket
  | MSRevealTilePacket
  | MSToggleFlagPacket
  | MSRequestSyncPacket;

/** 방/로비 공통 패킷을 제외한, 진행 중인 게임 인스턴스가 처리하는 패킷 */
export type GameClientPacket = Exclude<
  ClientToServerPacket,
  { type: SystemPacketType }
>;

export type ServerToClientPacket =
  | UpdateNumberPacket
  | RoomUpdatePacket
  | SystemMessagePacket
  | LobbyChatMessagePacket
  | LobbyChatHistoryPacket
  | LobbyChatErrorPacket
  | GameConfigUpdatePacket
  | ReadyScenePacket
  | UpdateScorePacket
  | ReturnToTheLobbyPacket
  | SetTimePacket
  | TimeEndPacket
  | SetFieldPacket
  | UpdateDragAreaPacket
  | DropCellIndexPacket
  | FlappyWorldStatePacket
  | FlappyScoreUpdatePacket
  | FlappyGameOverPacket
  | FlappyReadyStatusPacket
  | FlappyStartCountdownPacket
  | FlappyGameStartPacket
  | FlappySyncStatePacket
  | MSGameInitPacket
  | MSTileUpdatePacket
  | MSScoreUpdatePacket
  | MSRemainingMinesPacket
  | MSGameEndPacket;

export type SocketPayload<Packet extends { type: string }> = Omit<
  Packet,
  'type'
>;

type PacketPayloadMap<Packet extends { type: string }> = {
  [CurrentPacket in Packet as CurrentPacket['type']]: SocketPayload<CurrentPacket>;
};

type SocketEventHandlers<PayloadMap> = {
  [EventName in keyof PayloadMap]: (payload: PayloadMap[EventName]) => void;
};

export type ClientToServerPayloads = PacketPayloadMap<ClientToServerPacket>;
export type ServerToClientPayloads = PacketPayloadMap<ServerToClientPacket>;
export type ClientToServerEvents = SocketEventHandlers<ClientToServerPayloads>;
export type ServerToClientEvents = SocketEventHandlers<ServerToClientPayloads>;

export type ClientToServerEventName = ClientToServerPacket['type'];
export type ServerToClientEventName = ServerToClientPacket['type'];

export const CLIENT_TO_SERVER_EVENT_NAMES = [
  SystemPacketType.JOIN_ROOM,
  SystemPacketType.LOBBY_CHAT_SEND,
  SystemPacketType.GAME_CONFIG_UPDATE_REQ,
  SystemPacketType.GAME_START_REQ,
  SystemPacketType.RETURN_TO_THE_LOBBY_REQ,
  SystemPacketType.REPLAY_REQ,
  AppleGamePacketType.CONFIRM_DRAG_AREA,
  AppleGamePacketType.DRAWING_DRAG_AREA,
  FlappyBirdPacketType.FLAPPY_JUMP,
  FlappyBirdPacketType.FLAPPY_REQUEST_SYNC,
  FlappyBirdPacketType.FLAPPY_GAME_START_ACK,
  MineSweeperPacketType.MS_REVEAL_TILE,
  MineSweeperPacketType.MS_TOGGLE_FLAG,
  MineSweeperPacketType.MS_REQUEST_SYNC,
] as const satisfies readonly ClientToServerEventName[];

export const SERVER_TO_CLIENT_EVENT_NAMES = [
  SystemPacketType.UPDATE_NUMBER,
  SystemPacketType.ROOM_UPDATE,
  SystemPacketType.SYSTEM_MESSAGE,
  SystemPacketType.LOBBY_CHAT_MESSAGE,
  SystemPacketType.LOBBY_CHAT_HISTORY,
  SystemPacketType.LOBBY_CHAT_ERROR,
  SystemPacketType.GAME_CONFIG_UPDATE,
  SystemPacketType.READY_SCENE,
  SystemPacketType.UPDATE_SCORE,
  SystemPacketType.RETURN_TO_THE_LOBBY,
  SystemPacketType.SET_TIME,
  SystemPacketType.TIME_END,
  AppleGamePacketType.SET_FIELD,
  AppleGamePacketType.UPDATE_DRAG_AREA,
  AppleGamePacketType.DROP_CELL_INDEX,
  FlappyBirdPacketType.FLAPPY_WORLD_STATE,
  FlappyBirdPacketType.FLAPPY_SCORE_UPDATE,
  FlappyBirdPacketType.FLAPPY_GAME_OVER,
  FlappyBirdPacketType.FLAPPY_READY_STATUS,
  FlappyBirdPacketType.FLAPPY_START_COUNTDOWN,
  FlappyBirdPacketType.FLAPPY_GAME_START,
  FlappyBirdPacketType.FLAPPY_SYNC_STATE,
  MineSweeperPacketType.MS_GAME_INIT,
  MineSweeperPacketType.MS_TILE_UPDATE,
  MineSweeperPacketType.MS_SCORE_UPDATE,
  MineSweeperPacketType.MS_REMAINING_MINES,
  MineSweeperPacketType.MS_GAME_END,
] as const satisfies readonly ServerToClientEventName[];

export function toSocketPayload<Packet extends { type: string }>(
  packet: Packet,
): SocketPayload<Packet> {
  const { type: _type, ...payload } = packet;
  return payload;
}

export function fromClientSocketPayload<
  EventName extends ClientToServerEventName,
>(
  eventName: EventName,
  payload: ClientToServerPayloads[EventName],
): Extract<ClientToServerPacket, { type: EventName }> {
  return { ...payload, type: eventName } as unknown as Extract<
    ClientToServerPacket,
    { type: EventName }
  >;
}

export function fromServerSocketPayload<
  EventName extends ServerToClientEventName,
>(
  eventName: EventName,
  payload: ServerToClientPayloads[EventName],
): Extract<ServerToClientPacket, { type: EventName }> {
  return { ...payload, type: eventName } as unknown as Extract<
    ServerToClientPacket,
    { type: EventName }
  >;
}

export function isClientToServerEventName(
  eventName: string,
): eventName is ClientToServerEventName {
  return (CLIENT_TO_SERVER_EVENT_NAMES as readonly string[]).includes(
    eventName,
  );
}

export function isServerToClientEventName(
  eventName: string,
): eventName is ServerToClientEventName {
  return (SERVER_TO_CLIENT_EVENT_NAMES as readonly string[]).includes(
    eventName,
  );
}
