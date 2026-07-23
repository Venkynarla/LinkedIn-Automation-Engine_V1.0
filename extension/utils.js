/**
 * utils.js — wait helpers and the retry wrapper every DOM action goes
 * through. Load after logger.js.
 */
window.SFAssistant = window.SFAssistant || {};

(function () {
  const { logger } = window.SFAssistant;

  function delay(minMs, maxMs = minMs) {
    return new Promise((resolve) => setTimeout(resolve, minMs + Math.random() * (maxMs - minMs)));
  }

  /** Poll a finder function until it returns a truthy value or times out. */
  async function waitUntil(conditionFn, timeoutMs = 8000, intervalMs = 300) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const result = conditionFn();
      if (result) return result;
      await delay(intervalMs);
    }
    return null;
  }

  async function waitForSelector(selector, timeoutMs = 8000) {
    return waitUntil(() => document.querySelector(selector), timeoutMs);
  }

  async function waitUntilVisible(getEl, timeoutMs = 8000) {
    return waitUntil(() => {
      const el = getEl();
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 ? el : null;
    }, timeoutMs);
  }

  async function waitUntilEnabled(getEl, timeoutMs = 8000) {
    return waitUntil(() => {
      const el = getEl();
      if (!el) return null;
      return !el.disabled && el.getAttribute("aria-disabled") !== "true" ? el : null;
    }, timeoutMs);
  }

  /**
   * Every DOM action goes through this: try, wait, retry, fail — max 3
   * attempts. Returns { success, data } or { success:false, error } instead
   * of throwing, per the "every step returns a result object" convention.
   */
  async function retry(fn, { retries = 3, label = "action", delayMs = 800 } = {}) {
    let lastErr;
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const data = await fn();
        return { success: true, data };
      } catch (err) {
        lastErr = err;
        logger.warn(`${label} failed (attempt ${attempt}/${retries}): ${err.message}`);
        if (attempt < retries) await delay(delayMs, delayMs * 1.5);
      }
    }
    return { success: false, error: lastErr?.message || "unknown error" };
  }

  window.SFAssistant.utils = { delay, waitUntil, waitForSelector, waitUntilVisible, waitUntilEnabled, retry };
})();
