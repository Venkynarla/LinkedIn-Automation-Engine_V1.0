/**
 * routes.js — API surface the Chrome extension talks to.
 * Mount under e.g. /api on your Express app.
 */

const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const { runSchedulerTick } = require("./scheduler");
const { generateDraft } = require("./draft");

const router = express.Router();
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/**
 * GET /api/queue/next
 * Extension calls this when it's active on a LinkedIn tab. Returns AT MOST
 * ONE due action so the extension executes one thing, reports back, then
 * asks again — never a batch, to keep pacing human-like and let the caller
 * bail out cleanly if the tab closes mid-run.
 */
router.get("/queue/next", async (req, res) => {
  const { data, error } = await supabase
    .from("action_queue")
    .select("*, prospects(*), sequences(*)")
    .eq("status", "pending")
    .lte("scheduled_for", new Date().toISOString())
    .order("scheduled_for", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.json({ action: null });
  return res.json({ action: data });
});

/**
 * POST /api/queue/:id/result
 * Body: { status: 'sent' | 'failed' | 'skipped', error?: string }
 * Extension reports back after attempting an action. On success, this also
 * advances the sequence state and updates daily counters + message_log.
 */
router.post("/queue/:id/result", async (req, res) => {
  const { id } = req.params;
  const { status, error, sentContent } = req.body;

  const { data: action } = await supabase
    .from("action_queue")
    .select("*, sequences(*)")
    .eq("id", id)
    .single();

  if (!action) return res.status(404).json({ error: "action not found" });

  await supabase
    .from("action_queue")
    .update({ status, error: error || null, attempted_at: new Date().toISOString() })
    .eq("id", id);

  if (status === "sent") {
    const stateMap = {
      connect: "CONNECTION_SENT",
      message: "MESSAGE_1_SENT",
      followup: "MESSAGE_1_SENT", // loop back; followup_count tracks progress
    };

    const seq = action.sequences;
    const patch = {
      state: stateMap[action.action_type],
      updated_at: new Date().toISOString(),
    };
    if (action.action_type === "message" || action.action_type === "followup") {
      patch.last_message_sent_at = new Date().toISOString();
    }
    if (action.action_type === "followup") {
      patch.followup_count = (seq.followup_count || 0) + 1;
    }

    await supabase.from("sequences").update(patch).eq("id", seq.id);

    await supabase.from("message_log").insert({
      prospect_id: action.prospect_id,
      sequence_id: seq.id,
      direction: "outbound",
      message_type:
        action.action_type === "connect"
          ? "connection_note"
          : action.action_type === "message"
          ? "first_message"
          : "followup",
      content: sentContent || action.payload,
    });

    // bump today's counter
    const today = new Date().toISOString().slice(0, 10);
    const col = action.action_type === "connect" ? "connections_sent" : "messages_sent";
    await supabase.rpc("increment_send_counter", {
      p_campaign_id: seq.campaign_id,
      p_day: today,
      p_col: col,
    });
  }

  return res.json({ ok: true });
});

/**
 * POST /api/scheduler/run
 * Trigger a scheduler tick manually (also runnable via cron).
 */
router.post("/scheduler/run", async (req, res) => {
  const result = await runSchedulerTick();
  res.json(result);
});

/**
 * GET /api/dashboard/pending
 * Feeds the CRM dashboard: all pending/queued actions grouped by prospect.
 */
router.get("/dashboard/pending", async (req, res) => {
  const { data, error } = await supabase
    .from("action_queue")
    .select("*, prospects(full_name, headline, linkedin_url)")
    .in("status", ["pending", "failed"])
    .order("scheduled_for", { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ actions: data });
});

/**
 * GET /api/prospects/:linkedinUrl/history
 * Used by the extension on profile-open to answer "have I already
 * messaged this person" before drafting anything.
 */
router.get("/prospects/by-url", async (req, res) => {
  const { url } = req.query;
  const { data: prospect } = await supabase
    .from("prospects")
    .select("*, sequences(*)")
    .eq("linkedin_url", url)
    .maybeSingle();

  if (!prospect) return res.json({ prospect: null, history: [] });

  const { data: history } = await supabase
    .from("message_log")
    .select("*")
    .eq("prospect_id", prospect.id)
    .order("sent_at", { ascending: true });

  res.json({ prospect, history });
});

/**
 * POST /api/prospects/upsert
 * Called by the injected sidebar whenever a LinkedIn profile page loads.
 * Saves/updates the scraped profile so nothing needs manual SQL. Also
 * ensures a sequence + a default campaign exist so this prospect is
 * automation-eligible immediately (though `paused` defaults true here so
 * simply *viewing* a profile never triggers auto-sending on its own —
 * you opt a prospect into automation explicitly from the sidebar).
 */
router.post("/prospects/upsert", async (req, res) => {
  const { profile } = req.body; // { linkedin_url, full_name, headline, designation, company, about, skills, experience }
  if (!profile?.linkedin_url) {
    return res.status(400).json({ error: "profile.linkedin_url is required" });
  }

  const { data: prospect, error: upsertError } = await supabase
    .from("prospects")
    .upsert(profile, { onConflict: "linkedin_url" })
    .select()
    .single();

  if (upsertError) return res.status(500).json({ error: upsertError.message });

  let { data: sequence } = await supabase
    .from("sequences")
    .select("*")
    .eq("prospect_id", prospect.id)
    .maybeSingle();

  if (!sequence) {
    let { data: defaultCampaign } = await supabase
      .from("campaigns")
      .select("*")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (!defaultCampaign) {
      const { data: created } = await supabase
        .from("campaigns")
        .insert({ name: "Default" })
        .select()
        .single();
      defaultCampaign = created;
    }

    const { data: newSeq } = await supabase
      .from("sequences")
      .insert({ prospect_id: prospect.id, campaign_id: defaultCampaign.id, paused: true })
      .select()
      .single();
    sequence = newSeq;
  }

  const { data: history } = await supabase
    .from("message_log")
    .select("*")
    .eq("prospect_id", prospect.id)
    .order("sent_at", { ascending: true });

  res.json({ prospect, sequence, history: history || [] });
});

/**
 * POST /api/draft
 * Body: { profile, messageType: 'connection_note'|'first_message'|'followup',
 *         senderContext?, priorMessages? }
 * Calls NVIDIA's API and returns a draft. Does NOT send or store anything —
 * purely generates text for the sidebar to show in an editable box.
 */
router.post("/draft", async (req, res) => {
  const { profile, messageType, senderContext, priorMessages } = req.body;
  if (!profile || !messageType) {
    return res.status(400).json({ error: "profile and messageType are required" });
  }
  try {
    const result = await generateDraft({ profile, messageType, senderContext, priorMessages });
    res.json(result); // { draft, factsUsed, isFallback }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/actions/send-now
 * Body: { prospectId, actionType: 'connect'|'message'|'followup', content }
 * The sidebar calls this AFTER the extension's DOM click actually succeeds
 * on the LinkedIn page — this endpoint just records the outcome (state +
 * message_log + counters), the same bookkeeping as /queue/:id/result, but
 * for actions that were sent immediately from the sidebar rather than
 * picked up from the automated queue.
 */
router.post("/actions/send-now", async (req, res) => {
  const { prospectId, actionType, content } = req.body;
  if (!prospectId || !actionType) {
    return res.status(400).json({ error: "prospectId and actionType are required" });
  }

  const { data: sequence } = await supabase
    .from("sequences")
    .select("*")
    .eq("prospect_id", prospectId)
    .maybeSingle();

  if (!sequence) return res.status(404).json({ error: "no sequence found for this prospect — upsert the prospect first" });

  const stateMap = { connect: "CONNECTION_SENT", message: "MESSAGE_1_SENT", followup: "MESSAGE_1_SENT" };
  const patch = { state: stateMap[actionType], updated_at: new Date().toISOString() };
  if (actionType === "message" || actionType === "followup") patch.last_message_sent_at = new Date().toISOString();
  if (actionType === "followup") patch.followup_count = (sequence.followup_count || 0) + 1;

  await supabase.from("sequences").update(patch).eq("id", sequence.id);

  await supabase.from("message_log").insert({
    prospect_id: prospectId,
    sequence_id: sequence.id,
    direction: "outbound",
    message_type: actionType === "connect" ? "connection_note" : actionType === "message" ? "first_message" : "followup",
    content,
  });

  const today = new Date().toISOString().slice(0, 10);
  const col = actionType === "connect" ? "connections_sent" : "messages_sent";
  await supabase.rpc("increment_send_counter", { p_campaign_id: sequence.campaign_id, p_day: today, p_col: col });

  res.json({ ok: true, sequence: { ...sequence, ...patch } });
});

/**
 * POST /api/sequences/:id/automation
 * Body: { paused: boolean }
 * Sidebar toggle: "add this person to automation" (unpause) / "pause".
 */
router.post("/sequences/:id/automation", async (req, res) => {
  const { id } = req.params;
  const { paused } = req.body;
  const { data, error } = await supabase
    .from("sequences")
    .update({ paused, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ sequence: data });
});

/**
 * GET /api/dashboard/stats
 * Pipeline overview: counts per sequence state, plus per-prospect status
 * list with next-action timing — this is what the dashboard page renders
 * so you never need to check Supabase directly.
 */
router.get("/dashboard/stats", async (req, res) => {
  const { data: sequences, error } = await supabase
    .from("sequences")
    .select("*, prospects(full_name, headline, linkedin_url)")
    .order("updated_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  const counts = {};
  for (const seq of sequences) {
    counts[seq.state] = (counts[seq.state] || 0) + 1;
  }

  const now = Date.now();
  const rows = sequences.map((seq) => {
    let nextActionDue = null;
    if (seq.state === "MESSAGE_1_SENT" && !seq.replied && seq.followup_count < seq.max_followups) {
      const lastSent = seq.last_message_sent_at ? new Date(seq.last_message_sent_at).getTime() : null;
      const gapMs = seq.followup_gap_days * 24 * 60 * 60 * 1000;
      nextActionDue = lastSent ? new Date(lastSent + gapMs).toISOString() : null;
    }
    return {
      prospect_name: seq.prospects?.full_name || "(unknown)",
      linkedin_url: seq.prospects?.linkedin_url,
      state: seq.state,
      paused: seq.paused,
      replied: seq.replied,
      followup_count: seq.followup_count,
      max_followups: seq.max_followups,
      last_message_sent_at: seq.last_message_sent_at,
      next_action_due: nextActionDue,
      is_overdue: nextActionDue ? new Date(nextActionDue).getTime() < now : false,
    };
  });

  res.json({ counts, total: sequences.length, rows });
});

/**
 * GET /nextLead
 * Called by background.js on each automation tick. Returns the next
 * eligible sequence as a flat "lead" object, or { lead: null } if nothing
 * is due. Unlike the older /queue/next (which pre-decides connect vs.
 * message), this leaves that decision to the content script's live
 * connection-status detection — more robust against stale stored state.
 */
router.get("/nextLead", async (req, res) => {
  const { data: sequences, error } = await supabase
    .from("sequences")
    .select("*, prospects(*)")
    .eq("paused", false)
    .in("state", ["NEW", "CONNECTED", "MESSAGE_1_SENT"])
    .order("updated_at", { ascending: true })
    .limit(1);

  if (error) return res.status(500).json({ error: error.message });
  if (!sequences?.length) return res.json({ lead: null });

  const seq = sequences[0];
  res.json({
    lead: {
      id: seq.id, // sequence id — used as leadId in /status and /error
      prospect_id: seq.prospect_id,
      linkedin_url: seq.prospects?.linkedin_url,
      full_name: seq.prospects?.full_name,
      connection_note: seq.connection_note,
      campaign_id: seq.campaign_id,
    },
  });
});

/**
 * POST /conversation
 * Body: { leadId, conversation: [{ sender, text }, ...] }
 * Stores inbound messages (anything not from the account owner) into
 * message_log, and flips sequences.replied=true if any inbound message is
 * found — this is what lets the dashboard/scheduler know someone replied.
 */
router.post("/conversation", async (req, res) => {
  const { leadId, conversation } = req.body;
  if (!leadId || !Array.isArray(conversation)) {
    return res.status(400).json({ error: "leadId and conversation[] are required" });
  }

  const { data: seq } = await supabase.from("sequences").select("*").eq("id", leadId).single();
  if (!seq) return res.status(404).json({ error: "sequence not found" });

  const inbound = conversation.filter((m) => (m.sender || "").toLowerCase() !== "me");
  for (const msg of inbound) {
    await supabase.from("message_log").insert({
      prospect_id: seq.prospect_id,
      sequence_id: seq.id,
      direction: "inbound",
      message_type: "reply",
      content: msg.text,
    });
  }

  if (inbound.length > 0 && !seq.replied) {
    await supabase.from("sequences").update({ replied: true }).eq("id", seq.id);
  }

  res.json({ ok: true, stored: inbound.length });
});

/**
 * POST /status
 * Body: { leadId, status, sentContent? }
 * Called by background.js after processOneLead finishes. `status` is one
 * of executor.js's finalStatus values (CONNECTION_SENT, MESSAGE_SENT,
 * PENDING, FOLLOW, UNKNOWN, ERROR).
 */
router.post("/status", async (req, res) => {
  const { leadId, status, sentContent } = req.body;
  if (!leadId || !status) return res.status(400).json({ error: "leadId and status are required" });

  const { data: seq } = await supabase.from("sequences").select("*").eq("id", leadId).single();
  if (!seq) return res.status(404).json({ error: "sequence not found" });

  const stateMap = {
    CONNECTION_SENT: "CONNECTION_SENT",
    MESSAGE_SENT: seq.state === "CONNECTED" ? "MESSAGE_1_SENT" : "MESSAGE_1_SENT",
    PENDING: seq.state, // no change — still waiting on them to accept
    FOLLOW: "STOPPED", // Connect isn't available on this profile type; stop automation for it
    UNKNOWN: seq.state, // couldn't determine anything this pass — leave as-is, will retry next tick
  };

  const patch = {
    state: stateMap[status] || seq.state,
    last_processed: new Date().toISOString(),
    error: null,
  };
  if (status === "MESSAGE_SENT") patch.last_message_sent_at = new Date().toISOString();
  if (status === "MESSAGE_SENT" && seq.state === "MESSAGE_1_SENT") {
    patch.followup_count = (seq.followup_count || 0) + 1;
  }

  await supabase.from("sequences").update(patch).eq("id", leadId);

  if (sentContent && (status === "CONNECTION_SENT" || status === "MESSAGE_SENT")) {
    await supabase.from("message_log").insert({
      prospect_id: seq.prospect_id,
      sequence_id: seq.id,
      direction: "outbound",
      message_type: status === "CONNECTION_SENT" ? "connection_note" : seq.state === "CONNECTED" ? "first_message" : "followup",
      content: sentContent,
    });
  }

  res.json({ ok: true });
});

/**
 * POST /error
 * Body: { leadId, error }
 * Records a processing failure so repeatedly-broken leads are visible
 * (dashboard can surface these) rather than silently retried forever.
 */
router.post("/error", async (req, res) => {
  const { leadId, error } = req.body;
  if (!leadId) return res.status(400).json({ error: "leadId is required" });

  await supabase
    .from("sequences")
    .update({ error: error || "unknown error", last_processed: new Date().toISOString() })
    .eq("id", leadId);

  res.json({ ok: true });
});

module.exports = router;
