// main.js
require("dotenv").config();

const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");

// Puter.js Node init helpers
const { init, getAuthToken } = require("@heyputer/puter.js/src/init.cjs");

// --- SETTINGS ---
const WISH_CONFIDENCE_THRESHOLD = 0.7;
const NAME_CONFIDENCE_THRESHOLD = 0.8;

// Puter model (works through Puter AI routing)
const MODEL = "anthropic/claude-sonnet-4-5";

// ✅ Whitelist chats here (leave empty to allow all chats)
const ALLOWED_CHATS = new Set([
  "120363416007830368@g.us",
  "120363249911798575@g.us",
  "120363198566737953@g.us",
]);

// --- Helpers ---

// Normalize Puter/LLM content to plain text.
// Handles: string, array of blocks (e.g., [{type:"text", text:"..."}]), objects.
function contentToText(input) {
  if (input == null) return "";

  if (typeof input === "string") return input;

  // Anthropic-style content blocks often come as an array
  if (Array.isArray(input)) {
    return input
      .map((part) => {
        if (part == null) return "";
        if (typeof part === "string") return part;
        if (typeof part === "object") {
          // common shapes: {type:"text", text:"..."} or {text:"..."} etc.
          if (typeof part.text === "string") return part.text;
          if (typeof part.content === "string") return part.content;
          return JSON.stringify(part);
        }
        return String(part);
      })
      .join("");
  }

  // If it already looks like parsed JSON with expected keys, keep it
  if (typeof input === "object") {
    const keys = Object.keys(input);
    const looksParsed =
      keys.includes("is_birthday_wish") ||
      keys.includes("wish_confidence") ||
      keys.includes("birthday_person_name") ||
      keys.includes("name_confidence") ||
      keys.includes("safe") ||
      keys.includes("confidence");

    if (looksParsed) return JSON.stringify(input);

    if (typeof input.text === "string") return input.text;
    if (typeof input.content === "string") return input.content;

    return JSON.stringify(input);
  }

  return String(input);
}

// Helper: safely parse JSON even if wrapped in ```json fences or extra text
function safeJsonParse(textLike, fallback = null) {
  // If the model already returned an object, return it
  if (textLike && typeof textLike === "object" && !Array.isArray(textLike)) {
    // If it's a content-block object, contentToText will stringify it and parse below.
    // But if it already IS the target JSON object, we can just return it.
    const keys = Object.keys(textLike);
    const looksParsed =
      keys.includes("is_birthday_wish") ||
      keys.includes("wish_confidence") ||
      keys.includes("birthday_person_name") ||
      keys.includes("name_confidence") ||
      keys.includes("safe") ||
      keys.includes("confidence");

    if (looksParsed) return textLike;
  }

  let cleaned = contentToText(textLike).trim();

  // Remove code fences if present
  cleaned = cleaned
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  // If extra text exists, keep only the JSON object portion
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    return fallback;
  }
}

// Birthday classifier via Puter AI chat
async function classifyBirthdayMessage(puter, messageText) {
  const messages = [
    {
      role: "system",
      content:
        "You are a strict classifier.\n" +
        "1) Decide if the message is wishing someone happy birthday.\n" +
        "2) If yes, extract whose birthday it is ONLY if a name is explicitly present (e.g., 'Happy birthday John').\n" +
        "If unclear or not present, set birthday_person_name to null.\n\n" +
        "Return ONLY valid JSON with exactly these fields:\n" +
        '{ "is_birthday_wish": boolean, "wish_confidence": number, "birthday_person_name": string|null, "name_confidence": number }',
    },
    { role: "user", content: messageText },
  ];

  const resp = await puter.ai.chat(messages, false, {
    model: MODEL,
    temperature: 0,
    max_tokens: 200,
  });

  const raw = resp?.message?.content ?? resp?.content ?? resp;
  const parsed = safeJsonParse(raw, {
    is_birthday_wish: false,
    wish_confidence: 0,
    birthday_person_name: null,
    name_confidence: 0,
  });

  // Hardening types
  return {
    is_birthday_wish: Boolean(parsed?.is_birthday_wish),
    wish_confidence:
      typeof parsed?.wish_confidence === "number" ? parsed.wish_confidence : 0,
    birthday_person_name:
      typeof parsed?.birthday_person_name === "string"
        ? parsed.birthday_person_name
        : null,
    name_confidence:
      typeof parsed?.name_confidence === "number" ? parsed.name_confidence : 0,
  };
}

