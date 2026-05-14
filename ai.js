import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function isBirthdayWish(text) {
  const schema = {
    name: "birthday_check",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        is_birthday_wish: { type: "boolean" },
        confidence: { type: "number", minimum: 0, maximum: 1 }
      },
      required: ["is_birthday_wish", "confidence"]
    },
    strict: true
  };

  const resp = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content:
          "You are a strict classifier. Decide if the message is wishing someone happy birthday. " +
          "Return JSON only."
      },
      { role: "user", content: text }
    ],
    response_format: { type: "json_schema", json_schema: schema }
  });

  const jsonText = resp.choices[0].message.content;
  return JSON.parse(jsonText);
}
