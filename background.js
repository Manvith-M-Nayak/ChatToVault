/* ChatToVault — background service worker (MV3).
 *
 * Why here and not the content script: the fetch to Obsidian's Local REST API
 * is an HTTP (not HTTPS) request to localhost from an HTTPS page. Doing it from
 * the content script triggers CORS / mixed-content blocks. The service worker
 * is not bound by the page origin, so the request goes through cleanly.
 *
 * Flow: receive {question, answer, source, url} -> read settings from
 * chrome.storage -> build a Markdown note -> PUT it to a unique path -> reply
 * with {ok:true} or {ok:false, error}.
 */

"use strict";

const DEFAULTS = {
  restUrl: "http://127.0.0.1:27123",
  apiKey: "",
  folder: "Chats/",
  notionToken: "",
  notionParent: "",
  // Frontmatter properties — each can be toggled in options.
  fmCreated: true,
  fmSource: true,
  fmUrl: true,
  fmTags: false,
};

/* ---------------------------------------------------------------- *
 * SETTINGS
 * ---------------------------------------------------------------- */
/* Settings live in chrome.storage.local: sync storage is uploaded to the
 * browser vendor's servers and replicated to every signed-in device, which is
 * no place for an API key. Earlier versions used sync, so on first read we
 * migrate any old settings across and scrub the key from sync. */
function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(DEFAULTS, (local) => {
      if (local.apiKey) return resolve(local);
      chrome.storage.sync.get(DEFAULTS, (synced) => {
        if (synced.apiKey) {
          chrome.storage.local.set(synced);
          chrome.storage.sync.remove("apiKey");
        }
        resolve(synced);
      });
    });
  });
}

/* ---------------------------------------------------------------- *
 * FILENAME + PATH BUILDING
 * ---------------------------------------------------------------- */

