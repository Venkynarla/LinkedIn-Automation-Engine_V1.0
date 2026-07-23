/**
 * draft.js — LinkedIn outreach drafting engine.
 *
 * Ported and adapted from the drafting approach in the user's SalesFlow app
 * (backend/services/ai_generator.py), which grounds every draft in specific
 * facts (FACTS_USED), bans spammy language, infers role-based pain points
 * as a conservative fallback, and rotates follow-up angles instead of
 * repeating "just checking in" — adapted here from cold email to LinkedIn
 * connection notes / first messages / follow-ups.
 */

const NVIDIA_API_URL =
  process.env.NVIDIA_API_URL || "https://integrate.api.nvidia.com/v1/chat/completions";
const NVIDIA_MODEL = process.env.NVIDIA_MODEL || "meta/llama-3.1-70b-instruct";

const ANTI_SPAM_RULES = `
Write like a real person messaging from their laptop, not like marketing copy.
Never use these words/phrases or close variants: free, guarantee, guaranteed, act now, limited time,
click here, buy now, risk-free, 100%, amazing, revolutionary, cutting-edge, game-changer, game changer,
synergy, world-class, best-in-class, unlock, supercharge, don't miss out, exclusive offer, transform your business,
interesting background, similar passion, expand my network, hear about new experiences, exciting things happening in your field.
Do not use exclamation marks. Do not write in ALL CAPS anywhere.
Do not open with "Hope you're doing well" or any close variant.
Do not say "I'd love to connect" or "excited to connect".
Never use HTML tags of any kind (no <br>, <p>, <b>, etc). Use plain text only — if you need a line break, use an actual newline character, never the literal text "<br>".
Sentences should be short and plain, the way a busy professional actually writes.
`.trim();

// ---------- Role-based pain-point inference (used both as model context and offline fallback) ----------

function inferPainPoints(headline, designation, about, skills) {
  const t = `${headline || ""} ${designation || ""} ${about || ""} ${(skills || []).join(" ")}`.toLowerCase();
  if (/(sales|business development|bdr|sdr|account executive)/.test(t))
    return "pipeline predictability, outbound response rates, and rep ramp time";
  if (/(marketing|growth|demand gen|seo|content)/.test(t))
    return "attribution clarity, lead quality vs volume, and campaign ROI proof";
  if (/(data|analytics|bi|insights|scientist)/.test(t))
    return "trusted data pipelines, dashboard adoption, and self-service analytics";
  if (/(engineering|developer|software|platform|devops|cloud)/.test(t))
    return "delivery velocity, technical debt, and platform reliability";
  if (/(hr|talent|recruit|people ops)/.test(t))
    return "hiring velocity, retention, and manual screening overhead";
  if (/(finance|accounting|controller|cfo)/.test(t))
    return "forecasting accuracy, close-cycle speed, and reporting overhead";
  if (/(founder|ceo|owner|entrepreneur)/.test(t))
    return "runway efficiency, team bandwidth, and prioritization under constraint";
  if (/(operations|supply chain|logistics)/.test(t))
    return "process bottlenecks, visibility gaps, and manual coordination overhead";
  return "manual workflows, fragmented tools, and time lost to repetitive tasks";
}

function firstNameOf(profile) {
  return (profile.full_name || "").trim().split(" ")[0] || null;
}

// ---------- Prompt construction ----------

const FORMAT_INSTRUCTIONS = `
Strict rules:
1. Return ONLY the message text — no preamble, no explanation, no quotation marks.
2. After the message, on a new line, add:
FACTS_USED:
- <2-4 short bullets, one per line, each stating a specific fact from the profile you used, e.g. "Headline mentions leading a 12-person data team" or "About section mentions launching a GTM motion at [Company]". If no real profile data was available, write exactly one bullet: "No specific profile data available — do not send until scraper is fixed."
`.trim();

