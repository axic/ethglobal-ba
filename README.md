# ethglobal-ba — LLM MUD Initial Skeleton

This is a starter monorepo for an LLM-powered text MUD / MMORPG.

## Structure

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

4. Connect via WebSocket (for example using `wscat`):

   ```bash
   npx wscat -c ws://localhost:4000
   ```

5. Try commands:

   ```json
   {"type":"look"}
   {"type":"move","direction":"north"}
   {"type":"say","message":"Hello, world!"}
   {"type":"setName","name":"Alice"}
   ```
