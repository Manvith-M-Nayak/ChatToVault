/* ChatVault — options page logic.
 * Loads saved settings into the form and persists edits to chrome.storage.sync.
 */

"use strict";

const DEFAULTS = {
  restUrl: "http://127.0.0.1:27123",
  apiKey: "",
  folder: "Chats/",
};

const $ = (id) => document.getElementById(id);

// Populate the form with stored values (or defaults).
function load() {
  chrome.storage.sync.get(DEFAULTS, (items) => {
    $("restUrl").value = items.restUrl;
    $("apiKey").value = items.apiKey;
    $("folder").value = items.folder;
  });
}

// Persist the form values.
function save() {
  const settings = {
    restUrl: $("restUrl").value.trim() || DEFAULTS.restUrl,
    apiKey: $("apiKey").value.trim(),
    folder: $("folder").value.trim() || DEFAULTS.folder,
  };

  chrome.storage.sync.set(settings, () => {
    const status = $("status");
    status.textContent = "Saved ✓";
    setTimeout(() => (status.textContent = ""), 1500);
  });
}

document.addEventListener("DOMContentLoaded", load);
$("save").addEventListener("click", save);
