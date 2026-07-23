/**
 * scheduler.js
 *
 * Core state-machine logic for the automation engine. This does NOT talk to
 * LinkedIn directly — it only decides what SHOULD happen next and writes rows
 * into `action_queue`. The extension is the only thing that ever touches the
 * LinkedIn DOM (see extension/executor.js).
 *
 * Run this on a cron (e.g. every 15 min on Render, via node-cron or a
 * Render Cron Job) to keep the queue populated. Keep it separate from the
 * "execute" step so a human can always review/edit `payload` in the
 * dashboard before anything is sent.
 */

const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Safety defaults — deliberately conservative. LinkedIn's own weekly
// connection limit is ~100-200; staying well under daily caps and spreading
// sends across "active hours" is the single biggest lever against bans.
const DEFAULTS = {
  minDelayBetweenActionsMs: 45_000,   // never queue two actions back-to-back
  maxDelayBetweenActionsMs: 180_000,
};

async function getCampaignCounters(campaignId, day) {
  const { data } = await supabase
    .from("send_counters")
    .select("*")
    .eq("campaign_id", campaignId)
    .eq("day", day)
    .maybeSingle();
  return data || { connections_sent: 0, messages_sent: 0 };
}

function isWithinActiveHours(campaign, now) {
  // Simplified check — in production, convert `now` to campaign.timezone
  // with a library like luxon before comparing.
  const [startH, startM] = campaign.active_hours_start.split(":").map(Number);
  const [endH, endM] = campaign.active_hours_end.split(":").map(Number);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  return (
    nowMinutes >= startH * 60 + startM && nowMinutes <= endH * 60 + endM
  );
}

/**
 * Advances a single sequence's state if it's ready to move forward, and
 * enqueues the corresponding action_queue row. Does not send anything.
 */
async function advanceSequence(sequence, campaign, counters) {
  const now = new Date();

  switch (sequence.state) {
    case "NEW": {
      if (counters.connections_sent >= campaign.daily_connection_cap) return null;
      return {
        action_type: "connect",
        payload: sequence.connection_note || null,
        nextState: "CONNECTION_QUEUED",
      };
    }

    case "CONNECTED": {
      // Ready for the first personalized message (drafted by the AI service
      // beforehand and stored on the sequence or generated on demand here).
      if (counters.messages_sent >= campaign.daily_message_cap) return null;
      return {
        action_type: "message",
        payload: null, // filled in by the AI-draft step before send
        nextState: "MESSAGE_1_QUEUED",
      };
    }

    case "MESSAGE_1_SENT": {
      if (sequence.replied) return null; // never auto-followup a reply
      if (sequence.followup_count >= sequence.max_followups) return null;

      const lastSent = sequence.last_message_sent_at
        ? new Date(sequence.last_message_sent_at)
        : null;
      const gapMs = sequence.followup_gap_days * 24 * 60 * 60 * 1000;
      if (lastSent && now - lastSent < gapMs) return null; // not due yet

      if (counters.messages_sent >= campaign.daily_message_cap) return null;
      return {
        action_type: "followup",
        payload: null,
        nextState: "FOLLOWUP_QUEUED",
      };
    }

    default:
      return null; // terminal or already-queued states: nothing to do
  }
}

/**
 * Main entry point — call this from a cron job or an API route.
 * Scans all active, unpaused sequences and populates action_queue.
 */
async function runSchedulerTick() {
  const { data: campaigns } = await supabase.from("campaigns").select("*");
  const today = new Date().toISOString().slice(0, 10);
  let queued = 0;

  for (const campaign of campaigns) {
    if (!isWithinActiveHours(campaign, new Date())) continue;

    const counters = await getCampaignCounters(campaign.id, today);

    const { data: sequences } = await supabase
      .from("sequences")
      .select("*")
      .eq("campaign_id", campaign.id)
      .eq("paused", false)
      .in("state", ["NEW", "CONNECTED", "MESSAGE_1_SENT"]);

    for (const seq of sequences) {
      const result = await advanceSequence(seq, campaign, counters);
      if (!result) continue;

      // Space actions out with a random human-like delay instead of
      // scheduling everything for "now" in one burst.
      const delay =
        DEFAULTS.minDelayBetweenActionsMs +
        Math.random() *
          (DEFAULTS.maxDelayBetweenActionsMs - DEFAULTS.minDelayBetweenActionsMs);
      const scheduledFor = new Date(Date.now() + queued * delay);

      await supabase.from("action_queue").insert({
        sequence_id: seq.id,
        prospect_id: seq.prospect_id,
        action_type: result.action_type,
        payload: result.payload,
        scheduled_for: scheduledFor.toISOString(),
        status: "pending",
      });

      await supabase
        .from("sequences")
        .update({ state: result.nextState, updated_at: new Date().toISOString() })
        .eq("id", seq.id);

      queued++;
      // Bump the in-memory counters so we respect caps within this tick too.
      if (result.action_type === "connect") counters.connections_sent++;
      else counters.messages_sent++;
    }
  }

  return { queued };
}

module.exports = { runSchedulerTick, advanceSequence, isWithinActiveHours };
