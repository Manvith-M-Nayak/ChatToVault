/* ChatVault — options page logic.
 * Loads saved settings into the form and persists edits to chrome.storage.local
 * (NOT sync — the API key must never leave this machine). Reads fall back to
 * the old sync storage once so pre-existing settings migrate cleanly.
 */

"use strict";

const DEFAULTS = {
  restUrl: "http://127.0.0.1:27123",
  apiKey: "",
  folder: "Chats/",
};

const $ = (id) => document.getElementById(id);

function fillForm(items) {
  $("restUrl").value = items.restUrl;
  $("apiKey").value = items.apiKey;
  $("folder").value = items.folder;
}

// Populate the form with stored values (or defaults). Prefer local storage;
// fall back to the legacy sync storage so old installs see their settings.
function load() {
  chrome.storage.local.get(DEFAULTS, (local) => {
    if (local.apiKey) return fillForm(local);
    chrome.storage.sync.get(DEFAULTS, fillForm);
  });
}

// Persist the form values.
function save() {
  const settings = {
    restUrl: $("restUrl").value.trim() || DEFAULTS.restUrl,
    apiKey: $("apiKey").value.trim(),
    folder: $("folder").value.trim() || DEFAULTS.folder,
  };

  chrome.storage.local.set(settings, () => {
    const status = $("status");
    // Write can fail (e.g. storage quota); lastError must be checked
    // or the user sees "Saved ✓" for settings that were never stored.
    if (chrome.runtime.lastError) {
      status.textContent = `Save failed: ${chrome.runtime.lastError.message}`;
      return;
    }
    // Scrub any key left behind by versions that stored it in sync.
    chrome.storage.sync.remove("apiKey");
    status.textContent = "Saved ✓";
    setTimeout(() => (status.textContent = ""), 1500);
  });
}

document.addEventListener("DOMContentLoaded", load);
$("save").addEventListener("click", save);
