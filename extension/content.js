/**
 * content.js — thin bridge between background.js (the controller) and
 * executor.js (the DOM logic). Never manipulates the DOM itself. Load LAST
 * of the content scripts, after executor.js.
 */
window.SFAssistant = window.SFAssistant || {};

(function () {
  const { logger } = window.SFAssistant;
  const { executor } = window.SFAssistant;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.target !== "content") return false;

    logger.debug("Received command:", message.type, message.payload);

    (async () => {
      try {
        let result;
        switch (message.type) {
          case "PROCESS_LEAD":
            result = await executor.processLead(message.payload.lead);
            break;
          case "SEND_DRAFTED_MESSAGE":
            result = await executor.sendDraftedMessage(message.payload.draftText);
            break;
          case "PING":
            result = { success: true, data: "pong" };
            break;
          default:
            result = { success: false, error: `Unknown command type: ${message.type}` };
        }
        sendResponse(result);
      } catch (err) {
        logger.error("Unhandled error processing command:", err);
        sendResponse({ success: false, error: err.message });
      }
    })();

    return true; // keep the message channel open for the async response
  });

  logger.info("Content bridge ready.");
})();
