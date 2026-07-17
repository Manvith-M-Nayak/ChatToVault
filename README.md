# ChatToVault

A Chromium (Manifest V3) browser extension that adds a **Save to Obsidian**
button under every AI response on **claude.ai** and **chatgpt.com**. Each click
saves that one answer — plus the question directly above it — as its own
Markdown note in your Obsidian vault, a page in Notion, or both.

Obsidian notes are written through Obsidian's **Local REST API** community
plugin; Notion pages through the official **Notion API**. Every click creates a
new file/page; nothing is ever overwritten.

---

## Note format

```markdown
---
created: 2026-06-22T10:30:00.000Z
source: claude.ai
url: "https://claude.ai/chat/…"
---

## Question

How do I center a div?

## Answer

Use flexbox: …
```

Filename = first ~60 chars of the (sanitized) question + a local-time
timestamp (with milliseconds), so files are unique and chronologically
sortable. The frontmatter `created` field keeps the exact UTC instant.

Each frontmatter property (`created`, `source`, `url`, `tags`) can be toggled
in the extension options. Defaults: `created`, `source`, and `url` on;
`tags` (adds `ai-chat`) off. Disable all four and the note is written with no
frontmatter block.

---

## Setup

### 1. Install & configure Obsidian's Local REST API plugin

_Skip to step 2 if you only save to Notion._

1. In Obsidian: **Settings → Community plugins → Browse**, search for
   **Local REST API**, install and enable it.
2. Open the plugin's settings.
3. **Enable the non-encrypted (HTTP) server.** This extension talks to the
   plain `http://127.0.0.1:27123` endpoint (the HTTPS endpoint uses a
   self-signed cert the extension does not trust).
4. **Copy the API key** shown in the plugin settings — you'll paste it into the
   extension.

> Keep Obsidian running while you use the button — the REST API only responds
> while the app is open.

### 2. Load the extension unpacked

1. Open `chrome://extensions` (works in Chrome, Edge, Brave, etc.).
2. Toggle **Developer mode** (top-right) on.
3. Click **Load unpacked** and select this project folder (the one containing
   `manifest.json`).
4. ChatToVault appears in your extension list.

### 3. Paste your settings

1. Click the extension's **Details → Extension options** (or right-click the
   icon → **Options**).
2. Fill in:
   - **Local REST API URL** — default `http://127.0.0.1:27123`.
   - **API Key** — paste the key from step 1.4.
   - **Target Vault Folder** — default `Chats/`.
3. Click **Save**.

### 4. (Optional) Notion setup

Only needed if you want a **Save to Notion** button:

1. Go to **notion.so/my-integrations** → **New connection** → select
   **Access token** as the authentication method → copy the secret token into
   **Notion Integration Token**.
2. In Notion, open (or create) the page that should hold saved chats. Page
   menu (•••) → **Connections** → add your connection.
3. Copy that page's URL into **Notion Parent Page** — the extension extracts
   the ID automatically. Each save creates a new subpage there.

Notion pages get the question/answer as native blocks (headings, code blocks,
lists, tables). Of the frontmatter toggles, `source` and `url` become a line
under the title; `created` is tracked by Notion itself; `tags` doesn't apply.

---

## Testing it

1. Make sure Obsidian is open with the Local REST API (HTTP) server enabled.
2. Open **https://claude.ai** or **https://chatgpt.com** and view any
   conversation.
3. Under each AI response you'll see a save button per configured
   destination: **Save to Obsidian** when the Obsidian API key is set,
   **Save to Notion** when the Notion token + parent page are set — both
   buttons when both are configured.
4. Click it. The label cycles:
   - **Saving…** → **Saved ✓** on success.
   - **Failed — retry** on error (check the API key / that Obsidian is running;
     open the page DevTools console for the exact error).
5. Check your vault — a new `.md` file appears in the `Chats/` folder. If
   saving to Notion, a new subpage appears under your parent page instead
   (or as well, with **Both**).

---

## How it works

| File           | Role                                                                          |
| -------------- | ----------------------------------------------------------------------------- |
| `manifest.json`| MV3 manifest: permissions, host permissions, content script + worker wiring.  |
| `content.js`   | Scrapes the DOM and injects buttons. Uses a `MutationObserver` for streaming. |
| `background.js`| Builds the note; PUTs Markdown to Obsidian and/or creates Notion pages (off-page, to dodge CORS). |
| `styles.css`   | Minimal button styling that inherits the page theme.                          |
| `options.html` / `options.js` | Settings UI, stored in `chrome.storage.local`.                 |

### Updating selectors

If claude.ai or chatgpt.com change their markup and buttons stop appearing,
edit the `SELECTORS` constant at the top of **`content.js`** — every
site-specific DOM query lives there, clearly labeled.

---

## Privacy

No telemetry. No API keys in code. Keys/tokens are stored in
`chrome.storage.local` — never synced to the browser vendor's servers.

- **Obsidian**: notes go straight from your browser to your local Obsidian
  instance; nothing leaves the machine.
- **Notion** (opt-in): saved chats are sent to Notion's servers via the
  official API — cloud storage, by definition. Only what you explicitly click
  Save on is sent.
