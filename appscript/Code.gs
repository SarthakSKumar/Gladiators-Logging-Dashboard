/**
 * Gladiators bet logger — Google Apps Script web app (deploy as: Web app, execute as Me, access Anyone).
 *
 * Receives one POST per WhatsApp message from the logger server:
 *   { id, sender, message, groupName, timestamp, raceNumber }
 * and writes row (id + 2) of the sheet "RACE <raceNumber>" in the group's spreadsheet:
 *   S.No | Time (IST) | Sender | Message | first 2 letters of sender | Horse | Win | Place
 *
 * HOW THE BET IS READ
 *   1. Deterministic rules (parseBetByRules) — instant, free, same answer every time. Handles
 *      "2w200", "3p1kw5k", "4 ew 100", "9 each way 3k", "6, w,1000,plc,2000", "10w100  10plc100", ...
 *   2. Only if the rules cannot read it: Cloudflare Workers AI as a fallback (optional, see below).
 *   3. If neither can: the row is still written, Horse/Win/Place are left EMPTY, column D is red and has a
 *      note saying why. The reply says "parsed": false so the logger can show it.
 *   Messages with several bets ("1w1k 7w1k") are never guessed — they are flagged for manual entry.
 *
 * SETUP (one time)
 *   Project Settings (gear icon) → Script properties → add:
 *     CF_API_TOKEN   Cloudflare API token with "Workers AI - Read" + "Workers AI - Edit"   (optional)
 *     CF_ACCOUNT_ID  your Cloudflare account id                                            (optional)
 *     CF_MODEL       optional, default @cf/meta/llama-3.1-8b-instruct
 *   Without the two CF_* properties the script still works — it just has no AI fallback.
 *   NEVER paste the token into this file.
 *   Then run checkSetup() and runSelfTest() once from the editor, and Deploy → Manage deployments →
 *   Edit → Version: New version (that keeps the same /exec URL).
 */

const indianRacingSpreadsheet = "1VBCoHC4sFKo9-z-UFYBZyR5Ffb34mkOb_PANtgh5224";
const internationalRacingSpreadsheet = "17SV8q-OUgKocFJ_Vi6VEoWaU-0kGarRJiOJz16jiC2o";
const templateSpreadsheet = "156QsTSbUt6dKWfT0blH8pc4K0mX7y47tpUV4iLEqQdE";
const debugSpreadsheet = "1q0WgrlTZY4oONH4KppvgVKnO3-pxk3iUS_SB1_QLjbQ";
const indianGroup = "Gladiators Indian Racing 🏇";
const internationalGroup = "Gladiators International Racing 🏇";

const CF_MODEL = "@cf/meta/llama-3.1-8b-instruct";
const MAX_HORSE = 30; // horse numbers above this are not horse numbers

// ---------------------------------------------------------------------------------------------
// Sheet maintenance
// ---------------------------------------------------------------------------------------------

function resetSheets() {
  const targetSpreadsheets = [indianRacingSpreadsheet, internationalRacingSpreadsheet];

  const templateSS = SpreadsheetApp.openById(templateSpreadsheet);
  const templateSheets = templateSS.getSheets();

  targetSpreadsheets.forEach(function (spreadsheetId) {
    const ss = SpreadsheetApp.openById(spreadsheetId);

    ss.getSheets().forEach(function (sheet) {
      if (sheet.getName() !== "Debug") {
        ss.deleteSheet(sheet);
      }
    });
    templateSheets.forEach(function (sheet) {
      const newSheet = sheet.copyTo(ss);
      newSheet.setName(sheet.getName());
    });

    SpreadsheetApp.flush();
    Logger.log("Spreadsheet " + spreadsheetId + " reset from template, Debug sheet retained.");
  });
}

/** Appends one line to the Debug sheet. Only used for problems (parse failures, AI errors). */
function logDebug(dataObject, rawResponse, errorNote) {
  try {
    const debugSheet = SpreadsheetApp.openById(debugSpreadsheet).getSheetByName("Debug");
    if (!debugSheet) {
      throw new Error("Debug sheet not found");
    }
    debugSheet.appendRow([
      new Date(),
      typeof dataObject === "string" ? dataObject : JSON.stringify(dataObject),
      rawResponse || "",
      errorNote || ""
    ]);
  } catch (err) {
    Logger.log("Failed to log debug info: " + err.message);
  }
}

// ---------------------------------------------------------------------------------------------
// 1. Rule-based parser
// ---------------------------------------------------------------------------------------------

