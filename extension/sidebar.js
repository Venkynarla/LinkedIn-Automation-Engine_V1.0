/**
 * sidebar.js — SalesFlow LinkedIn Assistant panel.
 * Injects a floating panel on every LinkedIn profile page: view scraped
 * data, see contact history, generate an AI draft, edit it, send it, and
 * opt the prospect into/out of automation — all without leaving the tab.
 *
 * SCRAPING STRATEGY: rather than hard-coding LinkedIn's CSS class names
 * (which change often and vary by account type), this scrapes by finding
 * visible section HEADINGS ("About", "Skills", "Experience") by their text
 * content, then reads the nearest text block after them. This is far more
 * durable against markup changes, but LinkedIn's DOM still varies — if a
 * field comes back empty, check the console log this file prints on every
 * scrape and use "Rescan profile" after LinkedIn finishes loading.
 */

(function () {
const API_BASE = "https://linkedin-automation-engine-v1-0.onrender.com/api";

let state = {
  profile: null,
  prospect: null,
  sequence: null,
  history: [],
  draft: "",
  factsUsed: [],
  isFallback: false,
  messageType: "connection_note",
  connectionStatus: "unknown",
  loading: false,
};

function isProfilePage() {
  return /\/in\/[^/]+\/?$/.test(location.pathname);
}

// ---------- Scraping (heading-text based, not class-name based) ----------

/** Find an element whose own visible text (not descendants') matches `label`. */
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

/** From a heading element, walk up to its section container. */
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
  // LinkedIn duplicates text for accessibility (visually-hidden + aria-hidden
  // spans with the same content) — dedupe by using the visible one when both exist.
  const visible = el.querySelector('span[aria-hidden="true"]');
  return (visible ? visible.innerText : el.innerText || "").trim();
}

function scrapeAbout() {
  const heading = findHeading("About");
  console.log("[outreach-extension] About heading found:", !!heading);
  if (!heading) return "";
  const section = sectionFromHeading(heading);
  if (!section) return "";
  // The About text is usually the largest text block in the section.
  const candidates = Array.from(section.querySelectorAll("span, div"))
    .map((el) => cleanText(el))
    .filter((t) => t.length > 20);
  let about = candidates.sort((a, b) => b.length - a.length)[0] || "";

  // Clean up: strip a leading "About" heading that sometimes gets captured
  // as part of the same text block, and a trailing "Top skills" snippet
  // that LinkedIn sometimes renders inside the same container.
  about = about.replace(/^About\s*\n+/i, "").trim();
  about = about.replace(/\n+Top skills[\s\S]*$/i, "").trim();

  return about;
}

function scrapeSkills() {
  const heading = findHeading("Skills");
  console.log("[outreach-extension] Skills heading found:", !!heading);
  if (heading) {
    const section = sectionFromHeading(heading);
    if (section) {
      const items = Array.from(section.querySelectorAll('li, [role="listitem"]'))
        .map((li) => {
          const boldEl = li.querySelector(".t-bold, strong") || li;
          return cleanText(boldEl);
        })
        .filter((t) => t && t.length < 80);
      if (items.length) return [...new Set(items)].slice(0, 20);
    }
  }

  // Fallback: LinkedIn sometimes shows a "Top skills" snippet near the About
  // section even when the full Skills section isn't present/found. Grab that.
  const bodyText = document.body.innerText || "";
  const topSkillsMatch = bodyText.match(/Top skills\s*\n+([^\n]+)/i);
  if (topSkillsMatch) {
    const skills = topSkillsMatch[1].split(/[•|,]/).map((s) => s.trim()).filter(Boolean);
    console.log("[outreach-extension] Skills fallback (Top skills snippet) used:", skills);
    return skills;
  }

  return [];
}

function scrapeExperience() {
  const heading = findHeading("Experience");
  console.log("[outreach-extension] Experience heading found:", !!heading);
  if (!heading) return [];
  const section = sectionFromHeading(heading);
  if (!section) return [];
  const items = Array.from(section.querySelectorAll('li, [role="listitem"]'));
  const experience = items
    .map((li) => {
      const lines = Array.from(li.querySelectorAll("span"))
        .map((s) => cleanText(s))
        .filter(Boolean);
      const unique = [...new Set(lines)];
      return {
        title: unique[0] || "",
        company: unique[1] || "",
        duration: unique.find((l) => /\d{4}|mos|yrs|present/i.test(l)) || "",
      };
    })
    .filter((e) => e.title);
  return experience.slice(0, 5);
}

function scrapeName() {
  // Prefer the actual profile <h1> at the top of the page over any other
  // h1 that might exist elsewhere (e.g. in a "People also viewed" widget).
  const mainH1 = document.querySelector("main h1") || document.querySelector("h1");
  if (mainH1 && mainH1.innerText.trim()) return mainH1.innerText.trim();
  // Fallback: LinkedIn tab titles are usually "First Last | LinkedIn"
  const titleMatch = document.title.match(/^(.+?)\s*\|\s*LinkedIn/);
  return titleMatch ? titleMatch[1].trim() : "";
}

function scrapeHeadline() {
  const mainH1 = document.querySelector("main h1") || document.querySelector("h1");
  if (!mainH1) return "";
  const nameText = mainH1.innerText.trim();

  // Walk up a few ancestor levels from the name and collect short text lines
  // that appear near it — the headline is typically the first substantial
  // line after the name, before location/connections text.
  let container = mainH1.parentElement;
  for (let i = 0; i < 3 && container; i++) container = container.parentElement;
  if (!container) return "";

  const textNodes = Array.from(container.querySelectorAll("div, span"))
    .map((el) => el.innerText?.trim())
    .filter(Boolean)
    .filter((t) => t !== nameText)
    .filter((t) => t.length > 3 && t.length < 220)
    .filter((t) => !/^\d+(st|nd|rd|th)?\+? connections?$/i.test(t))
    .filter((t) => !/^Contact info$/i.test(t));

  console.log("[outreach-extension] headline candidates:", textNodes.slice(0, 5));
  return textNodes[0] || "";
}

async function scrollThroughPage() {
  const step = 900;
  const originalY = window.scrollY;
  let y = 0;
  const maxScroll = document.body.scrollHeight;
  while (y < maxScroll) {
    window.scrollTo(0, y);
    y += step;
    await new Promise((r) => setTimeout(r, 350));
  }
  window.scrollTo(0, originalY);
  await new Promise((r) => setTimeout(r, 400));
}

async function waitForProfileRender(timeoutMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const name = scrapeName();
    if (name) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

async function scrapeProfile() {
  await scrollThroughPage();
  await window.SFAssistant.executor.expandAllMoreButtons();

  const full_name = scrapeName();
  const headline = scrapeHeadline();
  const about = scrapeAbout();
  const skills = scrapeSkills();
  const experience = scrapeExperience();
  const designation = experience[0]?.title || "";
  const company = experience[0]?.company || "";

  const scraped = {
    linkedin_url: location.href.split("?")[0],
    full_name,
    headline,
    designation,
    company,
    about,
    skills,
    experience,
  };

  console.log("[outreach-extension] scraped profile:", scraped);
  return scraped;
}

// ---------- Backend calls ----------

async function upsertProspect(profile) {
  const res = await fetch(`${API_BASE}/prospects/upsert`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profile }),
  });
  return res.json();
}

