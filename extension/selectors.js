/**
 * selectors.js — the ONE file to edit when LinkedIn changes its UI.
 *
 * IMPORTANT: this LinkedIn account's UI renders "buttons" as plain
 * <span>/<div> elements with obfuscated CSS-module class names (confirmed
 * via live inspection — e.g. class="_53737314 _529e1019 ..." with no
 * role="button" and no real <button> tag). Traditional CSS selectors are
 * NOT reliable here. Instead we match by:
 *   1. Exact/prefix visible TEXT (e.g. the element's own text is exactly
 *      "Message" or "Connect") — durable because the label a human reads
 *      doesn't change even when the underlying markup does.
 *   2. Functional HTML attributes (contenteditable="true") instead of
 *      cosmetic class names — these are semantic, not styling, so LinkedIn
 *      has much less reason to change them.
 *   3. Nearby ancestor aria-label text (e.g. "Invite John Smith to
 *      connect") for name verification, since the visible leaf text is
 *      often just "Connect" with no name.
 */
window.SFAssistant = window.SFAssistant || {};

window.SFAssistant.selectors = {
  // Broad candidate pool for text-based matching. Includes plain div/span
  // since real buttons here often aren't <button> or [role="button"] at all.
  CLICKABLE_CANDIDATES: 'button, a, div, span, [role="button"]',

  TEXT: {
    CONNECT: ["connect"],
    INVITE: ["invite"],
    MESSAGE: ["message"],
    PENDING: ["pending"],
    ADD_NOTE: ["add a note"],
    SEND_INVITE: ["send invitation", "send now", "send without a note", "send"],
    SEND_MESSAGE: ["send"],
    FOLLOW: ["follow"],
  },

  // Functional attributes — prefer these over class names wherever possible.
  TEXTBOX: 'div[contenteditable="true"], div[role="textbox"], div.msg-form__contenteditable',
  NOTE_TEXTAREA: "textarea#custom-message, textarea",

  // Heading text used by the profile-data scraper (see linkedin.js).
  HEADINGS: {
    ABOUT: "About",
    SKILLS: "Skills",
    EXPERIENCE: "Experience",
  },
};
