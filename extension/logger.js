/**
 * logger.js — structured logging, loaded first so every other file can use it.
 * Shared across content scripts via window.SFAssistant namespace (content
 * scripts from the same extension share one JS scope per page, so plain
 * top-level `const`/`function` declarations in multiple files collide —
 * this is why we attach everything to one namespace object instead).
 */
window.SFAssistant = window.SFAssistant || {};

(function () {
  const PREFIX = "[SalesFlow]";

  function fmt(level, args) {
    return [`${PREFIX} [${level}]`, ...args];
  }

  window.SFAssistant.logger = {
    info: (...args) => console.log(...fmt("INFO", args)),
    debug: (...args) => console.debug(...fmt("DEBUG", args)),
    warn: (...args) => console.warn(...fmt("WARN", args)),
    error: (...args) => console.error(...fmt("ERROR", args)),
  };
})();
