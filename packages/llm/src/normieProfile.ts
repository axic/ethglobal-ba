import OpenAI from "openai";
import { z } from "zod";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const NormieProfileSchema = z.object({
  name: z.string(),
  description: z.string()
});

export async function generateNormieProfile(health: number): Promise<{
  name: string;
  description: string;
}> {
  const systemPrompt = `
You name and describe Normie NPCs for a multiplayer text game.
Return STRICT JSON with fields: name (a short, everyday human name, use names from multiple languages) and description (one short sentence about their lifestyle that matches how healthy they are).
Mention the name in the description. Keep it under 25 words.
  `.trim();

  const userPrompt = `
Health scale is 10 (very unhealthy) to 100 (peak fitness).
Provided health: ${health}.
Examples:
- 10 -> "John likes to Netflix and chill and only eats burgers."
- 50 -> "John is a regular joe."
- 100 -> "John is a fitness addict and raw vegan."
Return JSON only.
  `.trim();

  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ],
    temperature: 0.7,
    response_format: { type: "json_object" } as any
  });

  const raw = completion.choices[0].message.content ?? "{}";
  const parsed = NormieProfileSchema.parse(JSON.parse(raw));

  return parsed;
}
