// ==UserScript==
// @name         Invoapp Auto Mimic Trader
// @namespace    http://tampermonkey.net/
// @version      21.7
// @description  Auto-mimics trades on app.invoapp.com via Tampermonkey. Two-tab setup: notifications tab opens trades, wallet tab closes/updates.
// @author       Reed Huish reed@zpower.com
// @match        https://app.invoapp.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/* eslint-disable no-multi-spaces */

(function () {
'use strict';

// ════════════════════════════════════════════════════════════════════════════
// INVOAPP AUTO MIMIC TRADER
// ════════════════════════════════════════════════════════════════════════════
//
// ============================================================
// ============================================================
// CHANGELOG v21.5 — June 2026
// ============================================================
//
// BUG A (CRITICAL): detectModalType() returns null for "Adjust Position Size"
//   modal — Confirm is NEVER clicked, modal stays open forever, script unlocks.
//
//   ROOT CAUSE:
//   The "Adjust Position Size" modal (shown when a trader increases their
//   position size) exposes ONLY "Confirm" and "Reset" in Flutter's accessibility
//   tree. The modal title "Adjust Position Size" renders on canvas and is NOT
//   in the semantic/accessibility DOM at all. So:
//     hasAdjust     = false  (title not in tree)
//     hasReset      = true
//     hasPositionSz = false  (not found separately)
//     hasConfirm    = true
//     hasGoBack     = false
//     hasCancel     = false
//     hasExitPrice  = false
//   None of the 4 detection conditions matched [Confirm, Reset] alone.
//   detectModalType() returned null every 300ms for 6 full seconds.
//   Console showed: "[v21.4] detectModalType found: [Confirm, Reset]" repeated
//   ~20 times, then "No modal detected after 6000ms — skipping loop 0" → unlock.
//
//   FIX v21.5:
//   Added a final fallback condition BEFORE `return null`:
//     if (hasConfirm && hasReset && !hasGoBack && !hasCancel && !hasExitPrice)
//       return 'adjust';
//   This catches any modal that has Confirm+Reset with no other identifiers.
//   "Reset" does not appear in any other known Involio modal type, so this is
//   safe from false positives. The 'adjust' path just clicks Confirm directly
//   without calling setPositionSize() (correct — we mirror the trader's % as-is).
//
// BUG B (CRITICAL): waitForGroupExpansion() collapses already-open groups —
//   Copy button disappears, script finds nothing, onFail → unlock.
//
//   ROOT CAUSE:
//   waitForGroupExpansion() always called tryExpand() first, which clicked the
//   Trade Updates header element unconditionally. If the group was ALREADY
//   EXPANDED (Copy button already visible on screen), clicking the header
//   COLLAPSED it. The Copy button disappeared. The poll found 0 Copy/Copied.
//   After 2 expand attempts × 6s each = up to 12s, onFail() fired → the group
//   was skipped entirely and unlock() was called without ever clicking Copy.
//
//   In the screenshot: WLD's Trade Updates (1) was already open showing a Copy
//   button. The script collapsed it, waited 12 seconds, gave up, unlocked.
//   console: clicked "Trade Updates (1)" → immediately unlocked.
//
//   FIX v21.5:
//   Added a pre-check at the start of waitForGroupExpansion():
//     countGroupCopyState(group.el) BEFORE clicking.
//     If copyCount + copiedCount > 0 → already expanded → call onReady(copyCount)
//     immediately without touching the DOM (no collapse risk).
//   Only expands (clicks) if the group is currently collapsed (0 rows visible).
//
// ============================================================
//
// ROOT CAUSE:
//   detectModalType() used findByText() / findContaining() which both call
//   document.querySelectorAll with a CURATED tag list:
//   ('flt-semantics, flt-semantics-container, [role=button], button, div, span, a')
//
//   Flutter renders modal/dialog overlays inside a SEPARATE flt-glass-pane
//   DOM subtree stacked on top of the base content. The modal flt-semantics
//   nodes live inside this overlay glass-pane, NOT inside the base
//   flt-semantics-host that the curated selector targets.
//   Result: findByText('Confirm'), findByText('Reset'), and
//   findContaining('Adjust Position Size') ALL return null — they never
//   query inside the modal overlay layer. detectModalType returns null every
//   300ms for 6 full seconds, then logs "No modal detected" and skips.
//
// FIX v21.4 — detectModalType() rewritten with DUAL STRATEGY:
//   Strategy A: document.querySelectorAll('*') — scans EVERY element in the
//               entire document including all flt-glass-pane overlay layers.
//               Checks visible elements for modal keyword text.
//   Strategy B: document.body.innerText fallback — belt-and-suspenders for
//               any keywords missed by Strategy A's visibility filter.
//   Both populate a Set<string>; detection logic runs on that Set.
//   Also adds L() logging of found keywords for easier console debugging.
//
// CHANGELOG v21.3 — June 2026
// ============================================================
// BUG: processSingleCopy never hit Confirm — modal open on screen but
//      COPY_MODAL log never appeared; script unlocked immediately after
//      clicking Copy.
//
// ROOT CAUSE:
//   The modal detection block used document.body.innerText string matching:
//     hasAdjustModal  = body.includes('Adjust Position Size') || ...
//     hasPositionModal = body.includes('Position Size') && ...
//     hasConfirmModal  = body.includes('Confirm') && ...
//   These ran after a FIXED 1800ms setTimeout.
//
//   Flutter web populates individual flt-semantics element .innerText
//   BEFORE it updates the aggregate document.body.innerText. At 1800ms
//   the modal is fully visible on screen, but body.innerText is still
//   stale/empty. All three conditions evaluate to false → falls through
//   to Type 4 "modal not rendered yet" → waits 2s and retries → loops
//   until maxLoops is exhausted → onDone() → unlock() — modal still open.
//
// FIX v21.3:
//   (A) Added detectModalType() function that uses DOM-element queries
//       (findByText / findContaining) instead of body.innerText.
//       These query individual node .innerText which Flutter populates
//       immediately and reliably when the modal renders.
//       Returns: 'adjust' | 'position' | 'confirm' | 'close' | null
//
//   (B) Replaced the fixed 1800ms setTimeout + body.innerText block in
//       processSingleCopy with a 300ms polling loop (pollForModal) that
//       calls detectModalType() every 300ms for up to 6 seconds.
//       First detection fires typically at 300-600ms, not 1800ms.
//       Console will now show:
//         [v21.3] COPY_MODAL: Modal type: "adjust" detected at 300ms
//       instead of silence followed by unlock.
//
// CHANGELOG v21.2 — June 2026
//
// BUG: "Adjust Position Size" modal never gets Confirmed — script unlocks with
//      modal still open on screen.
//
// ROOT CAUSE:
//   When a trader adjusts the size of an existing position, clicking Copy opens
//   an "Adjust Position Size" modal. This modal shows:
//     — "Adjust Position Size" as the title
//     — A current dollar amount (e.g. $16.24)
//     — A slider showing the increase %
//     — "Reset" and "Confirm" buttons (NO "Go Back", NO "Cancel", NO "Exit Price")
//
//   The modal detection in processSingleCopy had THREE types:
//     A: hasPositionModal = body has "Position Size" AND NOT "Go Back"
//     B: hasConfirmModal  = body has "Confirm" AND ("Go Back" OR "Exit Price" OR "Cancel")
//     C: neither → wait 2s and retry
//
//   The "Adjust Position Size" modal matches type A (has "Position Size", no "Go Back").
//   So the script called setPositionSize() — which looks for a wallet total in
//   "$X / $Y" format to calculate a position size. That format does NOT exist in
//   the adjustment modal. setPositionSize() ran all 24 attempts (~7s), failed,
//   called callback(false, null), the script then tried to click Confirm... but by
//   then the modal may have timed out or the state was wrong. In practice:
//   unlocked fired immediately after "Copy" was clicked, before any Confirm.
//
// FIX (v21.2):
//   Added a 4th modal type — hasAdjustModal:
//     body has "Adjust Position Size" OR (body has "Reset" AND "Position Size" AND "Confirm")
//
//   When detected, just click Confirm directly — no position size calculation needed.
//   The trader already set the adjustment; we're mimicking their change as-is.
//
//   Modal detection priority order in processSingleCopy:
//     1. hasAdjustModal  — "Adjust Position Size" → click Confirm directly  ★ NEW
//     2. hasPositionModal — new trade size modal → setPositionSize() then Confirm
//     3. hasConfirmModal  — SL / simple confirm modal → click Confirm directly
//     4. none → wait 2s and retry (modal still rendering)
//
// ════════════════════════════════════════════════════════════════════════════
//
//
// ROOT CAUSE FIX: Multiple "Trade Updates (1)" groups all expand the same trade
//
//   THE BUG (present in all prior versions including v21.0):
//   When LINK, AVAX, and DOT each show "Trade Updates (1)", the page contains
//   THREE separate DOM elements all with identical text "Trade Updates (1)".
//
//   The old findTradeUpdateGroups() used innerText regex to find the groups,
//   storing only the label string — no DOM element reference.
//
//   Then expandTradeUpdateGroup() called findContaining('Trade Updates (1)')
//   which iterates all DOM elements and returns the one with the SMALLEST area
//   that contains the phrase. That is always the same element — always LINK's
//   card (first one in the list, smallest bounding box wins ties).
//
//   Result: LINK expands and gets Copied. AVAX and DOT: expandTradeUpdateGroup()
//   clicks LINK's header AGAIN (collapses it), finds no Copy buttons, calls
//   onDone() immediately. Script thinks all groups are done. unlock() fires.
//   Console shows: clicked "Trade Updates (1)" three times, all the same element.
//
//   THE FIX (v21.1):
//   findTradeUpdateGroups() now does the DOM scan itself. It queries all visible
//   flt-semantics/div/span/button elements, finds every one whose text is
//   EXACTLY or TIGHTLY "Trade Updates (N)" (using the same regex), and stores
//   the actual DOM element (el) in each group object alongside the label and count.
//
//   Elements are sorted by vertical Y position (top of bounding rect) so groups
//   are processed top-to-bottom matching visual order on screen.
//
//   expandTradeUpdateGroup() now receives the pre-captured el directly and
//   clicks it — no text search, no ambiguity.
//
//   DUPLICATE ELEMENT GUARD:
//   Flutter's accessibility tree sometimes creates multiple overlapping flt-semantics
//   nodes for the same logical element. The DOM scan deduplicates by checking that
//   no previously-collected element's bounding rect overlaps significantly with the
//   candidate (overlap > 80% area). The smallest-area element wins when overlapping.
//
//   ALSO FIXED: waitForGroupExpansion Copy/Copied count is now scoped per-group.
//   After expanding a group, we count only the Copy/Copied buttons that appear
//   BELOW the group header element (within a 400px vertical window). This prevents
//   Copy buttons from a different already-expanded group from being misattributed
//   to the current group.
//
// ════════════════════════════════════════════════════════════════════════════
//
//
// FIX: Trade Updates — expand ALL individual update rows, check Copied status,
//      and only click Copy on rows that have NOT been confirmed yet.
//
// ROOT CAUSE of prior missed updates:
//
//   After clicking "Trade Updates (1)" to expand a trade's update list, the
//   accordion reveals individual update rows. Each row shows either:
//     — "Copy"    → this update has NOT been applied yet (needs clicking)
//     — "Copied"  → this update was already applied (safe to skip)
//
//   The old processGroupQueue / processSingleCopy logic:
//     1. Expanded the group with a single click (no verify that it actually opened)
//     2. Waited 2200ms flat, then looked for any "Copy" button anywhere on the page
//     3. Clicked Copy, waited for a modal, confirmed, and moved on
//     4. Never explicitly verified the button changed to "Copied"
//     5. Used group.count + 4 as the loop limit — with multiple groups open at once
//        this meant Copy buttons from different groups could be confused with each other
//
//   This caused:
//     — Expansion failures (group didn't open, no Copy buttons found, onDone called immediately)
//     — Cross-group button confusion (Copy from AVAX counted as LINK's update)
//     — No audit trail: couldn't tell which rows were already Copied vs pending
//
// NEW APPROACH (v21.0):
//
//   waitForGroupExpansion(group, onReady, onFail)
//   ─────────────────────────────────────────────
//   After clicking the group header, polls every 300ms for up to 6 seconds
//   waiting for Copy OR Copied buttons to appear. If none appear, retries the
//   expand click once more (in case the first click missed), then polls again.
//   Calls onFail() if still nothing after 12 seconds total.
//
//   countGroupCopyState()
//   ─────────────────────
//   Returns { copyCount, copiedCount } by scanning the page for visible elements
//   whose text is exactly "Copy" or "Copied". Used to log the audit trail per
//   group and to decide how many Copy clicks are needed.
//
//   processSingleCopy — added Copied verification step
//   ────────────────────────────────────────────────────
//   After clicking Copy and handling the confirmation modal, waits up to 3s for
//   the button to change from "Copy" to "Copied". Logs a warning if it doesn't
//   change (helps debug cases where the click landed but the modal didn't confirm).
//   Does NOT block proceeding — moves to the next loop regardless.
//
//   processGroupQueue — per-group expand-verify-copy cycle
//   ──────────────────────────────────────────────────────
//   For each group:
//     1. Log how many Copy vs Copied rows are currently visible
//     2. Call waitForGroupExpansion → only proceeds when rows are visible
//     3. Log updated Copy vs Copied count after expansion
//     4. Call processSingleCopy only for the number of "Copy" (unconfirmed) rows
//     5. After all Copy clicks done, log final Copied count for the group
//     6. Move on to next group
//
// ════════════════════════════════════════════════════════════════════════════
//
//
// ROOT CAUSE ANALYSIS — Why overnight trades were still being missed:
//
//   Two separate problems were working together to cause complete overnight
//   blackouts despite the PC never sleeping:
//
//   PROBLEM 1 — Chrome's Memory Saver discards "inactive" tabs
//   ──────────────────────────────────────────────────────────
//   Chrome's Memory Saver feature (enabled by default in Chrome 108+) monitors
//   tabs for inactivity. When a tab hasn't been interacted with for a period,
//   Chrome frees its memory by COMPLETELY FREEZING the tab's JavaScript. The
//   tab's DOM is saved to disk. All setIntervals, setTimeout callbacks, the
//   MutationObserver, and the Web Worker are suspended. The Involio websocket
//   closes. The tab is essentially dead until you click on it.
//
//   THIS CANNOT BE FIXED IN JAVASCRIPT ALONE — Chrome decides externally
//   whether to discard the tab. The script can fight back somewhat (Web Locks
//   API, Web Worker pings, Audio context keepalive) but a determined Memory
//   Saver event will win anyway.
//
//   REQUIRED MANUAL FIX (do this in Chrome):
//     1. Open chrome://settings/performance
//     2. Turn OFF "Memory Saver" — OR —
//        Under "Memory Saver", click "Add" and add app.invoapp.com to the
//        "Always active" exceptions list (keeps those tabs live even with
//        Memory Saver on for other sites).
//     3. Right-click each Involio tab → Pin. Pinned tabs are lower-priority
//        for discarding.
//
//   REQUIRED MANUAL FIX (Windows Power Options):
//     1. Win+X → Power Options → High Performance plan
//     2. Change plan settings → "Put the computer to sleep" → Never
//     3. This prevents the OS from sleeping the PC, which also freezes Chrome.
//
//   SCRIPT-SIDE MITIGATION (v20.9 — startWebLocksKeepalive):
//   Added a Web Locks API keepalive that requests a permanent shared lock on
//   'am-tab-alive'. Holding a Web Lock signals to Chrome's scheduler that
//   this tab is actively doing background work and should not be discarded.
//   This works alongside the existing Web Worker keepalive (v20.4).
//   Combined, they give the strongest possible signal to keep the tab alive.
//
//   PROBLEM 2 — Involio session expires while the tab is frozen (401 errors)
//   ─────────────────────────────────────────────────────────────────────────
//   When Chrome thaws a frozen tab, the Involio authentication token (JWT /
//   session cookie) may have expired during the freeze. The Flutter app tries
//   to re-authenticate automatically, but sometimes it fails silently —
//   meaning the UI looks normal, the badge shows "🟢 Active", but API calls
//   return 401 Unauthorized. No new notifications arrive. Trader closes are
//   not delivered. The script scans correctly but sees a stale, disconnected
//   feed. This is why Tyron's PROVE close from 1h ago was not caught — the
//   wallet tab was receiving 401s and no new trade events were being delivered.
//
//   FIX (v20.9 — startAuthWatchdog):
//   Intercepts all outgoing fetch() calls and XMLHttpRequest calls to the
//   Involio API (api.invoapp.com). Counts consecutive 401 responses. After
//   2 consecutive 401s within 60 seconds, assumes the session has expired and
//   forces a page reload. After reload, Involio's Flutter app re-authenticates
//   automatically and the websocket reconnects. The fetch interceptor resets
//   its counter on any successful (non-401) response so normal API errors
//   (404, 500) do not trigger a reload.
//
//   Console log lines to watch:
//     [v20.9] AUTH WATCHDOG: 401 from api.invoapp.com (1/2 — reloading on next)
//     [v20.9] AUTH WATCHDOG: Session expired — 2 consecutive 401s — reloading
//
// ════════════════════════════════════════════════════════════════════════════
//
// NEW FEATURE: Dollar-based Auto Stop-Loss (ENABLE_DOLLAR_STOP_LOSS)
//
//   WHAT IT DOES:
//   The wallet tab continuously watches every active trade's dollar P&L.
//   The moment any single trade's dollar LOSS reaches AUTO_CLOSE_USD_THRESHOLD
//   (default: $5), the script automatically:
//     1. Clicks the trade card to open the hover context menu
//     2. Clicks "Close Trade" from that menu
//     3. Waits for the Close Position confirmation modal to appear
//     4. Clicks "Confirm" to execute the close
//
//   WHY THIS IS DIFFERENT FROM THE EMERGENCY SYSTEM:
//   The existing emergency system (EMERGENCY_WALLET_LOSS_PCT / EMERGENCY_MAX_LOSS_USD)
//   is designed for large catastrophic losses and requires BOTH a % threshold AND
//   a $ threshold to be breached simultaneously (v20.7 fix). It is intentionally
//   conservative and only alerts/acts in extreme situations.
//
//   The dollar stop-loss is simpler and more personal:
//   — Only looks at the raw dollar loss on each trade
//   — No percentage involved — pure dollar amount only
//   — Designed to limit how much real money you lose per position
//   — Example: $5 threshold means no single mimic trade can lose more than $5
//   — Trades are closed immediately and automatically, no manual action needed
//
//   HOW TO SET IT:
//   Change AUTO_CLOSE_USD_THRESHOLD = 5.0 in the USER SETTINGS section below.
//   Set ENABLE_DOLLAR_STOP_LOSS = false to disable it entirely.
//
//   COOLDOWN:
//   After triggering, a 3-minute cooldown per symbol prevents the script from
//   repeatedly trying to close the same trade if the first attempt fails or
//   if prices briefly dip and recover. The cooldown key is cleared automatically
//   when a trade is successfully closed (closeDone resets seenWallet).
//
//   PRIORITY IN scanWallet():
//   1. Dismiss hover menu (if accidentally open)
//   2. Handle blocking modals (Not Enough Funds, Duplicated Position)
//   3. Verify post-open stop loss (if SL was set on open)
//   4. Process Trade Updates — Copy buttons (highest routine priority)
//   5. ★ Dollar stop-loss check (NEW — auto-closes losing trades)
//   6. Emergency loss alert (large loss threshold, alert + banner)
//   7. Direct Close Position detection (trader manually closed)
//
// CHANGELOG v20.7 — June 2026
//
// BUG A (CRITICAL): Trade Updates — only FIRST group processed, rest skipped
//   ROOT CAUSE: All trades with "Trade Updates (1)" shared the IDENTICAL seenWallet
//   key: `wallet-group-Trade Updates (1)`. After LINK's update was processed and
//   the key was added to seenWallet, AVAX and DOT were skipped for 90 seconds
//   because they had the exact same key. Only the first "Trade Updates (1)" ever ran.
//   FIX: Removed per-group seenWallet tracking entirely. Replaced with a composite
//   key of ALL group labels joined together, so the key is unique per "session"
//   of updates. More importantly: all groups are now processed in ONE continuous
//   lock cycle via processGroupQueue() — no more one-at-a-time single-group logic.
//
// BUG B: Emergency alert beeps and red banner on small % loss / tiny $ amount
//   ROOT CAUSE: Emergency check used OR logic — if EITHER % OR $ exceeded threshold,
//   it triggered. A trade at -15.53% but only -$0.62 would fire because -15% > 8%.
//   This causes false alerts on high-leverage small positions where % swings wildly
//   but the dollar risk is tiny.
//   FIX: New setting EMERGENCY_REQUIRES_BOTH = true (default). When true, BOTH the %
//   threshold AND the $ threshold must be exceeded to trigger the emergency alert.
//   Set to false to restore old OR behavior.
//
// CHANGELOG v20.6 — June 2026
// FIX (CRITICAL): Trade Updates / Copy buttons now work reliably on wallet tab
//
// ROOT CAUSES OF WALLET TAB FAILURES:
//
// BUG A — Emergency check ran BEFORE Trade Updates, blocking the update path
//   scanWallet() checked for emergency losses before calling handleWalletTradeUpdates()
//   Any loss on any trade (even -4%) triggered the emergency path, preventing Copy
//   clicks from ever being processed. Fixed: Trade Updates processed FIRST, always.
//
// BUG B — Emergency used aggregate wallet % instead of single-trade %  
//   readLossPctFromWalletBody() found ALL negative percentages in the page text,
//   including the overall wallet change. With multiple open trades summing to -15%,
//   it triggered emergency even though NO single trade exceeded the threshold.
//   Fixed: Use findWorstTradeCard() which parses individual trade P&L only.
//
// BUG C — seenWallet key used group.index (character position in innerText)
//   Prices update every second, shifting character positions. "Trade Updates (1)"
//   at position 450 becomes position 462 next scan → script thinks it's a new group
//   and re-processes, or the key never matches and the group is skipped entirely.
//   Fixed: Key uses label text only. Old groups expire after 90s.
//
// BUG D — processCopiesSequentially didn't handle "Add Stop-Loss" modal
//   Clicking Copy sometimes shows an "Add Stop-Loss" confirmation (Go Back | Confirm)
//   instead of the full position size modal. Script didn't recognize this modal
//   and fell through without clicking Confirm. Fixed: 3-modal-type detection.
//
// CHANGELOG v20.5 — June 2026
// FIX: Emergency alert beeps ONCE only (playAlert(1)) — sessionStorage guard
//      prevents repeat beeps on every keepalive page reload
// FIX: 30-minute open pause on emergency REMOVED — wallet tab keeps watching
//      so the trader can close the position at profit without interference
// FIX: Emergency banner text changed from "PAUSED 30min" to "LOSS ALERT (watching)"
// FIX: Beep sessionStorage key cleared on banner dismiss so the NEXT emergency
//      (new trade/new loss event) will beep fresh again
//
// CHANGELOG v20.4     June 2026
//
// ROOT CAUSE ANALYSIS — Why SO many trades were missed overnight:
//
// BUG #1 — KEEPALIVE RELOAD KILLS THE seenNotifs SET (BIGGEST ISSUE)
//   The keepalive timer fires every 20-55 seconds and calls location.reload().
//   On reload, seenNotifs = new Set() (resets to empty). BUT all the stale
//   old notification DOM elements are still visible on the reloaded page.
//   The script then re-processes all old notifications that were already seen
//   BEFORE the reload, consuming the lock (isExec=true) with stale trades
//   that have no Mimic button → 22s OPEN_BUTTON_TIMEOUT per stale trade.
//   With 50+ overnight notifications on screen, this creates a cascade of
//   22-second stalls, blocking every fresh trade for hours.
//   FIX: seenNotifs is now persisted in sessionStorage and restored on boot.
//   Stale notifications are NEVER re-queued after a reload.
//
// BUG #2 — SCAN INTERVAL STOPS FIRING AFTER KEEPALIVE RELOAD
//   setInterval(scan, SCAN_MS) is registered once at boot. When location.reload()
//   fires, the page reloads and the old interval is destroyed. The new page
//   re-registers the interval — but the scheduleReload() setTimeout also fires
//   on the new page, triggering ANOTHER reload within 20-55s. On mobile/low-memory
//   Chrome, this can cause the tab to reload faster than the scan interval ever
//   ticks. Result: the scan loop never reliably runs between reloads.
//   FIX: Keepalive reload interval extended to 3-7 MINUTES (was 20-55 seconds).
//   The page doesn't need reloading that aggressively. Notifications arrive via
//   websocket — the app stays live for hours without a reload. Reloading every
//   30 seconds was the primary cause of the overnight miss cascade.
//
// BUG #3 — MutationObserver NOT USED — RELYING SOLELY ON setInterval
//   SCAN_MS=2000ms polling means there's a 0-2 second window where a notification
//   appears and disappears (e.g. the DOM briefly flashes) before the poll fires.
//   On a busy overnight session, this means fast traders get missed.
//   FIX: Added MutationObserver on the notification list to trigger scanNotifs()
//   immediately on any DOM change, instead of waiting up to 2 seconds.
//
// BUG #4 — WRONG PAGE GUARD TRIGGERS DURING NORMAL POST NAVIGATION
//   When the notifications tab clicks a notification and navigates to /post/...,
//   the wrong-page guard (WRONG_PAGE_MS=20s) starts a countdown. But SAFE_PATHS
//   includes '/post/' — so this shouldn't fire. However, during the doOpen()
//   execution, unlock() calls window.location.href = HOME_URL. If the wrong-page
//   guard fires at the SAME TIME as unlock() fires a navigation, the tab can
//   end up in a reload loop for 20-40 seconds, missing trades during that window.
//   FIX: Wrong page guard now respects isExec=true and does not fire at all
//   while a trade open is in progress.
//
// BUG #5 — pendingTrades QUEUE NEVER DRAINS IF UNLOCK() SKIPS IT
//   unlock() checks pendingTrades.length > 0 and fires scanNotifs() — but only
//   if onPage('/notifications'). If unlock() fires while on /post/ (mid-navigation),
//   it navigates to HOME_URL and returns early WITHOUT processing the pending queue.
//   The pending trades sit in the array until the next scan tick (up to 2s later).
//   With fast traders opening multiple positions, the queue backs up.
//   FIX: unlock() always schedules scanNotifs() with a 1200ms delay after
//   navigation completes, regardless of current page.
//
// BUG #6 — seenNotifs KEY COLLISIONS ACROSS DIFFERENT TRADERS
//   stableKey() strips the timestamp from notification text. But if two different
//   traders open the same symbol at the same leverage, their stableKey() is
//   IDENTICAL. The second notification gets dropped as a duplicate.
//   FIX: stableKey() now includes the first 12 chars of the notification text
//   (which includes the trader handle) so different traders never collide.
//
// BUG #7 — SCAN LOOP SKIPS WHEN BROWSER TAB IS BACKGROUNDED
//   Chrome throttles setInterval to 1-second minimum when the tab is in background,
//   and can throttle to 60s+ after several minutes of inactivity (Chrome's
//   "Intensive throttling" policy). Overnight, this means SCAN_MS=2000 becomes
//   effectively 60,000ms, and many trades are processed 60 seconds late —
//   exceeding MAX_AGE_MINUTES=3 — and are rejected as stale.
//   FIX: Added Page Visibility API handler. When tab becomes visible again after
//   being backgrounded, an immediate scan() fires. Also added a keepalive
//   Web Worker workaround using a Blob URL worker that pings the main thread
//   every 10 seconds to prevent Chrome's aggressive tab throttling.
//   Also increased MAX_AGE_MINUTES from 3 → 5 to give a buffer for throttled tabs.
//
// BUG #8 — STALE LOCK: MAX_EXEC_MS=3 MINUTES ALLOWS LONG STALLS
//   If doOpen() gets stuck (e.g. Mimic button timeout=22s + confirm timeout=30s
//   + SL verify=14 attempts × 500ms = 7s + settle 5.5s), a worst-case
//   execution takes ~65 seconds. MAX_EXEC_MS=180s (3 min) means a stuck
//   execution won't be force-unlocked for up to 3 minutes — blocking all trades.
//   FIX: MAX_EXEC_MS reduced to 90 seconds. Added per-step timeout tracking.
//
// ════════════════════════════════════════════════════════════════════════════

// ── USER SETTINGS ──────────────────────────────────────────────────────────
const FORCE_POSITION_PCT   = null;   // null = CAP mode, number = FIXED mode
const MAX_POSITION_PCT     = 4.0;
const MANAGE_STOP_LOSS     = true;
const STOP_LOSS_PCT        = 4.0;
const REQUIRE_SL_BEFORE_CONFIRM = false;

const EMERGENCY_WALLET_LOSS_PCT = 8.0;
const EMERGENCY_MAX_LOSS_USD    = 10.0;
const PAUSE_NEW_OPENS_AFTER_EMERGENCY  = false; // ★ v20.5: disabled — let trader close at profit
const RESUME_WALLET_UPDATES_AFTER_EMERGENCY = true;

const ENABLE_AUDIO_ALERTS    = true;
const ENABLE_EMERGENCY_BANNER = true;

// ★ v20.7: Emergency threshold logic
//   true  = BOTH % loss AND $ loss must exceed thresholds to trigger alert
//           (prevents false beeps on high-% but tiny-$ leveraged positions)
//   false = EITHER threshold alone triggers (old behaviour)
const EMERGENCY_REQUIRES_BOTH = true;

// ── DOLLAR STOP-LOSS (★ NEW v20.8) ────────────────────────────────────────
//
//  When ENABLE_DOLLAR_STOP_LOSS = true, the wallet tab watches every active
//  trade and automatically closes any trade whose dollar loss reaches the
//  AUTO_CLOSE_USD_THRESHOLD amount.
//
//  This is a DOLLAR-ONLY check — no percentage involved.
//  Think of it as: "I never want to lose more than $X on any single trade."
//
//  Examples with AUTO_CLOSE_USD_THRESHOLD = 7.50:
//    BTC  20X Long  down $4.80  → NO close (below $7.50 threshold)
//    BTC  20X Long  down $5.00  → AUTO CLOSE triggered ✓
//    ETH   3X Long  down $6.23  → AUTO CLOSE triggered ✓
//    DOGE  5X Short down $1.42  → NO close (below $5 threshold)
//
//  Set ENABLE_DOLLAR_STOP_LOSS = false to disable completely.
//  Set AUTO_CLOSE_USD_THRESHOLD to any dollar amount you choose.
//
const ENABLE_DOLLAR_STOP_LOSS  = true;
const AUTO_CLOSE_USD_THRESHOLD = 7.5;  // ← change this ($). Close any trade losing >= this amount.


const SYMBOL_BLACKLIST = [];
const MAX_ALLOWED_LEVERAGE = 20;

// ★ v21.7: increased to 10 — with 15-45s reloads, trades appear within 45s
// (showing as 0-1m old). Buffer of 10min covers Chrome tab throttle bursts.
// Still safely rejects anything truly stale (hour-old trades etc).
const MAX_AGE_MINUTES = 10;

// ── TIMING ─────────────────────────────────────────────────────────────────
const SCAN_MS               = 1500;   // ★ v20.4: was 2000 — faster poll
const MAX_EXEC_MS           = 90000;  // ★ v20.4: was 180000 — faster stale-lock recovery (BUG #8)
const STALE_MS              = 20 * 60000; // ★ v20.4: was 10min — page is stable, less aggressive
const CONFIRM_WAIT_MS       = 3500;
const OPEN_CONFIRM_MS       = 6500;
const WRONG_PAGE_MS         = 30000;
const POST_ACTION_COOL      = 5000;

// ★ v21.7: Reload restored to 15-45 SECONDS (was wrongly changed to 3-7 MINUTES in v20.4).
// The page MUST refresh frequently — the WebSocket pushes updates to Flutter's canvas
// renderer but does NOT reliably update the flt-semantics accessibility tree that the
// script reads. Without a page refresh, new notification rows simply don't appear in
// the DOM even though they are visible on screen. At 3-7min reload, a trade can sit
// undetected for the entire reload window. 15-45s matches the original working behavior.
const RELOAD_MIN_S          = 15;   // 15 seconds minimum
const RELOAD_MAX_S          = 45;   // 45 seconds maximum

const MODAL_SETTLE_MS           = 5500;
const OPEN_BUTTON_TIMEOUT_MS    = 22000;
const CONFIRM_BUTTON_TIMEOUT_MS = 30000;
const VERIFY_SL_ATTEMPTS        = 14;
const VERIFY_SL_INTERVAL_MS     = 500;
const VALUE_VERIFY_ATTEMPTS     = 8;
const VALUE_VERIFY_INTERVAL_MS  = 350;

// ── INTERNALS ───────────────────────────────────────────────────────────────
const NOTIFICATIONS_URL = 'https://app.invoapp.com/notifications';
const WALLET_URL        = 'https://app.invoapp.com/wallet';
const IS_WALLET         = window.location.href.includes('/wallet');
const HOME_URL          = IS_WALLET ? WALLET_URL : NOTIFICATIONS_URL;
const HOME_PATH         = IS_WALLET ? '/wallet' : '/notifications';
const SAFE_PATHS        = ['/notifications', '/wallet', '/post/', '/portfolio/'];
const VERSION           = '21.7';
const OPEN_PHRASES      = [
  'opened new trade',
  'opened a new trade',
  'opened new position',
  'opened a new position',
  'opened a trade'
];
const RISK_STATE_KEY    = '__AM_V20_RISK_STATE__';
const SEEN_NOTIFS_KEY   = '__AM_V20_SEEN_NOTIFS__'; // ★ v20.4: persistent seenNotifs (BUG #1)
const PENDING_TRADES_KEY = '__AM_V21_PENDING_TRADES__'; // ★ v21.6: persist queue across reloads

let isExec        = false;
let execStart     = 0;
let lastActivity  = Date.now();
let lastActionTime = 0;
let wrongSince    = null;
let pendingTrades = [];
let accOn         = false;
let emergencyMode = false;
let openPauseUntil = 0;
let lastOpenContext = null;
const actLog = [];

const L = msg => console.log(`[v${VERSION}] ${msg}`);
const W = msg => console.warn(`[v${VERSION}] ${msg}`);

// ★ v20.4: seenNotifs is now persisted in sessionStorage (FIX for BUG #1)
// On reload, we restore seen notification keys so old notifs are never re-queued.
let seenNotifs = new Set();
let seenWallet = new Set();

function saveSeenNotifs() {
  try {
    const arr = [...seenNotifs];
    // Keep only the last 800 entries to avoid sessionStorage bloat
    if (arr.length > 800) arr.splice(0, arr.length - 800);
    sessionStorage.setItem(SEEN_NOTIFS_KEY, JSON.stringify(arr));
  } catch {}
}

function loadSeenNotifs() {
  try {
    const raw = sessionStorage.getItem(SEEN_NOTIFS_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      seenNotifs = new Set(arr);
      L(`Restored ${seenNotifs.size} seen notification keys from sessionStorage`);
    }
  } catch {}
}

// ★ v21.6: Save pending trade queue to sessionStorage so it survives page reloads.
function savePendingTrades() {
  try {
    const arr = pendingTrades.map(t => ({ key: t.key, label: t.label, savedAt: t.savedAt || Date.now() }));
    sessionStorage.setItem(PENDING_TRADES_KEY, JSON.stringify(arr));
  } catch {}
}

// ★ v21.6: Restore pending trades on boot — re-queues any saved within MAX_AGE_MINUTES.
function loadPendingTrades() {
  try {
    const raw = sessionStorage.getItem(PENDING_TRADES_KEY);
    if (!raw) return;
    sessionStorage.removeItem(PENDING_TRADES_KEY);
    const arr = JSON.parse(raw);
    const now = Date.now();
    let restored = 0;
    for (const entry of arr) {
      const ageMinsVal = (now - (entry.savedAt || 0)) / 60000;
      if (ageMinsVal > MAX_AGE_MINUTES) continue;
      if (!pendingTrades.some(p => p.key === entry.key)) {
        pendingTrades.push({ key: entry.key, label: entry.label, age: ageMinsVal, el: null, savedAt: entry.savedAt });
        restored++;
      }
    }
    if (restored > 0) {
      L(`loadPendingTrades: restored ${restored} pending trade(s) from prior session`);
      logAct('PENDING_RESTORED', `${restored} trade(s) re-queued from sessionStorage`);
    }
  } catch {}
}

function logAct(type, detail) {
  actLog.push({ t: new Date().toLocaleTimeString(), type, detail });
  if (actLog.length > 500) actLog.shift();
}

// ── RISK STATE ─────────────────────────────────────────────────────────────
function getRiskState() {
  try { return JSON.parse(sessionStorage.getItem(RISK_STATE_KEY) || '{}'); } catch { return {}; }
}
function setRiskState(patch) {
  try { sessionStorage.setItem(RISK_STATE_KEY, JSON.stringify({ ...getRiskState(), ...patch, ts: Date.now() })); } catch {}
}

// ── CONSOLE HELPERS ────────────────────────────────────────────────────────
window._status = () => {
  console.log(`\n=== v${VERSION} ${IS_WALLET ? 'WALLET' : 'NOTIFICATIONS'} ===`);
  console.log(`State: ${isExec ? 'EXECUTING' : 'WATCHING'} | Queue: ${pendingTrades.length} | Seen: ${seenNotifs.size}`);
  console.log(`Size: ${FORCE_POSITION_PCT !== null ? `FIXED ${FORCE_POSITION_PCT}%` : `CAP ${MAX_POSITION_PCT}%`}`);
  console.log(`Stop loss: ${MANAGE_STOP_LOSS ? `${STOP_LOSS_PCT}% | require verify=${REQUIRE_SL_BEFORE_CONFIRM}` : 'manual'}`);
  console.log(`Dollar stop-loss: ${ENABLE_DOLLAR_STOP_LOSS ? `ACTIVE — auto-close >= $${AUTO_CLOSE_USD_THRESHOLD}` : 'DISABLED'}`);
  console.log(`Auth watchdog: ${SESSION_WATCHDOG_ENABLED ? `ACTIVE (reload on ${SESSION_RELOAD_THRESHOLD} consecutive 401s)` : 'DISABLED'}`);
  console.log(`Max age: ${MAX_AGE_MINUTES}min | Max leverage: ${MAX_ALLOWED_LEVERAGE}X`);
  console.log(`Open pause active: ${opensPaused()} | Emergency mode: ${emergencyMode}`);
  console.log(`Activity (${actLog.length} events):`);
  actLog.slice(-80).forEach(e => console.log(`  [${e.t}] ${e.type}: ${e.detail}`));
  console.log('===================\n');
  return actLog;
};

window._unpause = () => {
  openPauseUntil = 0;
  setRiskState({ openPauseUntil: 0 });
  clearEmergencyBanner();
  badge('🟢 Active');
  L('Open pause cleared manually');
};

window._clearSeen = () => {
  seenNotifs = new Set();
  saveSeenNotifs();
  L('seenNotifs cleared — will re-scan all visible notifications');
};

// ── BADGE ──────────────────────────────────────────────────────────────────
function badge(text, color = '#16a34a') {
  let b = document.getElementById('am-badge');
  if (!b) {
    b = document.createElement('div');
    b.id = 'am-badge';
    b.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:99999;color:white;font-size:12px;font-weight:bold;padding:6px 12px;border-radius:20px;box-shadow:0 2px 8px rgba(0,0,0,0.35);font-family:sans-serif;cursor:pointer;user-select:none;';
    b.title = 'Click for log | window._status() | window._unpause()';
    b.addEventListener('click', () => window._status());
    document.body.appendChild(b);
  }
  b.style.background = color;
  b.textContent = `${IS_WALLET ? '💼' : '📋'} ${text}`;
}

function showEmergencyBanner(message) {
  if (!ENABLE_EMERGENCY_BANNER) return;
  let el = document.getElementById('am-emergency-banner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'am-emergency-banner';
    el.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:100000;background:#991b1b;color:#fff;padding:12px 18px;font:700 14px/1.4 sans-serif;text-align:center;box-shadow:0 4px 14px rgba(0,0,0,.35);';
    document.body.appendChild(el);
  }
  // ★ v20.5: Not paused — just an alert
  el.textContent = `⚠️ INVO LOSS ALERT: ${message} | Watching — trader may close at profit`;
}

function clearEmergencyBanner() {
  document.getElementById('am-emergency-banner')?.remove();
  // ★ v20.5: Reset beep guard on resolution so next new emergency beeps fresh
  try { sessionStorage.removeItem('__AM_EMERGENCY_BEEPED__'); } catch {}
  emergencyMode = false;
}

function playAlert(times = 3) {
  if (!ENABLE_AUDIO_ALERTS) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    let t = ctx.currentTime;
    for (let i = 0; i < times; i++) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'square';
      o.frequency.value = i % 2 ? 660 : 880;
      g.gain.setValueAtTime(0.001, t);
      g.gain.exponentialRampToValueAtTime(0.12, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
      o.connect(g); g.connect(ctx.destination);
      o.start(t); o.stop(t + 0.24);
      t += 0.28;
    }
  } catch {}
}

// ── PAUSE CONTROL ──────────────────────────────────────────────────────────
function setOpenPause(ms, reason) {
  openPauseUntil = Date.now() + ms;
  setRiskState({ openPauseUntil, reason, emergencyMode });
  logAct('PAUSE', `${Math.round(ms / 1000)}s: ${reason}`);
  showEmergencyBanner(`PAUSED ${Math.round(ms / 60000)}min: ${reason} | Run window._unpause() to clear`);
  playAlert(2);
}

function opensPaused() {
  const st = getRiskState();
  const until = Math.max(openPauseUntil || 0, st.openPauseUntil || 0);
  return !!(until && Date.now() < until);
}

// ── PAGE UTILS ─────────────────────────────────────────────────────────────
function onPage(p) { return window.location.href.includes(p); }
function reloadSafe() {
  if (isExec) return false;
  if (lastActionTime && Date.now() - lastActionTime < POST_ACTION_COOL) return false;
  return true;
}

// ── LOCK / UNLOCK ──────────────────────────────────────────────────────────
function lock(label) {
  isExec = true; execStart = Date.now(); wrongSince = null; lastActivity = Date.now();
  badge(`⚡ ${label}`, '#b45309');
  L(`lock: ${label}`);
}

function unlock() {
  isExec = false; execStart = 0; lastActionTime = Date.now();
  badge('🟢 Active');
  L('unlocked');
  // ★ v20.4 FIX (BUG #5): Always navigate home first, then schedule a scan
  // regardless of current page — ensures pending queue drains after navigation completes
  if (!onPage(HOME_PATH)) {
    window.location.href = HOME_URL;
    // scan will fire on next page load via boot sequence — no setTimeout needed
    return;
  }
  // Already on home page — process pending queue immediately
  if (pendingTrades.length > 0 && onPage('/notifications') && !opensPaused()) {
    setTimeout(scanNotifs, 800);
  }
}

function closeDone() {
  isExec = false; execStart = 0; seenWallet = new Set(); lastActionTime = Date.now();
  badge('🟢 Active');
  clearEmergencyBanner();
  setTimeout(() => { if (onPage('/wallet')) window.location.href = WALLET_URL; }, POST_ACTION_COOL);
}

// ── ACCESSIBILITY ──────────────────────────────────────────────────────────
function enableAcc() {
  if (accOn) return;
  const ph = document.querySelector('flt-semantics-placeholder');
  if (ph) {
    ph.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    ph.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    accOn = true; L('accessibility on');
  }
}

// ── ELEMENT HELPERS ────────────────────────────────────────────────────────
function visible(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return !!(r.width && r.height && r.bottom > 0 && r.right > 0);
}

function textOf(el) {
  return (el?.innerText || el?.textContent || el?.value || '').trim();
}

function ariaOf(el) {
  return (el?.getAttribute?.('aria-label') || '').trim();
}

function findByText(text) {
  const lo = text.toLowerCase();
  let best = null, bestArea = Infinity;
  for (const el of document.querySelectorAll('flt-semantics,flt-semantics-container,[role="button"],button,div,span,a')) {
    if (textOf(el).toLowerCase() !== lo) continue;
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    const area = r.width * r.height;
    if (area < bestArea) { bestArea = area; best = el; }
  }
  return best;
}

function findContaining(phrase) {
  const lo = phrase.toLowerCase();
  let best = null, bestArea = Infinity;
  for (const el of document.querySelectorAll('flt-semantics,flt-semantics-container,div,span,a,button')) {
    const t = textOf(el).toLowerCase();
    if (!t.includes(lo) || t.length > 450) continue;
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    const area = r.width * r.height;
    if (area < bestArea) { bestArea = area; best = el; }
  }
  return best;
}

// ── CLICK ──────────────────────────────────────────────────────────────────
function click(el) {
  if (!el || !visible(el)) return false;
  const r = el.getBoundingClientRect();
  if (!r.width) return false;
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  const o = { bubbles: true, cancelable: true, clientX: x, clientY: y };
  el.dispatchEvent(new PointerEvent('pointerdown', o));
  el.dispatchEvent(new PointerEvent('pointerup', o));
  el.dispatchEvent(new MouseEvent('click', o));
  const top = document.elementFromPoint(x, y);
  if (top && top !== el) {
    top.dispatchEvent(new PointerEvent('pointerdown', o));
    top.dispatchEvent(new PointerEvent('pointerup', o));
    top.dispatchEvent(new MouseEvent('click', o));
  }
  const label = textOf(el) || ariaOf(el) || '(no text)';
  L(`clicked: "${label.substring(0, 60)}"`);
  return true;
}

// ── WAIT HELPERS ───────────────────────────────────────────────────────────
function waitForPredicate(fn, onSuccess, timeout = 12000, interval = 300, onTimeout = null) {
  const start = Date.now();
  const iv = setInterval(() => {
    let result = null;
    try { result = fn(); } catch {}
    if (result) {
      clearInterval(iv);
      onSuccess(result);
    } else if (Date.now() - start > timeout) {
      clearInterval(iv);
      if (onTimeout) onTimeout();
      else unlock();
    }
  }, interval);
}

function waitForEl(texts, onSuccess, timeout = 12000) {
  if (!Array.isArray(texts)) texts = [texts];
  waitForPredicate(
    () => { for (const t of texts) { const el = findByText(t) || findContaining(t); if (el) return el; } return null; },
    el => { click(el); setTimeout(onSuccess, 700); },
    timeout, 300,
    () => { W(`timeout waiting for: [${texts.join(', ')}]`); logAct('TIMEOUT', texts.join(', ')); unlock(); }
  );
}

function dismissMenu() {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  const safe = document.elementFromPoint(window.innerWidth / 2, 10);
  if (safe) safe.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: window.innerWidth / 2, clientY: 10 }));
}

