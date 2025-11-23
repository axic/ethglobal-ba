import "dotenv/config";
import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "crypto";
import {
  ClientCommand,
  ServerEvent,
  PlayerState,
  Room,
  ExitRef,
  WorldBuilderRoomInputContext,
  Inventory
} from "@ethglobal-ba/shared/src/types";
import { generateRoomsForExit } from "@ethglobal-ba/llm/src/worldBuilder";
import { generateNormieProfile } from "@ethglobal-ba/llm/src/normieProfile";

const PORT = Number(process.env.GAME_SERVER_PORT ?? 4000);
const NORMIE_ATTACK_RATING = 10;
const NORMIE_MIN_HEALTH = 15;
const NORMIE_MAX_HEALTH = 100;
const NORMIE_SPAWN_CHANCE = 0.35;
const MAX_NORMIES_PER_ROOM = 3;

interface ConnectionContext {
  socket: WebSocket;
  playerId: string;
}

const rooms = new Map<string, Room>();
const players = new Map<string, PlayerState>();
const connections = new Map<string, ConnectionContext>();
const npcs = new Map<string, PlayerState>();

function createEmptyInventory(): Inventory {
  return {
    weapon: null,
    armor: null,
    items: Array(20).fill(null)
  };
}

function describeWeaponSlot(inventory: Inventory): string {
  return inventory.weapon ?? "fist is equipped";
}

function describeArmorSlot(inventory: Inventory): string {
  return inventory.armor ?? "(empty)";
}

function formatInventory(inventory: Inventory): string {
  const equipped = [
    `Weapon slot: ${describeWeaponSlot(inventory)}`,
    `Armor slot: ${describeArmorSlot(inventory)}`
  ];

  const items = inventory.items.filter((item): item is string => item !== null);
  const freeSlots = inventory.items.length - items.length;

  const lines = [...equipped];

  if (items.length > 0) {
    lines.push("Items:");
    items.forEach((item, index) => {
      lines.push(`  ${index + 1}. ${item}`);
    });
  } else {
    lines.push("Items: (none)");
  }

  lines.push(`${freeSlots} slots free`);

  return lines.join("\n");
}

function formatStatus(player: PlayerState): string {
  return [
    `Name: ${player.name}`,
    `Health: ${player.health}`,
    `Attack rating: ${player.attackRating}`,
    `Creds: ${player.creds}`,
    `Weapon: ${describeWeaponSlot(player.inventory)}`,
    `Armor: ${describeArmorSlot(player.inventory)}`
  ].join("\n");
}

function formatStatusWithInventory(player: PlayerState): string {
  return [formatStatus(player), "", formatInventory(player.inventory)].join("\n");
}

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

function listNpcsInRoom(roomId: string): PlayerState[] {
  const result: PlayerState[] = [];
  for (const npc of npcs.values()) {
    if (npc.roomId === roomId) {
      result.push(npc);
    }
  }
  return result;
}

function listOtherActorsInRoom(roomId: string, excludePlayerId: string): PlayerState[] {
  const result: PlayerState[] = [];
  for (const player of players.values()) {
    if (player.roomId === roomId && player.id !== excludePlayerId) {
      result.push(player);
    }
  }
  return result.concat(listNpcsInRoom(roomId));
}

async function maybeSpawnNormie(room: Room): Promise<void> {
  const existingNormies = listNpcsInRoom(room.id);
  if (existingNormies.length >= MAX_NORMIES_PER_ROOM) return;
  if (Math.random() > NORMIE_SPAWN_CHANCE) return;

  const health = Math.floor(
    Math.random() * (NORMIE_MAX_HEALTH - NORMIE_MIN_HEALTH + 1) + NORMIE_MIN_HEALTH
  );
  const creds = Math.floor(Math.random() * 51);

  try {
    const profile = await generateNormieProfile(health);
    const npc: PlayerState = {
      id: `npc-${randomUUID()}`,
      name: profile.name,
      description: profile.description,
      health,
      attackRating: NORMIE_ATTACK_RATING,
      creds,
      isNpc: true,
      inventory: createEmptyInventory(),
      roomId: room.id,
      lastActiveAt: nowIso()
    };

    npcs.set(npc.id, npc);
    broadcastToRoom(room.id, {
      type: "system",
      ts: nowIso(),
      message: `A Normie named ${npc.name} appears. ${npc.description}`
    });
  } catch (err) {
    console.error("Failed to generate Normie profile:", err);
  }
}