const TASK_INSTRUCTIONS = {
  connection_note: `
Write a LinkedIn connection request note.
- Maximum 200 characters (LinkedIn's actual hard limit for connection notes) for the message itself. This is strict — going over means LinkedIn silently fails to send.
- Reference ONE specific, genuine detail from their profile data below.
- No generic flattery, no "I'd love to connect" filler.
- If a first name is available, start with "Hi <FirstName>," otherwise skip the greeting entirely (do not write "Hi there").
`.trim(),
  first_message: `
Write the first message to send after they've accepted your connection request.
- 3-5 short sentences.
- Reference one specific detail from their experience/skills/about naturally, not as a listed fact.
- Mention who you are in one line, naturally, not as a pitch.
- End with a low-friction, specific question tied to their actual work — not a generic "what's exciting in your field" question.
- If a first name is available, start with "Hi <FirstName>," otherwise skip the greeting entirely.
`.trim(),
  followup: `
Write a brief, non-pushy follow-up message.
- Acknowledge they're likely busy, in one short line, without guilt-tripping.
- Add ONE new angle or new value point instead of repeating the first message.
- Keep it under 80 words.
- End with a soft, easy-to-answer question.
- If a first name is available, start with "Hi <FirstName>," otherwise skip the greeting entirely.
`.trim(),
};

function buildPrompt({ profile, messageType, senderContext, priorMessages }) {
  const firstName = firstNameOf(profile);
  const painPoints = inferPainPoints(profile.headline, profile.designation, profile.about, profile.skills);

  const experienceLines = (profile.experience || [])
    .slice(0, 3)
    .map((e) => `- ${e.title || ""} at ${e.company || ""} ${e.duration || ""}`.trim())
    .join("\n");

  const profileBlock = `
Name: ${profile.full_name || "Not available"}
Headline: ${profile.headline || "Not available"}
Current role: ${profile.designation || "Not available"}${profile.company ? ` at ${profile.company}` : ""}
About: ${profile.about || "Not available"}
Skills: ${(profile.skills || []).join(", ") || "Not available"}
Experience:
${experienceLines || "Not available"}
`.trim();

  const senderBlock = senderContext ? `\nAbout the sender (you): ${senderContext}\n` : "";

  const historyBlock =
    priorMessages && priorMessages.length
      ? `\nPrior messages already sent to this person — do not repeat these:\n${priorMessages
          .map((m) => `- (${m.message_type}) ${m.content}`)
          .join("\n")}\n`
      : "\nThis is the first outreach to this person.\n";

  return `
You are drafting a highly personalized, human-sounding LinkedIn outreach message. Ground it in specific facts from the profile below. Never invent facts. If the profile data is sparse, say so in FACTS_USED rather than inventing generic praise.

${ANTI_SPAM_RULES}

=========================
PROFILE
=========================
${profileBlock}

Conservative role-based context (use only if it fits naturally, do not force it): ${painPoints}
${senderBlock}${historyBlock}
=========================
TASK
=========================
${TASK_INSTRUCTIONS[messageType] || TASK_INSTRUCTIONS.first_message}

${FORMAT_INSTRUCTIONS}
`.trim();
}

// ---------- Offline fallback (used if NVIDIA_API_KEY missing or the API call fails) ----------

function fallbackDraft({ profile, messageType }) {
  const firstName = firstNameOf(profile);
  const greeting = firstName ? `Hi ${firstName},` : "";
  const painPoints = inferPainPoints(profile.headline, profile.designation, profile.about, profile.skills);
  const roleLine = profile.designation
    ? `your role as ${profile.designation}${profile.company ? ` at ${profile.company}` : ""}`
    : "your background";

  let body;
  if (messageType === "connection_note") {
    body = `${greeting} noticed ${roleLine} — thought it'd be worth connecting given the overlap with ${painPoints}.`.trim();
  } else if (messageType === "followup") {
    body = `${greeting} know things get busy — wanted to follow up with one more thought on ${painPoints} in case it's useful now.`.trim();
  } else {
    body = `${greeting}\n\nThanks for connecting. Saw ${roleLine}, and figured it's worth a quick note given how much overlap there usually is with ${painPoints}.\n\nWorth a short exchange sometime?`.trim();
  }

  if (messageType === "connection_note" && body.length > 200) {
    const cut = body.slice(0, 200);
    const lastSpace = cut.lastIndexOf(" ");
    body = (lastSpace > 150 ? cut.slice(0, lastSpace) : cut).trim();
  }

  return {
    draft: body,
    factsUsed: [
      profile.designation ? `${profile.designation}${profile.company ? " at " + profile.company : ""} [Job Title/Company]` : null,
      "Generated by the offline fallback template (NVIDIA_API_KEY missing or the API call failed) — not grounded in live AI research",
    ].filter(Boolean),
    isFallback: true,
  };
}