function menuOpen() {
  const b = document.body.innerText || '';
  return b.includes('Share Trade') && b.includes('Close Trade');
}

function checkModals() {
  const b = document.body.innerText || '';
  if (b.includes('Not Enough Funds')) {
    logAct('BLOCKED', 'Not Enough Funds');
    const btn = findByText('Go Back') || findByText('Close') || findContaining('Go Back');
    if (btn) click(btn);
    setTimeout(() => { seenWallet = new Set(); unlock(); }, 2000);
    return true;
  }
  if (b.includes('Duplicated Position')) {
    logAct('BLOCKED', 'Duplicated Position');
    setTimeout(() => unlock(), 1500);
    return true;
  }
  return false;
}

// ── SYMBOL / LEVERAGE FILTER ───────────────────────────────────────────────
function normalizeSymbol(sym) { return String(sym || '').trim().toUpperCase(); }
function symbolAllowed(sym) {
  const s = normalizeSymbol(sym);
  if (!s) return true;
  if (SYMBOL_WHITELIST.length && !SYMBOL_WHITELIST.map(normalizeSymbol).includes(s)) return false;
  if (SYMBOL_BLACKLIST.map(normalizeSymbol).includes(s)) return false;
  return true;
}

// ── NOTIFICATION AGE ───────────────────────────────────────────────────────
function ageMins(label) {
  if (/just now|now/i.test(label)) return 0;
  const m = label.match(/[·•‧･∙⋅\-–|]\s*(\d+)\s*(s|m|h|d)\b/i)
    || label.match(/(\d+)\s*(s|m|h|d)\s*ago/i)
    || label.match(/\b(\d+)\s*(s|m|h|d)\b(?!\s*%)/i);
  if (!m) return 0;
  const v = parseInt(m[1], 10);
  const u = m[2].toLowerCase();
  return u === 's' ? v / 60 : u === 'm' ? v : u === 'h' ? v * 60 : v * 1440;
}

