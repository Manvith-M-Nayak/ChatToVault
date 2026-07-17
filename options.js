/* ChatToVault — options page logic.
 * Loads saved settings into the form and persists edits to chrome.storage.local
 * (NOT sync — keys and tokens must never leave this machine).
 */

"use strict";

const DEFAULTS = {
  restUrl: "http://127.0.0.1:27123",
  apiKey: "",
  folder: "Chats/",
  notionToken: "",
  notionParent: "",
  // Frontmatter property toggles.
  fmCreated: true,
  fmSource: true,
  fmUrl: true,
  // Note body section toggles.
  noteQHeading: true,
  noteQText: true,
  noteAHeading: true,
};

const FM_TOGGLES = ["fmCreated", "fmSource", "fmUrl"];
const BODY_TOGGLES = ["noteQHeading", "noteQText", "noteAHeading"];
const ALL_TOGGLES = [...FM_TOGGLES, ...BODY_TOGGLES];

const $ = (id) => document.getElementById(id);

function fillForm(items) {
  $("restUrl").value = items.restUrl;
  $("apiKey").value = items.apiKey;
  $("folder").value = items.folder;
  $("notionToken").value = items.notionToken || "";
  $("notionParent").value = items.notionParent || "";
  ALL_TOGGLES.forEach((k) => ($(k).checked = Boolean(items[k])));
  updateTitleWarning();
}

// Dropping the question text leaves the (60-char-truncated) title as the only
// record of the question — warn while that box is unticked.
function updateTitleWarning() {
  $("noteQTextWarning").hidden = $("noteQText").checked;
}

// Populate the form with stored values (or defaults).
function load() {
  chrome.storage.local.get(DEFAULTS, fillForm);
}

// Persist the form values.
function save() {
  const settings = {
    restUrl: $("restUrl").value.trim() || DEFAULTS.restUrl,
    apiKey: $("apiKey").value.trim(),
    folder: $("folder").value.trim() || DEFAULTS.folder,
    notionToken: $("notionToken").value.trim(),
    notionParent: $("notionParent").value.trim(),
  };
  ALL_TOGGLES.forEach((k) => (settings[k] = $(k).checked));

  chrome.storage.local.set(settings, () => {
    const status = $("status");
    // Write can fail (e.g. storage quota); lastError must be checked
    // or the user sees "Saved ✓" for settings that were never stored.
    if (chrome.runtime.lastError) {
      status.textContent = `Save failed: ${chrome.runtime.lastError.message}`;
      return;
    }
    status.textContent = "Saved ✓";
    setTimeout(() => (status.textContent = ""), 1500);
  });
}

document.addEventListener("DOMContentLoaded", load);
$("save").addEventListener("click", save);
$("noteQText").addEventListener("change", updateTitleWarning);
