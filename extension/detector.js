/**
 * detector.js — connection status detection. Load after linkedin.js.
 */
window.SFAssistant = window.SFAssistant || {};

(function () {
  const { logger } = window.SFAssistant;
  const { findMessageButton, findConnectButtonForPerson, findLeafByText, elementText } = window.SFAssistant.linkedin;
  const { TEXT } = window.SFAssistant.selectors;

  const STATUS = {
    CONNECTED: "CONNECTED",
    NOT_CONNECTED: "NOT_CONNECTED",
    PENDING: "PENDING",
    FOLLOW: "FOLLOW",
    UNKNOWN: "UNKNOWN",
  };

  /** Detect connection status. IMPORTANT ORDER: some LinkedIn profiles show
   * BOTH "Connect" and "Message" buttons at once (2nd-degree connections
   * with open messaging / InMail enabled) — a visible Connect button always
   * means "not actually connected yet", even if Message is also offered.
   * ALSO: on 3rd-degree profiles, LinkedIn often hides "Connect" inside the
   * "More" dropdown instead of showing it directly (only Message/Follow/More
   * show at the top level) — so if Connect isn't immediately visible, this
   * opens "More" and checks again before concluding CONNECTED. */
  async function detectConnectionStatus(fullName) {
    const { delay } = window.SFAssistant.utils;
    let hasConnect = findConnectButtonForPerson(fullName, true);

    if (!hasConnect) {
      const moreBtn = findLeafByText("more");
      if (moreBtn) {
        // Diff-based approach: the More dropdown's "Connect" menu item is
        // usually generic (no per-person aria-label), so name-verification
        // fails on it even when it's correctly this profile's own option.
        // Instead, capture which "Connect"-like elements exist BEFORE
        // opening the dropdown, then treat whatever's NEW after opening it
        // as belonging to this profile — since we deliberately opened
        // THIS profile's own More menu to reveal it.
        const beforeConnects = new Set(
          Array.from(document.querySelectorAll(window.SFAssistant.selectors.CLICKABLE_CANDIDATES)).filter(
            (el) => elementText(el) === "connect"
          )
        );
        moreBtn.click();
        await delay(500, 900);
        const afterConnects = Array.from(document.querySelectorAll(window.SFAssistant.selectors.CLICKABLE_CANDIDATES)).filter(
          (el) => elementText(el) === "connect"
        );
        const newConnect = afterConnects.find((el) => !beforeConnects.has(el));
        if (newConnect) hasConnect = newConnect;
        moreBtn.click(); // toggle the dropdown closed again
        await delay(200, 400);
      }
    }

    let status;
    if (hasConnect) {
      status = STATUS.NOT_CONNECTED;
    } else if (findMessageButton()) {
      status = STATUS.CONNECTED;
    } else if (findLeafByText(...TEXT.PENDING)) {
      status = STATUS.PENDING;
    } else if (findLeafByText(...TEXT.FOLLOW)) {
      status = STATUS.FOLLOW;
    } else {
      status = STATUS.UNKNOWN;
    }
    logger.info("Detected connection status:", status);
    return status;
  }

  window.SFAssistant.detector = { STATUS, detectConnectionStatus };
})();
