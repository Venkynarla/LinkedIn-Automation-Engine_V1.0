/**
 * linkedin.js — reusable LinkedIn DOM actions. Load after logger.js,
 * utils.js, selectors.js.
 */
window.SFAssistant = window.SFAssistant || {};

(function () {
  const { logger } = window.SFAssistant;
  const { delay, waitUntil } = window.SFAssistant.utils;
  const { CLICKABLE_CANDIDATES, TEXT, TEXTBOX, NOTE_TEXTAREA } = window.SFAssistant.selectors;

  function elementText(el) {
    return (el.innerText || el.getAttribute("aria-label") || el.textContent || "").trim().toLowerCase();
  }

  /** Element whose OWN text exactly matches/starts with one of the options.
   * Skips large containers (we want small leaf labels, not whole sections). */
  function findLeafByText(...textOptions) {
    const targets = textOptions.map((t) => t.toLowerCase());
    const candidates = document.querySelectorAll(CLICKABLE_CANDIDATES);
    for (const el of candidates) {
      const text = elementText(el);
      if (!text || text.length > 60) continue;
      if (targets.some((t) => text === t || text.startsWith(t))) return el;
    }
    return null;
  }

  /** Same as findLeafByText but scoped to a specific container instead of
   * the whole document — used after opening a modal so we can't accidentally
   * match an unrelated button elsewhere on the page (e.g. a "Send" button on
   * a completely different post/widget). */
  function findLeafByTextInScope(scope, ...textOptions) {
    const targets = textOptions.map((t) => t.toLowerCase());
    const candidates = scope.querySelectorAll(CLICKABLE_CANDIDATES);
    for (const el of candidates) {
      const text = elementText(el);
      if (!text || text.length > 60) continue;
      if (targets.some((t) => text === t || text.startsWith(t))) return el;
    }
    return null;
  }

  /** Snapshot document.body's direct children right now, so a caller can
   * later find whatever NEW element got appended (e.g. a modal overlay). */
  function snapshotBodyChildren() {
    return new Set(Array.from(document.body.children));
  }

  /** Given a snapshot taken before some action, find the modal/overlay that
   * appeared as a result of it — the newest top-level child of <body> that
   * wasn't there before. Falls back to document.body (unscoped) if nothing
   * new is detectable, so callers degrade gracefully rather than breaking. */
  function findNewModalSince(beforeSnapshot) {
    const after = Array.from(document.body.children);
    const news = after.filter((el) => !beforeSnapshot.has(el));
    return news[news.length - 1] || document.body;
  }

  /** Connect/Invite element that specifically belongs to `fullName` — walks
   * up to 6 ancestor levels looking for an aria-label mentioning the name,
   * since the visible leaf text is usually just "Connect" with no name.
   * `allowUnverifiedFallback`: sidebar (human-reviewed) can fall back to a
   * single unambiguous candidate; automation should not. */
  function findConnectButtonForPerson(fullName, allowUnverifiedFallback = false) {
    const firstName = (fullName || "").trim().split(" ")[0].toLowerCase();
    const leafCandidates = Array.from(document.querySelectorAll(CLICKABLE_CANDIDATES)).filter((el) => {
      const text = elementText(el);
      return TEXT.CONNECT.includes(text) || TEXT.INVITE.some((t) => text === t || text.startsWith(t + " "));
    });

    for (const el of leafCandidates) {
      let node = el;
      for (let i = 0; i < 6 && node; i++) {
        const aria = ((node.getAttribute && node.getAttribute("aria-label")) || "").toLowerCase();
        if ((aria.includes("connect") || aria.includes("invite")) && (!firstName || aria.includes(firstName))) {
          return el;
        }
        node = node.parentElement;
      }
    }

    if (allowUnverifiedFallback && leafCandidates.length === 1) return leafCandidates[0];
    return null;
  }

  function findMessageButton() {
    const candidates = document.querySelectorAll(CLICKABLE_CANDIDATES);
    for (const el of candidates) {
      if (TEXT.MESSAGE.includes(elementText(el))) return el;
    }
    return null;
  }

  function findPendingIndicator() {
    return findLeafByText(...TEXT.PENDING);
  }

  async function clickConnect(fullName, { allowUnverifiedFallback = false, timeoutMs = 8000 } = {}) {
    const btn = await waitUntil(() => findConnectButtonForPerson(fullName, allowUnverifiedFallback), timeoutMs);
    if (!btn) throw new Error("Connect element not found or not verifiably matched to this person");
    logger.info("Clicking Connect");
    const beforeSnapshot = snapshotBodyChildren();
    btn.click();
    await delay(700, 1200);
    const modal = findNewModalSince(beforeSnapshot);
    logger.info("Connect modal resolved to:", modal === document.body ? "document.body (no new element detected — searches will be unscoped, less safe)" : modal.tagName);
    return { btn, modal };
  }

  async function clickMessage({ timeoutMs = 8000 } = {}) {
    const btn = await waitUntil(findMessageButton, timeoutMs);
    if (!btn) throw new Error("Message element not found");
    logger.info("Clicking Message");
    btn.click();
    await delay(700, 1200);
    return btn;
  }

  async function clickAddNote(modal, { timeoutMs = 3000 } = {}) {
    const scope = modal || document;
    const btn = await waitUntil(() => findLeafByTextInScope(scope, ...TEXT.ADD_NOTE), timeoutMs);
    if (btn) {
      btn.click();
      await delay(400, 800);
    }
    return btn;
  }

  async function clickSendInvite(modal, { timeoutMs = 5000 } = {}) {
    const scope = modal || document;
    const btn = await waitUntil(() => findLeafByTextInScope(scope, ...TEXT.SEND_INVITE), timeoutMs);
    if (!btn) throw new Error("Send-invitation element not found within the Connect modal");
    logger.info("Clicking Send (connection invite)");
    btn.click();
    return btn;
  }

  async function clickSendMessage({ timeoutMs = 5000 } = {}) {
    const btn = await waitUntil(() => findLeafByText(...TEXT.SEND_MESSAGE), timeoutMs);
    if (!btn) throw new Error("Send element not found");
    logger.info("Clicking Send (message)");
    btn.click();
    return btn;
  }

  async function findTextbox({ timeoutMs = 6000 } = {}) {
    const el = await waitUntil(() => document.querySelector(TEXTBOX), timeoutMs);
    if (!el) throw new Error("Message textbox not found");
    return el;
  }

  /**
   * Navigate to LinkedIn's actual Messaging page and use its search/filter
   * box to find this person's real conversation thread, instead of relying
   * on the small popup opened from the profile page. This is more reliable
   * for reading complete history and for correctly identifying the right
   * thread when a name is ambiguous.
   *
   * ⚠️ UNVERIFIED — built from the described LinkedIn messaging UI, not
   * confirmed against a live session yet. Expect this may need adjustment
   * the same way the profile-page buttons did.
   */
  async function openMessagingSearchThread(fullName, { timeoutMs = 15000 } = {}) {
    if (!location.href.includes("/messaging")) {
      location.href = "https://www.linkedin.com/messaging/";
      await delay(2500, 4000);
    }

    const searchInput = await waitUntil(() => {
      const inputs = document.querySelectorAll("input");
      for (const inp of inputs) {
        const label = (inp.getAttribute("aria-label") || inp.placeholder || "").toLowerCase();
        if (label.includes("search")) return inp;
      }
      return null;
    }, 8000);
    if (!searchInput) throw new Error("Messaging search input not found");

    searchInput.focus();
    searchInput.value = fullName;
    searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    await delay(1200, 1800);

    const firstName = (fullName || "").trim().split(" ")[0].toLowerCase();
    const threadItem = await waitUntil(() => {
      const items = document.querySelectorAll('li, [role="listitem"], div[role="button"]');
      for (const item of items) {
        const text = (item.innerText || "").toLowerCase();
        if (text.includes(firstName) && text.length < 300) return item;
      }
      return null;
    }, timeoutMs);
    if (!threadItem) throw new Error(`No matching conversation thread found for "${fullName}" in Messaging search results`);

    threadItem.click();
    await delay(1000, 1600);
    return threadItem;
  }

  async function findNoteTextarea({ timeoutMs = 3000 } = {}) {
    return waitUntil(() => document.querySelector(NOTE_TEXTAREA), timeoutMs);
  }

  function dumpClickableElements() {
    return Array.from(document.querySelectorAll(CLICKABLE_CANDIDATES))
      .map((el) => elementText(el))
      .filter(Boolean)
      .slice(0, 300);
  }

  window.SFAssistant.linkedin = {
    elementText,
    findLeafByText,
    findLeafByTextInScope,
    findConnectButtonForPerson,
    findMessageButton,
    findPendingIndicator,
    clickConnect,
    clickMessage,
    clickAddNote,
    clickSendInvite,
    clickSendMessage,
    findTextbox,
    findNoteTextarea,
    openMessagingSearchThread,
    dumpClickableElements,
  };
})();
