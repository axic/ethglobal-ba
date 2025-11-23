import "dotenv/config";
import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "crypto";
import {
  ClientCommand,
  ServerEvent,
  PlayerState,
  Room,
  ExitRef,
  WorldBuilderRoomInputContext
} from "@ethglobal-ba/shared/src/types";
import { generateRoomsForExit } from "@ethglobal-ba/llm/src/worldBuilder";

const PORT = Number(process.env.GAME_SERVER_PORT ?? 4000);

interface ConnectionContext {
  socket: WebSocket;
  playerId: string;
}

const rooms = new Map<string, Room>();
const players = new Map<string, PlayerState>();
const connections = new Map<string, ConnectionContext>();

function createInitialWorld(): Room {
  const id = "hub-1";
  const hub: Room = {
    id,
    name: "Central Nexus",
    description:
      "A circular plaza of shifting stone and faint holographic sigils. Paths radiate in all directions, pulsing softly with potential.",
    regionId: "region-1",
    isHub: true,
    exits: [
      { direction: "north", targetRoomId: null },
      { direction: "east", targetRoomId: null }
    ],
    createdAt: new Date().toISOString()
  };

  rooms.set(id, hub);
  return hub;
}

const hubRoom = createInitialWorld();

function nowIso(): string {
  return new Date().toISOString();
}

function sendEvent(playerId: string, event: ServerEvent) {
  const ctx = connections.get(playerId);
  if (!ctx) return;
  ctx.socket.send(JSON.stringify(event));
}

function broadcastToRoom(roomId: string, event: ServerEvent) {
  for (const [playerId, player] of players) {
    if (player.roomId === roomId) {
      sendEvent(playerId, event);
    }
  }
}

function listOtherPlayersInRoom(roomId: string, excludePlayerId: string): PlayerState[] {
  const result: PlayerState[] = [];
  for (const player of players.values()) {
    if (player.roomId === roomId && player.id !== excludePlayerId) {
      result.push(player);
    }
  }
  return result;
}

async function handleCommand(playerId: string, command: ClientCommand): Promise<void> {
  const player = players.get(playerId);
  if (!player) return;

  player.lastActiveAt = nowIso();
  const room = rooms.get(player.roomId);
  if (!room) return;

  if (command.type === "setName") {
    player.name = command.name.slice(0, 32);
    sendEvent(playerId, {
      type: "system",
      ts: nowIso(),
      message: `You are now known as ${player.name}.`
    });
    return;
  }

  if (command.type === "look") {
    sendEvent(playerId, {
      type: "roomDescription",
      ts: nowIso(),
      room,
      otherPlayers: listOtherPlayersInRoom(room.id, playerId)
    });
    return;
  }

  if (command.type === "say") {
    const msg = command.message.trim().slice(0, 512);
    if (!msg) return;

    const chatEvent = {
      type: "chat" as const,
      ts: nowIso(),
      fromPlayerId: player.id,
      fromName: player.name,
      roomId: room.id,
      message: msg
    };
    broadcastToRoom(room.id, chatEvent);
    return;
  }

  if (command.type === "move") {
    const direction = command.direction;
    let exit = room.exits.find((e) => e.direction === direction);

    if (!exit || exit.targetRoomId === null) {
      const ctx: WorldBuilderRoomInputContext = {
        currentRoom: room,
        direction
      };

      try {
        const llmResult = await generateRoomsForExit(ctx);

        const first = llmResult.newRooms[0];
        if (!first) {
          sendEvent(playerId, {
            type: "error",
            ts: nowIso(),
            message: "The path seems unstable and cannot be traversed right now."
          });
          return;
        }

        const newRoomId = `room-${randomUUID()}`;
        const newRoom: Room = {
          id: newRoomId,
          name: first.name,
          description: first.description,
          isHub: !!first.isHub,
          regionId: room.regionId,
          exits: first.exits.map<ExitRef>((e) => ({
            direction: e.direction,
            targetRoomId: e.targetRoomId
          })),
          createdAt: nowIso()
        };

        rooms.set(newRoomId, newRoom);

        if (!exit) {
          exit = { direction, targetRoomId: newRoomId };
          room.exits.push(exit);
        } else {
          exit.targetRoomId = newRoomId;
        }
      } catch (err) {
        console.error("LLM world builder error:", err);
        sendEvent(playerId, {
          type: "error",
          ts: nowIso(),
          message: "The path shimmers and collapses. Try again later."
        });
        return;
      }
    }

    if (!exit.targetRoomId) {
      sendEvent(playerId, {
        type: "error",
        ts: nowIso(),
        message: "The way forward is blocked by an invisible force."
      });
      return;
    }

    const targetRoom = rooms.get(exit.targetRoomId);
    if (!targetRoom) {
      sendEvent(playerId, {
        type: "error",
        ts: nowIso(),
        message: "You feel reality glitch and snap back. The exit goes nowhere."
      });
      return;
    }

    const oldRoomId = player.roomId;
    player.roomId = targetRoom.id;

    sendEvent(playerId, {
      type: "roomDescription",
      ts: nowIso(),
      room: targetRoom,
      otherPlayers: listOtherPlayersInRoom(targetRoom.id, playerId)
    });

    broadcastToRoom(oldRoomId, {
      type: "system",
      ts: nowIso(),
      message: `${player.name} leaves ${command.direction}.`
    });
    broadcastToRoom(targetRoom.id, {
      type: "system",
      ts: nowIso(),
      message: `${player.name} arrives from ${command.direction}.`
    });
  }
}

function parseClientCommand(raw: string): ClientCommand | null {
  try {
    const parsed = JSON.parse(raw);

    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.type === "look") return { type: "look" };
    if (parsed.type === "say" && typeof parsed.message === "string") {
      return { type: "say", message: parsed.message };
    }
    if (parsed.type === "move" && typeof parsed.direction === "string") {
      return { type: "move", direction: parsed.direction };
    }
    if (parsed.type === "setName" && typeof parsed.name === "string") {
      return { type: "setName", name: parsed.name };
    }
  } catch {
    return null;
  }
  return null;
}

const wss = new WebSocketServer({ port: PORT });

wss.on("connection", (socket: WebSocket) => {
  const playerId = `p-${randomUUID()}`;
  const player: PlayerState = {
    id: playerId,
    name: `Wanderer-${playerId.slice(2, 6)}`,
    roomId: hubRoom.id,
    lastActiveAt: nowIso(),
    isBot: false
  };

  players.set(playerId, player);
  connections.set(playerId, { socket, playerId });

  const welcomeEvent: ServerEvent = {
    type: "welcome",
    ts: nowIso(),
    player,
    room: hubRoom
  };
  sendEvent(playerId, welcomeEvent);

  broadcastToRoom(hubRoom.id, {
    type: "system",
    ts: nowIso(),
    message: `${player.name} fades into view.`
  });

  socket.on("message", (data: Buffer) => {
    const text = data.toString("utf8");
    const cmd = parseClientCommand(text);
    if (!cmd) {
      sendEvent(playerId, {
        type: "error",
        ts: nowIso(),
        message: "Malformed command."
      });
      return;
    }
    void handleCommand(playerId, cmd);
  });

  socket.on("close", () => {
    const p = players.get(playerId);
    players.delete(playerId);
    connections.delete(playerId);

    if (p) {
      broadcastToRoom(p.roomId, {
        type: "system",
        ts: nowIso(),
        message: `${p.name} dissolves into static.`
      });
    }
  });
});

console.log(`Game server listening on ws://localhost:${PORT}`);