// ★ v20.4 FIX (BUG #6): stableKey now includes trader handle prefix (first 20 chars)
// to prevent collision when two different traders open the same symbol/leverage
function stableKey(label) {
  // Preserve first 20 chars (usually the trader handle) before stripping timestamps
  const prefix = label.substring(0, 20).toLowerCase().replace(/\s+/g, '_');
  const stripped = label
    .replace(/[·•‧･∙⋅\-–|]\s*\d+\s*(s|m|h|d)\b/gi, '')
    .replace(/\b\d+\s*(s|m|h|d)\s*ago\b/gi, '')
    .replace(/\s+/g, ' ').trim().toLowerCase();
  return `${prefix}::${stripped}`;
}

function isOpenPhrase(text) {
  const lo = text.toLowerCase();
  return OPEN_PHRASES.some(p => lo.includes(p));
}

function findClickableParent(el) {
  let cur = el;
  for (let i = 0; i < 8; i++) {
    if (!cur || !cur.parentElement) break;
    cur = cur.parentElement;
    const role = cur.getAttribute?.('role') || '';
    const tag = (cur.tagName || '').toLowerCase();
    if (role === 'button' || role === 'link' || tag === 'button' || tag === 'a') return cur;
    const r = cur.getBoundingClientRect();
    if (r.width > 200 && r.height > 40) return cur;
  }
  return el;
}

