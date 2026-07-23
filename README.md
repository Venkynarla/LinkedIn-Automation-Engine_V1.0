# Automation Engine — how it fits together

## v0.3 architecture (modular, per requested spec)

```
extension/
├── logger.js       structured logging (window.SFAssistant.logger)
├── utils.js        wait helpers + retry wrapper — no raw setTimeout sleeps
├── selectors.js     the ONE file to edit when LinkedIn changes its UI
├── linkedin.js      reusable actions: clickConnect, clickMessage, findTextbox...
├── detector.js       connection status: CONNECTED/NOT_CONNECTED/PENDING/FOLLOW/UNKNOWN
├── sender.js         focus/type/send/verify — nothing else
├── parser.js         reads the open conversation thread (⚠️ UNVERIFIED, see below)
├── executor.js       orchestrates one lead end-to-end, named functions, structured results
├── content.js        thin message bridge: background.js ⇄ executor.js
├── background.js     MV3 service worker: opens tabs, calls backend, drives the loop
├── sidebar.js         manual per-profile UI panel (uses the same shared modules above)
├── popup.html/js      toolbar popup: backend status + Start/Stop automation + dashboard link
└── dashboard.html/js  full pipeline dashboard, opens in a new tab

backend/
├── server.js         Express entrypoint + CORS
├── routes.js          all API routes, including /nextLead /conversation /status /error
├── scheduler.js        (legacy) queue-based scheduler — still used by the older /queue/next flow
└── draft.js            pure text generation — no DB writes, no LinkedIn calls, no scheduling
```

### What's PROVEN working (built from your actual live console output)
- `linkedin.js` / `detector.js`: Connect/Message element finding, using exact-text
  matching + ancestor aria-label name verification — confirmed against your
  real LinkedIn session across multiple debugging rounds.
- `sender.js`: message textbox finding via `contenteditable="true"`.
- `sidebar.js`: profile scraping (About/Skills/Experience), draft generation,
  manual send flow.

### What's NEW and UNVERIFIED — expect a debugging round, same as everything above
- **`parser.js`** (conversation reading): built on a timestamp-pattern heuristic,
  never tested against your live open conversation view. If it returns 0
  messages, that's expected until we go through the same live-inspection
  process we used for the buttons.
- **`background.js`** (multi-tab automation controller): opens LinkedIn tabs
  itself via `chrome.tabs`, no live testing done yet. **Start with the
  automation OFF and test on 1-2 leads manually before trusting it to run
  unattended.**

### MV3 constraint worth knowing
The spec's `while(true)` pseudocode isn't literally possible in a Manifest V3
service worker (it can be killed/restarted anytime by Chrome). `background.js`
uses `chrome.alarms` instead — functionally the same repeating loop, just
resilient to the worker being torn down between ticks.

## Flow diagram

```
[popup: Start automation] ──► background.js
                                  │
                                  ▼
                     GET /nextLead (backend)
                                  │
                                  ▼
                    chrome.tabs open/update lead's profile
                                  │
                                  ▼
              content.js ──► executor.js.processLead()
                    │  detectConnection → NOT_CONNECTED? → sendConnection → done
                    │  detectConnection → CONNECTED? → openMessageBox → readConversation
                    ▼
        background.js: POST /draft (with conversation) ──► gets AI draft
                                  │
                                  ▼
              content.js ──► executor.js.sendDraftedMessage()
                                  │
                                  ▼
                    POST /status, POST /conversation (backend)
                                  │
                                  ▼
                         next chrome.alarms tick
```

## What's here (files not yet described above)
- `db/schema.sql` — Supabase tables + the `error`/`last_processed` columns
  added for the new `/error` and `/status` endpoints
- `README.md` — this file

## Important — before this runs for real

1. **Test `parser.js` and `background.js` deliberately.** These are the two
   genuinely new, unverified pieces. Open a LinkedIn conversation manually,
   check the console for `Parsed N message(s) from conversation` — if N is 0,
   the parser needs the same live-inspection debugging round the buttons went through.
2. **Start with tiny caps and automation OFF by default.** Don't hit "Start
   automation" in the popup until you've manually verified `processLead` on
   at least one real lead via the sidebar first.
3. **`increment_send_counter` RPC** and the new `error`/`last_processed`
   columns need the updated `schema.sql` re-run in Supabase's SQL editor if
   you haven't already (re-running the whole file is safe — `alter table ...
   add column if not exists` won't error on a second run).

## Next pieces to build
- Apify boolean-search scraper → populate `prospects` for the automation loop to work through
- Dashboard surfacing for `sequences.error` (so failed leads are visible, not silent)

