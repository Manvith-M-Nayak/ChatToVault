/* ChatToVault — background service worker (MV3).
 *
 * Why here and not the content script: the fetch to Obsidian's Local REST API
 * is an HTTP (not HTTPS) request to localhost from an HTTPS page. Doing it from
 * the content script triggers CORS / mixed-content blocks. The service worker
 * is not bound by the page origin, so the request goes through cleanly.
 *
 * Flow: receive {dest, data: {question, answer, source, url}} -> read settings
 * from chrome.storage -> either build a Markdown note and PUT it to Obsidian's
 * REST API, or convert to blocks and create a Notion page -> reply with
 * {ok:true} or {ok:false, error}.
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
  // Note body sections — each can be toggled in options.
  noteQHeading: true, // "## Question" heading
  noteQText: true, // the question text (duplicates the note title)
  noteAHeading: true, // "## Answer" heading
  // Heading texts, customizable in options.
  noteQLabel: "Question",
  noteALabel: "Answer",
  // Wrap mentions of existing vault notes in the answer as [[wikilinks]]
  // (Obsidian only — Notion has no wikilink equivalent).
  autoLink: false,
  // Note names never auto-linked (comma-separated, case-insensitive) —
  // generic words that would match in nearly every answer.
  autoLinkIgnore:
    "objective, c++, implementation, introduction, conclusion, summary, overview, example, notes, question, answer",
};

/* ---------------------------------------------------------------- *
 * SETTINGS
 * ---------------------------------------------------------------- */
/* Settings live in chrome.storage.local: sync storage is uploaded to the
 * browser vendor's servers and replicated to every signed-in device, which is
 * no place for API keys and tokens. */
function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(DEFAULTS, resolve);
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

// Local-time timestamp, filesystem-safe (no colons). Only used as a
// last-resort collision fallback — the created instant normally lives in the
// frontmatter `created` field, not the filename.
function fileTimestamp(d) {
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    ` ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`
  );
}