const WIN_WORDS = ["w", "win", "wn", "ww", "won", "wiin", "winn", "wins"];
const PLACE_WORDS = ["p", "pl", "ple", "plz", "pls", "plc", "pla", "ps", "plase", "place", "please", "pal", "plce", "plac", "plas"];
const EACH_WAY_WORDS = ["ew", "eway", "eachway", "eachw", "each"];
const FILLER_WORDS = ["no", "number", "horse", "h", "nr", "num"]; // allowed before the horse number: "No 5 win 100"

function betKeyword(token) {
  if (WIN_WORDS.indexOf(token) !== -1) return "win";
  if (PLACE_WORDS.indexOf(token) !== -1) return "place";
  if (EACH_WAY_WORDS.indexOf(token) !== -1) return "ew";
  return null;
}

function isNumberToken(token) {
  return token !== undefined && /^\d/.test(token);
}

/**
 * Reads "<horse> <win|place|each way> <amount> ..." messages.
 * Returns { ok: true, hNo, win, place } or { ok: false, reason, multiple }.
 *  - "k" after an amount below 1000 means thousands (5k = 5000); a stray "k" after 3000 is ignored
 *  - the same horse repeated ("10w100 10plc100") is merged into one bet
 *  - another horse ("1w1k 7w1k", "3 and 5 win 150") => not guessed: { ok: false, multiple: true }
 */
function parseBetByRules(message) {
  const fail = function (reason, multiple) { return { ok: false, reason: reason, multiple: !!multiple }; };

  // keep "." only between digits (1.5k); every other character that is not a letter/digit separates tokens
  const cleaned = String(message === undefined || message === null ? "" : message)
    .toLowerCase()
    .replace(/[^a-z0-9.]/g, " ")
    .replace(/(?<!\d)\.|\.(?!\d)/g, " ");
  // "3p1kw5k": a "k" (thousand) written DIRECTLY after digits arrives glued to the next word ("kw") — split it
  // off, but only when the rest is a win/place word. "100 kw" (space) or initials like "1kb" stay untouched.
  const spaced = cleaned.replace(/(\d)k([a-z]+)/g, function (whole, digit, rest) {
    return betKeyword(rest) ? digit + " k " + rest : whole;
  });
  const tokens = spaced.match(/\d+(?:\.\d+)?|[a-z]+/g) || [];

  let i = 0;
  while (i < tokens.length && FILLER_WORDS.indexOf(tokens[i]) !== -1) i++;
  if (i >= tokens.length || !isNumberToken(tokens[i])) return fail("does not start with a horse number");

  const hNo = Number(tokens[i]);
  if (!Number.isInteger(hNo) || hNo < 1 || hNo > MAX_HORSE) return fail("first number is not a horse number");
  i++;

  let win = 0;
  let place = 0;
  let haveWin = false;
  let havePlace = false;

  while (i < tokens.length) {
    const token = tokens[i];
    const kind = betKeyword(token);

    if (kind) {
      i++;
      if (kind === "ew" && token === "each" && (tokens[i] === "way" || tokens[i] === "w")) i++; // "each way"

      if (!isNumberToken(tokens[i])) {
        // a keyword with no amount: harmless politeness at the very end ("... 100 please"), otherwise unreadable
        if (i >= tokens.length && (haveWin || havePlace)) break;
        return fail("a win/place word has no amount after it");
      }

      let amount = Number(tokens[i]);
      i++;
      let hadK = false;
      if (tokens[i] === "k") {
        hadK = true;
        if (amount < 1000) amount = amount * 1000; // "5k"; "3000 k" is already thousands
        i++;
      }
      amount = Math.round(amount);
      if (amount <= 0) return fail("amount is zero");

      // a small plain number directly followed by another win/place word is more likely the NEXT horse
      // ("3win../4pls100") than an amount of 4 — too risky to guess
      if (!hadK && amount <= MAX_HORSE && i < tokens.length && betKeyword(tokens[i])) {
        return fail("ambiguous: a small amount is followed by another bet", true);
      }

      if (kind === "win") {
        if (haveWin) return fail("win amount given twice");
        win = amount;
        haveWin = true;
      } else if (kind === "place") {
        if (havePlace) return fail("place amount given twice");
        place = amount;
        havePlace = true;
      } else {
        if (haveWin || havePlace) return fail("each way combined with win/place");
        win = amount;
        place = amount;
        haveWin = true;
        havePlace = true;
      }
      continue;
    }

    if (isNumberToken(token)) {
      // a number that is not an amount: a second horse, or noise
      if (betKeyword(tokens[i + 1])) {
        if (Number(token) !== hNo) return fail("more than one horse in the message", true);
        i++; // same horse repeated: keep merging ("10w100 10plc100")
        continue;
      }
      return fail("unexpected extra number");
    }

    i++; // any other word ("taken", "kb", "and") is ignored
  }

  if (!(win > 0 || place > 0)) return fail("no win/place amount found");
  return { ok: true, hNo: hNo, win: win, place: place };
}

