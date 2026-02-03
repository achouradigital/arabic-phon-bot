/**
 * Arabic Phon Bot
 * Endpoint /phon pour Slack (slash command)
 *
 * - ACK immédiat pour éviter le timeout Slack (<= 3s)
 * - Envoi asynchrone du résultat à response_url (avec retry + timeout)
 * - Fallback vers Slack Web API (chat.postMessage) si response_url échoue
 * - Vérification optionnelle de la signature via SLACK_SIGNING_SECRET
 *
 * Usage:
 *  - Mettre SLACK_SIGNING_SECRET pour activer la vérif. (optionnel)
 *  - Mettre SLACK_BOT_TOKEN pour fallback chat.postMessage (optionnel)
 */

const express = require("express");
const bodyParser = require("body-parser");
const crypto = require("crypto");
const axios = require("axios");

const APP_NAME = "Arabic Phon Bot";

const app = express();

// raw body capture for Slack signature verification
app.use(bodyParser.urlencoded({
  extended: true,
  verify: (req, res, buf) => { req.rawBody = buf; }
}));
app.use(bodyParser.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

// Simple request logger for debugging
app.use((req, res, next) => {
  console.log(`[${APP_NAME}] [REQ] ${new Date().toISOString()} ${req.method} ${req.url}`);
  // For privacy/security, avoid logging huge bodies in production
  console.log("Headers:", req.headers);
  console.log("Body:", req.body);
  next();
});

// --- Slack signature verification (optional)
function isValidSlackRequest(req) {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) return true; // disabled if not provided

  const timestamp = req.headers["x-slack-request-timestamp"];
  const sig = req.headers["x-slack-signature"];
  if (!timestamp || !sig) return false;

  const FIVE_MINUTES = 60 * 5;
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > FIVE_MINUTES) {
    return false;
  }

  const base = `v0:${timestamp}:${req.rawBody ? req.rawBody.toString() : ""}`;
  const hmac = crypto.createHmac("sha256", signingSecret).update(base).digest("hex");
  const computed = `v0=${hmac}`;

  try {
    return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(sig));
  } catch (e) {
    return false;
  }
}

// --- Transliteration utilities (fallback + optional lib)
let arabicTranslitPkg = null;
try {
  arabicTranslitPkg = require("arabic-transliteration");
} catch (e) {
  arabicTranslitPkg = null;
}
const transliterateLib = (arabicTranslitPkg && (arabicTranslitPkg.transliterate || arabicTranslitPkg.default || arabicTranslitPkg)) || null;