function findNormieInRoom(roomId: string, name: string): PlayerState | undefined {
  const lower = name.toLowerCase();
  return listNpcsInRoom(roomId).find((npc) => npc.name.toLowerCase() === lower);
}

function handleAttack(player: PlayerState, room: Room, target: string): void {
  const npc = findNormieInRoom(room.id, target);

  if (!npc) {
    sendEvent(player.id, {
      type: "error",
      ts: nowIso(),
      message: `There is no Normie named ${target} here.`
    });
    return;
  }

  const damage = Math.max(0, player.attackRating);
  const attackerWeapon = player.inventory.weapon ?? "their fist";
  npc.health = Math.max(0, npc.health - damage);
  npc.lastActiveAt = nowIso();

  broadcastToRoom(room.id, {
    type: "system",
    ts: nowIso(),
    message: `${player.name} attacks ${npc.name} with ${attackerWeapon} for ${damage} damage. (${npc.health} hp left)`
  });

  if (npc.health <= 0) {
    const loot = npc.creds ?? 0;
    npcs.delete(npc.id);
    broadcastToRoom(room.id, {
      type: "system",
      ts: nowIso(),
      message: `${npc.name} is defeated and slinks away.`
    });
    if (loot > 0) {
      player.creds += loot;
      sendEvent(player.id, {
        type: "system",
        ts: nowIso(),
        message: `You collect ${loot} creds from ${npc.name}. You now have ${player.creds}.`
      });
    }
    return;
  }

  const retaliation = Math.max(0, npc.attackRating);
  const npcWeapon = npc.inventory.weapon ?? "their fist";
  player.health = Math.max(0, player.health - retaliation);
  player.lastActiveAt = nowIso();

  broadcastToRoom(room.id, {
    type: "system",
    ts: nowIso(),
    message: `${npc.name} strikes back with ${npcWeapon} for ${retaliation} damage! ${player.name} has ${player.health} hp.`
  });

  if (player.health <= 0) {
    sendEvent(player.id, {
      type: "system",
      ts: nowIso(),
      message: "You are overwhelmed and need a moment to recover."
    });
  }
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

  if (command.type === "status") {
    sendEvent(playerId, {
      type: "system",
      ts: nowIso(),
      message: formatStatusWithInventory(player)
    });
    return;
  }

  if (command.type === "look") {
    sendEvent(playerId, {
      type: "roomDescription",
      ts: nowIso(),
      room,
      otherPlayers: listOtherActorsInRoom(room.id, playerId)
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

  if (command.type === "attack") {
    const target = command.target.trim();
    if (!target) {
      sendEvent(playerId, {
        type: "error",
        ts: nowIso(),
        message: "Attack who? Try: attack <name>"
      });
      return;
    }

    handleAttack(player, room, target);
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

    await maybeSpawnNormie(targetRoom);

    const oldRoomId = player.roomId;
    player.roomId = targetRoom.id;

    sendEvent(playerId, {
      type: "roomDescription",
      ts: nowIso(),
      room: targetRoom,
      otherPlayers: listOtherActorsInRoom(targetRoom.id, playerId)
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
    if (parsed.type === "attack" && typeof parsed.target === "string") {
      return { type: "attack", target: parsed.target };
    }
    if (parsed.type === "status") {
      return { type: "status" };
    }
    if (parsed.type === "inventory") {
      return { type: "status" };
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
    health: 100,
    attackRating: 10,
    creds: 0,
    isNpc: false,
    inventory: createEmptyInventory(),
    roomId: hubRoom.id,
    lastActiveAt: nowIso()
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