// Strip characters illegal in filenames; collapse whitespace. May return ""
// if the input is entirely illegal characters — callers pick their own fallback.
function sanitizeForFilename(text) {
  const cleaned = (text || "")
    .replace(/[\\/:*?"<>|#^[\]]/g, "") // illegal / Obsidian-unfriendly chars
    .replace(/[\u0000-\u001F\u007F]/g, "") // control chars
    .replace(/\s+/g, " ")
    .trim();
  // Slice by code points, not UTF-16 units, so we never cut an emoji's
  // surrogate pair in half (encodeURIComponent throws on lone surrogates).
  const chars = Array.from(cleaned);
  let slug = chars.slice(0, 60).join("");
  // If we actually cut something, back off to the last full word so the
  // filename doesn't end mid-word ("…implement authenti"). A single word
  // longer than the limit keeps the hard cut.
  if (chars.length > 60) {
    const lastSpace = slug.lastIndexOf(" ");
    if (lastSpace > 0) slug = slug.slice(0, lastSpace);
  }
  // Trailing dots are stripped last: "name." is illegal on Windows.
  return slug.trim().replace(/\.+$/, "");
}

// Local-time timestamp, filesystem-safe (no colons). Filenames should match
// the user's clock; the frontmatter `created` field keeps the exact UTC
// instant. Milliseconds keep rapid saves collision-free.
function fileTimestamp(d) {
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    ` ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`
  );
}

// Build "folder/slug timestamp.md" then URL-encode each segment but KEEP the
// slashes that separate folders, so the REST API nests correctly.
function buildVaultPath(folder, question, date) {
  const slug = sanitizeForFilename(question) || "untitled";
  const filename = `${slug} ${fileTimestamp(date)}.md`;

  // Normalize folder: trim, ensure no leading slash, allow nested folders.
  const cleanFolder = (folder || "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");

  const rawPath = cleanFolder ? `${cleanFolder}/${filename}` : filename;

  // Encode each segment individually; join with literal "/".
  return rawPath
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

/* ---------------------------------------------------------------- *
 * NOTE BUILDING
 * ---------------------------------------------------------------- */

// Escape a value for safe single-line YAML. Backslashes first, then quotes,
// so a literal \ never turns into an invalid YAML escape sequence.
function yamlString(s) {
  return `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function buildNote({ question, answer, source, url }, date, settings) {
  // Only the properties the user enabled; no fields -> no frontmatter block.
  const fields = [];
  if (settings.fmCreated) fields.push(`created: ${date.toISOString()}`);
  if (settings.fmSource) fields.push(`source: ${source}`);
  if (settings.fmUrl) fields.push(`url: ${yamlString(url)}`);
  if (settings.fmTags) fields.push("tags: [ai-chat]");

  const frontmatter = fields.length
    ? ["---", ...fields, "---"].join("\n")
    : "";

  // No H1: in Obsidian the filename is the note title, and the full question
  // lives under "## Question" — a heading would only duplicate (and truncate).
  const body = [
    "## Question",
    "",
    question || "_(no question captured)_",
    "",
    "## Answer",
    "",
    answer || "",
    "",
  ].join("\n");

  return frontmatter ? `${frontmatter}\n\n${body}` : body;
}

/* ---------------------------------------------------------------- *
 * MARKDOWN -> NOTION BLOCKS
 *
 * Notion has no Markdown ingestion: pages are trees of typed JSON blocks.
 * This converts the Markdown we scrape into those blocks, respecting the
 * API's limits (2000 chars per rich-text segment, shallow nesting).
 * ---------------------------------------------------------------- */

const RICH_TEXT_LIMIT = 2000;

// Languages Notion's code block accepts (subset we're likely to meet).
const NOTION_LANGS = new Set([
  "bash", "c", "c#", "c++", "css", "diff", "docker", "go", "graphql",
  "html", "java", "javascript", "json", "kotlin", "lua", "makefile",
  "markdown", "matlab", "perl", "php", "plain text", "powershell",
  "python", "r", "ruby", "rust", "scala", "shell", "sql", "swift",
  "typescript", "xml", "yaml",
]);
const NOTION_LANG_ALIASES = {
  js: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript",
  py: "python", rb: "ruby", sh: "shell", zsh: "shell", yml: "yaml",
  cs: "c#", csharp: "c#", cpp: "c++", golang: "go", dockerfile: "docker",
};

function notionLang(lang) {
  const l = NOTION_LANG_ALIASES[(lang || "").toLowerCase()] || (lang || "").toLowerCase();
  return NOTION_LANGS.has(l) ? l : "plain text";
}

// Split text into <=2000-char rich-text segments, optionally annotated/linked.
function richText(text, annotations, link) {
  const out = [];
  for (let i = 0; i < text.length; i += RICH_TEXT_LIMIT) {
    const seg = { type: "text", text: { content: text.slice(i, i + RICH_TEXT_LIMIT) } };
    if (link) seg.text.link = { url: link };
    if (annotations) seg.annotations = annotations;
    out.push(seg);
  }
  return out;
}

// Parse inline Markdown (**bold**, *italic*, ~~strike~~, `code`, [x](url))
// into a Notion rich_text array.
function inlineToRichText(md) {
  const out = [];
  const patterns = [
    { re: /^\*\*([^*]+)\*\*/, ann: { bold: true } },
    { re: /^\*([^*]+)\*/, ann: { italic: true } },
    { re: /^~~([^~]+)~~/, ann: { strikethrough: true } },
    { re: /^`([^`]+)`/, ann: { code: true } },
  ];
  const linkRe = /^\[([^\]]+)\]\((https?:[^)\s]+)\)/;
  let rest = md;
  let plain = "";
  const flush = () => {
    if (plain) out.push(...richText(plain));
    plain = "";
  };
  while (rest) {
    const lm = linkRe.exec(rest);
    if (lm) {
      flush();
      out.push(...richText(lm[1], null, lm[2]));
      rest = rest.slice(lm[0].length);
      continue;
    }
    const p = patterns.find((p) => p.re.test(rest));
    if (p) {
      const m = p.re.exec(rest);
      flush();
      out.push(...richText(m[1], p.ann));
      rest = rest.slice(m[0].length);
      continue;
    }
    plain += rest[0];
    rest = rest.slice(1);
  }
  flush();
  return out;
}

