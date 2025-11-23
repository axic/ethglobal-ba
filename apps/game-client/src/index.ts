import "dotenv/config";
import WebSocket, { RawData } from "ws";
import readline from "node:readline";
import {
  ClientCommand,
  Direction,
  PlayerState,
  Room,
  ServerEvent,
  WelcomeEvent,
  RoomDescriptionEvent
} from "@ethglobal-ba/shared/src/types";

const SERVER_URL = process.env.GAME_SERVER_URL ?? "ws://localhost:4000";

interface ClientState {
  player: PlayerState | null;
  room: Room | null;
}

const state: ClientState = {
  player: null,
  room: null
};

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "> "
});

function formatExits(exits: Direction[]): string {
  if (exits.length === 0) return "(no obvious exits)";
  return exits.join(", ");
}

function renderRoom(event: WelcomeEvent | RoomDescriptionEvent): void {
  state.room = event.room;
  const otherPlayers = "otherPlayers" in event ? event.otherPlayers : [];

  console.log("\n=== %s ===", event.room.name);
  console.log(event.room.description);

  if (otherPlayers && otherPlayers.length > 0) {
    const names = otherPlayers
      .map((p) => {
        if (p.isNpc) {
          const desc = p.description ? ` - ${p.description}` : "";
          return `${p.name} (Normie, HP ${p.health})${desc ? `: ${desc}` : ""}`;
        }
        return p.name;
      })
      .join("; ");
    console.log("You see: %s", names);
  }

  const exits = event.room.exits.map((exit) => exit.direction);
  console.log("Exits: %s", formatExits(exits));
  console.log("");
}

function handleEvent(event: ServerEvent): void {
  switch (event.type) {
    case "welcome": {
      state.player = event.player;
      console.log("Connected to %s", SERVER_URL);
      console.log("You are %s (%s).", event.player.name, event.player.id);
      renderRoom(event);
      break;
    }
    case "roomDescription": {
      renderRoom(event);
      break;
    }
    case "chat": {
      const sender =
        state.player && event.fromPlayerId === state.player.id ? "You" : event.fromName;
      console.log(`[${sender}] ${event.message}`);
      break;
    }
    case "system": {
      console.log(`* ${event.message}`);
      break;
    }
    case "error": {
      console.error(`! ${event.message}`);
      break;
    }
  }
}

function sendCommand(ws: WebSocket, command: ClientCommand): void {
  ws.send(JSON.stringify(command));
}

function printHelp(): void {
  console.log("Commands:");
  console.log("  look                Describe your surroundings");
  console.log("  say <message>       Speak to others in the room");
  console.log("  move <direction>    Move north/south/east/west/up/down");
  console.log("  attack <name>       Attack a Normie in the room");
  console.log("  status              Show your stats and inventory");
  console.log("  name <new name>     Change your display name");
  console.log("  help                Show this help text");
  console.log("  quit                Exit the client");
  console.log("");
}

function interpretInput(line: string, ws: WebSocket): void {
  const [cmd, ...rest] = line.trim().split(/\s+/);

  if (!cmd) return;

  const lower = cmd.toLowerCase();
  const arg = rest.join(" ");

  if (lower === "help" || lower === "h" || lower === "?" || lower === "/help") {
    printHelp();
    return;
  }

  if (lower === "quit" || lower === "exit") {
    console.log("Disconnecting...");
    ws.close();
    rl.close();
    return;
  }

  if (lower === "look") {
    sendCommand(ws, { type: "look" });
    return;
  }

  if (lower === "say") {
    if (!arg) {
      console.log("Usage: say <message>");
      return;
    }
    sendCommand(ws, { type: "say", message: arg });
    return;
  }

  if (lower === "move") {
    if (!arg) {
      console.log("Usage: move <direction>");
      return;
    }
    sendCommand(ws, { type: "move", direction: arg });
    return;
  }

  if (lower === "status") {
    sendCommand(ws, { type: "status" });
    return;
  }

  if (lower === "inventory") {
    sendCommand(ws, { type: "status" });
    return;
  }

  if (lower === "attack") {
    if (!arg) {
      console.log("Usage: attack <name>");
      return;
    }
    sendCommand(ws, { type: "attack", target: arg });
    return;
  }

  if (lower === "name") {
    if (!arg) {
      console.log("Usage: name <new name>");
      return;
    }
    sendCommand(ws, { type: "setName", name: arg });
    return;
  }

  // Fallbacks: single-word directions or plain chat.
  const directions: Direction[] = ["north", "south", "east", "west", "up", "down"];
  if (directions.includes(lower)) {
    sendCommand(ws, { type: "move", direction: lower });
    return;
  }

  sendCommand(ws, { type: "say", message: line.trim() });
}

function start(): void {
  console.log(`Connecting to ${SERVER_URL}...`);
  const ws = new WebSocket(SERVER_URL);

  ws.on("open", () => {
    printHelp();
    rl.prompt();
  });

  ws.on("message", (data: RawData) => {
    try {
      const event = JSON.parse(data.toString("utf8")) as ServerEvent;
      handleEvent(event);
    } catch (err) {
      console.error("Failed to parse server message", err);
    } finally {
      rl.prompt();
    }
  });

  ws.on("close", () => {
    console.log("Connection closed. Bye!");
    rl.close();
  });

  ws.on("error", (err: Error) => {
    console.error("Connection error:", err.message);
  });

  rl.on("line", (line) => {
    if (ws.readyState !== WebSocket.OPEN) {
      console.log("Not connected yet. Please wait...");
      rl.prompt();
      return;
    }

    interpretInput(line, ws);
    rl.prompt();
  });

  rl.on("SIGINT", () => {
    console.log("\nCaught interrupt. Closing...");
    ws.close();
    rl.close();
  });
}

start();