// ── READ HELPERS ───────────────────────────────────────────────────────────
function readTraderPositionPct() {
  const m = (document.body.innerText || '').match(/Position Size\s*\((\d+(?:\.\d+)?)%\)/i);
  return m ? parseFloat(m[1]) : null;
}

function readWalletTotal() {
  const m = (document.body.innerText || '').match(/\$[\d.]+\s*\/\s*\$([\d,]+\.?\d*)/);
  return m ? parseFloat(m[1].replace(/,/g, '')) : null;
}

function readCurrentPrice() {
  const m = (document.body.innerText || '').match(/Current\s*Price\s*[:\s]+\$([\d,]+\.?\d*)/i);
  return m ? parseFloat(m[1].replace(/,/g, '')) : null;
}

function readTradeDirection() {
  const body = document.body.innerText || '';
  const dirMatch = body.match(/\b\d+\s*[Xx]\s*(Long|Short)\b/);
  if (dirMatch) return dirMatch[1].toLowerCase();
  if (/\bshort\b/i.test(body)) return 'short';
  if (/\blong\b/i.test(body)) return 'long';
  return null;
}

function inferCurrentSymbol() {
  const m = (document.body.innerText || '').match(/\b([A-Z]{2,10})\s+\d+\s*[Xx]\s+(Long|Short)\b/);
  return m ? m[1] : null;
}

function inferLeverageFromBody() {
  const m = (document.body.innerText || '').match(/\b(\d+)\s*[Xx]\s*(Long|Short)\b/);
  return m ? parseInt(m[1], 10) : null;
}

function precisionForPrice(p) {
  return p < 0.1 ? 6 : p < 1 ? 5 : p < 10 ? 4 : 2;
}

function computeStopLossPrice(currentPrice, direction) {
  const slPrice = direction === 'short'
    ? currentPrice * (1 + STOP_LOSS_PCT / 100)
    : currentPrice * (1 - STOP_LOSS_PCT / 100);
  return slPrice.toFixed(precisionForPrice(currentPrice));
}

function readLossPctFromWalletBody() {
  const matches = [...(document.body.innerText || '').matchAll(/\((-?\d+(?:\.\d+)?)%\)/g)].map(m => parseFloat(m[1]));
  const negs = matches.filter(v => !isNaN(v) && v < 0);
  return negs.length ? Math.min(...negs) : null;
}

function extractWorstLossUsd() {
  const vals = [...(document.body.innerText || '').matchAll(/-\$([\d,]+(?:\.\d+)?)/g)]
    .map(m => parseFloat(m[1].replace(/,/g, ''))).filter(v => !isNaN(v));
  return vals.length ? Math.max(...vals) : null;
}

function findWorstTradeCard() {
  const body = document.body.innerText || '';
  const m = body.match(/\b([A-Z]{2,10})\s+\d+\s*[Xx]\s+(Long|Short)[\s\S]{0,220}?-\$([\d,]+(?:\.\d+)?)[\s\S]{0,120}?\((-?\d+(?:\.\d+)?)%\)/i);
  if (!m) return null;
  const symbol = m[1], usd = parseFloat(String(m[3]).replace(/,/g, '')), pct = parseFloat(m[4]);
  return { symbol, usd, pct, el: findContaining(symbol) || findContaining(`${symbol} `) };
}

// ── FIND MIMIC TRADE BUTTON — 4-pass robust search ─────────────────────────
function findMimicButton() {
  // Pass 1: exact text match
  for (const t of ['Mimic Trade', 'Mimic']) {
    const el = findByText(t);
    if (el) return el;
  }
  // Pass 2: text containing "Mimic Trade"
  const c = findContaining('Mimic Trade');
  if (c) return c;
  // Pass 3: aria-label attribute contains "mimic"
  for (const el of document.querySelectorAll('[aria-label]')) {
    if ((ariaOf(el) || '').toLowerCase().includes('mimic') && visible(el)) return el;
  }
  // Pass 4: any visible short element with "mimic" in text
  for (const el of document.querySelectorAll(
    'flt-semantics, flt-semantics-container, button, [role="button"], div, span, a')) {
    const t = textOf(el).toLowerCase();
    if (t.includes('mimic') && t.length < 80 && visible(el)) return el;
  }
  return null;
}

// ── INPUT HELPERS ──────────────────────────────────────────────────────────
function findPositionSizeInput() {
  for (const el of document.querySelectorAll('[role="textbox"],[role="spinbutton"],input[type="number"],input[type="text"]')) {
    if (visible(el)) return el;
  }
  for (const el of document.querySelectorAll('flt-semantics[contenteditable="true"]')) {
    if (visible(el)) return el;
  }
  const lbl = findContaining('Position Size');
  if (lbl) {
    const r = lbl.getBoundingClientRect();
    for (const el of document.querySelectorAll('flt-semantics,div,span,input')) {
      if (el === lbl || !visible(el)) continue;
      const er = el.getBoundingClientRect();
      if (er.top > r.bottom && er.top < r.bottom + 140 && er.width > 40 && /^\$?[\d.]+$/.test(textOf(el))) return el;
    }
  }
  return null;
}

function findStopLossInput() {
  const lbl = findContaining('Stop-Loss Price') || findContaining('Stop Loss Price');
  if (lbl) {
    const r = lbl.getBoundingClientRect();
    for (const el of document.querySelectorAll('[role="textbox"],[role="spinbutton"],input,flt-semantics[contenteditable="true"],div,span')) {
      if (!visible(el)) continue;
      const er = el.getBoundingClientRect();
      const t = textOf(el);
      if (er.top > r.top - 10 && er.top < r.bottom + 160 && er.width > 30 && /^[\$\d\-.]/.test(t) && t !== textOf(lbl)) return el;
    }
  }
  const inputs = [...document.querySelectorAll('[role="textbox"],[role="spinbutton"],input[type="number"],input[type="text"],flt-semantics[contenteditable="true"]')].filter(visible);
  return inputs.length >= 2 ? inputs[1] : null;
}

