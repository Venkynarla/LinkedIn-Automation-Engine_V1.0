/**
 * executor.js — orchestrates one lead end-to-end. Split into named
 * functions (never one giant function), each returning
 * { success: true, data } or { success: false, error } — never throws
 * uncaught, per spec.
 *
 * Load after logger.js, utils.js, selectors.js, linkedin.js, detector.js,
 * sender.js, parser.js.
 */
window.SFAssistant = window.SFAssistant || {};

(function () {
  const { logger } = window.SFAssistant;
  const { delay, retry } = window.SFAssistant.utils;
  const { HEADINGS } = window.SFAssistant.selectors;
  const {
    clickConnect,
    clickAddNote,
    clickSendInvite,
    clickMessage,
    findTextbox,
    findNoteTextarea,
  } = window.SFAssistant.linkedin;
  const { STATUS, detectConnectionStatus } = window.SFAssistant.detector;
  const { focusTextbox, pasteText, clickSend, verify } = window.SFAssistant.sender;
  const { findConversationContainer, scrollMessagesToTop, getConversation } = window.SFAssistant.parser;

  const ok = (data) => ({ success: true, data });
  const fail = (error) => ({ success: false, error: typeof error === "string" ? error : error.message });

  // ---------- Profile scraping (heading-text based; same approach proven
  // durable earlier in this project) ----------

  function findHeading(label) {
    const candidates = document.querySelectorAll("h2, h3, span");
    const target = label.toLowerCase();
    for (const el of candidates) {
      const ownText = Array.from(el.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent.trim())
        .join(" ")
        .trim();
      const text = (ownText || el.innerText || "").trim().toLowerCase();
      if (text === target) return el;
    }
    return null;
  }

  function sectionFromHeading(headingEl) {
    let node = headingEl;
    for (let i = 0; i < 6 && node; i++) {
      if (node.tagName === "SECTION") return node;
      node = node.parentElement;
    }
    return headingEl.closest("section") || headingEl.parentElement;
  }

  function cleanText(el) {
    if (!el) return "";
    const visible = el.querySelector('span[aria-hidden="true"]');
    return (visible ? visible.innerText : el.innerText || "").trim();
  }

  function scrapeName() {
    const mainH1 = document.querySelector("main h1") || document.querySelector("h1");
    if (mainH1 && mainH1.innerText.trim()) return mainH1.innerText.trim();
    const titleMatch = document.title.match(/^(.+?)\s*\|\s*LinkedIn/);
    return titleMatch ? titleMatch[1].trim() : "";
  }

  function scrapeAbout() {
    const heading = findHeading(HEADINGS.ABOUT);
    if (!heading) return "";
    const section = sectionFromHeading(heading);
    if (!section) return "";
    const candidates = Array.from(section.querySelectorAll("span, div"))
      .map((el) => cleanText(el))
      .filter((t) => t.length > 20);
    let about = candidates.sort((a, b) => b.length - a.length)[0] || "";
    about = about.replace(/^About\s*\n+/i, "").trim();
    about = about.replace(/\n+Top skills[\s\S]*$/i, "").trim();
    return about;
  }

  async function scrollThroughPage() {
    const step = 900;
    const originalY = window.scrollY;
    let y = 0;
    const maxScroll = document.body.scrollHeight;
    while (y < maxScroll) {
      window.scrollTo(0, y);
      y += step;
      await delay(350);
    }
    window.scrollTo(0, originalY);
    await delay(400);
  }

  /** Click every "…more" / "show more" style expander on the page so
   * truncated About/Experience/Education sections reveal their full text
   * before we scrape — LinkedIn hides a lot of real content behind these. */
  async function expandAllMoreButtons(maxClicks = 25) {
    const { findLeafByText } = window.SFAssistant.linkedin;
    let clicked = 0;
    for (let i = 0; i < maxClicks; i++) {
      const btn = findLeafByText("…more", "... more", "see more", "show more", "show all");
      if (!btn) break;
      btn.click();
      clicked++;
      await delay(400, 700);
    }
    if (clicked) logger.info(`Expanded ${clicked} truncated section(s) before scraping.`);
    return clicked;
  }

  function scrapeProfile() {
    return {
      linkedin_url: location.href.split("?")[0],
      full_name: scrapeName(),
      about: scrapeAbout(),
    };
  }

  // ---------- Named workflow steps (per spec) ----------

  async function openProfile(url) {
    return retry(
      async () => {
        if (location.href.split("?")[0] !== url.split("?")[0]) {
          location.href = url;
          await delay(2500, 4500);
        }
        await scrollThroughPage();
        await expandAllMoreButtons();
        const name = scrapeName();
        if (!name) throw new Error("Profile did not finish rendering (no name found)");
        return { url, name };
      },
      { label: "openProfile" }
    );
  }

  async function detectConnection(fullName) {
    try {
      const status = await detectConnectionStatus(fullName);
      return ok(status);
    } catch (err) {
      return fail(err);
    }
  }

  async function sendConnection(fullName, note) {
    if (note && note.length > 200) {
      const cut = note.slice(0, 200);
      const lastSpace = cut.lastIndexOf(" ");
      note = (lastSpace > 150 ? cut.slice(0, lastSpace) : cut).trim();
    }
    return retry(
      async () => {
        const { modal } = await clickConnect(fullName, { allowUnverifiedFallback: false });
        if (note) {
          const addNoteBtn = await clickAddNote(modal);
          if (addNoteBtn) {
            const textarea = await findNoteTextarea();
            if (textarea) {
              textarea.value = note;
              textarea.dispatchEvent(new Event("input", { bubbles: true }));
              await delay(400, 800);
            }
          }
        }
        await clickSendInvite(modal);
        return { sent: true, note };
      },
      { label: "sendConnection" }
    );
  }

  async function openMessageBox(fullName) {
    return retry(
      async () => {
        await window.SFAssistant.linkedin.openMessagingSearchThread(fullName);
        const box = await findTextbox();
        return { opened: true, hasBox: !!box };
      },
      { label: "openMessageBox" }
    );
  }

  async function readConversation() {
    try {
      const container = findConversationContainer();
      await scrollMessagesToTop(container);
      const messages = getConversation(container);
      return ok(messages);
    } catch (err) {
      // Parser is best-effort — never block the flow on a parse failure.
      logger.warn("readConversation failed, continuing with empty history:", err.message);
      return ok([]);
    }
  }

  async function typeMessage(text) {
    return retry(
      async () => {
        const box = await focusTextbox();
        window.SFAssistant.sender.clearTextbox(box);
        pasteText(box, text);
        await delay(500, 900);
        return { box, text };
      },
      { label: "typeMessage" }
    );
  }

  async function sendMessage() {
    return retry(
      async () => {
        await clickSend();
        return { clicked: true };
      },
      { label: "sendMessage" }
    );
  }

  async function verifyMessage(boxResult) {
    try {
      const box = boxResult?.data?.box;
      const text = boxResult?.data?.text;
      if (!box) return ok({ verified: false, reason: "no textbox reference to verify against" });
      const confirmed = await verify(box, text);
      return ok({ verified: confirmed });
    } catch (err) {
      return fail(err);
    }
  }

  function closePopup() {
    const closeBtn = window.SFAssistant.linkedin.findLeafByText("close", "×");
    if (closeBtn) closeBtn.click();
    return ok({ closed: !!closeBtn });
  }

  /**
   * Full end-to-end run for one lead. This is what background.js calls via
   * message passing (see content.js). Returns a single structured result
   * summarizing every step, so background.js can update the DB and log
   * without needing to know DOM details.
   */
  async function processLead(lead) {
    logger.info("Processing lead:", lead.linkedin_url);
    const result = { steps: {}, finalStatus: null, sentContent: null };

    const openResult = await openProfile(lead.linkedin_url);
    result.steps.openProfile = openResult;
    if (!openResult.success) return { ...result, finalStatus: "ERROR" };

    const profile = scrapeProfile();
    const statusResult = await detectConnection(profile.full_name);
    result.steps.detectConnection = statusResult;
    if (!statusResult.success) return { ...result, finalStatus: "ERROR" };

    const status = statusResult.data;

    if (status === STATUS.NOT_CONNECTED) {
      const connResult = await sendConnection(profile.full_name, lead.connection_note);
      result.steps.sendConnection = connResult;
      result.finalStatus = connResult.success ? "CONNECTION_SENT" : "ERROR";
      result.sentContent = lead.connection_note;
      return result;
    }

    if (status === STATUS.CONNECTED) {
      const openBoxResult = await openMessageBox(profile.full_name);
      result.steps.openMessageBox = openBoxResult;
      if (!openBoxResult.success) return { ...result, finalStatus: "ERROR" };

      const conversationResult = await readConversation();
      result.steps.readConversation = conversationResult;

      // Caller (content.js/background.js) is expected to fetch the AI draft
      // from the backend using `profile` + `conversationResult.data`, then
      // call typeMessage/sendMessage/verifyMessage with the returned text —
      // executor.js never calls the AI itself, per spec ("never generate AI
      // inside extension").
      result.finalStatus = "READY_FOR_DRAFT";
      result.profile = profile;
      result.conversation = conversationResult.data;
      return result;
    }

    result.finalStatus = status; // PENDING, FOLLOW, or UNKNOWN — nothing actionable
    return result;
  }

  /** Second half of the flow, called after the caller has a draft in hand. */
  async function sendDraftedMessage(draftText) {
    const result = { steps: {} };

    const typeResult = await typeMessage(draftText);
    result.steps.typeMessage = typeResult;
    if (!typeResult.success) return { ...result, finalStatus: "ERROR" };

    const sendResult = await sendMessage();
    result.steps.sendMessage = sendResult;
    if (!sendResult.success) return { ...result, finalStatus: "ERROR" };

    const verifyResult = await verifyMessage(typeResult);
    result.steps.verifyMessage = verifyResult;

    result.finalStatus = "MESSAGE_SENT";
    result.sentContent = draftText;
    return result;
  }

  window.SFAssistant.executor = {
    openProfile,
    detectConnection,
    sendConnection,
    openMessageBox,
    readConversation,
    typeMessage,
    sendMessage,
    verifyMessage,
    closePopup,
    scrapeProfile,
    expandAllMoreButtons,
    processLead,
    sendDraftedMessage,
  };
})();
