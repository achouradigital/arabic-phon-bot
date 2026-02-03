/**
 * Arabic Phon Bot
 * Slack Slash Command: /phon
 *
 * Objectifs :
 * - ACK immédiat (< 3s) pour éviter operation_timeout
 * - Traitement asynchrone après ACK
 * - Translittération arabe → phonétique intelligente
 * - Compatible Railway (cold start safe)
 */

const express = require("express");
const bodyParser = require("body-parser");
const crypto = require("crypto");
const axios = require("axios");

const APP_NAME = "Arabic Phon Bot";
const app = express();

/* --------------------------------------------------
   BODY PARSER (nécessaire pour Slack)
-------------------------------------------------- */
app.use(
  bodyParser.urlencoded({
    extended: true,
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

app.use(
  bodyParser.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

/* --------------------------------------------------
   Vérification signature Slack (OPTIONNELLE)
-------------------------------------------------- */
function isValidSlackRequest(req) {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) return true; // désactivé si non défini

  const timestamp = req.headers["x-slack-request-timestamp"];
  const slackSignature = req.headers["x-slack-signature"];
  if (!timestamp || !slackSignature) return false;

  // Anti-replay attack (5 minutes)
  const fiveMinutes = 60 * 5;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > fiveMinutes) return false;

  const sigBaseString = `v0:${timestamp}:${req.rawBody.toString()}`;
  const mySignature =
    "v0=" +
    crypto
      .createHmac("sha256", signingSecret)
      .update(sigBaseString)
      .digest("hex");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(mySignature),
      Buffer.from(slackSignature)
    );
  } catch {
    return false;
  }
}

/* --------------------------------------------------
   TRANSLITTÉRATION
-------------------------------------------------- */

// Tentative d'import de lib externe (optionnelle)
let transliterateLib = null;
try {
  const pkg = require("arabic-transliteration");
  transliterateLib = pkg.transliterate || pkg.default || pkg;
} catch {
  transliterateLib = null;
}

// Nettoyage
function normalizeArabic(text) {
  return String(text || "")
    .replace(/\u200F/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function stripDiacritics(text) {
  return text
    .replace(/[\u064B-\u0652\u0670]/g, "")
    .replace(/[إأآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/ـ/g, "")
    .trim();
}

// Mapping simple
const arabicToLatin = {
  ا: "a",
  ب: "b",
  ت: "t",
  ث: "th",
  ج: "j",
  ح: "h",
  خ: "kh",
  د: "d",
  ذ: "dh",
  ر: "r",
  ز: "z",
  س: "s",
  ش: "sh",
  ص: "s",
  ض: "d",
  ط: "t",
  ظ: "z",
  ع: "a",
  غ: "gh",
  ف: "f",
  ق: "q",
  ك: "k",
  ل: "l",
  م: "m",
  ن: "n",
  ه: "h",
  و: "w",
  ي: "y",
  ة: "a",
};

function capitalize(word) {
  return word ? word.charAt(0).toUpperCase() + word.slice(1) : "";
}

function fallbackTransliterate(text) {
  let out = "";
  for (const ch of text) {
    if (arabicToLatin[ch]) out += arabicToLatin[ch];
    else if (ch === " ") out += " ";
  }
  return out
    .split(/\s+/)
    .map(capitalize)
    .join(" ");
}

function scientificToPhonetic(text) {
  if (!text) return "";

  let s = text
    .toLowerCase()
    .replace(/ā/g, "aa")
    .replace(/ī/g, "ii")
    .replace(/ū/g, "uu")
    .replace(/ḥ/g, "h")
    .replace(/ṣ/g, "s")
    .replace(/ṭ/g, "t")
    .replace(/ḍ/g, "d")
    .replace(/ẓ/g, "z")
    .replace(/ʿ/g, "a")
    .replace(/ʾ/g, "")
    .replace(/-/g, " ");

  const corrections = {
    mhmd: "Muhammad",
    muhammad: "Muhammad",
    mohamed: "Muhammad",
    mohammad: "Muhammad",
    ahmad: "Ahmad",
    ali: "Ali",
    yusuf: "Yusuf",
    fatima: "Fatima",
  };

  return s
    .split(/\s+/)
    .map((w) => corrections[w] || capitalize(w))
    .join(" ");
}

function smartTransliterate(arabicText) {
  const clean = normalizeArabic(arabicText);
  const stripped = stripDiacritics(clean);

  let scientific = "";
  if (transliterateLib) {
    try {
      scientific = transliterateLib(stripped);
    } catch {
      scientific = "";
    }
  }

  if (!scientific) scientific = fallbackTransliterate(stripped);
  return scientificToPhonetic(scientific);
}

/* --------------------------------------------------
   SLASH COMMAND /phon
-------------------------------------------------- */
app.post("/phon", (req, res) => {
  // 🚀 ACK IMMÉDIAT — ABSOLUMENT RIEN AVANT
  res.status(200).json({
    response_type: "ephemeral",
    text: "🔄 Traitement en cours…",
  });

  // ⏱️ Traitement APRÈS ACK
  setImmediate(async () => {
    try {
      if (!isValidSlackRequest(req)) return;

      const text = req.body?.text?.trim();
      const responseUrl = req.body?.response_url;
      const channelId = req.body?.channel_id;

      if (!text) return;

      const result = smartTransliterate(text);
      const message = {
        response_type: "in_channel",
        text: `🔤 Phonetic : *${result}*`,
      };

      if (responseUrl) {
        await axios.post(responseUrl, message, {
          headers: { "Content-Type": "application/json" },
          timeout: 5000,
        });
      } else if (process.env.SLACK_BOT_TOKEN && channelId) {
        await axios.post(
          "https://slack.com/api/chat.postMessage",
          {
            channel: channelId,
            text: message.text,
          },
          {
            headers: {
              Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
              "Content-Type": "application/json",
            },
            timeout: 5000,
          }
        );
      }
    } catch (err) {
      console.error("Async /phon error:", err.message);
    }
  });
});

/* --------------------------------------------------
   HEALTH CHECK
-------------------------------------------------- */
app.get("/", (req, res) => {
  res.send(`${APP_NAME} is running`);
});

/* --------------------------------------------------
   SERVER
-------------------------------------------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`${APP_NAME} running on port ${PORT}`);
});
