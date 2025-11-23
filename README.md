# ethglobal-ba -- Caverna

This is a simple for an LLM-powered text MUD / MMORPG.

## Structure

- `apps/game-client` — Simple text client.
- `apps/game-server` — Node WebSocket server with dynamic, LLM-generated rooms (in-memory for now).
- `packages/shared` — Shared TypeScript types and protocol.
- `packages/llm` — LLM wrapper for the world-builder.

## Getting Started

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create a `.env` file based on `.env.example`:

   ```bash
   cp .env.example .env
   ```

3. Run the game server in dev mode:

   ```bash
   npm run dev:game
   ```

4. Connect to the game server via a simple client:

   ```bash
   npm run dev:client
   ```