function injectValue(el, value) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y }));
  el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x, clientY: y }));
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y }));
  el.focus?.();
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }));
  el.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', ctrlKey: true, bubbles: true }));
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  if (el.contentEditable === 'true' || el.isContentEditable) {
    el.innerText = value;
    el.dispatchEvent(new InputEvent('input', { data: value, bubbles: true }));
    return true;
  }
  for (let i = 0; i < 18; i++) {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Backspace', bubbles: true }));
  }
  for (const ch of value) {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
    el.dispatchEvent(new InputEvent('beforeinput', { data: ch, inputType: 'insertText', bubbles: true }));
    el.dispatchEvent(new InputEvent('input', { data: ch, inputType: 'insertText', bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
  }
  return true;
}

function verifyElementContainsValue(el, expected, done, attempt = 0) {
  const txt = textOf(el).replace(/[$,\s]/g, '');
  const want = String(expected).replace(/[$,\s]/g, '');
  const val = String(el?.value || '').replace(/[$,\s]/g, '');
  if (txt.includes(want) || val.includes(want)) { done(true); return; }
  if (attempt >= VALUE_VERIFY_ATTEMPTS) { done(false); return; }
  setTimeout(() => verifyElementContainsValue(el, expected, done, attempt + 1), VALUE_VERIFY_INTERVAL_MS);
}

function verifyStopLossVisible(expectedStr, done, attempt = 0) {
  const body = document.body.innerText || '';
  const norm = expectedStr.replace(/\.?0+$/, '');
  const ok = (body.includes('Stop-Loss Price') || body.includes('Stop Loss Price') || body.includes('Stop-Loss'))
    && (body.includes(expectedStr) || body.includes(norm) || !!findContaining(expectedStr));
  if (ok) { done(true); return; }
  if (attempt >= VERIFY_SL_ATTEMPTS) { done(false); return; }
  setTimeout(() => verifyStopLossVisible(expectedStr, done, attempt + 1), VERIFY_SL_INTERVAL_MS);
}

// ── POSITION SIZE ──────────────────────────────────────────────────────────
function setPositionSize(callback) {
  badge('⚡ CHECK SIZE', '#7c3aed');
  let attempts = 0;
  const trySet = () => {
    if (++attempts > 24) {
      logAct('SIZE_WARN', 'Position size field not found — proceeding anyway');
      W('Position size field not found after 24 attempts — proceeding');
      callback?.(false, null);
      return;
    }
    const total = readWalletTotal();
    if (!total || total < 1) { setTimeout(trySet, 300); return; }
    const traderPct = readTraderPositionPct();
    let finalPct;
    if (FORCE_POSITION_PCT !== null) finalPct = FORCE_POSITION_PCT;
    else if (traderPct !== null && traderPct <= MAX_POSITION_PCT) finalPct = traderPct;
    else finalPct = MAX_POSITION_PCT;
    const targetAmount = Math.floor((total * finalPct / 100) * 100) / 100;
    const inputEl = findPositionSizeInput();
    if (!inputEl) { setTimeout(trySet, 300); return; }
    injectValue(inputEl, targetAmount.toFixed(2));
    verifyElementContainsValue(inputEl, targetAmount.toFixed(2), ok => {
      logAct('SIZE_SET', `${finalPct}% = $${targetAmount.toFixed(2)} of $${total} | verify=${ok}`);
      badge(`⚡ $${targetAmount.toFixed(2)} (${finalPct}%)`, ok ? '#7c3aed' : '#b45309');
      callback?.(ok, { total, traderPct, finalPct, targetAmount: targetAmount.toFixed(2) });
    });
  };
  setTimeout(trySet, 300);
}

// ── STOP LOSS ──────────────────────────────────────────────────────────────
function setStopLoss(callback) {
  if (!MANAGE_STOP_LOSS) { callback?.(true, null); return; }
  badge('⚡ SL CHECK', '#dc2626');
  let attempts = 0;
  const trySet = () => {
    if (++attempts > 28) {
      logAct('SL_WARN', 'SL field not found / verify failed — proceeding');
      W('SL field not found after 28 attempts — proceeding without SL');
      callback?.(false, null);
      return;
    }
    const currentPrice = readCurrentPrice();
    const direction = readTradeDirection();
    if (!currentPrice || !direction) { setTimeout(trySet, 350); return; }
    const slStr = computeStopLossPrice(currentPrice, direction);
    const body = document.body.innerText || '';
    const toggleIsOff = body.includes('Stop-Loss Price') && /Stop-Loss Price[\s\S]{0,50}-?\$?0\b/.test(body);
    if (toggleIsOff) {
      const slToggle = findByText('Stop-Loss') || findContaining('Stop-Loss');
      if (slToggle) { click(slToggle); setTimeout(trySet, 900); return; }
    }
    const slField = findStopLossInput();
    if (!slField) { setTimeout(trySet, 350); return; }
    injectValue(slField, slStr);
    verifyElementContainsValue(slField, slStr, okField => {
      verifyStopLossVisible(slStr, okVisible => {
        const ok = okField || okVisible;
        logAct('SL_SET', `${direction.toUpperCase()} @ ${currentPrice} → ${slStr} | verify=${ok}`);
        badge(ok ? `⚡ SL ${slStr}` : '⚠️ SL not verified', ok ? '#dc2626' : '#b45309');
        callback?.(ok, { direction, currentPrice, slStr, okField, okVisible });
      });
    });
  };
  setTimeout(trySet, 400);
}

// ── RISK BLOCK CHECK ───────────────────────────────────────────────────────
function shouldBlockOpenFromCurrentView() {
  const symbol = inferCurrentSymbol();
  const lev = inferLeverageFromBody();
  if (symbol && !symbolAllowed(symbol)) return `Symbol ${symbol} blocked by filter rules`;
  if (lev && MAX_ALLOWED_LEVERAGE && lev > MAX_ALLOWED_LEVERAGE) return `Leverage ${lev}X exceeds max ${MAX_ALLOWED_LEVERAGE}X`;
  return null;
}

function abortForWalletEmergency(reason) {
  emergencyMode = true;
  logAct('EMERGENCY', reason);
  showEmergencyBanner(reason);
  // ★ v20.5: Single beep ONCE per session — sessionStorage prevents repeat on reload
  const beepKey = '__AM_EMERGENCY_BEEPED__';
  if (!sessionStorage.getItem(beepKey)) {
    playAlert(1);
    try { sessionStorage.setItem(beepKey, Date.now()); } catch {}
    logAct('EMERGENCY_BEEP', 'Single beep fired — silent on reload');
  } else {
    logAct('EMERGENCY_SILENT', 'Already beeped this session — silent');
  }
  badge('🚨 LOSS ALERT (watching)', '#991b1b');
  // ★ v20.5: No 30-min pause — wallet tab keeps watching so trader can close at profit
  logAct('EMERGENCY_NO_PAUSE', 'Wallet watching continues — not paused');
}

// ════════════════════════════════════════════════════════════════════════════
// TAB 1 — /notifications (opens new trades)
// ════════════════════════════════════════════════════════════════════════════
function scanNotifs() {
  if (!onPage('/notifications')) return;
  if (opensPaused()) {
    const st = getRiskState();
    const remaining = Math.round((Math.max(openPauseUntil || 0, st.openPauseUntil || 0) - Date.now()) / 1000);
    badge(`⏸ OPEN PAUSED ${remaining}s`, '#991b1b');
    return;
  }

  const freshTrades = [];
  const addTrade = (el, label) => {
    if (!label || label.length < 5 || label.length > 600) return;
    if (!isOpenPhrase(label)) return;
    const key = stableKey(label);
    if (seenNotifs.has(key)) return;
    const age = ageMins(label);
    if (age > MAX_AGE_MINUTES) {
      seenNotifs.add(key);
      saveSeenNotifs(); // ★ v20.4: persist so reload doesn't re-process these
      if (age < 30) logAct('STALE', `${age.toFixed(1)}m: ${label.substring(0, 60)}`);
      return;
    }
    freshTrades.push({ el, label, key, age });
  };

  // Pass 1: aria-label attributes
  document.querySelectorAll('[aria-label]').forEach(el => addTrade(el, el.getAttribute('aria-label') || ''));
  // Pass 2: flt-semantics innerText fallback
  document.querySelectorAll('flt-semantics, flt-semantics-container').forEach(el => {
    const txt = textOf(el);
    if (!txt || txt.length < 5 || txt.length > 400) return;
    if (!isOpenPhrase(txt)) return;
    if (seenNotifs.has(stableKey(txt))) return;
    addTrade(findClickableParent(el), txt);
  });

  if (!freshTrades.length) return;

  const seen = new Set();
  const unique = freshTrades.filter(t => seen.has(t.key) ? false : (seen.add(t.key), true));
  unique.sort((a, b) => a.age - b.age);

  if (isExec) {
    // ★ v21.6: Do NOT add to seenNotifs when queuing — only when actually processing.
    // If page reloads while isExec, seenNotifs would block the trade on next boot.
    unique.forEach(t => {
      if (!pendingTrades.some(p => p.key === t.key)) {
        t.savedAt = Date.now();
        pendingTrades.push(t);
        logAct('QUEUED', t.label.substring(0, 60));
      }
    });
    savePendingTrades(); // ★ v21.6: persist so reload doesn't lose queued trades
    return;
  }

  // Only mark seen when we're actually about to process
  unique.forEach(t => { seenNotifs.add(t.key); });
  saveSeenNotifs();

  const target = pendingTrades.length > 0 ? pendingTrades.shift() : unique[0];
  // ★ v21.6: el is null for trades restored from sessionStorage — re-find by key
  if (!target.el) {
    const found = [...document.querySelectorAll('[aria-label]')]
      .find(el => stableKey(el.getAttribute('aria-label') || '') === target.key);
    target.el = found ? findClickableParent(found) : null;
    if (!target.el) {
      W(`pendingTrades: cannot re-find element for "${target.label?.substring(0, 50)}" — skipping`);
      savePendingTrades();
      setTimeout(scanNotifs, 800);
      return;
    }
  }
  seenNotifs.add(target.key);
  saveSeenNotifs();
  L(`🚨 FRESH (${target.age.toFixed(1)}m): ${target.label.substring(0, 80)}`);
  logAct('OPENING', target.label.substring(0, 80));
  lock('OPENING');
  click(target.el);
  setTimeout(doOpen, 1700);
  if (seenNotifs.size > 1000) {
    const trimmed = [...seenNotifs].slice(-500);
    seenNotifs = new Set(trimmed);
    saveSeenNotifs();
  }
}

// ── doOpen ─────────────────────────────────────────────────────────────────
function doOpen() {
  const preBlock = shouldBlockOpenFromCurrentView();
  if (preBlock) {
    W(`Risk block: ${preBlock} — skipping gracefully`);
    logAct('RISK_SKIP', preBlock);
    badge('⏭ SKIPPED', '#b45309');
    unlock();
    return;
  }

  waitForPredicate(
    () => findMimicButton(),
    (mimicBtn) => {
      L('→ Mimic Trade button found — clicking');
      click(mimicBtn);

      setTimeout(() => {
        setPositionSize((sizeOK, sizeCtx) => {
          if (!sizeOK) {
            W('Position size verification failed — proceeding with displayed amount');
            logAct('SIZE_WARN', 'Proceeding without verified size');
          }

          setTimeout(() => {
            setStopLoss((slOK, slCtx) => {
              const openCtx = {
                ts: Date.now(),
                symbol: inferCurrentSymbol(),
                leverage: inferLeverageFromBody(),
                size: sizeCtx,
                sl: slCtx,
                slVerified: slOK
              };
              lastOpenContext = openCtx;

              if (MANAGE_STOP_LOSS && REQUIRE_SL_BEFORE_CONFIRM && !slOK) {
                W('SL not verified and REQUIRE_SL_BEFORE_CONFIRM=true — skipping gracefully');
                logAct('SL_SKIP', 'SL required but not verified');
                badge('⏭ SL SKIP', '#b45309');
                unlock();
                return;
              }

              setTimeout(() => {
                waitForEl(['Confirm Position', 'Confirm'], () => {
                  lastActionTime = Date.now();
                  logAct('SUCCESS', `Trade opened ${openCtx.symbol || ''} ${new Date().toLocaleTimeString()}`);
                  setRiskState({ lastOpenContext: openCtx, needWalletVerify: MANAGE_STOP_LOSS, expectedStopLoss: slCtx?.slStr || null });
                  setTimeout(unlock, OPEN_CONFIRM_MS);
                }, CONFIRM_BUTTON_TIMEOUT_MS);
              }, 1000);
            });
          }, 1400);
        });
      }, MODAL_SETTLE_MS);
    },
    OPEN_BUTTON_TIMEOUT_MS,
    300,
    () => {
      W('Mimic Trade button not found — trade may already be closed. Skipping gracefully.');
      logAct('SKIP', 'Mimic Trade button not found on post page');
      badge('⏭ NO MIMIC BTN', '#b45309');
      unlock();
    }
  );
}

// ════════════════════════════════════════════════════════════════════════════
// TAB 2 — /wallet (closes + updates trades)
// ════════════════════════════════════════════════════════════════════════════
function verifyPostOpenRiskIfNeeded() {
  const st = getRiskState();
  if (!st.needWalletVerify) return;
  const expected = st.expectedStopLoss;
  const body = document.body.innerText || '';
  const hasExpected = expected && (body.includes(expected) || !!findContaining(expected));
  if (hasExpected) {
    logAct('WALLET_VERIFY', `SL ${expected} confirmed on wallet`);
    setRiskState({ needWalletVerify: false, walletVerifiedAt: Date.now() });
    clearEmergencyBanner();
    return;
  }
  const lossPct = readLossPctFromWalletBody();
  const lossUsd = extractWorstLossUsd();
  if ((lossPct !== null && Math.abs(lossPct) >= STOP_LOSS_PCT + 1.5) ||
      (lossUsd !== null && lossUsd >= EMERGENCY_MAX_LOSS_USD)) {
    setRiskState({ needWalletVerify: false, walletVerifyFailedAt: Date.now() });
    attemptEmergencyClose(`SL not confirmed and loss=${lossPct ?? '?'}% / -$${lossUsd ?? '?'}`);
  }
}

function attemptEmergencyClose(reason) {
  if (isExec) return;
  abortForWalletEmergency(reason);
  const directBtn = findByText('Close Position') || findContaining('Close Position');
  if (directBtn && !menuOpen()) {
    lock('EMERGENCY CLOSE');
    click(directBtn);
    setTimeout(doCloseConfirm, 1800);
    return;
  }
  const worst = findWorstTradeCard();
  if (worst?.el) {
    click(worst.el);
    logAct('EMERGENCY', `Worst trade: ${worst.symbol} -$${worst.usd} ${worst.pct}%`);
    setTimeout(() => {
      const btn = findByText('Close Position') || findContaining('Close Position');
      if (btn) { lock('EMERGENCY CLOSE'); click(btn); setTimeout(doCloseConfirm, 1800); }
      else if (RESUME_WALLET_UPDATES_AFTER_EMERGENCY) unlock();
    }, 1400);
    return;
  }
  if (RESUME_WALLET_UPDATES_AFTER_EMERGENCY) setTimeout(() => unlock(), 2000);
}

function doCloseConfirm(attempt = 0) {
  if (attempt > 28) { W('Close confirm not found'); unlock(); return; }
  const body = document.body.innerText || '';
  const modal = body.includes('Exit Price') || body.includes('Position Size:') || body.includes('Confirm');
  const btn = findByText('Confirm') || findByText('Confirm Position');
  if (btn && modal) {
    click(btn); lastActionTime = Date.now();
    logAct('CLOSED', `Position closed at ${new Date().toLocaleTimeString()}`);
    clearEmergencyBanner();
    setTimeout(() => closeDone(), CONFIRM_WAIT_MS);
  } else {
    setTimeout(() => doCloseConfirm(attempt + 1), 600);
  }
}

function countVisibleCopies() {
  return [...document.querySelectorAll('flt-semantics,div,span,button')]
    .filter(el => textOf(el) === 'Copy' && visible(el)).length;
}

// ★ v21.1: findTradeUpdateGroups — captures real DOM element per group
//
// CRITICAL FIX over all prior versions:
// Previously this used innerText regex → label strings only, then re-searched
// by text in expandTradeUpdateGroup → always found the same (first) element.
//
// Now: queries the DOM directly, finds ALL matching elements, deduplicates
// overlapping Flutter accessibility nodes, sorts by Y position (top-to-bottom),
// and stores el directly. No text re-search ever happens.
function findTradeUpdateGroups() {
  const RE = /^Trade Updates?\s*\((\d+)\)$/i;
  const candidates = [];

  for (const el of document.querySelectorAll('flt-semantics,flt-semantics-container,div,span,button,a')) {
    const t = textOf(el);
    const m = t.match(RE);
    if (!m) continue;
    if (!visible(el)) continue;
    const count = parseInt(m[1], 10);
    if (count < 1) continue;
    const r = el.getBoundingClientRect();
    candidates.push({ label: t, count, el, r });
  }

  if (!candidates.length) return [];

  // Deduplicate overlapping Flutter accessibility nodes.
  // When two candidates have heavily overlapping bounding rects, keep the
  // one with the smaller area (the tightest/most-specific element).
  const kept = [];
  for (const c of candidates) {
    let duplicate = false;
    for (const k of kept) {
      const ox = Math.max(0, Math.min(c.r.right, k.r.right) - Math.max(c.r.left, k.r.left));
      const oy = Math.max(0, Math.min(c.r.bottom, k.r.bottom) - Math.max(c.r.top, k.r.top));
      const overlap = ox * oy;
      const areaC = c.r.width * c.r.height;
      const areaK = k.r.width * k.r.height;
      if (overlap > 0.7 * Math.min(areaC, areaK)) {
        // These two are the same logical element — keep the smaller one
        if (areaC < areaK) {
          kept.splice(kept.indexOf(k), 1, c); // replace k with c
        }
        duplicate = true;
        break;
      }
    }
    if (!duplicate) kept.push(c);
  }

  // Sort top-to-bottom by Y position so processing order matches visual order
  kept.sort((a, b) => a.r.top - b.r.top);

  L(`findTradeUpdateGroups: found ${kept.length} group(s): ${kept.map(g => `${g.label}@y${Math.round(g.r.top)}`).join(', ')}`);
  return kept;
}

// ★ v21.1: expandTradeUpdateGroup — clicks the pre-captured DOM element directly.
// No text search. The el was captured by findTradeUpdateGroups at scan time.
function expandTradeUpdateGroup(group) {
  if (!group.el || !visible(group.el)) {
    W(`expandTradeUpdateGroup: el for "${group.label}" is not visible — cannot expand`);
    return false;
  }
  click(group.el);
  logAct('EXPAND', `${group.label} @ y${Math.round(group.r?.top ?? 0)}`);
  return true;
}

// ★ v21.0: Find all visible Copy buttons (unconfirmed updates)
function findVisibleCopyButtons() {
  return [...document.querySelectorAll('flt-semantics,div,span,button')]
    .filter(el => textOf(el) === 'Copy' && visible(el));
}

// ★ v21.0: Find all visible Copied buttons (already-confirmed updates)
function findVisibleCopiedButtons() {
  return [...document.querySelectorAll('flt-semantics,div,span,button')]
    .filter(el => textOf(el) === 'Copied' && visible(el));
}

// ★ v21.1: Return Copy/Copied counts scoped to within a vertical window below
// a group header element. This prevents buttons from other expanded groups from
// being counted as belonging to the current group.
// groupEl   — the Trade Updates header DOM element
// windowPx  — how many pixels below the header to scan (default 400)
function countGroupCopyState(groupEl, windowPx = 400) {
  if (!groupEl) {
    // Fallback: global count (used in final sweep where no specific group matters)
    return {
      copyCount:   findVisibleCopyButtons().length,
      copiedCount: findVisibleCopiedButtons().length
    };
  }
  const headerBottom = groupEl.getBoundingClientRect().bottom;
  const scanBottom   = headerBottom + windowPx;

  let copyCount = 0, copiedCount = 0;
  for (const el of document.querySelectorAll('flt-semantics,div,span,button')) {
    if (!visible(el)) continue;
    const t = textOf(el);
    if (t !== 'Copy' && t !== 'Copied') continue;
    const r = el.getBoundingClientRect();
    // Must be below the header and within the scan window
    if (r.top < headerBottom - 10 || r.top > scanBottom) continue;
    if (t === 'Copy')   copyCount++;
    if (t === 'Copied') copiedCount++;
  }
  return { copyCount, copiedCount };
}

// ★ v21.1: Wait for a group to expand — polls until Copy or Copied rows appear
// within the vertical window below the group header.
// Retries the expand click once if nothing appears after half the timeout.
// ★ v21.5 FIX BUG B: Pre-checks if group is already expanded BEFORE clicking.
// If Copy/Copied rows are already visible, calls onReady() immediately without
// touching the DOM. Clicking an already-open header collapses it — the Copy
// button disappears, polls find nothing, onFail fires, Copy is never clicked.
function waitForGroupExpansion(group, onReady, onFail) {
  const EXPAND_POLL_MS    = 300;
  const EXPAND_TIMEOUT_MS = 6000;
  const MAX_ATTEMPTS      = 2;

  // ★ v21.5: Check BEFORE clicking — if already expanded, don't collapse it
  const { copyCount: preCopy, copiedCount: preCopied } = countGroupCopyState(group.el);
  if (preCopy + preCopied > 0) {
    logAct('ALREADY_EXPANDED',
      `${group.label}: already open — ${preCopy} Copy, ${preCopied} Copied — skipping click`);
    onReady(preCopy);
    return;
  }

  let attempt = 0;
  let elapsed = 0;

  function tryExpand() {
    attempt++;
    expandTradeUpdateGroup(group);
    elapsed = 0;
    poll();
  }

  function poll() {
    const { copyCount, copiedCount } = countGroupCopyState(group.el);
    const total = copyCount + copiedCount;

    if (total > 0) {
      logAct('EXPANDED', `${group.label}: ${copyCount} Copy, ${copiedCount} Copied below header`);
      onReady(copyCount);
      return;
    }

    elapsed += EXPAND_POLL_MS;
    if (elapsed >= EXPAND_TIMEOUT_MS) {
      if (attempt < MAX_ATTEMPTS) {
        L(`waitForGroupExpansion: retry expand for "${group.label}" (attempt ${attempt + 1})`);
        tryExpand();
      } else {
        W(`waitForGroupExpansion: no Copy/Copied for "${group.label}" after ${MAX_ATTEMPTS} clicks — skipping`);
        logAct('EXPAND_FAIL', group.label);
        onFail();
      }
      return;
    }

    setTimeout(poll, EXPAND_POLL_MS);
  }

  tryExpand();
}

// ★ v21.4: detectModalType()
// DUAL-STRATEGY: DOM-element scan of ALL elements (not just flt-semantics) PLUS
// body.innerText fallback. Flutter modal overlays render inside a separate
// flt-glass-pane layer — a different DOM subtree that the curated
// flt-semantics/button selector list may completely miss.
// Strategy A: querySelectorAll('*') text scan — catches any element in any layer.
// Strategy B: document.body.innerText fallback — belt-and-suspenders.
// Also logs what IS found for easier debugging.
//
// Returns: 'adjust' | 'position' | 'confirm' | 'close' | null
function detectModalType() {
  // ── Strategy A: scan ALL visible DOM elements for modal keywords ──────────
  const keywords = ['Confirm','Reset','Adjust Position Size','Go Back','Exit Price','Cancel','Position Size'];
  const found = new Set();
  for (const el of document.querySelectorAll('*')) {
    if (!visible(el)) continue;
    const t = (el.innerText || el.textContent || '').trim();
    if (!t || t.length > 600) continue;
    for (const kw of keywords) {
      if (t === kw || t.includes(kw)) found.add(kw);
    }
  }

  // ── Strategy B: body.innerText fallback ──────────────────────────────────
  const body = document.body.innerText || document.body.textContent || '';
  for (const kw of keywords) {
    if (body.includes(kw)) found.add(kw);
  }

  const hasConfirm    = found.has('Confirm');
  const hasReset      = found.has('Reset');
  const hasAdjust     = found.has('Adjust Position Size');
  const hasGoBack     = found.has('Go Back');
  const hasExitPrice  = found.has('Exit Price');
  const hasCancel     = found.has('Cancel');
  const hasPositionSz = found.has('Position Size');

  // Log what was found — visible in console for debugging
  if (found.size > 0) {
    L(`detectModalType found: [${[...found].join(', ')}]`);
  }

  // Priority order — most-specific first
  if (hasAdjust || (hasReset && hasPositionSz && hasConfirm && !hasGoBack)) {
    return 'adjust';
  }
  if (hasExitPrice && hasConfirm) {
    return 'close';
  }
  if (hasConfirm && (hasGoBack || hasCancel)) {
    return 'confirm';
  }
  if (hasPositionSz && hasConfirm && !hasGoBack) {
    return 'position';
  }

  // ★ v21.5 FIX BUG A:
  // "Adjust Position Size" modal fallback.
  // The modal title never appears in Flutter's accessibility tree — only the
  // "Confirm" and "Reset" buttons are exposed. None of the conditions above
  // matched [Confirm, Reset] alone, so detectModalType() returned null for
  // the entire 6-second polling window → Confirm was never clicked.
  // "Reset" does not appear in any other known Involio modal, so this is safe.
  if (hasConfirm && hasReset && !hasGoBack && !hasCancel && !hasExitPrice) {
    L('detectModalType: [Confirm+Reset] fallback → returning "adjust"');
    return 'adjust';
  }

  return null; // not rendered yet
}

// ★ v21.1/v21.3: Process one Copy button click scoped to a group's Y window.
// v21.3 KEY CHANGE: replaced fixed 1800ms + body.innerText modal detection
// with a 300ms polling loop using detectModalType() (DOM-element queries).
// body.innerText was always stale at 1800ms in Flutter web → all conditions
// false → retry loop → maxLoops exhausted → unlock() with modal still open.
function processSingleCopy(loop, maxLoops, groupEl, onDone) {
  if (loop >= maxLoops) { onDone(); return; }
  if (checkModals()) return;

  const copies = findVisibleCopyButtons();
  if (!copies.length) {
    const { copiedCount } = countGroupCopyState(groupEl);
    logAct('COPY_DONE', `No more Copy buttons at loop ${loop} — ${copiedCount} Copied confirmed`);
    onDone();
    return;
  }

  click(copies[0]);
  const { copiedCount: doneSoFar } = countGroupCopyState(groupEl);
  logAct('COPY_CLICK', `Copy ${loop + 1}/${maxLoops} (${copies.length} Copy remaining, ${doneSoFar} Copied done)`);

  // Verify Copy→Copied after modal is confirmed, then advance the loop
  function afterConfirm() {
    const VERIFY_MS = 300, VERIFY_MAX = 10;
    let v = 0;
    const verifyCopied = () => {
      const nowCopies = findVisibleCopyButtons().length;
      const { copiedCount: nowCopied } = countGroupCopyState(groupEl);
      if (nowCopies < copies.length || nowCopied > doneSoFar) {
        logAct('COPY_VERIFIED', `Button confirmed Copied (Copy left: ${nowCopies}, Copied: ${nowCopied})`);
        setTimeout(() => processSingleCopy(loop + 1, maxLoops, groupEl, onDone), CONFIRM_WAIT_MS);
      } else if (++v >= VERIFY_MAX) {
        W(`processSingleCopy: Copy→Copied not confirmed after ${VERIFY_MS * VERIFY_MAX}ms — proceeding`);
        logAct('COPY_VERIFY_WARN', `Copy→Copied not confirmed at loop ${loop}`);
        setTimeout(() => processSingleCopy(loop + 1, maxLoops, groupEl, onDone), CONFIRM_WAIT_MS);
      } else {
        setTimeout(verifyCopied, VERIFY_MS);
      }
    };
    setTimeout(verifyCopied, 600);
  }

  // ★ v21.3: Poll every 300ms using detectModalType() — DOM-element based.
  // Fires first check at 400ms (Flutter needs a moment to start rendering).
  // Gives up after 6 seconds (MODAL_MAX_WAIT) and skips to next loop.
  const MODAL_POLL_MS  = 300;
  const MODAL_MAX_WAIT = 6000;
  let   modalElapsed   = 0;

  function pollForModal() {
    if (checkModals()) return;

    const modalType = detectModalType();

    if (!modalType) {
      // Modal not rendered yet — keep waiting
      modalElapsed += MODAL_POLL_MS;
      if (modalElapsed >= MODAL_MAX_WAIT) {
        W(`processSingleCopy: No modal detected after ${MODAL_MAX_WAIT}ms — skipping loop ${loop}`);
        logAct('COPY_NO_MODAL', `Loop ${loop}: timed out waiting for modal`);
        setTimeout(() => processSingleCopy(loop + 1, maxLoops, groupEl, onDone), 500);
      } else {
        setTimeout(pollForModal, MODAL_POLL_MS);
      }
      return;
    }

    logAct('COPY_MODAL', `Modal type: "${modalType}" detected at ${modalElapsed}ms`);

    if (modalType === 'adjust') {
      // Trader resized their position — accept change as-is, just click Confirm
      const btn = findByText('Confirm') || findContaining('Confirm');
      if (btn) { click(btn); lastActionTime = Date.now(); }
      else W('processSingleCopy: adjust modal — Confirm not found in DOM');
      afterConfirm();

    } else if (modalType === 'position') {
      // New-trade position-size modal — scale to our wallet %, then Confirm
      setPositionSize(() => {
        const btn = findByText('Confirm') || findContaining('Confirm');
        if (btn) { click(btn); lastActionTime = Date.now(); }
        afterConfirm();
      });

    } else if (modalType === 'confirm' || modalType === 'close') {
      // Stop-loss confirm OR close-position confirm — click Confirm directly
      const btn = findByText('Confirm') || findContaining('Confirm');
      if (btn) { click(btn); lastActionTime = Date.now(); }
      else W(`processSingleCopy: ${modalType} modal — Confirm not found in DOM`);
      afterConfirm();

    } else {
      // Unknown modal type — attempt Confirm anyway as a safe fallback
      W(`processSingleCopy: unknown modal type "${modalType}" — attempting Confirm`);
      const btn = findByText('Confirm') || findContaining('Confirm');
      if (btn) { click(btn); lastActionTime = Date.now(); }
      afterConfirm();
    }
  }

  // Start polling 400ms after clicking Copy — give Flutter time to begin rendering
  setTimeout(pollForModal, 400);
}
// ★ v21.1: Process a queue of Trade Update groups one-by-one, all in the SAME lock.
// Each group's DOM element (captured at scan time) is used to click the header
// directly — no text re-search, no same-element-every-time bug.
// Copy/Copied counting is Y-scoped to each group's header position.
function processGroupQueue(groups, groupIdx) {
  if (groupIdx >= groups.length) {
    // All groups done — global final sweep for any stray Copy buttons
    const remaining = findVisibleCopyButtons();
    const alreadyCopied = findVisibleCopiedButtons().length;
    if (remaining.length > 0) {
      logAct('COPY_SWEEP', `Final sweep: ${remaining.length} Copy button(s) remaining, ${alreadyCopied} already Copied`);
      processSingleCopy(0, remaining.length + 3, null, () => {
        const finalCopied = findVisibleCopiedButtons().length;
        logAct('UPDATED', `All groups + final sweep complete — ${finalCopied} Copied total`);
        unlock();
      });
    } else {
      logAct('UPDATED', `All ${groups.length} Trade Update group(s) processed — ${alreadyCopied} Copied total`);
      unlock();
    }
    return;
  }

  const group = groups[groupIdx];
  const { copyCount: preCopy, copiedCount: preCopied } = countGroupCopyState(group.el);
  logAct('EXPAND_GROUP',
    `${groupIdx + 1}/${groups.length}: ${group.label} @ y${Math.round(group.r?.top ?? 0)} | pre: ${preCopy} Copy, ${preCopied} Copied`);

  // ★ v21.1: Expand using the pre-captured DOM element; wait for rows to appear
  waitForGroupExpansion(group,
    (copyCount) => {
      if (copyCount === 0) {
        const { copiedCount } = countGroupCopyState(group.el);
        logAct('GROUP_ALL_COPIED', `${group.label}: all ${copiedCount} update(s) already Copied — skipping`);
        processGroupQueue(groups, groupIdx + 1);
        return;
      }

      logAct('GROUP_NEEDS_COPY', `${group.label}: ${copyCount} unconfirmed update(s) to Copy`);
      // Pass group.el so processSingleCopy scopes its counts to this group's Y window
      processSingleCopy(0, copyCount + 3, group.el, () => {
        const { copyCount: postCopy, copiedCount: postCopied } = countGroupCopyState(group.el);
        logAct('GROUP_DONE', `${group.label}: done — ${postCopy} Copy remaining, ${postCopied} Copied`);
        processGroupQueue(groups, groupIdx + 1);
      });
    },
    () => {
      // Expansion failed — skip this group and continue
      processGroupQueue(groups, groupIdx + 1);
    }
  );
}

// ★ v20.7: COMPLETE REWRITE of handleWalletTradeUpdates
//
// OLD (v20.6) PROBLEM: seenWallet key was `wallet-group-Trade Updates (1)`.
// All trades with that label shared the SAME key. After one trade's updates
// were processed, ALL other trades with the same label were skipped for 90s.
//
// NEW APPROACH:
// 1. Build composite key from ALL currently-visible group labels joined together.
//    This key is unique when the SET of groups changes (new updates appear).
// 2. Process ALL groups in ONE continuous lock cycle using processGroupQueue().
//    No more "process one, unlock, hope the next scan catches the rest."
function handleWalletTradeUpdates() {
  const groups = findTradeUpdateGroups();
  if (!groups.length) return false;

  // Sort highest count first so the most-updated trade goes first
  groups.sort((a, b) => b.count - a.count);

  // Composite key covers the entire set of current groups.
  // Changes when any group is added/removed or its count changes.
  const compositeKey = 'wallet-groups::' + groups.map(g => g.label).sort().join('|');
  if (seenWallet.has(compositeKey)) return false;
  seenWallet.add(compositeKey);
  // Expire after 2 minutes — allows re-processing if new updates arrive
  setTimeout(() => seenWallet.delete(compositeKey), 120000);

  lock('UPDATING');
  logAct('UPDATING', `${groups.length} group(s): ${groups.map(g => g.label).join(', ')}`);
  processGroupQueue(groups, 0);
  return true;
}

// ── DOLLAR STOP-LOSS FUNCTIONS (★ v20.8) ──────────────────────────────────

// findTradesExceedingUsdThreshold(threshold)
//
//   Scans the wallet page body text for active trade cards and returns an array
//   of all trades whose dollar loss is >= the given threshold.
//
//   The wallet page body text contains entries in this format (one per trade):
//     SYMBOL\nNXLong/Short\n$PRICE\n-$LOSS\n(-PCT%)
//   Example: "BTC\n20X Long\n$60,699.00\n-$69.55\n(-36.36%)"
//
//   Returns an array of objects: { symbol, direction, usd, el }
//     symbol    — ticker, e.g. "BTC"
//     direction — "Long" or "Short"
//     usd       — dollar loss as a positive number, e.g. 69.55
//     el        — the DOM element for the trade card (used to click it open)
//
function findTradesExceedingUsdThreshold(threshold) {
  const body = document.body.innerText || '';
  const results = [];

  // Regex walks every trade card in the page body.
  // Pattern: SYMBOL whitespace NXLong/Short ... -$LOSS
  // [\s\S]{0,300}? — lazy match skips over the current price line
  const re = /\b([A-Z]{2,10})\s+(\d+)\s*[Xx]\s*(Long|Short)[\s\S]{0,300}?-\$([\d,]+(?:\.\d+)?)/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const symbol    = m[1];
    const direction = m[3];
    const usd       = parseFloat(m[4].replace(/,/g, ''));
    if (!isNaN(usd) && usd >= threshold) {
      // findContaining(symbol) finds the smallest DOM element whose text
      // includes the symbol name — this is the trade card we need to click.
      const el = findContaining(symbol) || null;
      results.push({ symbol, direction, usd, el });
    }
  }
  return results;
}

// checkDollarStopLoss()
//
//   Called on every scanWallet() cycle. Finds the trade with the largest dollar
//   loss that has exceeded AUTO_CLOSE_USD_THRESHOLD, then executes the close:
//
//   Close flow:
//     Step 1 — Click the trade card element to open the hover context menu.
//              (This is the same as hovering over the card manually, which shows
//               the "Share Trade / Edit Trade / Close Trade" options.)
//     Step 2 — Wait 1400ms for the menu to render, then click "Close Trade".
//     Step 3 — The close confirmation modal appears (shows Position Size,
//              Exit Price, Profit/Loss, Close Time).
//     Step 4 — doCloseConfirm() polls every 600ms until it finds "Confirm",
//              clicks it, then calls closeDone() to complete the sequence.
//
//   Cooldown: after triggering, a 3-minute cooldown per symbol is set using
//   seenWallet. This prevents repeated attempts if the first close fails,
//   or if price briefly dips below threshold and then recovers.
//   The cooldown is automatically cleared when closeDone() runs (it resets
//   seenWallet entirely), so a successful close is always allowed to retry
//   on a different trade.
//
//   Returns true if a close was triggered (caller should return immediately).
//   Returns false if no trades exceed the threshold (caller continues normally).
//
function checkDollarStopLoss() {
  // Guard: feature must be enabled and threshold must be a positive number
  if (!ENABLE_DOLLAR_STOP_LOSS || !AUTO_CLOSE_USD_THRESHOLD || AUTO_CLOSE_USD_THRESHOLD <= 0) return false;

  const trades = findTradesExceedingUsdThreshold(AUTO_CLOSE_USD_THRESHOLD);
  if (!trades.length) return false;

  // Target the trade with the highest dollar loss first
  trades.sort((a, b) => b.usd - a.usd);
  const target = trades[0];

  // 3-minute cooldown per symbol — prevents infinite retry on failed closes
  const cooldownKey = `dollar-stop-${target.symbol}`;
  if (seenWallet.has(cooldownKey)) return false;
  seenWallet.add(cooldownKey);
  setTimeout(() => seenWallet.delete(cooldownKey), 3 * 60 * 1000);

  L(`🛑 Dollar stop-loss TRIGGERED: ${target.symbol} ${target.direction} -$${target.usd.toFixed(2)} ≥ $${AUTO_CLOSE_USD_THRESHOLD} threshold`);
  logAct('DOLLAR_STOP', `${target.symbol} ${target.direction} -$${target.usd.toFixed(2)} (threshold: $${AUTO_CLOSE_USD_THRESHOLD})`);
  badge(`🛑 AUTO-CLOSE ${target.symbol} -$${target.usd.toFixed(2)}`, '#dc2626');

  // Beep once to alert the user
  playAlert(1);

  if (!target.el) {
    W(`Dollar stop-loss: could not find DOM element for ${target.symbol} trade card — skipping`);
    seenWallet.delete(cooldownKey); // allow immediate retry with better DOM state
    return false;
  }

  // Lock to prevent any other scan from interfering during the close sequence
  lock('DOLLAR STOP-LOSS');

  // Step 1: Click the trade card to open the hover menu
  click(target.el);

  setTimeout(() => {
    // Step 2: Look for "Close Trade" in the hover context menu
    const closeTradeBtn = findByText('Close Trade') || findContaining('Close Trade');
    if (closeTradeBtn) {
      L(`→ Clicking Close Trade for ${target.symbol}`);
      click(closeTradeBtn);
      // Step 3: doCloseConfirm polls for the confirmation modal and clicks Confirm
      setTimeout(doCloseConfirm, 1800);
      return;
    }

    // Fallback: "Close Position" may already be visible (modal opened directly)
    const closePosBtn = findByText('Close Position') || findContaining('Close Position');
    if (closePosBtn) {
      L(`→ Clicking Close Position (fallback) for ${target.symbol}`);
      click(closePosBtn);
      setTimeout(doCloseConfirm, 1800);
      return;
    }

    // Menu didn't open — remove cooldown so we can try again next scan
    W(`Dollar stop-loss: Close Trade / Close Position not found for ${target.symbol} — will retry`);
    logAct('DOLLAR_STOP_RETRY', `${target.symbol} — menu did not open`);
    seenWallet.delete(cooldownKey);
    unlock();
  }, 1400);

  return true;
}

function scanWallet() {
  if (!onPage('/wallet')) return;
  if (isExec) return;
  if (lastActionTime && Date.now() - lastActionTime < POST_ACTION_COOL) return;
  lastActivity = Date.now();
  if (menuOpen()) { dismissMenu(); return; }
  if (checkModals()) return;

  // ── PRIORITY ORDER IN scanWallet() ────────────────────────────────────────
  // 1. Dismiss hover menu (if open from a previous click)
  // 2. Handle blocking modals (Not Enough Funds / Duplicated Position)
  // 3. Post-open SL verify (check SL was correctly set after a new trade open)
  // 4. Trade Updates — process all pending Copy buttons across all trades
  // 5. ★ Dollar stop-loss (v20.8) — auto-close any trade exceeding $ threshold
  // 6. Emergency alert — large loss crossing both % AND $ thresholds
  // 7. Direct Close Position — trader has closed, button visible on wallet page

  verifyPostOpenRiskIfNeeded();

  // ── 4. TRADE UPDATES ──────────────────────────────────────────────────────
  // Processed FIRST so Copy/updates are never blocked by loss checks.
  // Handles ALL groups (LINK, AVAX, DOT...) in one continuous lock cycle.
  if (handleWalletTradeUpdates()) return;

  // ── 5. DOLLAR STOP-LOSS (★ v20.8) ─────────────────────────────────────────
  // Auto-close any trade whose dollar loss reaches AUTO_CLOSE_USD_THRESHOLD.
  // Runs BEFORE the emergency check — it's gentler and more common.
  if (checkDollarStopLoss()) return;

  // ── 6. EMERGENCY ALERT ────────────────────────────────────────────────────
  // ★ v20.7: Requires BOTH % AND $ thresholds (EMERGENCY_REQUIRES_BOTH=true).
  // Prevents false alerts on high-% but tiny-$ leveraged positions.
  const worstTrade = findWorstTradeCard();
  if (worstTrade) {
    const pctBreach = worstTrade.pct !== null && Math.abs(worstTrade.pct) >= EMERGENCY_WALLET_LOSS_PCT;
    const usdBreach = worstTrade.usd !== null && worstTrade.usd >= EMERGENCY_MAX_LOSS_USD;
    const triggered = EMERGENCY_REQUIRES_BOTH ? (pctBreach && usdBreach) : (pctBreach || usdBreach);
    if (triggered) {
      attemptEmergencyClose(`Trade ${worstTrade.symbol || '?'} loss ${worstTrade.pct ?? '?'}% / -$${worstTrade.usd?.toFixed(2) ?? '?'} exceeded threshold`);
      return;
    }
  }

  const body = document.body.innerText || '';
  if (body.includes('Close Position') && !menuOpen() && !seenWallet.has('recent-close')) {
    const btn = findByText('Close Position') || findContaining('Close Position');
    if (btn) {
      seenWallet.add('recent-close');
      setTimeout(() => seenWallet.delete('recent-close'), 90000);
      logAct('CLOSING', 'Direct Close Position found');
      lock('CLOSING');
      click(btn);
      setTimeout(doCloseConfirm, 2000);
    }
  }
}

// ── MAIN LOOP ──────────────────────────────────────────────────────────────
function scan() {
  enableAcc();
  if (onPage('/notifications')) scanNotifs();
  else if (onPage('/wallet')) scanWallet();
}

// ── WATCHDOGS ──────────────────────────────────────────────────────────────
// Force-unlock if stuck (BUG #8 fix: 90s vs 3min)
setInterval(() => {
  if (isExec && execStart && Date.now() - execStart > MAX_EXEC_MS) {
    W(`Stuck for ${MAX_EXEC_MS / 1000}s — force-unlocking`);
    isExec = false; execStart = 0; badge('🟢 Active');
    window.location.href = HOME_URL;
  }
}, 10000);

// ★ v20.4 FIX (BUG #4): Wrong page guard now skips entirely when isExec=true
setInterval(() => {
  if (!reloadSafe()) { wrongSince = null; return; }
  if (isExec) { wrongSince = null; return; } // ★ don't fire during trade execution
  const url = window.location.href;
  if (url.includes('/share_out')) { window.location.href = HOME_URL; return; }
  if (!url.includes(HOME_PATH) && !SAFE_PATHS.some(p => url.includes(p))) {
    if (!wrongSince) wrongSince = Date.now();
    if (Date.now() - wrongSince > WRONG_PAGE_MS) { wrongSince = null; window.location.href = HOME_URL; }
  } else { wrongSince = null; }
}, 2000);

// Stale reload (extended timeout: 20min for a stable ws connection)
setInterval(() => {
  if (!reloadSafe() || !onPage(HOME_PATH)) return;
  if (Date.now() - lastActivity > STALE_MS) { W('Stale — reloading'); location.reload(); }
}, 20000);

// 404 watchdog
setInterval(() => {
  const body = document.body?.innerText || '';
  const title = document.title || '';
  const is404 = body.includes('404') || body.toLowerCase().includes('page not found') || title.includes('404');
  if (is404 && !window._404recovering) {
    window._404recovering = true;
    logAct('404', `Recovering — title="${title}"`);
    badge('⚠️ 404 recovering', '#dc2626');
    setTimeout(() => { window._404recovering = false; window.location.href = HOME_URL; }, 1500);
  } else if (!is404) { window._404recovering = false; }
}, 5000);

// ── SESSION / AUTH WATCHDOG (★ v20.9) ─────────────────────────────────────
//
//   Intercepts every outgoing fetch() and XMLHttpRequest to detect when the
//   Involio session has expired (HTTP 401 responses from api.invoapp.com).
//
//   This happens after Chrome thaws a frozen tab — the JWT token has expired
//   while the tab was suspended, so API calls come back 401. The Flutter app
//   attempts re-auth but sometimes fails silently, leaving the UI looking normal
//   while the feed is completely dead (no new notifications, no trade updates).
//
//   Behaviour:
//   • Any successful response from Involio → resets the failure counter to 0.
//   • 1st consecutive 401 → logs a warning, keeps watching.
//   • 2nd consecutive 401 within SESSION_RELOAD_WINDOW_MS → force page reload.
//     After reload, Flutter re-authenticates automatically.
//   • Non-Involio URLs are completely ignored.
//   • While isExec=true (trade in progress) the reload is deferred until unlock.
//
//   To disable (not recommended): set SESSION_WATCHDOG_ENABLED = false below.
//
const SESSION_WATCHDOG_ENABLED    = true;
const SESSION_RELOAD_WINDOW_MS    = 60000; // 60s window for counting 401s
const SESSION_RELOAD_THRESHOLD    = 2;     // reload after this many consecutive 401s

function startAuthWatchdog() {
  if (!SESSION_WATCHDOG_ENABLED) { L('Auth watchdog: DISABLED'); return; }

  let failCount  = 0;
  let firstFailAt = 0;
  let reloadPending = false;

  function handleAuthFailure(url) {
    const now = Date.now();
    // Reset window if the last failure was too long ago
    if (firstFailAt && now - firstFailAt > SESSION_RELOAD_WINDOW_MS) {
      failCount = 0; firstFailAt = 0;
    }
    if (failCount === 0) firstFailAt = now;
    failCount++;

    W(`AUTH WATCHDOG: 401 from api.invoapp.com (${failCount}/${SESSION_RELOAD_THRESHOLD} — ${
      failCount >= SESSION_RELOAD_THRESHOLD ? 'reloading now' : 'reloading on next'
    })`);
    logAct('AUTH_401', `${failCount}/${SESSION_RELOAD_THRESHOLD}: ${String(url).substring(0, 80)}`);

    if (failCount >= SESSION_RELOAD_THRESHOLD && !reloadPending) {
      reloadPending = true;
      badge('🔄 Session expired — reloading', '#b45309');
      logAct('AUTH_RELOAD', 'Session expired — forcing reload to re-authenticate');
      // Defer if trade is in progress — reload after unlock
      const doReload = () => {
        if (isExec) { setTimeout(doReload, 3000); return; }
        W('AUTH WATCHDOG: Session expired — reloading to re-authenticate');
        location.reload();
      };
      setTimeout(doReload, 2500);
    }
  }

  function handleAuthSuccess() {
    if (failCount > 0) {
      L(`Auth watchdog: success response — resetting failure count (was ${failCount})`);
      failCount = 0; firstFailAt = 0; reloadPending = false;
    }
  }

  // Intercept fetch() — used by modern Flutter web builds
  const _origFetch = window.fetch;
  window.fetch = function (...args) {
    return _origFetch.apply(this, args).then(res => {
      const url = String(args[0] || '');
      if (url.includes('api.invoapp.com') || url.includes('invoapp.com')) {
        if (res.status === 401) handleAuthFailure(url);
        else if (res.ok)       handleAuthSuccess();
      }
      return res;
    }).catch(err => { throw err; });
  };

  // Intercept XMLHttpRequest — fallback for older request paths
  const _origOpen  = XMLHttpRequest.prototype.open;
  const _origSend  = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._amUrl = String(url || '');
    return _origOpen.apply(this, [method, url, ...rest]);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', function () {
      if ((this._amUrl || '').includes('invoapp.com')) {
        if (this.status === 401) handleAuthFailure(this._amUrl);
        else if (this.status >= 200 && this.status < 300) handleAuthSuccess();
      }
    });
    return _origSend.apply(this, args);
  };

  L('Auth watchdog: ACTIVE — monitoring fetch() + XHR for 401 session expiry');
}

