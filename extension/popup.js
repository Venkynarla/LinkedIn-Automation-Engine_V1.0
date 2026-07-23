const API_BASE = "https://linkedin-automation-engine-v1-0.onrender.com/api"; // keep in sync with executor.js

async function loadStatus() {
  const statusEl = document.getElementById("status");
  statusEl.textContent = "Checking backend…";
  try {
    const res = await fetch(`${API_BASE}/dashboard/pending`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    statusEl.textContent = `Backend OK — ${data.actions.length} pending action(s).`;
  } catch (err) {
    statusEl.textContent = `Backend unreachable: ${err.message}`;
  }
}

document.getElementById("refresh").addEventListener("click", loadStatus);
document.getElementById("open-dashboard").addEventListener("click", () => {
  window.open(chrome.runtime.getURL("dashboard.html"), "_blank");
});

async function refreshAutomationStatus() {
  chrome.runtime.sendMessage({ target: "background", type: "GET_STATE" }, (res) => {
    const running = res?.running;
    document.getElementById("automation-status").textContent = `Automation: ${running ? "running" : "stopped"}`;
    const btn = document.getElementById("toggle-automation");
    btn.textContent = running ? "Stop automation" : "Start automation";
    btn.style.background = running ? "#b91c1c" : "#166534";
  });
}

document.getElementById("toggle-automation").addEventListener("click", () => {
  chrome.runtime.sendMessage({ target: "background", type: "GET_STATE" }, (res) => {
    const type = res?.running ? "STOP_AUTOMATION" : "START_AUTOMATION";
    chrome.runtime.sendMessage({ target: "background", type }, () => refreshAutomationStatus());
  });
});

refreshAutomationStatus();
loadStatus();