async function requestDraft(messageType) {
  const res = await fetch(`${API_BASE}/draft`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      profile: state.profile,
      messageType,
      priorMessages: state.history,
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data; // { draft, factsUsed, isFallback }
}

async function recordSend(actionType, content) {
  const res = await fetch(`${API_BASE}/actions/send-now`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prospectId: state.prospect.id, actionType, content }),
  });
  return res.json();
}

async function toggleAutomation(paused) {
  const res = await fetch(`${API_BASE}/sequences/${state.sequence.id}/automation`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paused }),
  });
  return res.json();
}

// ---------- DOM actions ----------

function randomDelay(min, max) {
  return window.SFAssistant.utils.delay(min, max);
}

async function waitForSelector(selector, timeoutMs = 6000) {
  return window.SFAssistant.utils.waitForSelector(selector, timeoutMs);
}

// NOTE: button-finding, connection detection, and click logic all now live
// in linkedin.js / detector.js / sender.js (shared with executor.js and
// background.js automation) instead of being duplicated here. This is the
// single place those get called from for the manual sidebar flow.

async function clickSendConnection(note) {
  const { clickConnect, clickAddNote, clickSendInvite, findNoteTextarea } = window.SFAssistant.linkedin;

  // Truncate to LinkedIn's actual 200-char connection-note limit as a final
  // client-side safety net, in case an edited draft went over.
  if (note && note.length > 200) {
    const cut = note.slice(0, 200);
    const lastSpace = cut.lastIndexOf(" ");
    note = (lastSpace > 150 ? cut.slice(0, lastSpace) : cut).trim();
  }

  const { modal } = await clickConnect(state.profile?.full_name, { allowUnverifiedFallback: true });
  if (note) {
    const addNoteBtn = await clickAddNote(modal);
    if (addNoteBtn) {
      const textarea = await findNoteTextarea();
      if (textarea) {
        textarea.value = note;
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        await randomDelay(400, 800);
      }
    }
  }
  await clickSendInvite(modal);
}