// ---------- Response parsing ----------

function parseModelOutput(raw, messageType) {
  const text = (raw || "").trim();
  const factsMatch = text.match(/FACTS_USED\s*:\s*([\s\S]*)$/i);
  const factsUsed = factsMatch
    ? factsMatch[1]
        .split("\n")
        .map((l) => l.replace(/^[-*•]\s*/, "").trim())
        .filter(Boolean)
        .slice(0, 6)
    : [];
  let draft = text.replace(/FACTS_USED\s*:[\s\S]*$/i, "").trim();

  // Safety net: some models occasionally emit HTML despite instructions not
  // to. Convert <br>/<p> to real newlines and strip any other stray tags.
  draft = draft
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .trim();

  // Hard enforcement of LinkedIn's actual 200-character connection-note
  // limit — instructions alone aren't reliable, and going over means
  // LinkedIn silently fails to send the invite. Truncate at the last word
  // boundary before 200 chars rather than cutting mid-word.
  if (messageType === "connection_note" && draft.length > 200) {
    const cut = draft.slice(0, 200);
    const lastSpace = cut.lastIndexOf(" ");
    draft = (lastSpace > 150 ? cut.slice(0, lastSpace) : cut).trim();
    factsUsed.push(`Note: AI draft exceeded 200 chars and was truncated to fit LinkedIn's limit.`);
  }

  return { draft, factsUsed };
}

// ---------- Main entry point ----------

async function generateDraft({ profile, messageType, senderContext, priorMessages }) {
  const hasRealData =
    (profile.about && profile.about.trim().length > 10) ||
    (profile.skills && profile.skills.length > 0) ||
    (profile.experience && profile.experience.length > 0) ||
    (profile.headline && profile.headline.trim().length > 5);

  if (!hasRealData) {
    // Sparse profile (no About/Skills/Experience/Headline captured) — rather
    // than refusing outright, fall back to the honest offline template using
    // whatever minimal facts DO exist (name, designation/company if any).
    // It's clearly labeled isFallback so the sidebar shows a warning badge
    // and you can judge whether it's worth sending as-is or editing further.
    console.warn("[draft.js] Sparse profile data — using offline fallback template instead of AI call.");
    return fallbackDraft({ profile, messageType });
  }

  if (!process.env.NVIDIA_API_KEY) {
    return fallbackDraft({ profile, messageType });
  }

  const prompt = buildPrompt({ profile, messageType, senderContext, priorMessages });

  try {
    const res = await fetch(NVIDIA_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.NVIDIA_API_KEY}`,
      },
      body: JSON.stringify({
        model: NVIDIA_MODEL,
        temperature: 0.5,
        max_tokens: 400,
        messages: [
          {
            role: "system",
            content: "You are an expert LinkedIn outreach copywriter who writes grounded, specific, non-generic messages.",
          },
          { role: "user", content: prompt },
        ],
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`NVIDIA API error ${res.status}: ${errText}`);
    }

    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content;
    if (!raw) throw new Error("NVIDIA API returned no content");

    const { draft, factsUsed } = parseModelOutput(raw, messageType);
    if (!draft) throw new Error("Model response had no usable draft text");

    return { draft, factsUsed, isFallback: false };
  } catch (err) {
    // Never surface a total failure to the sidebar — fall back to the
    // offline template instead, same as SalesFlow's email generator does.
    console.error("[draft.js] NVIDIA call failed, using offline fallback:", err.message);
    return fallbackDraft({ profile, messageType });
  }
}

module.exports = { generateDraft };
