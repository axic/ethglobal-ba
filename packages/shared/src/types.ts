export type Direction = "north" | "south" | "east" | "west" | "up" | "down" | string;

export interface ExitRef {
  direction: Direction;
  targetRoomId: string | null;
}

export interface Room {
  id: string;
  name: string;
  description: string;
  regionId: string | null;
  isHub: boolean;
  exits: ExitRef[];
  createdAt: string;
}

export type NpcClass = "normie" | "vendor";

export interface VendorStockItem {
  name: string;
  type: "weapon" | "armor" | "item";
  quantity: number | "unlimited";
  attackRating?: number;
  cost?: number;
  description?: string;
}

export interface User {
  id: string;
  name: string;
  health: number;
  attackRating: number;
  isNpc: boolean;
  inventory: Inventory;
  creds: number;
  npcClass?: NpcClass;
  vendorStock?: VendorStockItem[];
  description?: string;
}

export interface Inventory {
  weapon: string | null;
  armor: string | null;
  items: (string | null)[];
}

export interface PlayerState extends User {
  roomId: string;
  lastActiveAt: string;
}

// Client → server

export type ClientCommand =
  | { type: "look" }
  | { type: "say"; message: string }
  | { type: "move"; direction: Direction }
  | { type: "setName"; name: string }
  | { type: "attack"; target: string }
  | { type: "status" }
  | { type: "talk"; target: string; action?: "list" | "buy" | "leave"; item?: string };

// Server → client

export type ServerEventType =
  | "welcome"
  | "roomDescription"
  | "chat"
  | "system"
  | "error";

export interface ServerEventBase {
  type: ServerEventType;
  ts: string;
}

export interface WelcomeEvent extends ServerEventBase {
  type: "welcome";
  player: PlayerState;
  room: Room;
}

export interface RoomDescriptionEvent extends ServerEventBase {
  type: "roomDescription";
  room: Room;
  otherPlayers: PlayerState[];
}

export interface ChatEvent extends ServerEventBase {
  type: "chat";
  fromPlayerId: string;
  fromName: string;
  roomId: string;
  message: string;
}

export interface SystemEvent extends ServerEventBase {
  type: "system";
  message: string;
}

export interface ErrorEvent extends ServerEventBase {
  type: "error";
  message: string;
}

export type ServerEvent =
  | WelcomeEvent
  | RoomDescriptionEvent
  | ChatEvent
  | SystemEvent
  | ErrorEvent;

// LLM world-builder interface

export interface WorldBuilderRoomInputContext {
  currentRoom: Room;
  direction: Direction;
}

export interface WorldBuilderRoomOutput {
  name: string;
  description: string;
  isHub?: boolean;
  exits: ExitRef[];
}

export interface WorldBuilderResponse {
  newRooms: WorldBuilderRoomOutput[];
}