// ---------------------------------------------------------------------------------------------
// 2. Cloudflare Workers AI fallback (only for messages the rules cannot read)
// ---------------------------------------------------------------------------------------------

const SYSTEM_PROMPT = [
  "You will be given a text message sent by a user in a horse betting group to register a bet for a horse race.",
  "Your task is to extract the following into a JSON object:",
  "- hNo: horse number (integer)",
  "- win: win amount (integer)",
  "- place: place amount (integer)",
  "",
  "Rules:",
  '- Message may include variations of "win": W, Win, Wn, Ww, Won, WIIN (case in-sensitive)',
  '- Message may include variations of "place": P, Plase, Pl, Ple, Plz, Pls, Plc, Pla, Ps, Please, pal (case in-sensitive)',
  '- Message may include variations of "each way": ew, each way, eachw, eway (case in-sensitive)',
  '- "k" means thousand (1k = 1000, 2k = 2000)',
  '- Message may contain various spacing between elements or none at all (e.g., "2 win 200", "6w1200p 300", "2 p100", "6w100", "2p 1k w 3k", "10ew1000)',
  '- "each way" means the bet is for both win and place with the same amount.',
  "- Message need not contain both place and win. It can be only for place or only for win, or both. If it's each way, then it's same as both place and win. (e.g., 2ew200 is same as 2p200w200)",
  "- If only win is present in the message, then the amount for place would be 0. Similarly for place as well.",
  "- Only ONE horse per message. If the message has several horses, or is unclear, invalid, or unparseable, return: { \"error\": \"Could not parse message\" }",
  "- Always respond in a strict JSON object format like:",
  '  { "hNo": number, "win": number, "place": number }',
  "",
  "Examples:",
  '- "2w200" → { "hNo": 2, "win": 200, "place": 0 }',
  '- "3p1kw5k" → { "hNo": 3, "win": 5000, "place": 1000 }',
  '- "3p2k" → { "hNo": 3, "win": 0, "place": 2000 }',
  '- "2 place. 8000. K B" → { "hNo": 2, "win": 0, "place": 8000 }',
  '- "4ew100" → { "hNo": 4, "win": 100, "place": 100 }',
  '- "9 each way 3k" → { "hNo": 9, "win": 3000, "place": 3000 }',
  '- "6w1200p300" → { "hNo": 6, "win": 1200, "place": 300 }',
  '- "2 win 200 place 500" → { "hNo": 2, "win": 200, "place": 500 }',
  '- "random garbage" → { "error": "Could not parse message" }',
  "",
  "Respond only with one valid JSON object. Do not include explanations, markdown or any extra text."
].join("\n");

/** First flat {...} block in a model reply, in case the model wraps the JSON in text or ``` fences. */
function extractJsonString(text) {
  const cleaned = String(text).replace(/```(?:json)?/g, "").replace(/```/g, "").trim();
  const match = cleaned.match(/\{[^{}]*\}/);
  return match ? match[0] : cleaned;
}

/**
 * Pulls the bet out of whatever shape the AI endpoint answered with: an OpenAI-style
 * choices[0].message.content, or Cloudflare's result.response — as a string OR as an already parsed object.
 */
function betObjectFromAiReply(data) {
  let candidate = null;
  if (data && data.choices && data.choices.length) {
    const first = data.choices[0];
    candidate = first.message ? first.message.content : first.text;
  }
  if (candidate === null || candidate === undefined || candidate === "") {
    const result = data ? data.result : null;
    if (result) {
      if (result.response !== undefined && result.response !== null) candidate = result.response;
      else if (result.choices && result.choices.length && result.choices[0].message) candidate = result.choices[0].message.content;
    }
  }
  if (candidate === null || candidate === undefined || candidate === "") return { ok: false, reason: "no text in the AI reply" };

  let obj = candidate;
  if (typeof candidate === "string") {
    try {
      obj = JSON.parse(extractJsonString(candidate));
    } catch (err) {
      return { ok: false, reason: "AI reply was not valid JSON: " + String(candidate).slice(0, 120) };
    }
  }
  if (!obj || typeof obj !== "object") return { ok: false, reason: "AI reply was not a JSON object" };
  if (obj.error) return { ok: false, reason: "AI could not read the message" };
  return validateAiBet(obj);
}

