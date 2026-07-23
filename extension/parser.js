/**
 * parser.js — reads the currently-open conversation thread into structured
 * data. Load after utils.js, logger.js.
 *
 * ⚠️ UNVERIFIED: unlike detector.js/linkedin.js (which are built on button
 * behavior confirmed against your live LinkedIn session), this has NOT been
 * tested against a real open conversation. It uses a heuristic — find
 * elements whose text matches a timestamp pattern (e.g. "3:52 PM"), treat
 * each as one message, and read the sender name / body text near it. Expect
 * this to need the same debug-with-real-output loop as everything else in
 * this project before it's reliable. Designed to fail SAFELY: if parsing
 * finds nothing, it returns an empty array and logs a warning rather than
 * throwing — so a parser bug can't block the send flow.
 */
window.SFAssistant = window.SFAssistant || {};

(function () {
  const { logger } = window.SFAssistant;

  const TIME_PATTERN = /\b\d{1,2}:\d{2}\s*(AM|PM)?\b/i;
  const DATE_SEPARATOR_PATTERN = /^(TODAY|YESTERDAY|MON|TUE|WED|THU|FRI|SAT|SUN|JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)/i;
  const TYPING_INDICATOR_PATTERN = /is typing/i;

  function looksLikeDateSeparator(text) {
    return DATE_SEPARATOR_PATTERN.test(text.trim()) && text.trim().length < 30;
  }

  /** Find the scrollable conversation container — best-effort: the
   * textbox's message pane ancestor. Falls back to document if not found. */
  function findConversationContainer() {
    const textbox = document.querySelector(window.SFAssistant.selectors.TEXTBOX);
    if (!textbox) return null;
    let node = textbox;
    for (let i = 0; i < 10 && node; i++) {
      // A reasonable heuristic: a scrollable ancestor with many children.
      if (node.scrollHeight > node.clientHeight + 50 && node.children.length > 2) return node;
      node = node.parentElement;
    }
    return textbox.closest("section") || textbox.parentElement;
  }

  async function scrollMessagesToTop(container, maxScrolls = 15) {
    if (!container) return;
    let lastHeight = -1;
    for (let i = 0; i < maxScrolls; i++) {
      container.scrollTop = 0;
      await new Promise((r) => setTimeout(r, 400));
      if (container.scrollHeight === lastHeight) break; // no more content loaded
      lastHeight = container.scrollHeight;
    }
  }

  /**
   * Returns: [{ sender: "Me" | "<Name>", text: "...", raw: "..." }, ...]
   * "Me" is inferred by position/styling being inconsistent across
   * LinkedIn layouts, so this labels by the actual name text found instead
   * — the caller (backend prompt builder) can map the account owner's own
   * name to "Me" if needed.
   */
  function getConversation(container) {
    if (!container) {
      logger.warn("Conversation container not found — returning empty conversation.");
      return [];
    }

    const allTextEls = Array.from(container.querySelectorAll("span, div, p"));
    const timeMarkers = allTextEls.filter((el) => {
      const text = (el.innerText || "").trim();
      return TIME_PATTERN.test(text) && text.length < 40 && !looksLikeDateSeparator(text);
    });

    const messages = [];
    for (const marker of timeMarkers) {
      // Sender name: look at preceding siblings/ancestor text near the marker.
      let senderEl = marker.previousElementSibling;
      let sender = "";
      for (let i = 0; i < 3 && senderEl; i++) {
        const t = (senderEl.innerText || "").trim();
        if (t && t.length < 60 && !TIME_PATTERN.test(t)) {
          sender = t;
          break;
        }
        senderEl = senderEl.previousElementSibling;
      }

      // Message body: look at the parent row's largest text block that
      // isn't the timestamp or sender name itself.
      const row = marker.closest("li") || marker.parentElement?.parentElement || marker.parentElement;
      if (!row) continue;

      const bodyCandidates = Array.from(row.querySelectorAll("span, div, p"))
        .map((el) => (el.innerText || "").trim())
        .filter((t) => t && t !== sender && !TIME_PATTERN.test(t) && !looksLikeDateSeparator(t) && !TYPING_INDICATOR_PATTERN.test(t));

      const text = bodyCandidates.sort((a, b) => b.length - a.length)[0] || "";
      if (!text) continue;

      messages.push({ sender: sender || "Unknown", text, raw: row.innerText?.trim().slice(0, 300) });
    }

    // Dedupe consecutive identical entries (common when markers overlap rows).
    const deduped = messages.filter((m, i) => i === 0 || m.text !== messages[i - 1].text);

    logger.info(`Parsed ${deduped.length} message(s) from conversation.`);
    if (deduped.length === 0) {
      logger.warn("Parser found zero messages — this heuristic likely needs adjustment for this account's UI. Sending will still proceed without conversation context.");
    }
    return deduped;
  }

  window.SFAssistant.parser = { findConversationContainer, scrollMessagesToTop, getConversation };
})();