// ── WEB LOCKS KEEPALIVE (★ v20.9) ─────────────────────────────────────────
//
//   Requests a permanent shared Web Lock named 'am-tab-alive'. Holding an
//   active Web Lock signals to Chrome's scheduler that this tab is performing
//   background work and should NOT be frozen or discarded by Memory Saver.
//
//   This complements the Web Worker keepalive (v20.4):
//   — Web Worker: keeps the JS event loop running (prevents timer throttling)
//   — Web Locks:  signals background importance (prevents tab discarding)
//   Together they give the strongest possible hint to keep the tab alive.
//
//   The lock uses { mode: 'shared' } so both the notifications and wallet tabs
//   can hold the same lock simultaneously without competing.
//
//   Falls back silently if the Web Locks API is unavailable (older Chrome,
//   some enterprise policies block it).
//
function startWebLocksKeepalive() {
  if (!navigator.locks?.request) {
    W('Web Locks API not available — tab-alive lock skipped (Chrome Memory Saver may still freeze tab)');
    return;
  }
  // Request the lock and pass a Promise that never resolves — holds lock forever
  navigator.locks.request('am-tab-alive', { mode: 'shared' }, () =>
    new Promise(() => {}) // never resolves = lock held for lifetime of this page
  ).catch(e => W(`Web Locks keepalive error: ${e.message}`));
  L('Web Locks keepalive: ACTIVE — Chrome tab-discard signal sent (am-tab-alive lock held)');
}