/** The AI may not invent numbers: anything outside sane ranges is rejected. */
function validateAiBet(obj) {
  const hNo = Number(obj.hNo);
  const win = Number(obj.win || 0);
  const place = Number(obj.place || 0);
  if (!Number.isInteger(hNo) || hNo < 1 || hNo > MAX_HORSE) return { ok: false, reason: "AI returned an invalid horse number" };
  if (!Number.isInteger(win) || !Number.isInteger(place) || win < 0 || place < 0) return { ok: false, reason: "AI returned invalid amounts" };
  if (win === 0 && place === 0) return { ok: false, reason: "AI returned no amount" };
  return { ok: true, hNo: hNo, win: win, place: place };
}

/** Every number written in the message (1.5 stays 1.5). */
function numbersIn(message) {
  return (String(message).match(/\d+(?:\.\d+)?/g) || []).map(Number);
}

/**
 * The AI may only re-arrange what is written: the horse must be a number in the message, and every
 * non-zero amount must be a number in the message (or that number as thousands, for "5k").
 * Anything else is a hallucination and is rejected.
 */
function aiBetAgreesWithMessage(bet, message) {
  const nums = numbersIn(message);
  const allowed = {};
  nums.forEach(function (n) { allowed[n] = true; allowed[Math.round(n * 1000)] = true; });
  if (nums.indexOf(bet.hNo) === -1) return false;
  if (bet.win !== 0 && !allowed[bet.win]) return false;
  if (bet.place !== 0 && !allowed[bet.place]) return false;
  return true;
}

/** Returns { ok, hNo, win, place } or { ok: false, reason, raw }. Never throws. */
function parseBetWithAI(message) {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty("CF_API_TOKEN");
  const accountId = props.getProperty("CF_ACCOUNT_ID");
  const model = props.getProperty("CF_MODEL") || CF_MODEL;
  if (!token || !accountId) return { ok: false, reason: "AI fallback not configured (script properties CF_API_TOKEN / CF_ACCOUNT_ID)" };

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: 'Now extract from this message: "' + message + '"' }
  ];
  const base = "https://api.cloudflare.com/client/v4/accounts/" + accountId + "/ai";
  // OpenAI-compatible endpoint first (standard reply shape), Cloudflare's native endpoint as a second try
  const attempts = [
    { url: base + "/v1/chat/completions", body: { model: model, messages: messages, max_tokens: 100, temperature: 0 } },
    { url: base + "/run/" + model, body: { messages: messages, max_tokens: 100, temperature: 0 } }
  ];

  let lastReason = "AI request failed";
  let lastRaw = "";
  for (let n = 0; n < attempts.length; n++) {
    try {
      const response = UrlFetchApp.fetch(attempts[n].url, {
        method: "post",
        contentType: "application/json",
        headers: { Authorization: "Bearer " + token },
        payload: JSON.stringify(attempts[n].body),
        muteHttpExceptions: true
      });
      const code = response.getResponseCode();
      const text = response.getContentText();
      lastRaw = text;
      if (code !== 200) {
        lastReason = "AI HTTP " + code + (n === 0 ? " (OpenAI-compatible endpoint)" : " (native endpoint)");
        if (code === 401 || code === 403) break; // wrong token / missing Workers AI permission: the 2nd endpoint will not help
        continue;
      }
      let data;
      try {
        data = JSON.parse(text);
      } catch (err) {
        lastReason = "AI reply was not JSON";
        continue;
      }
      if (data.success === false) {
        lastReason = "Cloudflare returned success:false";
        continue;
      }
      const bet = betObjectFromAiReply(data);
      bet.raw = text;
      if (bet.ok && !aiBetAgreesWithMessage(bet, message)) {
        return { ok: false, reason: "AI answer does not match the numbers in the message (" + JSON.stringify({ hNo: bet.hNo, win: bet.win, place: bet.place }) + ")", raw: text };
      }
      return bet;
    } catch (err) {
      lastReason = "AI request error: " + err.message;
    }
  }
  return { ok: false, reason: lastReason, raw: lastRaw };
}

// ---------------------------------------------------------------------------------------------
// Web app entry points
// ---------------------------------------------------------------------------------------------