function normalizeArabicKeepShadda(text) {
  if (!text) return "";
  return String(text).replace(/\u200F/g, "").replace(/\s+/g, " ").trim();
}
function stripDiacritics(text) {
  if (!text) return "";
  return String(text)
    .replace(/[\u064B-\u0652\u0670]/g, "")
    .replace(/[إأآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/ة/g, "ة")
    .replace(/ـ/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const arabicToLatin = {
  "ا":"a","أ":"a","إ":"a","آ":"a",
  "ب":"b","ت":"t","ث":"th","ج":"j","ح":"h","خ":"kh",
  "د":"d","ذ":"dh","ر":"r","ز":"z",
  "س":"s","ش":"sh","ص":"s","ض":"d",
  "ط":"t","ظ":"z","ع":"a","غ":"gh",
  "ف":"f","ق":"q","ك":"k","ل":"l","م":"m","ن":"n",
  "ه":"h","و":"w","ي":"y","ء":"'","ئ":"y","ؤ":"w","ة":"a","ى":"a"
};
const sunLetters = new Set(["ت","ث","د","ذ","ر","ز","س","ش","ص","ض","ط","ظ","ل","ن"]);
function capitalizeWord(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

function fallbackTransliterate(text) {
  if (!text) return "";
  const s = stripDiacritics(text);
  let out = "";
  for (const ch of s) {
    if (arabicToLatin[ch]) out += arabicToLatin[ch];
    else if (ch === " ") out += " ";
    else out += "";
  }
  return out.split(/\s+/).map(capitalizeWord).join(" ");
}
function scientificToPhonetic(scientific) {
  if (!scientific) return "";
  let s = scientific;
  s = s.replace(/ā/g, "aa").replace(/ī/g, "ii").replace(/ū/g, "uu");
  s = s.replace(/ḥ/g, "h").replace(/ḍ/g, "d").replace(/ṣ/g, "s").replace(/ṭ/g, "t").replace(/ẓ/g, "z");
  s = s.replace(/ʿ/g, "a").replace(/ʾ/g, "'").replace(/’/g, "'").replace(/ˁ/g, "a");
  s = s.replace(/-/g, " ").replace(/\s+/g, " ").trim().toLowerCase();

  const corrections = {
    "mhmd":"Muhammad","muhammad":"Muhammad","mohammad":"Muhammad","mohamed":"Muhammad",
    "ahmad":"Ahmad","ali":"Ali","yusuf":"Yusuf","fatima":"Fatima","abd":"Abd","bin":"bin"
  };

  return s.split(" ").map(w => {
    if (!w) return "";
    if (corrections[w]) return corrections[w];
    return capitalizeWord(w);
  }).join(" ");
}

function applyContextualRules(originalArabic, phoneticLatin) {
  if (!originalArabic || !phoneticLatin) return phoneticLatin;
  let out = phoneticLatin;
  const raw = originalArabic.trim();

  if (raw.startsWith("ال") && raw.length >= 2) {
    const secondLetter = raw[2] || raw[1];
    if (sunLetters.has(secondLetter)) {
      const mapped = arabicToLatin[secondLetter] || "";
      const prefix = "A" + mapped;
      out = out.replace(/^al[-\s]?/i, prefix + "-");
      out = out.replace(/^Al[-\s]?/i, prefix + "-");
    }
  }

  if (raw.includes("ّ")) {
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      const next = raw[i + 1];
      if (next === "ّ") {
        const mapped = arabicToLatin[ch];
        if (mapped) {
          const regex = new RegExp(mapped, "i");
          const doubled = mapped + mapped;
          out = out.replace(regex, doubled);
        }
      }
    }
  }

  if (raw.endsWith("ة")) {
    if (!/[aA]$/.test(out)) out = out + "a";
  }

  out = out.replace(/\s+/g, " ").replace(/-+/g, "-").trim();
  out = out.split(" ").map(capitalizeWord).join(" ");
  return out;
}

function smartTransliterate(arabicText) {
  if (!arabicText) return "Nom vide";
  const rawKeep = normalizeArabicKeepShadda(arabicText);
  const stripped = stripDiacritics(rawKeep);

  let scientific = "";
  if (transliterateLib && typeof transliterateLib === "function") {
    try {
      scientific = transliterateLib(stripped, { longVowels: true, hamza: true });
      if (!scientific || typeof scientific !== "string") scientific = transliterateLib(stripped);
    } catch (e) {
      try { scientific = transliterateLib(stripped); } catch (e2) { scientific = ""; }
    }
  } else {
    scientific = fallbackTransliterate(stripped);
  }

  let phonetic = scientificToPhonetic(scientific);
  phonetic = applyContextualRules(rawKeep, phonetic);
  return phonetic;
}

// --- Robust /phon handler (ACK + async response)
app.post("/phon", (req, res) => {
  const now = new Date().toISOString();
  console.log(`[${APP_NAME}] [${now}] /phon received`);
  console.log("headers:", req.headers);
  console.log("body:", req.body);

  if (!isValidSlackRequest(req)) {
    console.warn(`[${APP_NAME}] Invalid Slack signature - rejecting`);
    return res.status(400).send("Invalid Slack request signature");
  }

  const text = (req.body && req.body.text) ? String(req.body.text).trim() : "";
  const responseUrl = req.body && req.body.response_url;
  const channelId = req.body && req.body.channel_id;

  if (!text) {
    return res.json({
      response_type: "ephemeral",
      text: "❌ Veuillez fournir un nom arabe. Exemple: /phon أحمد بن محمد"
    });
  }

  // ACK immédiat
  try {
    res.status(200).json({ response_type: "ephemeral", text: "🔄 Traitement en cours…" });
  } catch (e) {
    console.error(`[${APP_NAME}] Erreur en envoyant ACK:`, e);
  }

  // Traitement asynchrone
  (async () => {
    try {
      const translit = smartTransliterate(text);
      const message = {
        response_type: "in_channel",
        text: `🔤 Phonetic: *${translit}*`
      };

      if (responseUrl) {
        const maxAttempts = 2;
        let lastErr = null;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          try {
            console.log(`[${APP_NAME}] [${now}] Posting to response_url (attempt ${attempt})`);
            await axios.post(responseUrl, message, {
              headers: { "Content-Type": "application/json" },
              timeout: 5000
            });
            console.log(`[${APP_NAME}] [${now}] Posted result to response_url`);
            lastErr = null;
            break;
          } catch (err) {
            lastErr = err;
            console.error(`[${APP_NAME}] [${now}] Attempt ${attempt} failed posting to response_url:`, err.message,
              err.response && err.response.status, err.response && err.response.data);
            await new Promise(r => setTimeout(r, 500 * attempt));
          }
        }

        if (lastErr) {
          const botToken = process.env.SLACK_BOT_TOKEN;
          if (botToken && channelId) {
            try {
              console.log(`[${APP_NAME}] [${now}] response_url failed, trying chat.postMessage fallback`);
              await axios.post("https://slack.com/api/chat.postMessage", {
                channel: channelId,
                text: message.text,
                mrkdwn: true
              }, {
                headers: { Authorization: `Bearer ${botToken}`, "Content-Type": "application/json" },
                timeout: 5000
              });
              console.log(`[${APP_NAME}] [${now}] Posted result using chat.postMessage fallback`);
            } catch (err2) {
              console.error(`[${APP_NAME}] [${now}] chat.postMessage fallback failed:`, err2.message, err2.response && err2.response.data);
            }
          } else {
            console.warn(`[${APP_NAME}] [${now}] response_url failed and no SLACK_BOT_TOKEN/channelId for fallback`);
          }
        }
      } else {
        const botToken = process.env.SLACK_BOT_TOKEN;
        if (botToken && channelId) {
          try {
            await axios.post("https://slack.com/api/chat.postMessage", {
              channel: channelId,
              text: message.text,
              mrkdwn: true
            }, {
              headers: { Authorization: `Bearer ${botToken}`, "Content-Type": "application/json" },
              timeout: 5000
            });
            console.log(`[${APP_NAME}] [${now}] Posted result using chat.postMessage (no response_url)`);
          } catch (err) {
            console.error(`[${APP_NAME}] [${now}] chat.postMessage failed:`, err.message, err.response && err.response.data);
          }
        } else {
          console.log(`[${APP_NAME}] [${now}] No response_url and no bot token - cannot deliver final message`);
        }
      }
    } catch (err) {
      console.error(`[${APP_NAME}] [${now}] Unexpected error during async processing:`, err);
    }
  })();
});

// Health check
app.get("/", (req, res) => res.send(`${APP_NAME} is running!`));

// Start server (Railway provides PORT)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`${APP_NAME} running on port ${PORT}`));
