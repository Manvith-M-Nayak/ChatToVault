/* ChatToVault — content script.
 *
 * Responsibilities:
 *   1. Detect which site we are on (claude.ai vs chatgpt.com).
 *   2. Find every assistant message in the DOM.
 *   3. Inject a save button per configured destination (Obsidian, Notion)
 *      under each one.
 *   4. On click, scrape that answer + the preceding user question as Markdown
 *      and ask the background service worker to write it to that destination.
 *
 * Messages stream in token-by-token and the user can switch chats without a
 * full page reload, so we use a MutationObserver to keep buttons in sync.
 */

(() => {
  "use strict";

  /* ------------------------------------------------------------------ *
   * SITE-SPECIFIC SELECTORS
   *
   * These are the only things likely to break when the sites change their
   * markup. Keep them here, clearly labeled, so they are easy to update.
   *
   * For each site we need:
   *   assistant : selector matching one assistant (AI) message block.
   *   user      : selector matching one user message block.
   *   content   : selector (relative to a message block) for the rendered
   *               text. Falls back to the block itself if not found.
   * ------------------------------------------------------------------ */
  const SELECTORS = {
    "claude.ai": {
      // Claude renders messages with data-testid attributes.
      assistant: '[data-testid="assistant-message"], div.font-claude-message',
      user: '[data-testid="user-message"]',
      content: ".prose, .font-claude-message, [class*='prose']",
      // Anchor inside the copy/retry action row under each answer; our button
      // is appended to that row's container.
      actionBar: '[data-testid="action-bar-copy"]',
    },
    "chatgpt.com": {
      // ChatGPT tags every turn with data-message-author-role.
      assistant: '[data-message-author-role="assistant"]',
      user: '[data-message-author-role="user"]',
      content: ".markdown, .prose, [class*='markdown']",
      actionBar: '[data-testid="copy-turn-action-button"]',
    },
  };

  // Resolve the active site's selector set. Bail out if unknown host.
  const HOST = location.hostname.replace(/^www\./, "");
  const SITE = SELECTORS[HOST];
  if (!SITE) return;

  const BTN_CLASS = "chattovault-btn";

  const WRAP_CLASS = "chattovault-actions";

  const LABELS = {
    obsidian: "Save to Obsidian",
    notion: "Save to Notion",
  };

  // Which destinations have their API settings filled in. One button per
  // configured destination; both configured -> both buttons. Kept in sync via
  // storage so editing options rebuilds buttons without a page refresh.
  const config = { obsidian: false, notion: false };
  const CONFIG_KEYS = { apiKey: "", notionToken: "", notionParent: "" };

  function enabledDests() {
    const dests = [];
    if (config.obsidian) dests.push("obsidian");
    if (config.notion) dests.push("notion");
    // Nothing configured yet: show the Obsidian button; clicking it surfaces
    // the "no API key" error that points the user at the options page.
    return dests.length ? dests : ["obsidian"];
  }

  function refreshConfig(then) {
    chrome.storage.local.get(CONFIG_KEYS, (items) => {
      config.obsidian = Boolean(items.apiKey);
      config.notion = Boolean(items.notionToken && items.notionParent);
      if (then) then();
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.apiKey || changes.notionToken || changes.notionParent) {
      refreshConfig(scanAndInject);
    }
  });

  // Map each assistant message element to its injected button. Both sites are
  // React apps that can drop our button on re-render while keeping the message
  // element itself, so we track the live button and re-inject when it is gone
  // (a flag attribute on the element would outlive the button and block that).
  const buttons = new WeakMap();

  /* ------------------------------------------------------------------ *
   * SCRAPING HELPERS
   * ------------------------------------------------------------------ */

  /* Convert a rendered message's HTML into Markdown so the saved note keeps
   * code blocks, lists, links, tables, and emphasis — Obsidian notes are .md,
   * and a flat innerText dump loses all of that structure. */
  function htmlToMarkdown(rootEl) {
    const walk = (node, listDepth) => {
      if (node.nodeType === Node.TEXT_NODE) {
        // Respect pre-wrap contexts (user prompts): keep their line breaks.
        const ws =
          node.parentElement &&
          getComputedStyle(node.parentElement).whiteSpace;
        return ws && ws.startsWith("pre")
          ? node.nodeValue
          : node.nodeValue.replace(/\s+/g, " ");
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return "";
      const el = node;
      const tag = el.tagName.toLowerCase();
      if (
        tag === "script" ||
        tag === "style" ||
        tag === "button" ||
        tag === "svg" ||
        el.classList.contains(BTN_CLASS) ||
        el.classList.contains(WRAP_CLASS) ||
        el.getAttribute("aria-hidden") === "true"
      ) {
        return "";
      }

      const inner = (depth = listDepth) =>
        Array.from(el.childNodes).map((n) => walk(n, depth)).join("");

      switch (tag) {
        case "br":
          return "\n";
        case "hr":
          return "\n\n---\n\n";
        case "strong":
        case "b": {
          const t = inner().trim();
          return t ? `**${t}**` : "";
        }
        case "em":
        case "i": {
          const t = inner().trim();
          return t ? `*${t}*` : "";
        }
        case "del":
        case "s": {
          const t = inner().trim();
          return t ? `~~${t}~~` : "";
        }
        case "code":
          // Inside <pre> the fence handler below owns the text.
          if (el.closest("pre")) return el.textContent;
          return "`" + el.textContent.trim() + "`";
        case "pre": {
          const codeEl = el.querySelector("code");
          const text = (codeEl || el).textContent.replace(/\n+$/, "");
          const lang =
            codeEl && /language-([\w+#.-]+)/.exec(codeEl.className || "");
          return `\n\n\`\`\`${lang ? lang[1] : ""}\n${text}\n\`\`\`\n\n`;
        }
        case "h1":
        case "h2":
        case "h3":
        case "h4":
        case "h5":
        case "h6":
          return `\n\n${"#".repeat(+tag[1])} ${inner().trim()}\n\n`;
        case "p":
          return `\n\n${inner().trim()}\n\n`;
        case "blockquote": {
          const t = inner().replace(/\n{3,}/g, "\n\n").trim();
          return `\n\n${t.split("\n").map((l) => `> ${l}`).join("\n")}\n\n`;
        }
        case "ul":
        case "ol": {
          const indent = "  ".repeat(listDepth);
          const items = Array.from(el.children)
            .filter((c) => c.tagName === "LI")
            .map((li, i) => {
              const marker = tag === "ol" ? `${i + 1}.` : "-";
              const body = Array.from(li.childNodes)
                .map((n) => walk(n, listDepth + 1))
                .join("")
                .replace(/\n{3,}/g, "\n")
                .trim()
                .split("\n")
                .map((l, j) => (j === 0 ? l : `${indent}  ${l}`))
                .join("\n");
              return `${indent}${marker} ${body}`;
            });
          return `\n\n${items.join("\n")}\n\n`;
        }
        case "a": {
          const href = el.getAttribute("href") || "";
          const t = inner().trim();
          return /^https?:/.test(href) && t ? `[${t}](${href})` : t;
        }
        case "img":
          return el.alt || "";
        case "table": {
          const rows = Array.from(el.querySelectorAll("tr"));
          if (!rows.length) return "";
          const cellText = (cell) =>
            Array.from(cell.childNodes)
              .map((n) => walk(n, 0))
              .join("")
              .replace(/\s*\n\s*/g, " ")
              .replace(/\|/g, "\\|")
              .trim();
          const lines = rows.map(
            (tr) =>
              "| " + Array.from(tr.children).map(cellText).join(" | ") + " |"
          );
          lines.splice(1, 0, "|" + " --- |".repeat(rows[0].children.length));
          return `\n\n${lines.join("\n")}\n\n`;
        }
        default: {
          const isBlock = /^(div|section|article|main|aside|header|footer|figure|figcaption|details|summary|li|tr|td|th|thead|tbody)$/.test(
            tag
          );
          return isBlock ? `\n${inner()}\n` : inner();
        }
      }
    };

    return walk(rootEl, 0)
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  // Extract a message element's content as Markdown.
  function extractText(messageEl) {
    if (!messageEl) return "";
    const contentEl = messageEl.querySelector(SITE.content) || messageEl;
    return htmlToMarkdown(contentEl);
  }

  // Given an assistant message element, find the user message immediately
  // before it in document order.
  function findPrecedingQuestion(assistantEl) {
    const userNodes = Array.from(document.querySelectorAll(SITE.user));
    let best = null;
    for (const u of userNodes) {
      // compareDocumentPosition: is u BEFORE assistantEl?
      const pos = assistantEl.compareDocumentPosition(u);
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) {
        best = u; // keep the last user node that precedes the answer
      }
    }
    return best ? extractText(best) : "";
  }

  /* ------------------------------------------------------------------ *
   * BUTTON INJECTION
   * ------------------------------------------------------------------ */

  function makeButton(assistantEl, dest) {
    const btn = document.createElement("button");
    btn.className = BTN_CLASS;
    btn.type = "button";
    btn.dataset.label = LABELS[dest];
    btn.textContent = LABELS[dest];
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleSave(btn, assistantEl, dest);
    });
    return btn;
  }

  // Find this answer's copy/retry action row so our button sits with the
  // site's own buttons. Walk up from the message, but stop before an ancestor
  // that spans multiple messages — that would find another answer's bar.
  function findActionBar(assistantEl) {
    if (!SITE.actionBar) return null;
    let node = assistantEl;
    for (let i = 0; i < 6 && node; i++, node = node.parentElement) {
      if (node.querySelectorAll(SITE.assistant).length > 1) return null;
      const anchor = node.querySelector(SITE.actionBar);
      if (anchor) return anchor.parentElement;
    }
    return null;
  }

  function injectButton(assistantEl) {
    const bar = findActionBar(assistantEl);
    const dests = enabledDests();
    const destsKey = dests.join(",");

    const existing = buttons.get(assistantEl);
    if (existing && existing.isConnected && existing.dataset.dests === destsKey) {
      // The action bar often renders only after streaming ends; if the buttons
      // were placed via the fallback, migrate them into the bar once it exists.
      if (bar && !bar.contains(existing)) bar.appendChild(existing);
      return;
    }
    // Settings changed which destinations exist: rebuild from scratch.
    if (existing) existing.remove();

    const wrap = document.createElement("span");
    wrap.className = WRAP_CLASS;
    wrap.dataset.dests = destsKey;
    dests.forEach((d) => wrap.appendChild(makeButton(assistantEl, d)));
    buttons.set(assistantEl, wrap);

    if (bar) {
      bar.appendChild(wrap);
    } else {
      // Fallback: SIBLING after the message block, never inside it — otherwise
      // extractText's whole-block fallback would scrape the button labels into
      // the saved answer.
      assistantEl.insertAdjacentElement("afterend", wrap);
    }
  }

  function scanAndInject() {
    // The selector list can match both a message block AND a wrapper nested
    // inside it (e.g. [data-testid="assistant-message"] containing
    // .font-claude-message) — that produced two buttons per answer. Only the
    // outermost match per message gets a button.
    Array.from(document.querySelectorAll(SITE.assistant))
      .filter((el) => !el.parentElement?.closest(SITE.assistant))
      .forEach(injectButton);
  }

  /* ------------------------------------------------------------------ *
   * SAVE FLOW + BUTTON STATES
   * ------------------------------------------------------------------ */

  function setState(btn, state) {
    btn.classList.remove(
      "chattovault-saving",
      "chattovault-saved",
      "chattovault-failed"
    );
    switch (state) {
      case "saving":
        btn.classList.add("chattovault-saving");
        btn.textContent = "Saving…";
        btn.disabled = true;
        break;
      case "saved":
        btn.classList.add("chattovault-saved");
        btn.textContent = "Saved ✓";
        btn.disabled = false;
        break;
      case "failed":
        btn.classList.add("chattovault-failed");
        btn.textContent = "Failed — retry";
        btn.disabled = false;
        break;
      default:
        btn.textContent = btn.dataset.label || "Save";
        btn.disabled = false;
    }
  }

  // Show "failed", then revert to idle so the button visibly stays reusable.
  // Guarded so a retry started meanwhile isn't clobbered back to idle.
  function flashFailed(btn) {
    setState(btn, "failed");
    setTimeout(() => {
      if (btn.classList.contains("chattovault-failed")) setState(btn, "idle");
    }, 4000);
  }

  // Streaming answers grow token-by-token. Sample the text until it stops
  // changing so a mid-stream click saves the whole answer, not a prefix.
  function waitForStableText(el, intervalMs = 600, timeoutMs = 120000) {
    return new Promise((resolve) => {
      let last = extractText(el);
      const started = Date.now();
      const tick = () => {
        const current = extractText(el);
        if (current === last || Date.now() - started >= timeoutMs) {
          resolve(current);
          return;
        }
        last = current;
        setTimeout(tick, intervalMs);
      };
      setTimeout(tick, intervalMs);
    });
  }

  async function handleSave(btn, assistantEl, dest) {
    setState(btn, "saving");

    const answer = await waitForStableText(assistantEl);
    const question = findPrecedingQuestion(assistantEl);

    if (!answer) {
      flashFailed(btn);
      return;
    }

    const payload = {
      type: "chattovault-save",
      dest,
      data: {
        question,
        answer,
        source: HOST, // "claude.ai" or "chatgpt.com"
        url: location.href,
      },
    };

    // sendMessage throws synchronously ("Extension context invalidated") if
    // the extension was reloaded after this content script was injected —
    // without the catch the button would stay disabled at "Saving…" forever.
    try {
      chrome.runtime.sendMessage(payload, (resp) => {
        // chrome.runtime.lastError fires if the worker is asleep/missing.
        if (chrome.runtime.lastError || !resp) {
          console.error("[ChatToVault]", chrome.runtime.lastError);
          flashFailed(btn);
          return;
        }
        if (resp.ok) {
          setState(btn, "saved");
          // Revert label after a moment so the button stays reusable —
          // unless another save already started on this button.
          setTimeout(() => {
            if (btn.classList.contains("chattovault-saved")) setState(btn, "idle");
          }, 2500);
        } else {
          console.error("[ChatToVault] save failed:", resp.error);
          flashFailed(btn);
        }
      });
    } catch (err) {
      console.error("[ChatToVault]", err);
      flashFailed(btn);
    }
  }

  /* ------------------------------------------------------------------ *
   * OBSERVERS — handle streaming + chat navigation without reload
   * ------------------------------------------------------------------ */

  // Debounce scans: streaming fires mutations very rapidly.
  let scanTimer = null;
  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scanAndInject();
    }, 300);
  }

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.body, { childList: true, subtree: true });

  // Both sites are SPAs; watch for URL changes (new chat) and rescan.
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      scheduleScan();
    }
  }, 1000);

  // Initial pass, once we know which destinations are configured.
  refreshConfig(scanAndInject);
})();