// The old 30-second reload was resetting seenNotifs on every reload, causing
// the cascade of stale-trade processing that blocked all overnight trades.
function scheduleReload() {
  const delay = (Math.floor(Math.random() * (RELOAD_MAX_S - RELOAD_MIN_S)) + RELOAD_MIN_S) * 1000;
  L(`Next keepalive reload in ${Math.round(delay / 1000)}s`);
  setTimeout(() => {
    if (reloadSafe() && onPage(HOME_PATH)) { L('Keepalive reload'); location.reload(); }
    else scheduleReload();
  }, delay);
}

// ★ v20.4 FIX (BUG #3): MutationObserver for immediate notification detection
// Fires scanNotifs() immediately when new nodes appear in the DOM,
// instead of waiting up to 1500ms for the next poll tick.
function startMutationWatcher() {
  if (!onPage('/notifications')) return;
  const target = document.querySelector('flt-glass-pane') || document.body;
  if (!target) return;
  const observer = new MutationObserver(() => {
    if (!isExec && onPage('/notifications') && !opensPaused()) {
      scanNotifs();
    }
  });
  observer.observe(target, { childList: true, subtree: true, attributes: false, characterData: false });
  L('MutationObserver active — instant notification detection enabled');
}

// ★ v20.4 FIX (BUG #7): Page Visibility API — immediate scan when tab refocuses
// Chrome's intensive throttling (60s+ intervals) is bypassed by this handler.
// When the tab becomes visible again, we fire an immediate scan + log the gap.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    L('Tab became visible — running immediate scan');
    lastActivity = Date.now();
    scan();
    // If we've been hidden for a while, clear pending stale queue
    if (pendingTrades.length > 0) {
      const now = Date.now();
      const fresh = pendingTrades.filter(t => t.age <= MAX_AGE_MINUTES);
      if (fresh.length < pendingTrades.length) {
        logAct('CLEAR_STALE', `Removed ${pendingTrades.length - fresh.length} stale pending trades on tab restore`);
        pendingTrades = fresh;
      }
    }
  }
});

