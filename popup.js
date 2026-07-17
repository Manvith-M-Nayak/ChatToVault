/* ChatToVault — popup. Quick view/controls: destination status, frontmatter
 * toggles (saved instantly), Obsidian folder quick-edit, last save info.
 * Full settings stay on the options page.
 */

"use strict";

const $ = (id) => document.getElementById(id);

const FM_TOGGLES = ["fmCreated", "fmSource", "fmUrl"];
const DEFAULTS = {
  apiKey: "",
  notionToken: "",
  notionParent: "",
  folder: "Chats/",
  fmCreated: true,
  fmSource: true,
  fmUrl: true,
  lastSave: null,
};

function relTime(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function renderStatus(items) {
  const obsidian = Boolean(items.apiKey);
  const notion = Boolean(items.notionToken && items.notionParent);
  $("dotObsidian").classList.toggle("on", obsidian);
  $("stateObsidian").textContent = obsidian ? "active" : "not configured";
  $("dotNotion").classList.toggle("on", notion);
  $("stateNotion").textContent = notion ? "active" : "not configured";
}

function renderLastSave(last) {
  const el = $("lastSave");
  if (!last || !last.time) {
    el.textContent = "No saves yet.";
    return;
  }
  el.textContent = "";
  const dest = last.dest === "notion" ? "Notion" : "Obsidian";
  el.append(`${relTime(last.time)} → ${dest}: `);
  if (last.url) {
    const a = document.createElement("a");
    a.href = last.url;
    a.target = "_blank";
    a.textContent = last.title || "open";
    el.append(a);
  } else {
    el.append(last.title || "");
  }
}

function load() {
  chrome.storage.local.get(DEFAULTS, (items) => {
    renderStatus(items);
    FM_TOGGLES.forEach((k) => ($(k).checked = Boolean(items[k])));
    $("folder").value = items.folder;
    renderLastSave(items.lastSave);
  });
}

// Frontmatter toggles: write-through on change.
FM_TOGGLES.forEach((k) => {
  $(k).addEventListener("change", () => {
    chrome.storage.local.set({ [k]: $(k).checked });
  });
});

// Folder quick-edit: save on change (blur/Enter), flash confirmation.
$("folder").addEventListener("change", () => {
  const folder = $("folder").value.trim() || DEFAULTS.folder;
  chrome.storage.local.set({ folder }, () => {
    if (chrome.runtime.lastError) return;
    const note = $("saveNote");
    note.style.visibility = "visible";
    setTimeout(() => (note.style.visibility = "hidden"), 1200);
  });
});

$("openSettings").addEventListener("click", () => chrome.runtime.openOptionsPage());

// Live-refresh if settings change elsewhere (options page, a finished save).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local") load();
});

document.addEventListener("DOMContentLoaded", load);