function jsonReply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** Opening the /exec URL in a browser: proves the deployment is live (the logger only uses POST). */
function doGet() {
  return jsonReply({ status: "ok", message: "Gladiators bet logger is deployed. Send a POST." });
}

/** A message that would start with = + - @ must not become a spreadsheet formula. */
function asText(value) {
  const s = String(value === undefined || value === null ? "" : value);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonReply({ status: "error", message: "No POST body received" });
    }
    const data = JSON.parse(e.postData.contents);
    const id = Number(data.id);
    const sender = data.sender;
    const message = data.message;
    const groupName = data.groupName;
    const timestamp = Number(data.timestamp);
    const raceNumber = String(data.raceNumber === undefined || data.raceNumber === null ? "" : data.raceNumber).trim();

    let spreadsheetId;
    if (groupName === indianGroup) {
      spreadsheetId = indianRacingSpreadsheet;
    } else if (groupName === internationalGroup) {
      spreadsheetId = internationalRacingSpreadsheet;
    } else {
      return jsonReply({ status: "error", message: "Unrecognized group name: '" + groupName + "'" });
    }
    if (!Number.isInteger(id) || id < 1) return jsonReply({ status: "error", message: "Invalid id: " + data.id });
    if (!/^\d{1,2}$/.test(raceNumber)) return jsonReply({ status: "error", message: "Invalid raceNumber: '" + data.raceNumber + "'" });

    const ss = SpreadsheetApp.openById(spreadsheetId);
    const sheet = ss.getSheetByName("RACE " + raceNumber);
    if (!sheet) {
      return jsonReply({ status: "error", message: 'Sheet "RACE ' + raceNumber + '" not found in the spreadsheet (Template Sheet not found!)' });
    }

    const targetRow = id + 2;
    const sNo = id;
    const istTime = Utilities.formatDate(new Date(isNaN(timestamp) ? Date.now() : timestamp), "Asia/Kolkata", "dd/MM/yyyy HH:mm");

    // ---- read the bet: rules first, AI only as a fallback ----
    let bet = parseBetByRules(message);
    let source = "rules";
    let reason = "";

    if (!bet.ok) {
      reason = bet.reason;
      // AI only for short, single-bet-looking messages (at most 3 numbers): with more, it could silently
      // drop a second bet, and a wrong amount in a betting ledger is worse than a flagged row
      const count = numbersIn(message).length;
      const worthAsking = count >= 1 && count <= 3 && !bet.multiple && String(message).length <= 80;
      if (worthAsking) {
        const ai = parseBetWithAI(String(message));
        if (ai.ok) {
          bet = ai;
          source = "ai";
          reason = "";
        } else {
          reason = reason + "; AI: " + ai.reason;
          logDebug(data, ai.raw || "", "AI could not read it — " + ai.reason);
        }
      } else {
        source = "none";
      }
      if (!bet.ok) {
        source = "none";
        logDebug(data, "", "Not parsed (" + reason + ")");
      }
    }

    const parsed = !!bet.ok;
    sheet.getRange(targetRow, 1, 1, 8).setValues([
      [sNo, istTime, asText(sender), asText(message), "=LEFT(C" + targetRow + ", 2)", parsed ? bet.hNo : "", parsed ? bet.win : "", parsed ? bet.place : ""]
    ]);

    const messageCell = sheet.getRange(targetRow, 4);
    if (!parsed) {
      messageCell.setBackground("#FFCCCC"); // red: needs a human
      messageCell.setNote("Could not read horse/win/place: " + reason);
    } else {
      messageCell.setBackground(null);
      messageCell.setNote(source === "ai" ? "Read by AI — please double-check" : "");
    }

    return jsonReply({
      status: "success",
      message: "Bet logged at row " + targetRow + " (ID: " + id + "), Horse: " + (parsed ? bet.hNo : "?") + ", Win: " + (parsed ? bet.win : "?") + ", Place: " + (parsed ? bet.place : "?") + (parsed ? "" : " [NOT PARSED: " + reason + "]"),
      row: targetRow,
      parsed: parsed,
      source: source,
      hNo: parsed ? bet.hNo : null,
      win: parsed ? bet.win : null,
      place: parsed ? bet.place : null,
      reason: parsed ? null : reason
    });
  } catch (error) {
    return jsonReply({ status: "error", message: error.message });
  }
}

// ---------------------------------------------------------------------------------------------
// Run these from the editor (Run ▶) after deploying — they do not touch any spreadsheet
// ---------------------------------------------------------------------------------------------

