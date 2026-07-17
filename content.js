/* ChatVault — content script.
 *
 * Responsibilities:
 *   1. Detect which site we are on (claude.ai vs chatgpt.com).
 *   2. Find every assistant message in the DOM.
 *   3. Inject a "Save to Obsidian" button under each one.
 *   4. On click, scrape that answer + the preceding user question and ask the
 *      background service worker to write it to Obsidian.
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
      user: '[data-testid="user-message"], div[data-testid="user-message"]',
      content: ".prose, .font-claude-message, [class*='prose']",
    },
    "chatgpt.com": {
      // ChatGPT tags every turn with data-message-author-role.
      assistant: '[data-message-author-role="assistant"]',
      user: '[data-message-author-role="user"]',
      content: ".markdown, .prose, [class*='markdown']",
    },
  };

  // Resolve the active site's selector set. Bail out if unknown host.
  const HOST = location.hostname.replace(/^www\./, "");
  const SITE = SELECTORS[HOST];
  if (!SITE) return;

  const BTN_CLASS = "chatvault-btn";

  // Map each assistant message element to its injected button. Both sites are
  // React apps that can drop our button on re-render while keeping the message
  // element itself, so we track the live button and re-inject when it is gone
  // (a flag attribute on the element would outlive the button and block that).
  const buttons = new WeakMap();

  /* ------------------------------------------------------------------ *
   * SCRAPING HELPERS
   * ------------------------------------------------------------------ */

  // Extract clean visible text from a message element.
  function extractText(messageEl) {
    if (!messageEl) return "";
    const contentEl = messageEl.querySelector(SITE.content) || messageEl;
    // innerText preserves line breaks roughly as rendered, which is good
    // enough for a Markdown note and avoids pulling in hidden UI text.
    return (contentEl.innerText || "").trim();
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

  function makeButton(assistantEl) {
    const btn = document.createElement("button");
    btn.className = BTN_CLASS;
    btn.type = "button";
    btn.textContent = "💾 Save to Obsidian";
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleSave(btn, assistantEl);
    });
    return btn;
  }

  function injectButton(assistantEl) {
    const existing = buttons.get(assistantEl);
    if (existing && existing.isConnected) return;

    const btn = makeButton(assistantEl);
    buttons.set(assistantEl, btn);
    // Insert as a SIBLING after the message block, never inside it — otherwise
    // extractText's whole-block fallback would scrape the button label into
    // the saved answer.
    assistantEl.insertAdjacentElement("afterend", btn);
  }

  function scanAndInject() {
    const assistants = document.querySelectorAll(SITE.assistant);
    assistants.forEach(injectButton);
  }

  /* ------------------------------------------------------------------ *
   * SAVE FLOW + BUTTON STATES
   * ------------------------------------------------------------------ */

  function setState(btn, state) {
    btn.classList.remove(
      "chatvault-saving",
      "chatvault-saved",
      "chatvault-failed"
    );
    switch (state) {
      case "saving":
        btn.classList.add("chatvault-saving");
        btn.textContent = "Saving…";
        btn.disabled = true;
        break;
      case "saved":
        btn.classList.add("chatvault-saved");
        btn.textContent = "Saved ✓";
        btn.disabled = false;
        break;
      case "failed":
        btn.classList.add("chatvault-failed");
        btn.textContent = "Failed — retry";
        btn.disabled = false;
        break;
      default:
        btn.textContent = "💾 Save to Obsidian";
        btn.disabled = false;
    }
  }

  function handleSave(btn, assistantEl) {
    const answer = extractText(assistantEl);
    const question = findPrecedingQuestion(assistantEl);

    if (!answer) {
      setState(btn, "failed");
      return;
    }

    setState(btn, "saving");

    const payload = {
      type: "chatvault-save",
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
          console.error("[ChatVault]", chrome.runtime.lastError);
          setState(btn, "failed");
          return;
        }
        if (resp.ok) {
          setState(btn, "saved");
          // Revert label after a moment so the button stays reusable.
          setTimeout(() => setState(btn, "idle"), 2500);
        } else {
          console.error("[ChatVault] save failed:", resp.error);
          setState(btn, "failed");
        }
      });
    } catch (err) {
      console.error("[ChatVault]", err);
      setState(btn, "failed");
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

  // Initial pass.
  scanAndInject();
})();
