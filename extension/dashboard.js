const API_BASE = "https://linkedin-automation-engine-v1-0.onrender.com/api";

const STATE_LABELS = {
  NEW: "New",
  CONNECTION_QUEUED: "Connection queued",
  CONNECTION_SENT: "Connection sent",
  CONNECTED: "Connected",
  MESSAGE_1_QUEUED: "First message queued",
  MESSAGE_1_SENT: "Messaged",
  FOLLOWUP_QUEUED: "Follow-up queued",
  REPLIED: "Replied",
  STOPPED: "Stopped",
  BOUNCED: "Bounced",
};

function fmtDate(d) {
  return d ? new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "—";
}

function badge(text, variant) {
  return `<span class="badge badge-${variant}">${text}</span>`;
}

async function loadDashboard() {
  document.getElementById("loading").style.display = "block";
  document.getElementById("content").style.display = "none";

  try {
    const res = await fetch(`${API_BASE}/dashboard/stats`);
    const data = await res.json();
    render(data);
  } catch (err) {
    document.getElementById("loading").textContent = `Failed to load: ${err.message}`;
    return;
  }

  document.getElementById("loading").style.display = "none";
  document.getElementById("content").style.display = "block";
}

function render(data) {
  const { counts, total, rows } = data;

  const cardsEl = document.getElementById("stat-cards");
  const cardDefs = [
    ["Total prospects", total],
    ["New", counts.NEW || 0],
    ["Connection sent", counts.CONNECTION_SENT || 0],
    ["Connected", counts.CONNECTED || 0],
    ["Messaged", counts.MESSAGE_1_SENT || 0],
    ["Replied", rows.filter((r) => r.replied).length],
  ];
  cardsEl.innerHTML = cardDefs
    .map(([label, num]) => `<div class="stat-card"><div class="num">${num}</div><div class="label">${label}</div></div>`)
    .join("");

  const overdueRows = rows.filter((r) => r.next_action_due);
  const overdueBody = document.querySelector("#overdue-table tbody");
  if (overdueRows.length === 0) {
    overdueBody.innerHTML = `<tr><td colspan="5" id="empty">No follow-ups due right now.</td></tr>`;
  } else {
    overdueBody.innerHTML = overdueRows
      .map(
        (r) => `<tr>
          <td>${escapeHtml(r.prospect_name)}</td>
          <td>${STATE_LABELS[r.state] || r.state}</td>
          <td>${r.followup_count} / ${r.max_followups}</td>
          <td>${r.is_overdue ? badge("Overdue — " + fmtDate(r.next_action_due), "overdue") : badge("Due " + fmtDate(r.next_action_due), "warn")}</td>
          <td><a class="profile-link" href="${r.linkedin_url}" target="_blank">View</a></td>
        </tr>`
      )
      .join("");
  }

  const allBody = document.querySelector("#all-table tbody");
  if (rows.length === 0) {
    allBody.innerHTML = `<tr><td colspan="6" id="empty">No prospects yet — open a LinkedIn profile with the extension active to add one.</td></tr>`;
  } else {
    allBody.innerHTML = rows
      .map(
        (r) => `<tr>
          <td>${escapeHtml(r.prospect_name)}</td>
          <td>${STATE_LABELS[r.state] || r.state}</td>
          <td>${fmtDate(r.last_message_sent_at)}</td>
          <td>${r.replied ? badge("Replied", "new") : badge("No", "neutral")}</td>
          <td>${r.paused ? badge("Paused", "neutral") : badge("Active", "new")}</td>
          <td><a class="profile-link" href="${r.linkedin_url}" target="_blank">View</a></td>
        </tr>`
      )
      .join("");
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.innerText = str || "";
  return div.innerHTML;
}

document.getElementById("refresh").addEventListener("click", loadDashboard);
loadDashboard();
