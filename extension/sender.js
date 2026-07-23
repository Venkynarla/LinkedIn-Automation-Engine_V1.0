/**
 * sender.js — responsible ONLY for typing and sending. Load after
 * linkedin.js, utils.js.
 */
window.SFAssistant = window.SFAssistant || {};

(function () {
  const { logger } = window.SFAssistant;
  const { delay } = window.SFAssistant.utils;
  const { findTextbox, clickSendMessage } = window.SFAssistant.linkedin;

  async function focusTextbox() {
    const box = await findTextbox();
    box.focus();
    return box;
  }

  function clearTextbox(box) {
    box.focus();
    document.execCommand("selectAll", false, null);
    document.execCommand("delete", false, null);
  }

  /** Insert text via execCommand, which fires the input events React-based
   * editors need to register the change (a raw .value/.innerText set often
   * gets silently reverted by frameworks that control the field). */
  function pasteText(box, text) {
    box.focus();
    document.execCommand("insertText", false, text);
  }

  /** Optional slower character-by-character typing, for cases where a
   * single bulk insertText doesn't trigger LinkedIn's "enable send button"
   * validation logic. */
  async function simulateTyping(box, text, delayPerCharMs = 15) {
    box.focus();
    for (const char of text) {
      document.execCommand("insertText", false, char);
      await delay(delayPerCharMs, delayPerCharMs * 2);
    }
  }

  async function clickSend() {
    return clickSendMessage();
  }

  /** Verify a send actually went through: the textbox clearing is a weak
   * signal (LinkedIn clears it optimistically before confirming), so this
   * also checks whether the sent text appears somewhere in the page (the
   * new message bubble) within the timeout. Falls back to the textbox-empty
   * check alone if a text match can't be confirmed either way. */
  async function verify(box, sentText, timeoutMs = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const stillHasText = (box.innerText || "").trim().length > 0;
      if (!stillHasText && sentText) {
        const found = document.body.innerText.includes(sentText.slice(0, 40));
        if (found) return true;
      } else if (!stillHasText && !sentText) {
        return true;
      }
      await delay(200, 300);
    }
    logger.warn("Could not positively confirm the message appeared in the thread — it may still have sent; check manually.");
    return false;
  }

  window.SFAssistant.sender = { focusTextbox, clearTextbox, pasteText, simulateTyping, clickSend, verify };
})();