async function clickSendMessage(text) {
  const { openMessagingSearchThread, findTextbox, clickSendMessage: clickSend } = window.SFAssistant.linkedin;
  await openMessagingSearchThread(state.profile?.full_name);
  const textbox = await findTextbox();
  textbox.focus();
  document.execCommand("insertText", false, text);
  await randomDelay(500, 800);
  await clickSend();
}

async function detectConnectionStatus() {
  const status = await window.SFAssistant.detector.detectConnectionStatus(state.profile?.full_name);
  // Map the shared enum (CONNECTED/NOT_CONNECTED/...) to this file's
  // lowercase convention used throughout the UI rendering below.
  return status.toLowerCase();
}


function recommendMessageType(connectionStatus, history) {
  if (connectionStatus === "not_connected") return "connection_note";
  if (connectionStatus === "connected") {
    const hasFirstMessage = history.some((h) => h.message_type === "first_message");
    return hasFirstMessage ? "followup" : "first_message";
  }
  return null; // pending or unknown — nothing actionable right now
}

// ---------- UI ----------

function connectionStatusBadge() {
  const labels = {
    not_connected: ["Not yet connected", "neutral"],
    pending: ["Connection request pending", "warn"],
    connected: ["Connected", "new"],
    unknown: ["Connection status unclear — check manually", "warn"],
  };
  const [text, variant] = labels[state.connectionStatus] || labels.unknown;
  return `<div class="ola-badge ola-badge-${variant}">${text}</div>`;
}

function panelHTML() {
  const alreadyContacted = state.history.length > 0;
  const lastMsg = state.history[state.history.length - 1];

  return `
    <div class="ola-header">
      <div class="ola-logo">
        <div class="ola-logo-icon">S</div>
        <div>
          <div class="ola-logo-text">Sales<span>Flow</span></div>
          <div class="ola-logo-sub">LinkedIn Assistant</div>
        </div>
      </div>
      <button id="ola-close" title="Collapse">—</button>
    </div>
    <div class="ola-body">
      ${
        state.loading
          ? `<div class="ola-loading">Working…</div>`
          : `
        <div class="ola-section">
          <div class="ola-label">Status</div>
          ${connectionStatusBadge()}
          ${
            alreadyContacted
              ? `<div class="ola-badge ola-badge-warn">Last sent: ${lastMsg.message_type} (${new Date(
                  lastMsg.sent_at
                ).toLocaleDateString()})</div>`
              : `<div class="ola-badge ola-badge-new">No prior messages sent</div>`
          }
          <div class="ola-history">
            ${state.history
              .map(
                (h) =>
                  `<div class="ola-history-item"><b>${h.message_type}</b> — ${new Date(
                    h.sent_at
                  ).toLocaleDateString()}<br/><span>${escapeHtml(h.content || "").slice(0, 120)}</span></div>`
              )
              .join("")}
          </div>
        </div>

        ${
          state.connectionStatus === "pending"
            ? `<div class="ola-section"><div class="ola-badge ola-badge-warn">Connection request pending — nothing to send until they accept.</div></div>`
            : `
        <div class="ola-section">
          <div class="ola-label">Draft type</div>
          <select id="ola-msgtype">
            <option value="connection_note" ${state.connectionStatus !== "not_connected" ? "disabled" : ""} ${state.messageType === "connection_note" ? "selected" : ""}>Connection note</option>
            <option value="first_message" ${state.connectionStatus !== "connected" ? "disabled" : ""} ${state.messageType === "first_message" ? "selected" : ""}>First message</option>
            <option value="followup" ${state.connectionStatus !== "connected" ? "disabled" : ""} ${state.messageType === "followup" ? "selected" : ""}>Follow-up</option>
          </select>
          <button id="ola-generate" class="ola-primary">Generate AI draft</button>
        </div>

        <div class="ola-section">
          <div class="ola-label">Draft (edit before sending)</div>
          ${state.isFallback ? `<div class="ola-badge ola-badge-warn">Offline fallback draft — review carefully</div>` : ""}
          <textarea id="ola-draft" rows="6">${escapeHtml(state.draft)}</textarea>
          ${
            state.factsUsed && state.factsUsed.length
              ? `<div class="ola-facts">
                  <div class="ola-label">Facts used</div>
                  <ul>${state.factsUsed.map((f) => `<li>${escapeHtml(f)}</li>`).join("")}</ul>
                 </div>`
              : ""
          }
        </div>

        <div class="ola-section ola-actions">
          <button id="ola-send" class="ola-primary">Send now</button>
          <button id="ola-rescan">Rescan profile</button>
        </div>`
        }

        <div class="ola-section">
          <div class="ola-label">Automation</div>
          <label class="ola-toggle">
            <input type="checkbox" id="ola-automation" ${state.sequence && !state.sequence.paused ? "checked" : ""} />
            Include this person in automated sequence (connect → message → follow-ups)
          </label>
        </div>
      `
      }
    </div>
  `;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.innerText = str || "";
  return div.innerHTML;
}