// Casual friend-style answer via Puter AI chat
async function answerCasually(puter, userText) {
  const messages = [
    {
      role: "system",
      content:
        "Reply like a normal friend texting:\n" +
        "- casual tone, not formal\n" +
        "- keep it short and direct\n" +
        "- no report/essay formatting\n" +
        "- if you're unsure, just try to make a joke out of it\n",
    },
    { role: "user", content: userText },
  ];

  const resp = await puter.ai.chat(messages, false, {
    model: MODEL,
    temperature: 0.7,
    max_tokens: 220,
  });

  const raw = resp?.message?.content ?? resp?.content ?? resp;
  let reply = contentToText(raw).trim();

  // If the model sometimes prefixes with labels, strip only obvious single-line headers
  reply = reply.replace(/^(assistant|reply|response)\s*:\s*/i, "").trim();

  if (!reply) reply = "Hmm not sure tbh 😅";
  return reply;
}

// ✅ Safety checker: block offensive/mean/inappropriate replies
async function isReplySafeToSend(puter, replyText) {
  const messages = [
    {
      role: "system",
      content:
        "You are a safety filter for a WhatsApp bot.\n" +
        "Decide if the bot reply is safe to send.\n" +
        "Mark unsafe if it contains: hate/offensive slurs, harassment/mean insults, sexual content, self-harm encouragement, illegal wrongdoing instructions, threats, or explicit profanity aimed at someone.\n" +
        "If uncertain, mark unsafe.\n\n" +
        "Return ONLY valid JSON exactly like:\n" +
        '{ "safe": boolean, "confidence": number }',
    },
    { role: "user", content: replyText },
  ];

  const resp = await puter.ai.chat(messages, false, {
    model: MODEL,
    temperature: 0,
    max_tokens: 80,
  });

  const raw = resp?.message?.content ?? resp?.content ?? resp;
  const parsed = safeJsonParse(raw, { safe: false, confidence: 0 });

  const safe = Boolean(parsed?.safe);
  const confidence = typeof parsed?.confidence === "number" ? parsed.confidence : 0;

  // If the filter says unsafe OR low confidence, treat as unsafe
  return safe && confidence >= 0.6;
}

// --- WhatsApp client ---
const client = new Client({
  authStrategy: new LocalAuth(),
});

client.on("ready", () => {
  console.log("Client is ready!");
});

client.on("qr", (qr) => {
  qrcode.generate(qr, { small: true });
});

// Main startup
(async () => {
  const authToken = process.env.PUTER_AUTH_TOKEN || (await getAuthToken());
  const puter = init(authToken);

  client.on("message_create", async (message) => {
    try {
      // Ignore messages from yourself
      if (message.fromMe) return;

      const chat = await message.getChat();
      const chatId = chat.id._serialized;

      // Only run in allowed chats (if ALLOWED_CHATS is non-empty)
      if (ALLOWED_CHATS.size > 0 && !ALLOWED_CHATS.has(chatId)) return;

      const text = (message.body || "").trim();
      if (!text) return;

      let replyToSend = null;

      // 1) Birthday detection first
      const bday = await classifyBirthdayMessage(puter, text);

      if (bday.is_birthday_wish && bday.wish_confidence >= WISH_CONFIDENCE_THRESHOLD) {
        replyToSend = "Happy birthday! 🎉";

        if (bday.birthday_person_name && bday.name_confidence >= NAME_CONFIDENCE_THRESHOLD) {
          replyToSend = `Happy birthday, ${bday.birthday_person_name}! 🎉`;
        }
      } else {
        // 2) Otherwise, casual Q&A
        replyToSend = await answerCasually(puter, text);
      }

      // ✅ Final safety gate before sending
      const ok = await isReplySafeToSend(puter, replyToSend);
      if (!ok) {
        await client.sendMessage(message.from, "nice try");
        return;
      }

      await client.sendMessage(message.from, replyToSend);
    } catch (err) {
      console.error("Error handling message:", err);
    }
  });

  client.initialize();
})();
