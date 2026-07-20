# Privacy Policy — ChatToVault

_Last updated: 2026-07-20_

ChatToVault is a browser extension that saves individual AI responses from
claude.ai, chatgpt.com, and gemini.google.com to your own Obsidian vault or
Notion workspace. This policy explains what the extension does and does not do
with your data.

**ChatToVault is an unofficial, independent project. It is not affiliated with
or endorsed by Anthropic, OpenAI, Google, Obsidian, or Notion.**

## Summary

- **No telemetry.** The extension collects no analytics, no usage statistics,
  and no personal information.
- **No servers of ours.** There is no ChatToVault backend. Your data never
  passes through any server operated by the developer.
- **You control the destinations.** Content goes only to the destinations you
  configure — your local Obsidian instance and/or your Notion workspace.

## What data the extension handles

### Configuration you enter
Stored locally in `chrome.storage.local` on your own machine:

- Obsidian Local REST API URL and API key
- Notion integration token and parent page ID
- Target vault folder and frontmatter/section toggles

These are used only to authenticate save requests to the destinations you
chose. They are never transmitted anywhere else and are not synced to the
browser vendor's cloud.

### Chat content you save
When you click a save button, the question/answer pair from the current page is
converted to Markdown and sent **directly from your browser** to:

- **Obsidian** — via the Local REST API community plugin, over
  `http://127.0.0.1` (localhost). This content never leaves your machine.
- **Notion** — via the official Notion API (`https://api.notion.com`). This
  content is transmitted to and stored on Notion's servers, subject to
  [Notion's Privacy Policy](https://www.notion.so/Privacy-Policy). Only the
  specific responses you explicitly click Save on are sent.

Nothing is saved automatically; the extension acts only on an explicit click.

## Data the extension does NOT collect

- No browsing history
- No keystrokes or page content other than the response you choose to save
- No account credentials for claude.ai, chatgpt.com, or gemini.google.com
- No advertising or tracking identifiers

## Permissions

- `storage` — save your settings locally.
- Host permissions for claude.ai, chatgpt.com, gemini.google.com — inject the
  save buttons and read the response you save.
- `127.0.0.1` / `localhost` — reach your local Obsidian REST API.
- `api.notion.com` — create pages via the Notion API.

## Third-party services

If you enable the Notion destination, your saved content is subject to Notion's
own privacy terms. Obsidian saves stay entirely on your local machine.

## Changes

This policy may be updated; the "Last updated" date above reflects the latest
revision.

## Contact

Questions: manvithnayak8704@gmail.com
