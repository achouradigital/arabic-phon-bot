const express = require("express");
const bodyParser = require("body-parser");
const crypto = require("crypto");

// try to require a transliteration lib if present, otherwise fallback
let arabicTranslitPkg = null;
try {
  arabicTranslitPkg = require("arabic-transliteration");
} catch (e) {
  arabicTranslitPkg = null;
}
const transliterateLib = (arabicTranslitPkg && (arabicTranslitPkg.transliterate || arabicTranslitPkg.default || arabicTranslitPkg)) || null;

const app = express();

// capture raw body for optional Slack signature verification
app.use(bodyParser.urlencoded({
  extended: true,
  verify: (req, res, buf) => { req.rawBody = buf; }
}));
app.use(bodyParser.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

app.get("/", (req, res) => res.send("Achoura Phonetic Bot is running!"));

// Optional Slack signature verification using SLACK_SIGNING_SECRET
function isValidSlackRequest(req) {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) return true; // disabled when not provided

  const ts = req.headers["x-slack-request-timestamp"];
  const sig = req.headers["x-slack-signature"];
  if (!ts || !sig) return false;

  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(ts));
  if (age > 60 * 5) return false; // too old

  const base = `v0:${ts}:${req.rawBody ? req.rawBody.toString() : ""}`;
  const hmac = crypto.createHmac("sha256", signingSecret).update(base).digest("hex");
  const computed = `v0=${hmac}`;
  try {
    return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(sig));
  } catch (e) {
    return false;
  }
}

// Keep shadda and basic spacing for contextual rules
function normalizeArabicKeepShadda(text) {
  if (!text) return "";
  return String(text).replace(/\u200F/g, "").replace(/\s+/g, " ").trim();
}

// Remove short vowel diacritics, normalize alef forms and common chars
function stripDiacritics(text) {
  if (!text) return "";
  return String(text)
    .replace(/[\u064B-\u0652\u0670]/g, "") // remove short vowel diacritics
    .replace(/[إأآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/ة/g, "ة")
    .replace(/ـ/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// basic map for heuristics and fallback
const arabicToLatin = {
  "ا":"a","أ":"a","إ":"a","آ":"a",
  "ب":"b","ت":"t","ث":"th","ج":"j","ح":"h","خ":"kh",
  "د":"d","ذ":"dh","ر":"r","ز":"z",
  "س":"s","ش":"sh","ص":"s","ض":"d",
  "ط":"t","ظ":"z","ع":"a","غ":"gh",
  "ف":"f","ق":"q","ك":"k","ل":"l","م":"m","ن":"n",
  "ه":"h","و":"w","ي":"y","ء":"'","ئ":"y","ؤ":"w","ة":"a","ى":"a"
};

// sun letters for assimilation rule
const sunLetters = new Set(["ت","ث","د","ذ","ر","ز","س","ش","ص","ض","ط","ظ","ل","ن"]);

function capitalizeWord(s) {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// fallback very conservative transliteration
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

// Convert scientific translit (from lib) to human-friendly phonetic
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

// Apply contextual rules using original Arabic (rawKeep includes shadda etc.)
function applyContextualRules(originalArabic, phoneticLatin) {
  if (!originalArabic || !phoneticLatin) return phoneticLatin;
  let out = phoneticLatin;
  const raw = originalArabic.trim();

  // Assimilation of "ال" before sun letters -> Ash-, Ad-, ...
  if (raw.startsWith("ال") && raw.length >= 2) {
    const secondLetter = raw[2] || raw[1];
    if (sunLetters.has(secondLetter)) {
      const mapped = arabicToLatin[secondLetter] || "";
      const prefix = "A" + mapped;
      out = out.replace(/^al[-\s]?/i, prefix + "-");
      out = out.replace(/^Al[-\s]?/i, prefix + "-");
    }
  }

  // shadda doubling: for each letter doubled by shadda, double its latin mapping once
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

  // taa marbuta: if ends with ة, ensure final 'a'
  if (raw.endsWith("ة")) {
    if (!/[aA]$/.test(out)) out = out + "a";
  }

  out = out.replace(/\s+/g, " ").replace(/-+/g, "-").trim();
  out = out.split(" ").map(capitalizeWord).join(" ");
  return out;
}

// Main smart transliteration: use lib if available, fallback otherwise, then apply heuristics
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

// /phon endpoint expects form-encoded 'text' like Slack slash command
app.post("/phon", async (req, res) => {
  try {
    if (!isValidSlackRequest(req)) {
      return res.status(400).send("Invalid Slack request signature");
    }

    const text = (req.body && req.body.text) ? String(req.body.text).trim() : "";
    if (!text) {
      return res.json({
        response_type: "ephemeral",
        text: "❌ Veuillez fournir un nom arabe. Exemple: /phon أحمد بن محمد"
      });
    }

    const normalized = stripDiacritics(text).replace(/\s+/g, " ").trim();
    const tokens = normalized.split(" ").filter(Boolean);

    const translitTokens = [];
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      if (tok === "بن" || tok === "ابن") {
        translitTokens.push("bin");
        continue;
      }
      // if token starts with definite article, use original slice for contextual rule
      if (tok.startsWith("ال") && tok.length > 2) {
        // find occurrence in original raw to preserve shadda if any
        const idx = text.indexOf(tok);
        const origPiece = (idx >= 0) ? text.substr(idx, tok.length) : tok;
        translitTokens.push(smartTransliterate(origPiece));
      } else {
        translitTokens.push(smartTransliterate(tok));
      }
    }

    const output = translitTokens.filter(Boolean).join(" ");

    return res.json({
      response_type: "in_channel",
      text: `🔤 Phonetic: *${output}*`
    });
  } catch (err) {
    console.error("Error /phon:", err);
    return res.json({
      response_type: "ephemeral",
      text: "❌ Erreur interne lors de la translittération."
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Achoura Phonetic Bot running on port ${PORT}`));
