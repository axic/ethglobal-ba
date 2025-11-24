import "dotenv/config";
import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "crypto";
import { hasPaymentProof as hasX402PaymentProof, sendPaymentRequired } from "x402";
import {
  ClientCommand,
  ServerEvent,
  User,
  PlayerState,
  Room,
  ExitRef,
  WorldBuilderRoomInputContext,
  Inventory,
  VendorStockItem
} from "@ethglobal-ba/shared/src/types";
import { generateRoomsForExit } from "@ethglobal-ba/llm/src/worldBuilder";
import { generateNormieProfile } from "@ethglobal-ba/llm/src/normieProfile";

const PORT = Number(process.env.GAME_SERVER_PORT ?? 4000);
const HTTP_PORT = Number(process.env.GAME_HTTP_PORT ?? 3000);
const TOPUP_PRICE_USDC = 0.01;
const TOPUP_CREDITS = 100;
const NORMIE_ATTACK_RATING = 10;
const NORMIE_MIN_HEALTH = 15;
const NORMIE_MAX_HEALTH = 100;
const NORMIE_SPAWN_CHANCE = 0.35;
const MAX_NORMIES_PER_ROOM = 3;
const GAME_DAYS_PER_YEAR = 7;
const GAME_DAY_MS = 24 * 60 * 60 * 1000;

interface ConnectionContext {
  socket: WebSocket;
  playerId: string;
}

const rooms = new Map<string, Room>();
const players = new Map<string, PlayerState>();
const connections = new Map<string, ConnectionContext>();
const npcs = new Map<string, PlayerState>();
const WORLD_START_ISO = nowIso();

function getHttpBaseUrl(): string {
  const envBase = process.env.GAME_HTTP_BASE_URL;
  if (envBase) return envBase.replace(/\/$/, "");
  return `http://localhost:${HTTP_PORT}`;
}

function buildTopupUrl(playerId: string): string {
  return `${getHttpBaseUrl()}/x402/payments/${playerId}`;
}

const BROKEN_LEDGER: VendorStockItem = {
  name: "Broken Ledger",
  type: "weapon",
  quantity: "unlimited",
  attackRating: 20,
  cost: 20,
  description: "Ledger broken in half with sharp edges. Still holds the seed phrase."
};

const COFFEE: VendorStockItem = {
  name: "Coffee",
  type: "item",
  quantity: "unlimited",
  cost: 2,
  healAmount: 10,
  description: "A hot brew that restores 10 health when sipped."
};

const MONSTER: VendorStockItem = {
  name: "Monster",
  type: "item",
  quantity: "unlimited",
  cost: 1,
  healAmount: 4,
  description: "Sugary fizz that restores 4 health."
};

const MATE: VendorStockItem = {
  name: "Mate",
  type: "item",
  quantity: "unlimited",
  cost: 2,
  healAmount: 10,
  description: "Herbal energy that restores 10 health."
};

interface ItemDefinition {
  type: VendorStockItem["type"];
  attackRating?: number;
  healAmount?: number;
}

const ITEM_DEFINITIONS: Record<string, ItemDefinition> = {
  [BROKEN_LEDGER.name.toLowerCase()]: {
    type: BROKEN_LEDGER.type,
    attackRating: BROKEN_LEDGER.attackRating
  },
  [COFFEE.name.toLowerCase()]: {
    type: COFFEE.type,
    healAmount: COFFEE.healAmount
  },
  [MONSTER.name.toLowerCase()]: {
    type: MONSTER.type,
    healAmount: MONSTER.healAmount
  },
  [MATE.name.toLowerCase()]: {
    type: MATE.type,
    healAmount: MATE.healAmount
  }
};

const FIST_ATTACK_RATING = 10;
const PLAYER_MAX_HEALTH = 100;

