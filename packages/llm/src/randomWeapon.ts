import OpenAI from "openai";
import { z } from "zod";
import { VendorStockItem } from "@ethglobal-ba/shared/src/types";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const GeneratedWeaponSchema = z.object({
  name: z.string(),
  description: z.string(),
  attackRating: z
    .number()
    .int()
    .min(1)
    .max(100),
  cost: z.number().int().min(2)
});

export type GeneratedWeapon = z.infer<typeof GeneratedWeaponSchema>;

export async function generateRandomWeapon(): Promise<VendorStockItem> {
  const systemPrompt = `You invent a single, strange but evocative weapon for a text adventure. Return STRICT JSON. Do not add extra text.`;

  const userPrompt = `Return a JSON object with these keys:
- name: a unique, ominous-sounding weapon name (3-8 words max)
- description: 1-2 sentences describing the weapon's vibe and oddity
- attackRating: an integer between 1 and 100 (inclusive), randomized
- cost: MUST equal attackRating * 2, nothing else
`;

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
  const parsed = GeneratedWeaponSchema.parse(JSON.parse(raw));
  const normalizedCost = parsed.attackRating * 2;

  return {
    name: parsed.name,
    description: parsed.description,
    attackRating: parsed.attackRating,
    cost: normalizedCost,
    quantity: 1,
    type: "weapon"
  };
}
