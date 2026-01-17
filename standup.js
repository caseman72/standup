#!/usr/bin/env bun
"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const JSON5 = require("json5");
const { execFileSync, spawnSync } = require("child_process");

// Config
const SCRIPT_DIR = __dirname;
const TEMPLATE_FILE = path.join(SCRIPT_DIR, "standup-template.md");
const JSON_FILE = `/tmp/standup.${Date.now()}.json`; // use a different file each time
const EDITOR = process.env.EDITOR || "vim";

// Database backup config
const MEMOS_DB = process.env.MEMOS_DB || path.join(process.env.HOME, ".memos/memos_prod.db");
const BACKUP_DIR = path.join(process.env.HOME, ".memos/dbBackups");

/**
 * Backup memos database before posting
 */
function backupDatabase() {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupFile = path.join(BACKUP_DIR, `memos_prod.${timestamp}.db`);
    fs.copyFileSync(MEMOS_DB, backupFile);
    console.log(`💾 Database backed up: ${path.basename(backupFile)}`);
    return true;
  }
  catch (e) {
    console.log(`⚠️  Backup failed: ${e.message}`);
    return false;
  }
}

/**
 * Get last standup content from memos DB
 */
function getLastStandup() {
  try {
    const content = execFileSync("sqlite3", [
      MEMOS_DB,
      "SELECT content FROM memo WHERE content LIKE '%#standup%' ORDER BY created_ts DESC LIMIT 1;"
    ], { encoding: "utf8" });
    return content || "";
  }
  catch (e) {
    return "";
  }
}

/**
 * Extract section content between div tags
 */