// ★ v20.4 FIX (BUG #7): Web Worker keepalive to prevent Chrome tab throttling
// Creates a minimal worker using a Blob URL that pings the main thread every
// 10 seconds, keeping the tab's JS event loop awake even when backgrounded.
function startAntiThrottleWorker() {
  try {
    const workerCode = `
      setInterval(() => { self.postMessage('ping'); }, 10000);
    `;
    const blob = new Blob([workerCode], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    const worker = new Worker(url);
    worker.onmessage = () => { lastActivity = Date.now(); };
    L('Anti-throttle worker active — Chrome tab throttling suppressed');
  } catch (e) {
    W(`Anti-throttle worker failed (CSP?): ${e.message} — relying on visibility API instead`);
  }
}

// ── BOOT ──────────────────────────────────────────────────────────────────
clearEmergencyBanner();
badge('🟢 Active');
lastActivity = Date.now();

// ★ v20.4: Restore seen notification keys BEFORE first scan (critical for BUG #1)
loadSeenNotifs();
// ★ v21.6: Restore pending trades queue BEFORE first scan
loadPendingTrades();

// Restore open pause state from sessionStorage
const bootState = getRiskState();
if (bootState.openPauseUntil && Date.now() < bootState.openPauseUntil) {
  openPauseUntil = bootState.openPauseUntil;
  L(`Restored open pause — ${Math.round((openPauseUntil - Date.now()) / 1000)}s remaining`);
}

setTimeout(() => {
  enableAcc();
  startWebLocksKeepalive();   // ★ v20.9: Web Locks — prevent Chrome tab discard
  startAuthWatchdog();        // ★ v20.9: 401 watchdog — detect + recover session expiry
  startAntiThrottleWorker();  // ★ v20.4: Web Worker — prevent JS timer throttling
  setTimeout(() => {
    scan();
    setInterval(scan, SCAN_MS);
    startMutationWatcher(); // ★ v20.4: MutationObserver for instant detection
    scheduleReload();
    L(`v${VERSION} booted on: ${location.pathname}`);
    L(`★ MAX_AGE_MINUTES=${MAX_AGE_MINUTES}min | Seen keys restored: ${seenNotifs.size} | Pending restored: ${pendingTrades.length}`);
  L(`★ v21.3: Modal detection → DOM-element polling via detectModalType() — no body.innerText`);
    L(`★ Reload: ${RELOAD_MIN_S}-${RELOAD_MAX_S}s (v21.7: restored to 15-45s — 3-7min was causing missed trades)`);
    L(`★ Size: ${FORCE_POSITION_PCT !== null ? `FIXED ${FORCE_POSITION_PCT}%` : `CAP ${MAX_POSITION_PCT}%`}`);
    L(`★ Stop loss: ${MANAGE_STOP_LOSS ? `${STOP_LOSS_PCT}% | require verify=${REQUIRE_SL_BEFORE_CONFIRM}` : 'manual'}`);
    L(`★ Dollar stop-loss: ${ENABLE_DOLLAR_STOP_LOSS ? `ACTIVE — auto-close any trade losing >= $${AUTO_CLOSE_USD_THRESHOLD}` : 'DISABLED'}`);
    L(`★ Emergency: ${EMERGENCY_REQUIRES_BOTH ? 'BOTH' : 'EITHER'} % AND $ | ${EMERGENCY_WALLET_LOSS_PCT}% + $${EMERGENCY_MAX_LOSS_USD}`);
    L(`★ Keepalive: ${RELOAD_MIN_S}-${RELOAD_MAX_S}s | MutationObserver: active | Anti-throttle worker: active`);
    L(`★ Trade Updates: per-element DOM capture + Y-scoped Copy/Copied counting (v21.1)`);
    L(`★ Trade Updates: Adjust Position Size modal → direct Confirm (v21.2)`);
    L(`★ Auth watchdog: ${SESSION_WATCHDOG_ENABLED ? `ACTIVE — reloads on ${SESSION_RELOAD_THRESHOLD} consecutive 401s` : 'DISABLED'}`);
    L(`★ Web Locks keepalive: active — Chrome tab-discard prevention`);
    L(`★ window._clearSeen() — manually reset seen notifications if needed`);
    L(`★ REMINDER: Disable Chrome Memory Saver at chrome://settings/performance`);
    L(`★ REMINDER: Add app.invoapp.com to Memory Saver exceptions if left enabled`);
  }, 2200);
}, 1000);

})();