/**
 * RUN THIS ONCE from the editor after pasting any new version (select "authorize" → Run ▶ → Review permissions
 * → Allow). A web app cannot ask for permissions itself: until the owner has granted them, every request fails
 * with "You do not have permission to call SpreadsheetApp.openById". Read-only — it changes nothing; it also
 * reports which RACE sheets are missing. (Do NOT use resetSheets() for this: that one deletes sheets.)
 */
function authorize() {
  [["Indian", indianRacingSpreadsheet], ["International", internationalRacingSpreadsheet]].forEach(function (entry) {
    const ss = SpreadsheetApp.openById(entry[1]);
    const missing = [];
    for (let n = 1; n <= 10; n++) {
      if (!ss.getSheetByName("RACE " + n)) missing.push("RACE " + n);
    }
    Logger.log(entry[0] + " spreadsheet: OK — " + (missing.length ? "MISSING sheets: " + missing.join(", ") : "RACE 1..10 all present"));
  });
  const debugSheet = SpreadsheetApp.openById(debugSpreadsheet).getSheetByName("Debug");
  Logger.log("Debug spreadsheet: " + (debugSheet ? "OK" : "MISSING a sheet named Debug"));
  Logger.log("Permissions granted. Now: Deploy → Manage deployments → Edit (pencil) → Version: New version → Deploy.");
}

/** Shows whether the optional AI fallback is configured and whether Cloudflare accepts the token. */
function checkSetup() {
  const props = PropertiesService.getScriptProperties();
  const hasToken = !!props.getProperty("CF_API_TOKEN");
  const hasAccount = !!props.getProperty("CF_ACCOUNT_ID");
  Logger.log("CF_API_TOKEN: " + (hasToken ? "set" : "MISSING") + " | CF_ACCOUNT_ID: " + (hasAccount ? "set" : "MISSING"));
  if (!hasToken || !hasAccount) {
    Logger.log("AI fallback is OFF. The rule-based parser still works for normal bet messages.");
    return;
  }
  const ai = parseBetWithAI("7 win 1000");
  Logger.log("AI test for '7 win 1000': " + JSON.stringify({ ok: ai.ok, hNo: ai.hNo, win: ai.win, place: ai.place, reason: ai.reason }));
  Logger.log("Raw AI reply (first 600 chars): " + String(ai.raw || "").slice(0, 600));
}

/** Checks the rule-based parser against known messages. */
function runSelfTest() {
  const cases = [
    ["2w200", 2, 200, 0], ["3p1kw5k", 3, 5000, 1000], ["3p2k", 3, 0, 2000], ["2 place. 8000. K B", 2, 0, 8000],
    ["5place500", 5, 0, 500], ["1.W.500", 1, 500, 0], ["4ew100", 4, 100, 100], ["1win. 15k", 1, 15000, 0],
    ["2 win.   3000. .k", 2, 3000, 0], ["9 each way 3k", 9, 3000, 3000], ["6w1200p300", 6, 1200, 300],
    ["2 win 200 place 500", 2, 200, 500], ["2p 1k w 3k", 2, 3000, 1000], ["10ew1000", 10, 1000, 1000],
    ["1 win 1000", 1, 1000, 0], ["6, w,1000,plc,2000", 6, 1000, 2000], ["10w100.   10plc100", 10, 100, 100],
    ["3 WIN. 777. KB", 3, 777, 0], ["4 ew\n100", 4, 100, 100], ["2Pl2k", 2, 0, 2000]
  ];
  const mustFail = ["random garbage", "1 win", "1 plc all", "1w1k 7w1k", "3 and 5 win 150", "3win../4pls100", "290 taken", "Not taken", "600"];
  let bad = 0;
  cases.forEach(function (c) {
    const r = parseBetByRules(c[0]);
    const ok = r.ok && r.hNo === c[1] && r.win === c[2] && r.place === c[3];
    if (!ok) bad++;
    Logger.log((ok ? "PASS " : "FAIL ") + JSON.stringify(c[0]) + " -> " + JSON.stringify(r));
  });
  mustFail.forEach(function (m) {
    const r = parseBetByRules(m);
    if (r.ok) bad++;
    Logger.log((r.ok ? "FAIL " : "PASS ") + JSON.stringify(m) + " should NOT parse -> " + JSON.stringify(r));
  });
  Logger.log(bad === 0 ? "ALL PASSED" : bad + " FAILED");
}