function extractSection(content, sectionName) {
  const regex = new RegExp(
    `<div class="standup-${sectionName}">([\\s\\S]*?)</div>`,
    "i"
  );
  const match = content.match(regex);
  return (match ? match[1].trim() : "").split("\n")
    .map(line => {
      if (/^[*#]{1,4}\s|^---$|^\s*$|^Key:|^</.test(line)) {
        return "";
      }
      // Strip list marker and normalize &nbsp; to spaces
      return line.replace(/^-\s*/, "").replace(/&nbsp;/g, " ");
    })
    .filter(l => l?.trim());
}

/**
 * Parse list items from markdown content
 * Returns array of {text, status} for yesterday, or strings for other sections
 *
 * Supports formats:
 * - [ ] text = not_started, - [x] text = done
 * - text + nested "- [ ] In Progress" = in_progress
 * - text + nested "- [x] Blocked" = blocked
 */
function parseListItems(lines, isYesterday = false) {
  const items = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Skip headers, empty lines, dividers
    if (/^#{1,4}\s|^---$|^\s*$|^Key:/.test(line)) continue;

    // Check for nested status indicators (update previous item)
    const nestedInProgress = line.match(/^\s+-\s*\[\s*\]\s*In Progress$/i);
    const nestedBlocked = line.match(/^\s+-\s*\[x\]\s*Blocked$/i);

    if (nestedInProgress && items.length > 0 && isYesterday) {
      items[items.length - 1].status = "in_progress";
      continue;
    }
    if (nestedBlocked && items.length > 0 && isYesterday) {
      items[items.length - 1].status = "blocked";
      continue;
    }

    // Match list items: - [ ] text, - [x] text, or plain text
    const checkboxMatch = line.match(/^\[([ xX])\]\s*(.+)$/);
    const plainMatch = line.match(/^(.+)$/);

    if (checkboxMatch) {
      const checked = checkboxMatch[1].toLowerCase() === "x";
      const text = checkboxMatch[2].trim();
      if (isYesterday) {
        if (!checked) {
          items.push({ text, status: "not_started" });
        }
      }
      else {
        items.push(text);
      }
    }
    else if (plainMatch) {
      const text = plainMatch[1].trim();
      if (text) {
        if (isYesterday) {
          items.push({ text, status: "not_started" });
        }
        else {
          items.push(text);
        }
      }
    }
  }

  return items;
}

/**
 * Parse blockers - extract text from checkbox format
 */
function parseBlockers(lines) {
  const items = [];

  for (const line of lines) {
    // Match: - [x] text or - [ ] text (checkbox format)
    const checkboxMatch = line.match(/^\[x?\]\s*(.+)$/i);

    if (checkboxMatch) {
      items.push(checkboxMatch[1].trim());
    }
  }

  return items;
}

/**
 * Parse today items - extract checkbox items
 */
function parseTodayItems(lines) {
  const items = [];

  for (const line of lines) {
    const match = line.match(/^\[([ xX])\]\s*(.+)$/);
    if (match) {
      const checked = match[1].toLowerCase() === "x";
      const text = match[2].trim();
      if (text) {
        items.push({ text, done: checked });
      }
    }
  }

  return items;
}

/**
 * Get automatic tasks based on day/week (e.g., trash day)
 */
function getAutoTasks() {
  const tasks = [];
  const dateInfo = getDateInfo();

  const trashRecycling = ["trash", "trash/recycling"][dateInfo.week % 2];
  const s = ["", "s"][dateInfo.week % 2];

  // Wednesday = trash day
  if (dateInfo.day === "Wednesday") {
    tasks.push(`Put ${trashRecycling} out!`);
  }
  if (dateInfo.day === "Thursday") {
    tasks.push(`Grab ${trashRecycling} bin${s}!`);
  }

  return tasks;
}

/**
 * Transform previous standup into new standup JSON
 */
function transformStandup(prevContent) {

  // Parse today's items to become yesterday (filter empty)
  const todaySection = extractSection(prevContent, "today");
  const todayItems = parseTodayItems(todaySection);
  const completeTasks = todayItems.filter(item => item.done);
  const incompleteTasks = todayItems.filter(item => !item.done);

  // if incomplete add to auto tasks
  const newToday = [
    "",
    ...incompleteTasks.map(item => `// ${item.text}`),
    ...getAutoTasks()
  ];

  // Parse previous yesterday items (to carry over incomplete ones)
  const yesterdaySection = extractSection(prevContent, "yesterday");
  const prevYesterdayItems = parseListItems(yesterdaySection, true);

  // Transform today -> yesterday with status, then add incomplete from previous yesterday
  const seenTexts = new Set();
  const newYesterday = [
    {
      text:"",
      status: "done,not_started,in_progress,done,blocked"
    },
    ...incompleteTasks.map(item => ({
      text: item.text,
      status: "done,not_started,in_progress,blocked" // User will update
    })),
    ...completeTasks.map(item => ({
      text: item.text,
      status: "done"
    })),
    ...prevYesterdayItems
  ].filter((y, i, arr) => {
    if (arr.length === 1) return true;
    if (!y?.text) return false;
    if (seenTexts.has(y.text)) return false;
    seenTexts.add(y.text);
    return true;
  });


  // Carry over notes and blockers as comments
  const blockersSection = extractSection(prevContent, "blockers");
  const prevBlockers = [
    "",
    ...parseBlockers(blockersSection).map(b => `// ${b}`)
  ];

  const notesSection = extractSection(prevContent, "notes");
  const newNotes = [
    "",
    ...notesSection.map(n => `// ${n}`)
  ];

  return {
    live: false,
    status: [""],
    breakfast: [""],
    today: newToday,
    yesterday: newYesterday,
    blockers: prevBlockers,
    notes: newNotes
  };
}

/**
 * Get current date info
 */
function getDateInfo() {
  const now = new Date();
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const yyyy = now.getFullYear();

  // Calculate ISO week number
  const jan1 = new Date(now.getFullYear(), 0, 1);
  const dayOfYear = Math.ceil((now - jan1 + 1) / 86400000);
  const weekNumber = Math.ceil((dayOfYear + jan1.getDay()) / 7);

  return {
    date: `${mm}-${dd}-${yyyy}`,
    day: days[now.getDay()],
    week: weekNumber
  };
}

// Yesterday (markdown checkboxes with nesting for in_progress/blocked)
const formatYesterdayItem = (item) => {
  switch (item.status) {
    case "done":
      return `- [x] ${item.text}`;
    case "in_progress":
      return `- ${item.text}\n  - [ ] In Progress`;
    case "blocked":
      return `- ${item.text}\n  - [x] Blocked`;
    case "not_started":
    default:
      return `- [ ] ${item.text}`;
  }
};

// format section list
const formatSectionList = (section, list) => {
  if (!list.length) {
    return "-";
  }

  switch(section) {
    case "today":
      return list.map(t => `- [ ] ${t}`).join("\n")
    case "yesterday":
      return list.map(formatYesterdayItem).join("\n");
    case "blockers":
      return list.map(t => `- [x] ${t}`).join("\n")
    default:
      return list.map(t => `- ${t}`).join("\n")
  }
}

/**
 * Generate standup content from JSON and template
 */
function generateStandup(json) {
  const dateInfo = getDateInfo();

  let template = fs.readFileSync(TEMPLATE_FILE, "utf8");

  // Replace date placeholders
  template = template.replace(/%%DATE%%/g, dateInfo.date);
  template = template.replace(/%%DAY%%/g, dateInfo.day);
  template = template.replace(/%%NOW%%/g, Date.now());

  for (const [section, list] of Object.entries(json)) {
    if (!Array.isArray(list)) continue;

    const sectionVisible = list.length > 0;
    const sectionRegEx = new RegExp(`%%${section.toUpperCase()}_LIST%%`, "g");
    const sectionLengthRegEx = new RegExp(`%%${section.toUpperCase()}_LIST_LENGTH%%`, "g");

    const sectionList = formatSectionList(section, list);
    const sectionListLength = sectionVisible ? "" : ' style="display: none"';

    template = template.replace(sectionRegEx, sectionList);
    template = template.replace(sectionLengthRegEx, sectionListLength);
  }

  return template;
}

/**
 * parse json and filter out blanks
 */
function parseStandupJson(json) {
  const standupJson = JSON5.parse(json);

  for (const [section, list] of Object.entries(standupJson)) {
    if (Array.isArray(list)) {
      standupJson[section] = list.filter(
        v => typeof v?.text !== "undefined" ? v.text?.trim() : v?.trim()
      );
    }
  }

  return standupJson;
}


// =============================================================================
// Main
// =============================================================================

// Get previous standup
const prevContent = getLastStandup();
if (prevContent) {
  console.log("Found previous standup, transforming...");
}
else {
  console.log("No previous standup found, creating blank...");
}

const standupJson = transformStandup(prevContent);
const formattedJson = JSON5.stringify(standupJson, {space: 2, quote: '"'})
  .replace(/^    "\/\/\s*/gm, '    \/\/ "');
  // ^^^ replace commented out strings with commented lines JSON5 compatible

// Write JSON file
fs.writeFileSync(JSON_FILE, formattedJson, "utf8");
console.log(`Wrote: ${JSON_FILE}`);

/**
 * Prompt user for yes/no/edit response
 */
function prompt(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

/**
 * Main edit loop
 */
async function editLoop() {
  while (true) {
    // Launch editor
    console.log(`\nLaunching ${EDITOR}...`);
    const editor = spawnSync(EDITOR, [JSON_FILE], { stdio: "inherit" });

    if (editor.status !== 0) {
      console.error(`Error: editor exited with status ${editor.status}`);
      process.exit(1);
    }

    // Read and parse JSON
    let editedJson;
    try {
      const content = fs.readFileSync(JSON_FILE, "utf8");
      editedJson = parseStandupJson(content);
    }
    catch (e) {
      console.error(`\n❌ JSON parse error: ${e.message}`);
      const answer = await prompt("\n(E)dit again, or (q)uit? [E/q]: ");
      if (answer === "q" || answer === "quit") {
        console.log("Cancelled.");
        process.exit(0);
      }
      continue; // Loop back to editor
    }

    // Check live flag
    if (!editedJson.live) {
      console.log("\n⚠️  Standup not marked as live (live: false)");
      const answer = await prompt("(E)dit again, (p)ost anyway, or (q)uit? [E/p/q]: ");

      if (answer === "q" || answer === "quit") {
        console.log("Cancelled.");
        process.exit(0);
      }
      else if (answer === "p" || answer === "post") {
        editedJson.live = true; // Force live for this post
      }
      else {
        continue; // Loop back to editor (default)
      }
    }

    // Proofread with Claude (light spelling/grammar fixes only)
    console.log("🔍 Proofreading with Claude...");
    try {
      const proofreadPrompt = [
        [
          "Fix only spelling and grammar errors in this JSON.",
          "Do not rewrite or rephrase anything.",
          "Keep the exact same JSON structure and keys.",
          "Return ONLY the corrected JSON, no explanation."
        ].join(" "),
        "",
        `${JSON5.stringify(editedJson, { space: 2, quote: '"' })}`
      ].join("\n");

      const claude = spawnSync("claude", ["-p", proofreadPrompt], {
        encoding: "utf8",
        timeout: 30000,
        stdio: ["pipe", "pipe", "pipe"]
      });

      if (claude.status === 0 && claude.stdout) {
        // Strip markdown code fences if present
        const jsonOutput = claude.stdout
          .replace(/^```(?:json5?|javascript)?\n?/i, "")
          .replace(/\n?```\s*$/i, "")
          .trim();

        editedJson = parseStandupJson(jsonOutput);

        console.log("✓ Proofread complete");
      }
      else {
        console.log("⚠️  Proofreading skipped (Claude unavailable)");
      }
    }
    catch (e) {
      console.log(`⚠️  Proofreading skipped: ${e.message}`);
    }

    const standupContent = generateStandup(editedJson);

    // Backup database before posting
    backupDatabase();

    // Post to memos
    console.log("Posting to memos...");
    const postMemo = spawnSync(path.join(SCRIPT_DIR, "postMemo"), [], {
      input: standupContent,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "inherit"] // capture stdout
    });

    if (postMemo.status !== 0) {
      // copy md to tmp
      fs.writeFileSync(JSON_FILE.replace(/json$/, "md"), standupContent, "utf8");

      console.error(`⚠️  Error posting to memos\n${postMemo.stderr}`);
      process.exit(1);
    }

    // Parse response and extract memo URL
    try {
      const response = JSON.parse(postMemo.stdout);
      console.log(`✅ Standup posted!\n   https://memos.machfour.com/${response.name}`);
    }
    catch (e) {
      console.log("✅ Standup posted!");
    }
    break; // Success, exit loop
  }
}

// Run the edit loop
editLoop().catch(e => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});
