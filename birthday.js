require("dotenv").config();

// main.js
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const { GoogleGenerativeAI } = require("@google/generative-ai");

// --- SETTINGS (tweak as you like) ---
const WISH_CONFIDENCE_THRESHOLD = 0.7;
const NAME_CONFIDENCE_THRESHOLD = 0.8;

const GEMINI_API_KEY="AIzaSyDnQopU4vHT6yMJFRywkmwtB9ibl6DaW0E"
// Gemini setup
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Helper: safely parse JSON even if Gemini wraps it in ```json fences
function safeJsonParse(text) {
  let cleaned = (text || "").trim();

  // Remove ```json ... ``` or ``` ... ``` fences if present
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();

  // If model adds extra text, try to extract the first JSON object
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }

  return JSON.parse(cleaned);
}

async function classifyBirthdayMessage(messageText) {
  const model = genAI.getGenerativeModel({
    model: "gemini-2.0-flash-lite",
    generationConfig: {
      temperature: 0.0,
      // Encourage pure JSON output
      responseMimeType: "application/json",
    },
  });

  const prompt = `
You are a strict classifier.

Task:
1) Decide if the message is wishing someone happy birthday.
2) If yes, extract whose birthday it is ONLY if a name is explicitly present (e.g., "Happy birthday John").
   If unclear or not present, set birthday_person_name to null.

Return ONLY valid JSON with exactly these fields:
{
  "is_birthday_wish": boolean,
  "wish_confidence": number,   // 0 to 1
  "birthday_person_name": string | null,
  "name_confidence": number    // 0 to 1
}

Message:
${JSON.stringify(messageText)}
`.trim();

  const result = await model.generateContent(prompt);
  const text = result.response.text();
  return safeJsonParse(text);
}

// WhatsApp client
const client = new Client({
  authStrategy: new LocalAuth(),
});

client.on("ready", () => {
  console.log("Client is ready!");
});

client.on("qr", (qr) => {
  qrcode.generate(qr, { small: true });
});

client.on("message_create", async (message) => {
  try {
    // Ignore messages from yourself
    if (message.fromMe) return;

    const text = (message.body || "").trim();
    if (!text) return;

    const result = await classifyBirthdayMessage(text);

    if (result.is_birthday_wish && result.wish_confidence >= WISH_CONFIDENCE_THRESHOLD) {
      let reply = "Happy birthday! 🎉";

      if (
        result.birthday_person_name &&
        result.name_confidence >= NAME_CONFIDENCE_THRESHOLD
      ) {
        reply = `Happy birthday, ${result.birthday_person_name}! 🎉`;
      }

      await client.sendMessage(message.from, reply);
    }
  } catch (err) {
    console.error("Error handling message:", err);
  }
});

client.initialize();