function createEmptyInventory(): Inventory {
  return {
    weapon: "fist",
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
  const currentAge = getCurrentAge(player);
  const gameTime = formatGameTime();
  return [
    `Name: ${player.name}`,
    `Age: ${currentAge}`,
    `Creds: ${player.creds}`,
    `Health: ${player.health}`,
    `Attack rating: ${player.attackRating}`,
    `Weapon: ${describeWeaponSlot(player.inventory)}`,
    `Armor: ${describeArmorSlot(player.inventory)}`,
    `In-game time: ${gameTime}`
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

  const vault: Room = {
    id: "vault-1",
    name: "The Vault",
    description:
      "A silent chamber of reinforced walls and suspended particle dust. It feels abandoned, yet the air hums with dormant security protocols.",
    regionId: hub.regionId,
    isHub: false,
    exits: [{ direction: "down", targetRoomId: hub.id }],
    createdAt: new Date().toISOString()
  };

  hub.exits.push({ direction: "up", targetRoomId: vault.id });

  rooms.set(id, hub);
  rooms.set(vault.id, vault);
  return hub;
}

const hubRoom = createInitialWorld();

function spawnVendorChet(): void {
  const vendorInventory = createEmptyInventory();
  vendorInventory.weapon = BROKEN_LEDGER.name;

  const createdAt = nowIso();

  const vendor: PlayerState = {
    id: "npc-vendor-chet",
    name: "Chet",
    description:
      "A vendor hunched over a stack of cracked ledgers, ready to cut you up if you are not nice.",
    age: 18,
    creds: 0,
    health: 100,
    attackRating: BROKEN_LEDGER.attackRating ?? 20,
    isNpc: true,
    npcClass: "vendor",
    vendorStock: [BROKEN_LEDGER, COFFEE, MONSTER, MATE],
    bornAt: createdAt,
    inventory: vendorInventory,
    roomId: hubRoom.id,
    lastActiveAt: createdAt
  };

  npcs.set(vendor.id, vendor);
}

spawnVendorChet();

function nowIso(): string {
  return new Date().toISOString();
}

function gameTimeSince(timestamp: string): { years: number; days: number } {
  const elapsedMs = Date.now() - new Date(timestamp).getTime();
  const elapsedDays = Math.max(0, Math.floor(elapsedMs / GAME_DAY_MS));
  const years = Math.floor(elapsedDays / GAME_DAYS_PER_YEAR);
  const days = elapsedDays % GAME_DAYS_PER_YEAR;

  return { years, days };
}

function formatGameTime(): string {
  const { years, days } = gameTimeSince(WORLD_START_ISO);
  return `Year ${years + 1}, Day ${days + 1}`;
}

function getCurrentAge(user: User): number {
  const { years } = gameTimeSince(user.bornAt);
  return user.age + years;
}

function withCurrentAge<T extends User>(user: T): T {
  return { ...user, age: getCurrentAge(user) };
}

function withCurrentAges<T extends User>(users: T[]): T[] {
  return users.map((user) => withCurrentAge(user));
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

function findVendorInRoom(roomId: string, name: string): PlayerState | undefined {
  const lower = name.toLowerCase();
  return listNpcsInRoom(roomId).find(
    (npc) => npc.npcClass === "vendor" && npc.name.toLowerCase() === lower
  );
}

function formatVendorStock(stock: VendorStockItem[]): string {
  if (stock.length === 0) return "(Chet shrugs. Nothing for sale right now.)";

  const lines = stock.map((item) => {
    const qty = item.quantity === "unlimited" ? "unlimited" : `x${item.quantity}`;
    const attack = typeof item.attackRating === "number" ? `, atk ${item.attackRating}` : "";
    const heal = typeof item.healAmount === "number" ? `, heals ${item.healAmount}` : "";
    const cost = typeof item.cost === "number" ? `${item.cost} creds` : "free";
    const description = item.description ? ` — ${item.description}` : "";
    return `- ${item.name} (${item.type}, ${qty}${attack}${heal}) for ${cost}${description}`;
  });

  return ["Chet shows you his wares:", ...lines, "(Try: talk chet buy <item name> or talk chet leave)"]
    .filter(Boolean)
    .join("\n");
}

function addItemToInventory(inventory: Inventory, itemName: string): boolean {
  const slot = inventory.items.findIndex((item) => item === null);
  if (slot === -1) return false;
  inventory.items[slot] = itemName;
  return true;
}

function removeItemFromInventory(inventory: Inventory, itemName: string): string | null {
  const index = inventory.items.findIndex((item) => item?.toLowerCase() === itemName.toLowerCase());
  if (index === -1) return null;

  const found = inventory.items[index];
  inventory.items[index] = null;
  return found;
}

function identifyItem(
  itemName: string
): { type: VendorStockItem["type"]; attackRating?: number; healAmount?: number } | null {
  return ITEM_DEFINITIONS[itemName.toLowerCase()] ?? null;
}

function handleTalk(
  player: PlayerState,
  room: Room,
  target: string,
  action: Extract<ClientCommand, { type: "talk" }>["action"],
  itemName?: string
): void {
  const vendor = findVendorInRoom(room.id, target);

  if (!vendor || vendor.name.toLowerCase() !== "chet") {
    sendEvent(player.id, {
      type: "error",
      ts: nowIso(),
      message: `You don't see ${target} here to talk to. Only Chet seems interested in conversation.`,
    });
    return;
  }

  const stock = vendor.vendorStock ?? [];

  if (!action || action === "list") {
    sendEvent(player.id, {
      type: "system",
      ts: nowIso(),
      message: formatVendorStock(stock),
    });
    return;
  }

  if (action === "leave") {
    sendEvent(player.id, {
      type: "system",
      ts: nowIso(),
      message: "You nod to Chet and step away.",
    });
    return;
  }

  if (action === "buy") {
    if (!itemName) {
      sendEvent(player.id, {
        type: "error",
        ts: nowIso(),
        message: "Specify what to buy. Example: talk chet buy Broken Ledger",
      });
      return;
    }

    const desired = stock.find((item) => item.name.toLowerCase() === itemName.toLowerCase());

    if (!desired) {
      sendEvent(player.id, {
        type: "error",
        ts: nowIso(),
        message: `Chet doesn't carry ${itemName}. Try talk chet list.`,
      });
      return;
    }

    const cost = desired.cost ?? 0;

    if (player.creds < cost) {
      sendEvent(player.id, {
        type: "error",
        ts: nowIso(),
        message: `You need ${cost} creds to buy ${desired.name}, but you only have ${player.creds}.`,
      });
      return;
    }

    player.creds -= cost;
    vendor.creds += cost;

    if (!addItemToInventory(player.inventory, desired.name)) {
      player.creds += cost;
      vendor.creds -= cost;

      sendEvent(player.id, {
        type: "error",
        ts: nowIso(),
        message: "Your pack is full. Drop something before buying that.",
      });
      return;
    }

    sendEvent(player.id, {
      type: "system",
      ts: nowIso(),
      message: `You buy ${desired.name} from Chet for ${cost} creds and stash it in your pack.`,
    });
    return;
  }

  sendEvent(player.id, {
    type: "error",
    ts: nowIso(),
    message: "Chet tilts his head. Try list, buy, or leave.",
  });
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
  const age = Math.floor(Math.random() * 63) + 18;

  try {
    const profile = await generateNormieProfile(health);
    const createdAt = nowIso();
    const npc: PlayerState = {
      id: `npc-${randomUUID()}`,
      name: profile.name,
      description: profile.description,
      age,
      creds,
      health,
      attackRating: NORMIE_ATTACK_RATING,
      npcClass: "normie",
      isNpc: true,
      bornAt: createdAt,
      inventory: createEmptyInventory(),
      roomId: room.id,
      lastActiveAt: createdAt
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
  return listNpcsInRoom(roomId).find(
    (npc) => npc.npcClass === "normie" && npc.name.toLowerCase() === lower
  );
}

function handleAttack(player: PlayerState, room: Room, target: string): void {
  const lowerTarget = target.toLowerCase();
  const otherPlayer = listOtherActorsInRoom(room.id, player.id).find(
    (actor) => !actor.isNpc && actor.name.toLowerCase() === lowerTarget
  );

  if (otherPlayer) {
    sendEvent(player.id, {
      type: "system",
      ts: nowIso(),
      message: `You cannot attack the friendly ${otherPlayer.name}.`
    });
    return;
  }

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

  if (command.type === "topup") {
    const topupUrl = buildTopupUrl(playerId);
    sendEvent(playerId, {
      type: "system",
      ts: nowIso(),
      message:
        `Top up by sending a paid request to ${topupUrl}. ` +
        `Requests missing proof will respond with HTTP 402 showing the ${TOPUP_PRICE_USDC} USDC price for ${TOPUP_CREDITS} creds.`
    });
    return;
  }

  if (command.type === "equip") {
    const itemName = command.item.trim();

    if (!itemName) {
      sendEvent(playerId, {
        type: "error",
        ts: nowIso(),
        message: "Equip what? Try: equip <item name>"
      });
      return;
    }

    const foundItem = removeItemFromInventory(player.inventory, itemName);
    if (!foundItem) {
      sendEvent(playerId, {
        type: "error",
        ts: nowIso(),
        message: `${itemName} isn't in your inventory.`
      });
      return;
    }

    const definition = identifyItem(foundItem);
    if (!definition) {
      addItemToInventory(player.inventory, foundItem);
      sendEvent(playerId, {
        type: "error",
        ts: nowIso(),
        message: `You don't know how to equip ${foundItem}.`
      });
      return;
    }

    if (definition.type === "weapon") {
      const currentWeapon = player.inventory.weapon;
      if (currentWeapon && currentWeapon.toLowerCase() !== "fist") {
        if (!addItemToInventory(player.inventory, currentWeapon)) {
          addItemToInventory(player.inventory, foundItem);
          sendEvent(playerId, {
            type: "error",
            ts: nowIso(),
            message: "No space to stow your current weapon."
          });
          return;
        }
      }

      player.inventory.weapon = foundItem;
      player.attackRating = definition.attackRating ?? FIST_ATTACK_RATING;

      sendEvent(playerId, {
        type: "system",
        ts: nowIso(),
        message: `You equip ${foundItem} as your weapon.`
      });
      return;
    }

    if (definition.type === "armor") {
      const currentArmor = player.inventory.armor;
      if (currentArmor) {
        if (!addItemToInventory(player.inventory, currentArmor)) {
          addItemToInventory(player.inventory, foundItem);
          sendEvent(playerId, {
            type: "error",
            ts: nowIso(),
            message: "No space to stow your current armor."
          });
          return;
        }
      }

      player.inventory.armor = foundItem;
      sendEvent(playerId, {
        type: "system",
        ts: nowIso(),
        message: `You equip ${foundItem} as your armor.`
      });
      return;
    }

    if (definition.type === "item") {
      const healAmount = Math.max(0, definition.healAmount ?? 0);
      const previousHealth = player.health;
      player.health = Math.min(PLAYER_MAX_HEALTH, player.health + healAmount);
      const healedFor = player.health - previousHealth;

      sendEvent(playerId, {
        type: "system",
        ts: nowIso(),
        message:
          healedFor > 0
            ? `You consume ${foundItem} and recover ${healedFor} health. (${player.health} hp now)`
            : `You consume ${foundItem} but feel no different. (${player.health} hp)`
      });
      return;
    }

    addItemToInventory(player.inventory, foundItem);
    sendEvent(playerId, {
      type: "error",
      ts: nowIso(),
      message: `${foundItem} cannot be equipped.`
    });
    return;
  }

  if (command.type === "unequip") {
    const slot = command.slot ?? "weapon";

    if (slot === "weapon") {
      const equipped = player.inventory.weapon;

      if (!equipped || equipped.toLowerCase() === "fist") {
        player.inventory.weapon = "fist";
        player.attackRating = FIST_ATTACK_RATING;
        sendEvent(playerId, {
          type: "system",
          ts: nowIso(),
          message: "You ball up your fists, ready to swing."
        });
        return;
      }

      if (!addItemToInventory(player.inventory, equipped)) {
        sendEvent(playerId, {
          type: "error",
          ts: nowIso(),
          message: "No space in your pack to unequip that weapon."
        });
        return;
      }

      player.inventory.weapon = "fist";
      player.attackRating = FIST_ATTACK_RATING;

      sendEvent(playerId, {
        type: "system",
        ts: nowIso(),
        message: `You stow ${equipped} and rely on your fists.`
      });
      return;
    }

    if (slot === "armor") {
      const equipped = player.inventory.armor;

      if (!equipped) {
        sendEvent(playerId, {
          type: "system",
          ts: nowIso(),
          message: "You aren't wearing any armor."
        });
        return;
      }

      if (!addItemToInventory(player.inventory, equipped)) {
        sendEvent(playerId, {
          type: "error",
          ts: nowIso(),
          message: "No space in your pack to unequip that armor."
        });
        return;
      }

      player.inventory.armor = null;
      sendEvent(playerId, {
        type: "system",
        ts: nowIso(),
        message: `You remove ${equipped} and pack it away.`
      });
      return;
    }
  }

  if (command.type === "look") {
    sendEvent(playerId, {
      type: "roomDescription",
      ts: nowIso(),
      room,
      otherPlayers: withCurrentAges(listOtherActorsInRoom(room.id, playerId))
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

  if (command.type === "talk") {
    const target = command.target.trim();

    if (!target) {
      sendEvent(playerId, {
        type: "error",
        ts: nowIso(),
        message: "Talk to whom? Try: talk chet",
      });
      return;
    }

    handleTalk(player, room, target, command.action, command.item);
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
      otherPlayers: withCurrentAges(listOtherActorsInRoom(targetRoom.id, playerId))
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
    if (parsed.type === "topup") {
      return { type: "topup" };
    }
    if (parsed.type === "inventory") {
      return { type: "status" };
    }
    if (parsed.type === "equip" && typeof parsed.item === "string") {
      return { type: "equip", item: parsed.item };
    }
    if (
      parsed.type === "unequip" &&
      (parsed.slot === undefined || parsed.slot === "weapon" || parsed.slot === "armor")
    ) {
      return { type: "unequip", slot: parsed.slot };
    }
    if (parsed.type === "talk" && typeof parsed.target === "string") {
      const action =
        parsed.action === "list" || parsed.action === "buy" || parsed.action === "leave"
          ? parsed.action
          : undefined;
      return {
        type: "talk",
        target: parsed.target,
        action,
        item: typeof parsed.item === "string" ? parsed.item : undefined,
      };
    }
  } catch {
    return null;
  }
  return null;
}

function writeJson(
  res: http.ServerResponse,
  statusCode: number,
  body: Record<string, unknown>,
  headers: Record<string, string> = {}
): void {
  res.writeHead(statusCode, {
    "content-type": "application/json",
    ...headers
  });
  res.end(JSON.stringify(body));
}

function respondWith402(res: http.ServerResponse, player: PlayerState): void {
  sendPaymentRequired(res, {
    amount: TOPUP_PRICE_USDC,
    asset: "USDC",
    credits: TOPUP_CREDITS,
    reason: `Top up credits for ${player.name}`,
    message: `Send ${TOPUP_PRICE_USDC} USDC to top up ${TOPUP_CREDITS} creds for ${player.name}.`
  });
}

function handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (url.pathname === "/") {
    writeJson(res, 200, {
      status: "ok",
      message: "Caverna game server HTTP + X402 endpoint"
    });
    return;
  }

  if (url.pathname.startsWith("/x402/payments/")) {
    const playerId = url.pathname.split("/").pop() ?? "";
    const player = players.get(playerId);

    if (!player) {
      writeJson(res, 404, { error: "not_found", message: "Player not found" });
      return;
    }

    if (!hasX402PaymentProof(req)) {
      respondWith402(res, player);
      return;
    }

    player.creds += TOPUP_CREDITS;
    sendEvent(playerId, {
      type: "system",
      ts: nowIso(),
      message: `Payment received! ${TOPUP_CREDITS} creds added. Balance: ${player.creds}.`
    });

    writeJson(res, 200, {
      status: "ok",
      creditsAdded: TOPUP_CREDITS,
      balance: player.creds
    });
    return;
  }

  writeJson(res, 404, { error: "not_found", message: "Unknown path" });
}

const httpServer = http.createServer(handleHttpRequest);
httpServer.listen(HTTP_PORT, () => {
  console.log(`HTTP/X402 server listening on http://localhost:${HTTP_PORT}`);
});

const wss = new WebSocketServer({ port: PORT });

wss.on("connection", (socket: WebSocket) => {
  const playerId = `p-${randomUUID()}`;
  const createdAt = nowIso();
  const player: PlayerState = {
    id: playerId,
    name: `Wanderer-${playerId.slice(2, 6)}`,
    age: 18,
    health: 100,
    attackRating: 10,
    creds: 0,
    isNpc: false,
    bornAt: createdAt,
    inventory: createEmptyInventory(),
    roomId: hubRoom.id,
    lastActiveAt: createdAt
  };

  players.set(playerId, player);
  connections.set(playerId, { socket, playerId });

  const welcomeEvent: ServerEvent = {
    type: "welcome",
    ts: nowIso(),
    player: withCurrentAge(player),
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