// Convert a Markdown string into an array of Notion blocks. List nesting is
// capped at one child level (Notion limits nesting depth per request);
// anything deeper flattens to that level.
function markdownToBlocks(md) {
  const blocks = [];
  const lines = (md || "").split("\n");
  let i = 0;
  let lastTopListItem = null;

  while (i < lines.length) {
    const line = lines[i];

    const listMatch = /^(\s*)(?:[-*]|\d+\.)\s+(.*)$/.exec(line);
    if (!listMatch && line.trim()) lastTopListItem = null;

    // Fenced code block.
    const fence = /^```(\S*)\s*$/.exec(line);
    if (fence) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) buf.push(lines[i++]);
      i++; // skip closing fence
      blocks.push({
        object: "block",
        type: "code",
        code: { rich_text: richText(buf.join("\n")), language: notionLang(fence[1]) },
      });
      continue;
    }

    if (!line.trim()) { i++; continue; }

    if (/^---+\s*$/.test(line.trim())) {
      blocks.push({ object: "block", type: "divider", divider: {} });
      i++;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.min(heading[1].length, 3); // Notion max heading_3
      const key = `heading_${level}`;
      blocks.push({ object: "block", type: key, [key]: { rich_text: inlineToRichText(heading[2]) } });
      i++;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ""));
      blocks.push({ object: "block", type: "quote", quote: { rich_text: inlineToRichText(buf.join("\n")) } });
      continue;
    }

    if (/^\|.*\|\s*$/.test(line.trim())) {
      const rows = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i].trim())) {
        const cells = lines[i].trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
        if (!cells.every((c) => /^:?-{3,}:?$/.test(c))) rows.push(cells); // drop separator row
        i++;
      }
      if (rows.length) {
        const width = Math.max(...rows.map((r) => r.length));
        blocks.push({
          object: "block",
          type: "table",
          table: {
            table_width: width,
            has_column_header: true,
            has_row_header: false,
            children: rows.map((r) => ({
              object: "block",
              type: "table_row",
              table_row: {
                cells: Array.from({ length: width }, (_, c) => inlineToRichText(r[c] || "")),
              },
            })),
          },
        });
      }
      continue;
    }

    if (listMatch) {
      const type = /^\s*\d+\./.test(line) ? "numbered_list_item" : "bulleted_list_item";
      const block = { object: "block", type, [type]: { rich_text: inlineToRichText(listMatch[2]) } };
      const indented = listMatch[1].length >= 2;
      if (indented && lastTopListItem) {
        const pk = lastTopListItem.type;
        (lastTopListItem[pk].children = lastTopListItem[pk].children || []).push(block);
      } else {
        blocks.push(block);
        lastTopListItem = block;
      }
      i++;
      continue;
    }

    // Paragraph: consume consecutive plain lines.
    const buf = [line.trim()];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(```|#{1,6}\s|>|\||---+\s*$)/.test(lines[i].trim()) &&
      !/^(\s*)(?:[-*]|\d+\.)\s+/.test(lines[i])
    ) {
      buf.push(lines[i++].trim());
    }
    blocks.push({ object: "block", type: "paragraph", paragraph: { rich_text: inlineToRichText(buf.join(" ")) } });
  }

  return blocks;
}

/* ---------------------------------------------------------------- *
 * REST API PUT
 * ---------------------------------------------------------------- */

