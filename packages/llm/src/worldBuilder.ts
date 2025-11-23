import OpenAI from "openai";
import { z } from "zod";
import {
  WorldBuilderRoomInputContext,
  WorldBuilderResponse,
  WorldBuilderRoomOutput
} from "@ethglobal-ba/shared/src/types";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const ExitSchema = z.object({
  direction: z.string(),
  targetRoomId: z.string().nullable().default(null)
});

const RoomSchema = z.object({
  name: z.string(),
  description: z.string(),
  isHub: z.boolean().optional(),
  exits: z.array(ExitSchema)
});

const WorldBuilderResponseSchema = z.object({
  newRooms: z.array(RoomSchema)
});

export async function generateRoomsForExit(
  ctx: WorldBuilderRoomInputContext
): Promise<WorldBuilderResponse> {
  const systemPrompt = `
You are the World Builder for a text-based multiplayer dungeon.
You must return STRICT JSON matching the given schema. Do not include any explanation text.

Constraints:
- The new room must be thematically consistent with the current room.
- Never reference specific players by name.
- Keep room descriptions under ~160 words.
- Exits must be simple text directions like "north", "south", "east", "west", "up", "down".
  `.trim();

  const userPrompt = `
Current room:
- id: ${ctx.currentRoom.id}
- name: ${ctx.currentRoom.name}
- description: ${ctx.currentRoom.description}
- regionId: ${ctx.currentRoom.regionId}
- isHub: ${ctx.currentRoom.isHub}
- exits: ${ctx.currentRoom.exits
    .map((e) => `${e.direction} -> ${e.targetRoomId ?? "unknown"}`)
    .join(", ")}

The player is moving: ${ctx.direction}

Return JSON for 1-2 new rooms to place beyond that direction.
  `.trim();

  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ],
    temperature: 0.9,
    response_format: { type: "json_object" } as any
  });

  const raw = completion.choices[0].message.content ?? "{}";

  const parsed = WorldBuilderResponseSchema.parse(JSON.parse(raw));

  const result: WorldBuilderResponse = {
    newRooms: parsed.newRooms.map((r: any): WorldBuilderRoomOutput => ({
      name: r.name,
      description: r.description,
      isHub: r.isHub ?? false,
      exits: r.exits
    }))
  };

  return result;
}
