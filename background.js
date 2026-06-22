/* ChatVault — background service worker (MV3).
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
};

/* ---------------------------------------------------------------- *
 * SETTINGS
 * ---------------------------------------------------------------- */
function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(DEFAULTS, (items) => resolve(items));
  });
}

/* ---------------------------------------------------------------- *
 * FILENAME + PATH BUILDING
 * ---------------------------------------------------------------- */

// Strip characters illegal in filenames; collapse whitespace.
function sanitizeForFilename(text) {
  return (text || "untitled")
    .replace(/[\\/:*?"<>|#^[\]]/g, "") // illegal / Obsidian-unfriendly chars
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60)
    .trim();
}

// ISO timestamp, filesystem-safe (no colons).
function fileTimestamp(d) {
  return d.toISOString().replace(/[:.]/g, "-");
}

// Build "folder/slug timestamp.md" then URL-encode each segment but KEEP the
// slashes that separate folders, so the REST API nests correctly.
function buildVaultPath(folder, question, date) {
  const slug = sanitizeForFilename(question);
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

// Escape a value for safe single-line YAML.
function yamlString(s) {
  return `"${String(s).replace(/"/g, '\\"')}"`;
}

function buildNote({ question, answer, source, url }, date) {
  const created = date.toISOString();
  const title = sanitizeForFilename(question) || "AI Chat";

  const frontmatter = [
    "---",
    `created: ${created}`,
    `source: ${source}`,
    `url: ${yamlString(url)}`,
    "tags: [ai-chat]",
    "---",
  ].join("\n");

  const body = [
    `# ${title}`,
    "",
    "## Question",
    "",
    question || "_(no question captured)_",
    "",
    "## Answer",
    "",
    answer || "",
    "",
  ].join("\n");

  return `${frontmatter}\n\n${body}`;
}

/* ---------------------------------------------------------------- *
 * REST API PUT
 * ---------------------------------------------------------------- */

async function saveToObsidian(data) {
  const settings = await getSettings();

  if (!settings.apiKey) {
    throw new Error("No API key set. Open ChatVault options and paste it.");
  }

  const date = new Date();
  const path = buildVaultPath(settings.folder, data.question, date);
  const note = buildNote(data, date);

  // Strip any trailing slash on the base URL to avoid a double slash.
  const base = settings.restUrl.replace(/\/+$/, "");
  const endpoint = `${base}/vault/${path}`;

  const res = await fetch(endpoint, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${settings.apiKey}`,
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
 * MESSAGE HANDLER
 * ---------------------------------------------------------------- */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "chatvault-save") {
    saveToObsidian(msg.data)
      .then((endpoint) => sendResponse({ ok: true, endpoint }))
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    // Return true to keep the message channel open for the async response.
    return true;
  }
});
