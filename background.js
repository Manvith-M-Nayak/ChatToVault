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
  // Trailing dots are stripped last: "name." is illegal on Windows.
  return Array.from(cleaned).slice(0, 60).join("").trim().replace(/\.+$/, "");
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

  // Tolerate users pasting the full header value ("Bearer <key>") — some
  // plugin UIs present it that way; we add the scheme ourselves below.
  const apiKey = settings.apiKey.replace(/^Bearer\s+/i, "");

  const date = new Date();
  const path = buildVaultPath(settings.folder, data.question, date);
  const note = buildNote(data, date);

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