// Build "folder/slug.md" (plus an optional collision suffix) then URL-encode
// each segment but KEEP the slashes that separate folders, so the REST API
// nests correctly.
function buildVaultPath(folder, question, suffix) {
  const slug = sanitizeForFilename(question) || "untitled";
  const filename = `${slug}${suffix ? ` ${suffix}` : ""}.md`;

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

  const frontmatter = fields.length
    ? ["---", ...fields, "---"].join("\n")
    : "";

  // No H1: in Obsidian the filename is the note title. Each body section is
  // individually toggleable — e.g. the question text duplicates the title, so
  // users may drop it (though the title truncates at 60 chars and the full
  // question then lives nowhere).
  const qLabel = (settings.noteQLabel || "").trim() || "Question";
  const aLabel = (settings.noteALabel || "").trim() || "Answer";
  const parts = [];
  if (settings.noteQHeading) parts.push(`## ${qLabel}`, "");
  if (settings.noteQText)
    parts.push(question || "_(no question captured)_", "");
  // Divider between the question and answer sections (only when a question
  // section exists to divide from).
  if (settings.noteQHeading || settings.noteQText) parts.push("---", "");
  if (settings.noteAHeading) parts.push(`## ${aLabel}`, "");
  parts.push(answer || "", "");
  const body = parts.join("\n");

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
 * AUTO-LINKING
 *
 * Wrap the first mention of each existing vault note in the answer text as a
 * [[wikilink]]. The note list comes from the Local REST API's vault listing
 * and is cached in chrome.storage.local with an hourly TTL so saves don't
 * crawl the vault every time.
 * ---------------------------------------------------------------- */

const VAULT_INDEX_TTL = 60 * 60 * 1000; // 1 hour
const VAULT_INDEX_MAX_DIRS = 100; // crawl safety cap

// Recursively list every .md note name (basename, no extension) in the vault.
async function listVaultNotes(base, apiKey) {
  const enc = (p) => p.split("/").map(encodeURIComponent).join("/");
  const headers = { Authorization: `Bearer ${apiKey}` };
  const names = [];
  const queue = [""]; // vault-relative dirs, "" = root, each ends with "/"
  let visited = 0;
  while (queue.length && visited < VAULT_INDEX_MAX_DIRS) {
    const dir = queue.shift();
    visited++;
    const res = await fetch(`${base}/vault/${enc(dir)}`, { headers });
    if (!res.ok) continue;
    const body = await res.json().catch(() => null);
    if (!body || !Array.isArray(body.files)) continue;
    for (const f of body.files) {
      if (f.endsWith("/")) queue.push(dir + f);
      else if (f.endsWith(".md")) names.push(f.replace(/\.md$/, ""));
    }
  }
  return names;
}

// Cached wrapper. Keyed on the REST base URL so switching vaults invalidates;
// on fetch failure falls back to whatever stale cache exists.
async function getVaultNoteNames(base, apiKey) {
  const { vaultIndex } = await new Promise((resolve) =>
    chrome.storage.local.get({ vaultIndex: null }, resolve)
  );
  const fresh =
    vaultIndex &&
    vaultIndex.base === base &&
    Date.now() - vaultIndex.fetchedAt < VAULT_INDEX_TTL;
  if (fresh) return vaultIndex.names;
  try {
    const names = await listVaultNotes(base, apiKey);
    chrome.storage.local.set({
      vaultIndex: { base, fetchedAt: Date.now(), names },
    });
    return names;
  } catch {
    return vaultIndex ? vaultIndex.names : [];
  }
}

// Insert [[wikilinks]] for the first whole-word, case-insensitive mention of
// each note name — but never inside code fences, inline code, existing links,
// or URLs. Longest names first so "React Hooks" beats "React". A mention
// whose casing differs from the note name keeps its display text via alias
// syntax ("[[React Hooks|react hooks]]").
function autoLinkMarkdown(md, names) {
  if (!md || !names.length) return md;

  // Split into alternating safe (plain text) / protected segments.
  const PROTECT =
    /```[\s\S]*?```|`[^`\n]*`|\[\[[^\]]*\]\]|\[[^\]\n]*\]\([^)\n]*\)|https?:\/\/\S+/g;
  const parts = [];
  let last = 0;
  let m;
  while ((m = PROTECT.exec(md))) {
    if (m.index > last) parts.push({ text: md.slice(last, m.index), safe: true });
    parts.push({ text: m[0], safe: false });
    last = m.index + m[0].length;
  }
  if (last < md.length) parts.push({ text: md.slice(last), safe: true });

  const sorted = [...names].sort((a, b) => b.length - a.length);
  for (const name of sorted) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // \b only works next to word characters; skip it for names that start or
    // end with punctuation ("C++").
    const head = /^\w/.test(name) ? "\\b" : "";
    const tail = /\w$/.test(name) ? "\\b" : "";
    const re = new RegExp(`${head}${esc}${tail}`, "i");
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!part.safe) continue;
      const hit = re.exec(part.text);
      if (!hit) continue;
      const matched = hit[0];
      const link =
        matched === name ? `[[${name}]]` : `[[${name}|${matched}]]`;
      // Re-split so the inserted link is opaque to later (shorter) names.
      parts.splice(
        i,
        1,
        { text: part.text.slice(0, hit.index), safe: true },
        { text: link, safe: false },
        { text: part.text.slice(hit.index + matched.length), safe: true }
      );
      break; // first occurrence only
    }
  }
  return parts.map((p) => p.text).join("");
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

  // Strip any trailing slash on the base URL to avoid a double slash.
  const base = settings.restUrl.replace(/\/+$/, "");

  // Auto-link mentions of existing notes in the answer (toggle in options).
  if (settings.autoLink) {
    const names = await getVaultNoteNames(base, apiKey);
    // Never self-link the note being created, and skip user-ignored names —
    // generic words ("implementation") that would link in every answer.
    const ignored = new Set(
      (settings.autoLinkIgnore || "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    );
    ignored.add((sanitizeForFilename(data.question) || "untitled").toLowerCase());
    const usable = names.filter((n) => !ignored.has(n.toLowerCase()));
    data = { ...data, answer: autoLinkMarkdown(data.answer || "", usable) };
  }

  const note = buildNote(data, date, settings);

  // Filenames are just the question slug (the created time lives in the
  // frontmatter), so re-saving the same question would PUT over the old note.
  // Probe for a free name: "slug.md", then "slug 2.md", "slug 3.md", …, and
  // as a last resort a timestamped name that cannot collide.
  let path = buildVaultPath(settings.folder, data.question);
  for (let n = 2; ; n++) {
    const probe = await fetch(`${base}/vault/${path}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    }).catch(() => null);
    if (probe && probe.status === 404) break; // name is free — use it
    if (!probe || n > 20) {
      // Probe failed or absurd duplicate count: timestamped name can't collide.
      path = buildVaultPath(settings.folder, data.question, fileTimestamp(date));
      break;
    }
    path = buildVaultPath(settings.folder, data.question, n);
  }

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

  // Notion tracks creation time itself, so `created` is skipped. source/url
  // become a line under the title.
  const children = [];
  if (settings.fmSource || settings.fmUrl) {
    const meta = [];
    if (settings.fmSource) meta.push(...richText(`Source: ${data.source}`));
    if (settings.fmSource && settings.fmUrl) meta.push(...richText(" — "));
    if (settings.fmUrl) meta.push(...richText(data.url, null, data.url));
    children.push({ object: "block", type: "paragraph", paragraph: { rich_text: meta } });
  }
  // Same body-section toggles and heading labels as the Obsidian note.
  const qLabel = (settings.noteQLabel || "").trim() || "Question";
  const aLabel = (settings.noteALabel || "").trim() || "Answer";
  if (settings.noteQHeading)
    children.push({ object: "block", type: "heading_2", heading_2: { rich_text: richText(qLabel) } });
  if (settings.noteQText)
    children.push(...markdownToBlocks(data.question || "(no question captured)"));
  if (settings.noteQHeading || settings.noteQText)
    children.push({ object: "block", type: "divider", divider: {} });
  if (settings.noteAHeading)
    children.push({ object: "block", type: "heading_2", heading_2: { rich_text: richText(aLabel) } });
  children.push(...markdownToBlocks(data.answer || ""));

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
  const d = dest === "notion" ? "notion" : "obsidian";
  const result =
    d === "notion"
      ? await saveToNotion(data, settings, date)
      : await saveToObsidian(data, settings, date);

  // Record for the popup's "last save" line. Notion returns a user-facing
  // page URL; Obsidian's endpoint is an API URL, so only the title is shown.
  chrome.storage.local.set({
    lastSave: {
      time: Date.now(),
      dest: d,
      title: sanitizeForFilename(data.question) || "AI Chat",
      url: d === "notion" ? result : "",
    },
  });

  return result;
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