function render() {
  let panel = document.getElementById("ola-panel");
  if (!panel) {
    panel = document.createElement("div");
    panel.id = "ola-panel";
    document.body.appendChild(panel);
  }
  panel.innerHTML = panelHTML();
  attachHandlers(panel);
}

function attachHandlers(panel) {
  panel.querySelector("#ola-close")?.addEventListener("click", () => {
    panel.classList.toggle("ola-collapsed");
  });

  panel.querySelector("#ola-msgtype")?.addEventListener("change", (e) => {
    state.messageType = e.target.value;
  });

  panel.querySelector("#ola-generate")?.addEventListener("click", async () => {
    state.loading = true;
    render();
    try {
      const result = await requestDraft(state.messageType);
      state.draft = result.draft;
      state.factsUsed = result.factsUsed || [];
      state.isFallback = !!result.isFallback;
    } catch (err) {
      alert(`Draft failed: ${err.message}`);
    }
    state.loading = false;
    render();
  });

  panel.querySelector("#ola-draft")?.addEventListener("input", (e) => {
    state.draft = e.target.value;
  });

  panel.querySelector("#ola-rescan")?.addEventListener("click", async () => {
    await init();
  });

  panel.querySelector("#ola-automation")?.addEventListener("change", async (e) => {
    const paused = !e.target.checked;
    const result = await toggleAutomation(paused);
    state.sequence = result.sequence;
  });

  panel.querySelector("#ola-send")?.addEventListener("click", async () => {
    const draftText = panel.querySelector("#ola-draft").value.trim();
    if (!draftText) return alert("Draft is empty");
    if (!confirm(`Send this now?\n\n${draftText}`)) return;

    state.loading = true;
    render();
    try {
      if (state.messageType === "connection_note") {
        await clickSendConnection(draftText);
      } else {
        await clickSendMessage(draftText);
      }
      const actionType = state.messageType === "connection_note" ? "connect" : state.messageType === "followup" ? "followup" : "message";
      const result = await recordSend(actionType, draftText);
      state.sequence = result.sequence;

      const upsertResult = await upsertProspect(state.profile);
      state.history = upsertResult.history;
      state.draft = "";
      alert("Sent and logged.");
    } catch (err) {
      alert(`Send failed: ${err.message}`);
    }
    state.loading = false;
    render();
  });
}

// ---------- Init ----------

async function init() {
  if (!isProfilePage()) {
    document.getElementById("ola-panel")?.remove();
    return;
  }

  state.loading = true;
  render();

  const rendered = await waitForProfileRender();
  if (!rendered) {
    state.loading = false;
    render();
    console.warn("[outreach-extension] profile did not finish rendering in time");
    alert("SalesFlow Assistant: profile page didn't finish loading in time — try clicking 'Rescan profile'.");
    return;
  }

  state.profile = await scrapeProfile();
  const result = await upsertProspect(state.profile);
  state.prospect = result.prospect;
  state.sequence = result.sequence;
  state.history = result.history;
  state.draft = "";
  state.factsUsed = [];
  state.isFallback = false;

  state.connectionStatus = await detectConnectionStatus();
  const recommended = recommendMessageType(state.connectionStatus, state.history);
  if (recommended) state.messageType = recommended;

  state.loading = false;
  render();
}

let lastUrl = location.href;
new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    setTimeout(() => init(), 1500);
  }
}).observe(document.body, { childList: true, subtree: true });

init();
})();