async function saveToObsidian(data, settings, date) {
  if (!settings.apiKey) {
    throw new Error("No API key set. Open ChatToVault options and paste it.");
  }

  // Tolerate users pasting the full header value ("Bearer <key>") — some
  // plugin UIs present it that way; we add the scheme ourselves below.
  const apiKey = settings.apiKey.replace(/^Bearer\s+/i, "");

  const path = buildVaultPath(settings.folder, data.question, date);
  const note = buildNote(data, date, settings);

  // Strip any trailing slash on the base URL to avoid a double slash.
  const base = settings.restUrl.replace(/\/+$/, "");
  const endpoint = `${base}/vault/${path}`;

  const res = await fetch(endpoint, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "text/markdown",
    },
    body: note,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`REST API ${res.status}: ${text || res.statusText}`);
  }

  return endpoint;
}

/* ---------------------------------------------------------------- *
 * NOTION PAGE CREATION
 * ---------------------------------------------------------------- */

// Accept a raw ID, a dashed UUID, or a full Notion URL; return the 32-hex ID.
// Anchored to the end: page slugs contain hex-valid letters ("...-Page-<id>")
// that would otherwise bleed into a floating match.
function extractNotionId(input) {
  const s = (input || "").split(/[?#]/)[0].replace(/-/g, "").replace(/\/+$/, "");
  const m = /([0-9a-f]{32})$/i.exec(s);
  return m ? m[1] : "";
}

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
const BLOCKS_PER_REQUEST = 100; // API cap on children per create/append

async function saveToNotion(data, settings, date) {
  const token = (settings.notionToken || "").replace(/^Bearer\s+/i, "");
  if (!token) {
    throw new Error("No Notion token set. Open ChatToVault options and paste it.");
  }
  const parentId = extractNotionId(settings.notionParent);
  if (!parentId) {
    throw new Error("No Notion parent page set. Paste the page URL in options.");
  }

  const title = sanitizeForFilename(data.question) || "AI Chat";

  // Notion tracks creation time itself and tags need a database, so of the
  // frontmatter toggles only source/url translate — as a line under the title.
  const children = [];
  if (settings.fmSource || settings.fmUrl) {
    const meta = [];
    if (settings.fmSource) meta.push(...richText(`Source: ${data.source}`));
    if (settings.fmSource && settings.fmUrl) meta.push(...richText(" — "));
    if (settings.fmUrl) meta.push(...richText(data.url, null, data.url));
    children.push({ object: "block", type: "paragraph", paragraph: { rich_text: meta } });
  }
  children.push(
    { object: "block", type: "heading_2", heading_2: { rich_text: richText("Question") } },
    ...markdownToBlocks(data.question || "(no question captured)"),
    { object: "block", type: "heading_2", heading_2: { rich_text: richText("Answer") } },
    ...markdownToBlocks(data.answer || "")
  );

  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "Notion-Version": NOTION_VERSION,
  };

  const res = await fetch(`${NOTION_API}/pages`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      parent: { page_id: parentId },
      properties: { title: { title: richText(title) } },
      children: children.slice(0, BLOCKS_PER_REQUEST),
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Notion API ${res.status}: ${body.message || res.statusText}`);
  }
  const page = await res.json();

  // Long notes: append the remaining blocks in API-sized chunks.
  for (let i = BLOCKS_PER_REQUEST; i < children.length; i += BLOCKS_PER_REQUEST) {
    const r = await fetch(`${NOTION_API}/blocks/${page.id}/children`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ children: children.slice(i, i + BLOCKS_PER_REQUEST) }),
    });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      throw new Error(`Notion API ${r.status} while appending: ${body.message || r.statusText}`);
    }
  }

  return page.url;
}

/* ---------------------------------------------------------------- *
 * MESSAGE HANDLER
 * ---------------------------------------------------------------- */

// Each button targets one destination; the content script sends it along.
async function handleSave(data, dest) {
  const settings = await getSettings();
  const date = new Date();
  return dest === "notion"
    ? saveToNotion(data, settings, date)
    : saveToObsidian(data, settings, date);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "chattovault-save") {
    handleSave(msg.data, msg.dest)
      .then((endpoint) => sendResponse({ ok: true, endpoint }))
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    // Return true to keep the message channel open for the async response.
    return true;
  }
});
