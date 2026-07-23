/**
 * background.js — the automation controller (MV3 service worker).
 *
 * IMPORTANT MV3 CONSTRAINT: service workers are event-driven and can be
 * killed/restarted by Chrome at any time — a literal `while(true)` loop
 * (as in the requested pseudocode) is not viable here. This uses
 * chrome.alarms instead, which is the standard MV3-compatible way to get a
 * repeating loop: each alarm firing does ONE tick (one lead), then Chrome
 * may suspend the worker until the next alarm, at which point it wakes and
 * continues. Net effect is the same repeating behavior, just resilient to
 * the worker being torn down between ticks.
 *
 * This is a NEW capability, not something confirmed working against your
 * live LinkedIn session — test carefully, on a low lead-count run first.
 */

const API_BASE = "https://linkedin-automation-engine-v1-0.onrender.com/api";
const ALARM_NAME = "sf-automation-tick";
const TICK_INTERVAL_MINUTES = 1; // checks for due work every minute; actual send pacing is controlled by the backend scheduler's own delays

function log(...args) {
  console.log("[SalesFlow:background]", ...args);
}

async function getRunningState() {
  const { automationRunning } = await chrome.storage.local.get("automationRunning");
  return !!automationRunning;
}

async function setRunningState(running) {
  await chrome.storage.local.set({ automationRunning: running });
}

async function startAutomation() {
  await setRunningState(true);
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: TICK_INTERVAL_MINUTES });
  log("Automation started.");
  runTick(); // run immediately instead of waiting for the first alarm
}

async function stopAutomation() {
  await setRunningState(false);
  chrome.alarms.clear(ALARM_NAME);
  log("Automation stopped.");
}

async function fetchNextLead() {
  const res = await fetch(`${API_BASE}/nextLead`);
  if (!res.ok) throw new Error(`fetchNextLead HTTP ${res.status}`);
  const data = await res.json();
  return data.lead || null;
}

async function postStatus(leadId, status, extra = {}) {
  await fetch(`${API_BASE}/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ leadId, status, ...extra }),
  });
}

async function postError(leadId, error) {
  await fetch(`${API_BASE}/error`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ leadId, error }),
  });
}

async function fetchDraft(profile, conversation, campaignId) {
  const res = await fetch(`${API_BASE}/draft`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      profile,
      messageType: conversation?.length ? "followup" : "first_message",
      priorMessages: conversation,
      campaignId,
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.draft;
}

/** Send a command to the content script running in `tabId` and await its
 * structured result. Rejects if the tab has no content script listening
 * (e.g. page hasn't finished loading yet). */
function sendToContentScript(tabId, type, payload) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { target: "content", type, payload }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

async function openOrReuseLeadTab(url) {
  // Reuses the extension's dedicated automation tab if one exists, so we
  // don't spawn a new tab per lead — keeps things visibly manageable.
  const { automationTabId } = await chrome.storage.local.get("automationTabId");

  if (automationTabId) {
    try {
      const tab = await chrome.tabs.get(automationTabId);
      if (tab) {
        await chrome.tabs.update(automationTabId, { url, active: false });
        await waitForTabLoad(automationTabId);
        return automationTabId;
      }
    } catch {
      // tab no longer exists, fall through to creating a new one
    }
  }

  const newTab = await chrome.tabs.create({ url, active: false });
  await chrome.storage.local.set({ automationTabId: newTab.id });
  await waitForTabLoad(newTab.id);
  return newTab.id;
}

function waitForTabLoad(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const start = Date.now();
    function check() {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError) return resolve(); // tab closed, give up gracefully
        if (tab.status === "complete" || Date.now() - start > timeoutMs) {
          setTimeout(resolve, 1500); // extra settle time for the content script to attach
        } else {
          setTimeout(check, 400);
        }
      });
    }
    check();
  });
}

async function processOneLead(lead) {
  log("Processing lead:", lead.linkedin_url);
  let tabId;
  try {
    tabId = await openOrReuseLeadTab(lead.linkedin_url);

    const leadResult = await sendToContentScript(tabId, "PROCESS_LEAD", { lead });
    if (!leadResult) throw new Error("No response from content script (page may not have loaded in time)");

    if (leadResult.finalStatus === "READY_FOR_DRAFT") {
      const draft = await fetchDraft(leadResult.profile, leadResult.conversation, lead.campaign_id);
      const sendResult = await sendToContentScript(tabId, "SEND_DRAFTED_MESSAGE", { draftText: draft });
      await postStatus(lead.id, sendResult.finalStatus, { sentContent: sendResult.sentContent });
      return sendResult;
    }

    await postStatus(lead.id, leadResult.finalStatus, { sentContent: leadResult.sentContent });
    return leadResult;
  } catch (err) {
    log("Lead processing error:", err.message);
    await postError(lead.id, err.message);
    return { success: false, error: err.message };
  }
}

async function runTick() {
  const running = await getRunningState();
  if (!running) return;

  try {
    const lead = await fetchNextLead();
    if (!lead) {
      log("No due leads right now.");
      return;
    }
    await processOneLead(lead);
  } catch (err) {
    log("Tick error:", err.message);
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) runTick();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== "background") return false;

  (async () => {
    if (message.type === "START_AUTOMATION") {
      await startAutomation();
      sendResponse({ success: true });
    } else if (message.type === "STOP_AUTOMATION") {
      await stopAutomation();
      sendResponse({ success: true });
    } else if (message.type === "GET_STATE") {
      sendResponse({ running: await getRunningState() });
    } else {
      sendResponse({ success: false, error: `Unknown command: ${message.type}` });
    }
  })();

  return true;
});
