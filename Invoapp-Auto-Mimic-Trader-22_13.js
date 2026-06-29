// ==UserScript==
// @name         Invoapp Auto Mimic Trader
// @namespace    http://tampermonkey.net/
// @version      22.13
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
// ★★★  USER SETTINGS — EDIT ONLY THIS SECTION  ★★★
// ════════════════════════════════════════════════════════════════════════════

const FORCE_POSITION_PCT        = null;
const MAX_POSITION_PCT          = 2.5;

const MANAGE_STOP_LOSS          = false;
const STOP_LOSS_PCT             = 10.0;
const REQUIRE_SL_BEFORE_CONFIRM = false;

const ENABLE_DOLLAR_STOP_LOSS   = false;
const AUTO_CLOSE_USD_THRESHOLD  = 8.0;

const EMERGENCY_WALLET_LOSS_PCT = 30.0;
const EMERGENCY_MAX_LOSS_USD    = 60.0;
const EMERGENCY_REQUIRES_BOTH   = true;
const ENABLE_AUDIO_ALERTS       = true;
const ENABLE_EMERGENCY_BANNER   = true;

const SYMBOL_WHITELIST          = [];
const SYMBOL_BLACKLIST          = [];
const MAX_ALLOWED_LEVERAGE      = 50;

const RELOAD_MIN_S              = 15;
const RELOAD_MAX_S              = 45;
const MAX_AGE_MINUTES           = 10;

// ── ADVANCED TIMING ─────────────────────────────────────────────────────────
const SCAN_MS                    = 800;
const MAX_EXEC_MS                = 90000;
const STALE_MS                   = 8 * 60000;
const CONFIRM_WAIT_MS            = 3500;
const OPEN_CONFIRM_MS            = 6500;
const WRONG_PAGE_MS              = 30000;
const POST_ACTION_COOL           = 5000;
const MODAL_SETTLE_MS            = 5500;
const OPEN_BUTTON_TIMEOUT_MS     = 22000;
const CONFIRM_BUTTON_TIMEOUT_MS  = 30000;
const VERIFY_SL_ATTEMPTS         = 14;
const VERIFY_SL_INTERVAL_MS      = 500;
const VALUE_VERIFY_ATTEMPTS      = 8;
const VALUE_VERIFY_INTERVAL_MS   = 350;
const CLOSE_POSITION_COOLDOWN_MS = 12000;

const WALLET_SCROLL_STEPS        = 3;
const WALLET_SCROLL_PAUSE_MS     = 300;
const WALLET_SCROLL_MAX_POS      = 35;

const URGENT_SCAN_INTERVAL_MS    = 300;
const URGENT_SCROLL_PAUSE_MS     = 80;
const URGENT_CLOSE_SIGNAL_TTL    = 25000;

const SESSION_WATCHDOG_ENABLED   = true;
const SESSION_RELOAD_WINDOW_MS   = 60000;
const SESSION_RELOAD_THRESHOLD   = 2;
const MAX_OPEN_ATTEMPTS          = 2;

// ════════════════════════════════════════════════════════════════════════════
// END OF USER SETTINGS
// ════════════════════════════════════════════════════════════════════════════

const RESUME_WALLET_UPDATES_AFTER_EMERGENCY = true;

const NOTIFICATIONS_URL  = 'https://app.invoapp.com/notifications';
const WALLET_URL         = 'https://app.invoapp.com/wallet';
const IS_WALLET          = window.location.href.includes('/wallet');
const HOME_URL           = IS_WALLET ? WALLET_URL : NOTIFICATIONS_URL;
const HOME_PATH          = IS_WALLET ? '/wallet' : '/notifications';
const SAFE_PATHS         = ['/notifications', '/wallet', '/post/', '/portfolio/'];
const VERSION            = '22.13';

// ════════════════════════════════════════════════════════════════════════════
// CHANGELOG v22.13 — June 2026
// ════════════════════════════════════════════════════════════════════════════
//
// BUG A (CRITICAL) — Infinite retry loop: old BTC/any trade cycling forever
// ─────────────────────────────────────────────────────────────────────────────
// SYMPTOM: Script keeps navigating /notifications → /post/ → /notifications
//   for the same stale trade (e.g. Normie BTC 6h old) indefinitely.
//   It never gives up even after exhausting MAX_OPEN_ATTEMPTS.
//
// ROOT CAUSE 1 — openAttempts Map was never persisted to localStorage:
//   openAttempts is an in-memory Map. Every /post/ → /notifications navigation
//   is a full page load. The Map is reset to empty on every load. So
//   `openAttempts.get(key)` always returns undefined → `prev = 0` → `attempts = 1`.
//   Since `1 < MAX_OPEN_ATTEMPTS(2)`, the code always calls `seenNotifs.delete(key)`
//   to allow a retry, and NEVER reaches the "exhausted" branch that leaves the
//   key in seenNotifs permanently. The loop never breaks.
//
// FIX 1 — Persist openAttempts to localStorage (OPEN_ATTEMPTS_KEY):
//   `saveOpenAttempts()` serialises the Map to localStorage before any page
//   navigation. `loadOpenAttempts()` restores it at boot. Entries auto-expire
//   after 30 min (OPEN_ATTEMPTS_TTL_MS) so the Map stays clean.
//   `unlock()` calls saveOpenAttempts() before setting window.location.href.
//   `doOpen()` timeout handler calls saveOpenAttempts() after incrementing.
//   Now attempt counts survive page reloads → MAX_OPEN_ATTEMPTS is actually
//   reached → key stays in seenNotifs → loop terminates. ✅
//
// ROOT CAUSE 2 — savePendingTrades() didn't persist the `age` field:
//   The saved JSON was `{ key, label, savedAt }` — no `age`. When
//   loadPendingTrades() restored entries it computed ageMinsVal = (now - savedAt)
//   / 60000 (minutes since the last save) rather than the true detection age.
//   If a page reloaded 30 seconds after the save, ageMinsVal ≈ 0.5 min — well
//   under MAX_AGE_MINUTES(10) — so the stale trade was always restored.
//
// FIX 2 — Save and restore `age` in pending-trade persistence:
//   savePendingTrades() now serialises `age: t.age || 0` alongside key/label/savedAt.
//   loadPendingTrades() now computes:
//     effectiveAge = (entry.age || 0) + (now - entry.savedAt) / 60000
//   A trade originally detected at 2 min old and saved 9 min ago has
//   effectiveAge = 11 > MAX_AGE_MINUTES(10) → correctly excluded. ✅
//
// BUG B — Script could remain stranded on a /post/ page after execution ends
// ─────────────────────────────────────────────────────────────────────────────
// SYMPTOM: Script finishes (isExec → false) but stays on /post/ instead of
//   returning to /notifications. The wrong-page watchdog ignores it because
//   '/post/' is in SAFE_PATHS.
//
// FIX — New post-stuck watchdog (POST_STUCK_MS = 9 000 ms):
//   A dedicated setInterval checks every 2 s: if the notifications tab is on
//   a /post/ URL and isExec is false, it waits POST_STUCK_MS before forcing
//   window.location.href = NOTIFICATIONS_URL. This is the safety net for any
//   edge case where unlock() failed to redirect (e.g. Flutter SPA navigation
//   intercepted the href, or the redirect fired before the post page loaded). ✅
//
// CHANGELOG v22.12 — June 2026 (retained for reference)
// ─────────────────────────────────────────────────────────────────────────────
// BUG (v22.12): pendingTrades stale-age purge and seenNotifs guard on target
//   selection. seenWallet compositeKey TTL raised 4 000 → 60 000 ms.
//
// ════════════════════════════════════════════════════════════════════════════
const OPEN_PHRASES       = [
  'opened new trade', 'opened a new trade', 'opened new position',
  'opened a new position', 'opened a trade'
];

const RISK_STATE_KEY           = '__AM_V22_RISK_STATE__';
const SEEN_NOTIFS_KEY          = '__AM_V22_SEEN_NOTIFS__';
const PENDING_TRADES_KEY       = '__AM_V22_PENDING_TRADES__';
const EMERGENCY_BEEP_KEY       = '__AM_V22_EMERGENCY_BEEPED__';
const CLOSE_POSITION_TS_KEY    = '__AM_V22_LAST_CLOSE_TS__';
const WALLET_BALANCE_KEY       = '__AM_V22_WALLET_BALANCE__';
const OPEN_MIMIC_POSITIONS_KEY = '__AM_V22_OPEN_MIMIC_POSITIONS__';
const OPEN_ATTEMPTS_KEY        = '__AM_V22_OPEN_ATTEMPTS__';  // ★ v22.13: persist retry counters across page loads

// ★ v22.13: How long a completed execution can leave us on a /post/ page
// before the post-stuck watchdog forces a return to /notifications.
const POST_STUCK_MS            = 9000;

const COPY_ACTION_SKIP = 'skip';
const COPY_ACTION_FLIP = 'flip';
const COPY_ACTION_COPY = 'copy';

let walletScrollSweepActive  = false;
let walletScrollLastSeenBody = '';
let urgentCloseSignalTs      = 0;
let urgentCloseSymbol        = null;
let isExec                   = false;
let execStart                = 0;
let lastActivity             = Date.now();
let lastActionTime           = 0;
let wrongSince               = null;
let pendingTrades            = [];
let accOn                    = false;
let emergencyMode            = false;
let openPauseUntil           = 0;
let lastOpenContext           = null;
const actLog                 = [];
const openAttempts           = new Map();

// v22.11: Track how many acc enable attempts have been made so we don't
// spam the log once Flutter renders.
let accAttempts = 0;

const L = msg => console.log(`[v${VERSION}] ${msg}`);
const W = msg => console.warn(`[v${VERSION}] ${msg}`);

let seenNotifs = new Set();
let seenWallet = new Set();

// ════════════════════════════════════════════════════════════════════════════
// OPEN MIMIC POSITIONS REGISTRY
// ════════════════════════════════════════════════════════════════════════════
function loadOpenMimicPositions() {
  try { const r = localStorage.getItem(OPEN_MIMIC_POSITIONS_KEY); return r ? JSON.parse(r) : []; } catch { return []; }
}
function saveOpenMimicPositions(arr) {
  try { localStorage.setItem(OPEN_MIMIC_POSITIONS_KEY, JSON.stringify(arr)); } catch {}
}
function registerOpenMimicPosition(symbol, trader, leverage, direction) {
  if (!symbol) return;
  const positions = loadOpenMimicPositions();
  const filtered = positions.filter(p => !(p.symbol === symbol && p.direction === direction));
  filtered.push({ symbol, trader: trader || '', leverage: leverage || 0, direction: direction || '', openedAt: Date.now() });
  if (filtered.length > 50) filtered.splice(0, filtered.length - 50);
  saveOpenMimicPositions(filtered);
  L(`registry: +${symbol} ${direction} (${trader}) — ${filtered.length} total`);
}
function unregisterOpenMimicPosition(symbol, direction) {
  if (!symbol) return;
  const positions = loadOpenMimicPositions();
  const filtered = positions.filter(p => !(p.symbol === symbol && (!direction || p.direction === direction)));
  saveOpenMimicPositions(filtered);
  L(`registry: -${symbol} ${direction} — ${filtered.length} remaining`);
}
function isMimicPosition(symbol) {
  // v22.10 FIX: null/empty = NOT a mimic — never close unknown positions
  if (!symbol) return false;
  const positions = loadOpenMimicPositions();
  if (positions.length === 0) return true; // empty registry = trust signal
  return positions.some(p => p.symbol === symbol);
}

// ── PERSISTENCE ───────────────────────────────────────────────────────────────
function saveSeenNotifs() {
  try {
    const arr = [...seenNotifs];
    if (arr.length > 800) arr.splice(0, arr.length - 800);
    localStorage.setItem(SEEN_NOTIFS_KEY, JSON.stringify(arr));
  } catch {}
}
function loadSeenNotifs() {
  try {
    const raw = localStorage.getItem(SEEN_NOTIFS_KEY);
    if (raw) { seenNotifs = new Set(JSON.parse(raw)); L(`Restored ${seenNotifs.size} seen keys`); }
  } catch {}
}
function savePendingTrades() {
  try {
    // ★ v22.13 FIX 2: Save `age` so loadPendingTrades can compute effectiveAge correctly.
    const arr = pendingTrades.map(t => ({ key: t.key, label: t.label, age: t.age || 0, savedAt: t.savedAt || Date.now() }));
    localStorage.setItem(PENDING_TRADES_KEY, JSON.stringify(arr));
  } catch {}
}
function loadPendingTrades() {
  try {
    const raw = localStorage.getItem(PENDING_TRADES_KEY);
    if (!raw) return;
    localStorage.removeItem(PENDING_TRADES_KEY);
    const arr = JSON.parse(raw);
    const now = Date.now();
    let restored = 0;
    for (const entry of arr) {
      // ★ v22.13 FIX 2: Use effectiveAge = original detection age + time elapsed since save.
      // Previously only (now - savedAt)/60000 was used — this missed the original trade age
      // (e.g. a 6h-old trade saved 30s ago showed effectiveAge ≈ 0.5 min, always restored).
      const effectiveAge = (entry.age || 0) + (now - (entry.savedAt || now)) / 60000;
      if (effectiveAge > MAX_AGE_MINUTES) continue;
      if (!pendingTrades.some(p => p.key === entry.key)) {
        pendingTrades.push({ key: entry.key, label: entry.label, age: effectiveAge, el: null, savedAt: entry.savedAt });
        restored++;
      }
    }
    if (restored > 0) { L(`loadPendingTrades: restored ${restored}`); logAct('PENDING_RESTORED', `${restored} re-queued`); }
  } catch {}
}
function logAct(type, detail) {
  actLog.push({ t: new Date().toLocaleTimeString(), type, detail });
  if (actLog.length > 500) actLog.shift();
}

// ── OPEN-ATTEMPTS PERSISTENCE (★ v22.13 FIX 1) ───────────────────────────────
// openAttempts was a plain in-memory Map. Every page navigation (notifications
// → post → notifications) is a full page reload, wiping the Map. So `attempts`
// was always 1, `seenNotifs.delete(key)` always fired, and the retry loop never
// terminated. Fix: persist to localStorage with a 30-minute TTL.
const OPEN_ATTEMPTS_TTL_MS = 30 * 60 * 1000;
function loadOpenAttempts() {
  try {
    const raw = localStorage.getItem(OPEN_ATTEMPTS_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (!data.savedAt || Date.now() - data.savedAt > OPEN_ATTEMPTS_TTL_MS) {
      localStorage.removeItem(OPEN_ATTEMPTS_KEY);
      L('loadOpenAttempts: expired — cleared');
      return;
    }
    openAttempts.clear();
    for (const [key, count] of Object.entries(data.attempts || {})) openAttempts.set(key, count);
    if (openAttempts.size > 0) L(`loadOpenAttempts: restored ${openAttempts.size} entries`);
  } catch { try { localStorage.removeItem(OPEN_ATTEMPTS_KEY); } catch {} }
}
function saveOpenAttempts() {
  try {
    if (openAttempts.size === 0) { localStorage.removeItem(OPEN_ATTEMPTS_KEY); return; }
    const obj = {};
    for (const [key, count] of openAttempts) obj[key] = count;
    localStorage.setItem(OPEN_ATTEMPTS_KEY, JSON.stringify({ attempts: obj, savedAt: Date.now() }));
  } catch {}
}

function getRiskState() { try { return JSON.parse(localStorage.getItem(RISK_STATE_KEY) || '{}'); } catch { return {}; } }
function setRiskState(patch) { try { localStorage.setItem(RISK_STATE_KEY, JSON.stringify({ ...getRiskState(), ...patch, ts: Date.now() })); } catch {} }

// ── CONSOLE HELPERS ───────────────────────────────────────────────────────────
window._status = () => {
  const positions = loadOpenMimicPositions();
  console.log(`\n=== v${VERSION} ${IS_WALLET ? 'WALLET' : 'NOTIFICATIONS'} ===`);
  console.log(`State: ${isExec?'EXECUTING':'WATCHING'} | Queue: ${pendingTrades.length} | Seen: ${seenNotifs.size} | accOn: ${accOn} (${accAttempts} attempts)`);
  console.log(`OpenAttempts: ${openAttempts.size} entries | postStuckSince: ${postStuckSince?Math.round((Date.now()-postStuckSince)/1000)+'s ago':'none'}`);
  console.log(`Size: CAP ${MAX_POSITION_PCT}% | SL: OFF | Dollar stop: OFF | Leverage max: ${MAX_ALLOWED_LEVERAGE}X`);
  console.log(`Emergency: BOTH ${EMERGENCY_WALLET_LOSS_PCT}% + $${EMERGENCY_MAX_LOSS_USD}`);
  console.log(`Urgent close: ${urgentCloseSignalTs?`ACTIVE (${Math.round((Date.now()-urgentCloseSignalTs)/1000)}s) sym=${urgentCloseSymbol||'?'}`:'none'}`);
  console.log(`Registry (${positions.length}): ${positions.map(p=>`${p.symbol}/${p.direction}/${p.trader}`).join(', ')||'none'}`);
  actLog.slice(-80).forEach(e => console.log(`  [${e.t}] ${e.type}: ${e.detail}`));
  console.log('===================\n');
  return actLog;
};
window._unpause          = () => { openPauseUntil=0; setRiskState({openPauseUntil:0}); clearEmergencyBanner(); badge('🟢 Active'); L('Unpaused'); };
window._pauseOpens       = (min=30, reason='manual') => setOpenPause(min*60000, reason);
window._clearSeen        = () => { seenNotifs=new Set(); openAttempts.clear(); saveOpenAttempts(); saveSeenNotifs(); L('seenNotifs + openAttempts cleared'); };
window._clearMimicRegistry = () => { saveOpenMimicPositions([]); L('Registry cleared'); };
window._addMimicPosition = (sym, dir='long', trader='manual') => registerOpenMimicPosition(sym.toUpperCase(), trader, 0, dir);
window._forceAcc         = () => { accOn=false; accAttempts=0; enableAcc(); L('Force acc re-attempt'); };

// ── BADGE ─────────────────────────────────────────────────────────────────────
function badge(text, color = '#16a34a') {
  let b = document.getElementById('am-badge');
  if (!b) {
    b = document.createElement('div');
    b.id = 'am-badge';
    b.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:99999;color:white;font-size:12px;font-weight:bold;padding:6px 12px;border-radius:20px;box-shadow:0 2px 8px rgba(0,0,0,0.35);font-family:sans-serif;cursor:pointer;user-select:none;';
    b.title = '_status() | _pauseOpens(min) | _unpause() | _clearSeen() | _clearMimicRegistry() | _addMimicPosition(sym,dir,trader) | _forceAcc()';
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
  el.textContent = `⚠️ INVO LOSS ALERT: ${message}`;
}
function clearEmergencyBanner() {
  document.getElementById('am-emergency-banner')?.remove();
  try { localStorage.removeItem(EMERGENCY_BEEP_KEY); } catch {}
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
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'square'; o.frequency.value = i%2?660:880;
      g.gain.setValueAtTime(0.001,t); g.gain.exponentialRampToValueAtTime(0.12,t+0.02); g.gain.exponentialRampToValueAtTime(0.001,t+0.22);
      o.connect(g); g.connect(ctx.destination); o.start(t); o.stop(t+0.24); t+=0.28;
    }
  } catch {}
}
function setOpenPause(ms, reason) {
  openPauseUntil = Date.now() + ms;
  setRiskState({ openPauseUntil, reason, emergencyMode });
  logAct('PAUSE', `${Math.round(ms/1000)}s: ${reason}`);
  showEmergencyBanner(`PAUSED ${Math.round(ms/60000)}min: ${reason} | window._unpause() to clear`);
  playAlert(2);
}
function opensPaused() {
  const st = getRiskState();
  const until = Math.max(openPauseUntil||0, st.openPauseUntil||0);
  return !!(until && Date.now() < until);
}
function onPage(p) { return window.location.href.includes(p); }
function reloadSafe() {
  if (isExec) return false;
  if (lastActionTime && Date.now()-lastActionTime < POST_ACTION_COOL) return false;
  return true;
}
function lock(label) {
  isExec = true; execStart = Date.now(); wrongSince = null; lastActivity = Date.now();
  badge(`⚡ ${label}`, '#b45309');
  L(`lock: ${label}`);
}
function unlock() {
  isExec = false; execStart = 0; lastActionTime = Date.now();
  badge('🟢 Active');
  L('unlocked');
  // ★ v22.13: Persist retry counters BEFORE navigating — page reload wipes the Map.
  saveOpenAttempts();
  if (!onPage(HOME_PATH)) { window.location.href = HOME_URL; return; }
  if (IS_WALLET && urgentCloseSignalTs && Date.now()-urgentCloseSignalTs < URGENT_CLOSE_SIGNAL_TTL) {
    L('unlock: close signal hot — re-scan');
    setTimeout(scanWallet, 200);
    return;
  }
  if (pendingTrades.length > 0 && onPage('/notifications') && !opensPaused()) setTimeout(scanNotifs, 800);
}
function closeDone(symbol, direction) {
  isExec = false; execStart = 0; seenWallet = new Set(); lastActionTime = Date.now();
  urgentCloseSignalTs = 0; urgentCloseSymbol = null;
  badge('🟢 Active');
  clearEmergencyBanner();
  try { localStorage.removeItem(CLOSE_POSITION_TS_KEY); } catch {}
  if (symbol) unregisterOpenMimicPosition(symbol, direction);
  setTimeout(() => { if (onPage('/wallet')) window.location.href = WALLET_URL; }, POST_ACTION_COOL);
}

// ════════════════════════════════════════════════════════════════════════════
// v22.11 FIX #1 — ACCESSIBILITY ENGINE REWRITE
//
// ROOT CAUSE of blacked-out notifications page:
//
// The old enableAcc() ran ONCE and set accOn=true even when it FAILED
// (i.e. flt-semantics-placeholder wasn't in the DOM yet). Flutter apps
// render asynchronously — the placeholder element often doesn't exist at
// document-idle. Once accOn=true, the function never ran again, so the
// accessibility tree was never actually activated. The notifications page
// renders as blurred/dark boxes because Flutter needs a pointer event on
// that placeholder to switch into semantics mode. Without it, innerText
// returns empty strings and the script can't see any notifications.
//
// v22.11 FIX:
//   1. enableAcc() no longer sets accOn=true on failure — it only marks
//      success when the element is actually found AND events dispatched.
//   2. A dedicated accInterval retries every 500ms for up to 30 seconds
//      after page load, then every 3s indefinitely (page reload may reset).
//   3. On success it also clicks the center of the page to force Flutter
//      to render the semantics tree, which is required on some Chromium builds.
//   4. After success, a 2-second follow-up re-fires the events in case the
//      first attempt landed before Flutter was ready to handle them.
//   5. On the notifications page, after acc activates, scanNotifs() is
//      called immediately instead of waiting for the next poll interval.
// ════════════════════════════════════════════════════════════════════════════

let accInterval = null;

function enableAcc() {
  if (accOn) return true;
  accAttempts++;

  // Strategy 1: flt-semantics-placeholder (standard Flutter acc trigger)
  const ph = document.querySelector('flt-semantics-placeholder');
  if (ph) {
    const r = ph.getBoundingClientRect();
    const x = r.left + r.width / 2 || window.innerWidth / 2;
    const y = r.top  + r.height / 2 || window.innerHeight / 2;
    ph.dispatchEvent(new PointerEvent('pointerdown', { bubbles:true, clientX:x, clientY:y }));
    ph.dispatchEvent(new PointerEvent('pointerup',   { bubbles:true, clientX:x, clientY:y }));
    ph.dispatchEvent(new MouseEvent('click',          { bubbles:true, clientX:x, clientY:y }));
    accOn = true;
    L(`accessibility ON via placeholder (attempt ${accAttempts})`);
    logAct('ACC_ON', `placeholder — attempt ${accAttempts}`);

    // Follow-up: re-fire after 2s in case Flutter wasn't ready
    setTimeout(() => {
      const ph2 = document.querySelector('flt-semantics-placeholder');
      if (ph2) {
        ph2.dispatchEvent(new PointerEvent('pointerdown', { bubbles:true }));
        ph2.dispatchEvent(new PointerEvent('pointerup',   { bubbles:true }));
      }
      // Also click the glass pane center to force semantics render
      const gp = document.querySelector('flt-glass-pane');
      if (gp) {
        const cx = window.innerWidth/2, cy = window.innerHeight/2;
        gp.dispatchEvent(new PointerEvent('pointerdown', { bubbles:true, clientX:cx, clientY:cy }));
        gp.dispatchEvent(new PointerEvent('pointerup',   { bubbles:true, clientX:cx, clientY:cy }));
      }
      L('accessibility follow-up fired');
      // Trigger immediate scan now that acc is confirmed on
      if (onPage('/notifications') && !isExec) setTimeout(scanNotifs, 300);
    }, 2000);

    // Stop the retry interval once we succeed
    if (accInterval) { clearInterval(accInterval); accInterval = null; }
    return true;
  }

  // Strategy 2: flt-glass-pane center click (backup for some Flutter builds)
  const gp = document.querySelector('flt-glass-pane');
  if (gp && accAttempts % 5 === 0) {
    const cx = window.innerWidth/2, cy = window.innerHeight/2;
    gp.dispatchEvent(new PointerEvent('pointerdown', { bubbles:true, clientX:cx, clientY:cy }));
    gp.dispatchEvent(new PointerEvent('pointerup',   { bubbles:true, clientX:cx, clientY:cy }));
    L(`accessibility glass-pane click (attempt ${accAttempts})`);
  }

  return false;
}

// Start persistent acc retry loop — runs until acc is confirmed
function startAccRetry() {
  if (accInterval) clearInterval(accInterval);
  accAttempts = 0;
  accInterval = setInterval(() => {
    if (accOn) { clearInterval(accInterval); accInterval = null; return; }
    const success = enableAcc();
    if (!success && accAttempts <= 5) L(`acc retry ${accAttempts} — placeholder not yet in DOM`);
  }, 500);

  // After 30s switch to slow retry in case page was already loaded
  setTimeout(() => {
    if (accOn) return;
    if (accInterval) { clearInterval(accInterval); accInterval = null; }
    W('acc not activated after 30s — switching to 3s retry');
    accInterval = setInterval(() => {
      if (accOn) { clearInterval(accInterval); accInterval = null; return; }
      accOn = false; // reset so enableAcc() re-runs
      enableAcc();
    }, 3000);
  }, 30000);
}

// ── ELEMENT HELPERS ───────────────────────────────────────────────────────────
function visible(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return !!(r.width && r.height && r.bottom > 0 && r.right > 0);
}
function textOf(el) { return (el?.innerText || el?.textContent || el?.value || '').trim(); }
function ariaOf(el) { return (el?.getAttribute?.('aria-label') || '').trim(); }

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
function click(el) {
  if (!el || !visible(el)) return false;
  const r = el.getBoundingClientRect();
  if (!r.width) return false;
  const x = r.left+r.width/2, y = r.top+r.height/2;
  const o = {bubbles:true,cancelable:true,clientX:x,clientY:y};
  el.dispatchEvent(new PointerEvent('pointerdown',o));
  el.dispatchEvent(new PointerEvent('pointerup',o));
  el.dispatchEvent(new MouseEvent('click',o));
  const top = document.elementFromPoint(x,y);
  if (top && top !== el) {
    top.dispatchEvent(new PointerEvent('pointerdown',o));
    top.dispatchEvent(new PointerEvent('pointerup',o));
    top.dispatchEvent(new MouseEvent('click',o));
  }
  L(`clicked: "${(textOf(el)||ariaOf(el)||'(no text)').substring(0,60)}"`);
  return true;
}

// ── WAIT HELPERS ──────────────────────────────────────────────────────────────
function waitForPredicate(fn, onSuccess, timeout=12000, interval=300, onTimeout=null) {
  const start = Date.now();
  const iv = setInterval(() => {
    let result = null;
    try { result = fn(); } catch {}
    if (result) { clearInterval(iv); onSuccess(result); }
    else if (Date.now()-start > timeout) { clearInterval(iv); if (onTimeout) onTimeout(); else unlock(); }
  }, interval);
}
function waitForEl(texts, onSuccess, timeout=12000) {
  if (!Array.isArray(texts)) texts = [texts];
  waitForPredicate(
    () => { for (const t of texts) { const el=findByText(t)||findContaining(t); if (el) return el; } return null; },
    el => { click(el); setTimeout(onSuccess, 700); },
    timeout, 300,
    () => { W(`timeout: [${texts.join(', ')}]`); logAct('TIMEOUT', texts.join(', ')); unlock(); }
  );
}
function dismissMenu() {
  document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
  const safe = document.elementFromPoint(window.innerWidth/2, 10);
  if (safe) safe.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:window.innerWidth/2,clientY:10}));
}
function menuOpen() {
  const b = document.body.innerText || '';
  return b.includes('Share Trade') && b.includes('Close Trade');
}
function checkModals() {
  const b = document.body.innerText || '';
  if (b.includes('Not Enough Funds')) {
    logAct('BLOCKED','Not Enough Funds');
    const btn = findByText('Go Back')||findByText('Close')||findContaining('Go Back');
    if (btn) click(btn);
    setTimeout(() => { seenWallet = new Set(); unlock(); }, 2000);
    return true;
  }
  if (b.includes('Duplicated Position')) { logAct('BLOCKED','Duplicated Position'); setTimeout(()=>unlock(),1500); return true; }
  return false;
}

// ── SYMBOL / LEVERAGE FILTER ──────────────────────────────────────────────────
function normalizeSymbol(sym) { return String(sym||'').trim().toUpperCase(); }
function symbolAllowed(sym) {
  const s = normalizeSymbol(sym);
  if (!s) return true;
  if (SYMBOL_WHITELIST.length && !SYMBOL_WHITELIST.map(normalizeSymbol).includes(s)) return false;
  if (SYMBOL_BLACKLIST.map(normalizeSymbol).includes(s)) return false;
  return true;
}

// ── NOTIFICATION AGE ──────────────────────────────────────────────────────────
function ageMins(label) {
  if (/just now|now/i.test(label)) return 0;
  const m = label.match(/[·•‧･∙⋅\-–|]\s*(\d+)\s*(s|m|h|d)\b/i)
    || label.match(/(\d+)\s*(s|m|h|d)\s*ago/i)
    || label.match(/\b(\d+)\s*(s|m|h|d)\b(?!\s*%)/i);
  if (!m) return 0;
  const v = parseInt(m[1],10), u = m[2].toLowerCase();
  return u==='s'?v/60:u==='m'?v:u==='h'?v*60:v*1440;
}
function stableKey(label) {
  const age = ageMins(label);
  const createdWindowId = Math.round((Date.now()-age*60000)/(5*60*1000));
  const stripped = label
    .replace(/[·•‧･∙⋅\-–|]\s*\d+\s*(s|m|h|d)\b/gi,'')
    .replace(/\b\d+\s*(s|m|h|d)\s*ago\b/gi,'')
    .replace(/\s+/g,' ').trim().toLowerCase();
  return `w${createdWindowId}::${stripped}`;
}
function isOpenPhrase(text) {
  const lo = text.toLowerCase();
  return OPEN_PHRASES.some(p => lo.includes(p));
}
function findClickableParent(el) {
  let cur = el;
  for (let i=0; i<8; i++) {
    if (!cur||!cur.parentElement) break;
    cur = cur.parentElement;
    const role=cur.getAttribute?.('role')||'', tag=(cur.tagName||'').toLowerCase();
    if (role==='button'||role==='link'||tag==='button'||tag==='a') return cur;
    const r = cur.getBoundingClientRect();
    if (r.width>200&&r.height>40) return cur;
  }
  return el;
}

// ── READ HELPERS ──────────────────────────────────────────────────────────────
function readTraderPositionPct() {
  const m = (document.body.innerText||'').match(/Position Size\s*\((\d+(?:\.\d+)?)%\)/i);
  return m ? parseFloat(m[1]) : null;
}
function readWalletTotal() {
  const body = document.body.innerText||'';
  const m1 = body.match(/\$[\d.,]+\s*\/\s*\$([\d,]+\.?\d*)/);
  if (m1) { const v=parseFloat(m1[1].replace(/,/g,'')); if (v>1) return v; }
  const m2 = body.match(/Total Balance[\s\S]{0,25}\$([\d,]+\.?\d*)/i);
  if (m2) { const v=parseFloat(m2[1].replace(/,/g,'')); if (v>1) return v; }
  try {
    const stored = JSON.parse(localStorage.getItem(WALLET_BALANCE_KEY)||'{}');
    if (stored.balance>1 && Date.now()-(stored.ts||0)<30*60000) return stored.balance;
  } catch {}
  return null;
}
function readCurrentPrice() {
  const m = (document.body.innerText||'').match(/Current\s*Price\s*[:\s]+\$([\d,]+\.?\d*)/i);
  return m ? parseFloat(m[1].replace(/,/g,'')) : null;
}
function readTradeDirection() {
  const body = document.body.innerText||'';
  const d = body.match(/\b\d+\s*[Xx]\s*(Long|Short)\b/);
  if (d) return d[1].toLowerCase();
  if (/\bshort\b/i.test(body)) return 'short';
  if (/\blong\b/i.test(body)) return 'long';
  return null;
}
function inferCurrentSymbol() {
  const m = (document.body.innerText||'').match(/\b([A-Z]{2,10})\s+\d+\s*[Xx]\s+(Long|Short)\b/);
  return m ? m[1] : null;
}
function inferLeverageFromBody() {
  const m = (document.body.innerText||'').match(/\b(\d+)\s*[Xx]\s*(Long|Short)\b/);
  return m ? parseInt(m[1],10) : null;
}
function precisionForPrice(p) { return p<0.1?6:p<1?5:p<10?4:2; }
function computeStopLossPrice(currentPrice, direction) {
  const slPrice = direction==='short'?currentPrice*(1+STOP_LOSS_PCT/100):currentPrice*(1-STOP_LOSS_PCT/100);
  return slPrice.toFixed(precisionForPrice(currentPrice));
}
function readLossPctFromWalletBody() {
  const matches = [...(document.body.innerText||'').matchAll(/\((-?\d+(?:\.\d+)?)%\)/g)].map(m=>parseFloat(m[1]));
  const negs = matches.filter(v=>!isNaN(v)&&v<0);
  return negs.length ? Math.min(...negs) : null;
}
function extractWorstLossUsd() {
  const vals = [...(document.body.innerText||'').matchAll(/-\$([\d,]+(?:\.\d+)?)/g)].map(m=>parseFloat(m[1].replace(/,/g,''))).filter(v=>!isNaN(v));
  return vals.length ? Math.max(...vals) : null;
}
function findWorstTradeCard() {
  const body = document.body.innerText||'';
  const re = /\b([A-Z]{2,10})\s+\d+\s*[Xx]\s+(Long|Short)[\s\S]{0,120}?-\$([\d,]+(?:\.\d+)?)[\s\S]{0,80}?\((-?\d+(?:\.\d+)?)%\)/gi;
  let m, best = null;
  while ((m=re.exec(body))!==null) {
    const usd = parseFloat(String(m[3]).replace(/,/g,''));
    if (!isMimicPosition(m[1])) continue;
    if (!best||usd>best.usd) best = {symbol:m[1],direction:m[2],usd,pct:parseFloat(m[4])};
  }
  if (!best) return null;
  best.el = findContaining(best.symbol)||findContaining(`${best.symbol} `);
  return best;
}
function storeWalletBalance() {
  if (!IS_WALLET) return;
  const body = document.body.innerText||'';
  let bal=null, source='';
  const tbIdx = body.search(/Total Balance/i);
  if (tbIdx!==-1) {
    const after = body.substring(tbIdx,tbIdx+100);
    const m = after.match(/\$([\d,]+\.\d{2})/);
    if (m) { bal=parseFloat(m[1].replace(/,/g,'')); source='Total Balance'; }
  }
  if (!bal||bal<10) {
    const todayIdx = body.search(/\bToday\b/);
    if (todayIdx>0) {
      const portion = body.substring(Math.max(0,todayIdx-300),todayIdx+20);
      const amounts = [...portion.matchAll(/\$([\d,]+\.\d{2})/g)].map(m=>parseFloat(m[1].replace(/,/g,''))).filter(v=>v>=10&&v<=50000);
      if (amounts.length) { bal=Math.max(...amounts); source='near-Today'; }
    }
  }
  if (!bal||bal<10) return;
  try {
    const cur = JSON.parse(localStorage.getItem(WALLET_BALANCE_KEY)||'{}');
    if (Math.abs((cur.balance||0)-bal)<0.01&&Date.now()-(cur.ts||0)<60000) return;
    localStorage.setItem(WALLET_BALANCE_KEY,JSON.stringify({balance:bal,ts:Date.now()}));
    L(`balance: $${bal} (${source})`);
  } catch {}
}

// ── FIND MIMIC TRADE BUTTON ───────────────────────────────────────────────────
function findMimicButton() {
  for (const t of ['Mimic Trade','Mimic']) { const el=findByText(t); if (el) return el; }
  const c = findContaining('Mimic Trade'); if (c) return c;
  for (const el of document.querySelectorAll('[aria-label]')) {
    if ((ariaOf(el)||'').toLowerCase().includes('mimic')&&visible(el)) return el;
  }
  for (const el of document.querySelectorAll('flt-semantics,flt-semantics-container,button,[role="button"],div,span,a')) {
    const t = textOf(el).toLowerCase();
    if (t.includes('mimic')&&t.length<80&&visible(el)) return el;
  }
  return null;
}

// ── INPUT HELPERS ─────────────────────────────────────────────────────────────
function findPositionSizeInput() {
  for (const el of document.querySelectorAll('[role="textbox"],[role="spinbutton"],input[type="number"],input[type="text"]')) { if (visible(el)) return el; }
  for (const el of document.querySelectorAll('flt-semantics[contenteditable="true"]')) { if (visible(el)) return el; }
  const lbl = findContaining('Position Size');
  if (lbl) {
    const r = lbl.getBoundingClientRect();
    for (const el of document.querySelectorAll('flt-semantics,div,span,input')) {
      if (el===lbl||!visible(el)) continue;
      const er = el.getBoundingClientRect();
      if (er.top>r.bottom&&er.top<r.bottom+140&&er.width>40&&/^\$?[\d.]+$/.test(textOf(el))) return el;
    }
  }
  return null;
}
function findStopLossInput() {
  const lbl = findContaining('Stop-Loss Price')||findContaining('Stop Loss Price');
  if (lbl) {
    const r = lbl.getBoundingClientRect();
    for (const el of document.querySelectorAll('[role="textbox"],[role="spinbutton"],input,flt-semantics[contenteditable="true"],div,span')) {
      if (!visible(el)) continue;
      const er = el.getBoundingClientRect();
      const t = textOf(el);
      if (er.top>r.top-10&&er.top<r.bottom+160&&er.width>30&&/^[\$\d\-.]/.test(t)&&t!==textOf(lbl)) return el;
    }
  }
  const inputs = [...document.querySelectorAll('[role="textbox"],[role="spinbutton"],input[type="number"],input[type="text"],flt-semantics[contenteditable="true"]')].filter(visible);
  return inputs.length>=2?inputs[1]:null;
}
function injectValue(el, value) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  const x=r.left+r.width/2, y=r.top+r.height/2;
  el.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,clientX:x,clientY:y}));
  el.dispatchEvent(new PointerEvent('pointerup',  {bubbles:true,clientX:x,clientY:y}));
  el.dispatchEvent(new MouseEvent('click',         {bubbles:true,clientX:x,clientY:y}));
  el.focus?.();
  el.dispatchEvent(new KeyboardEvent('keydown',{key:'a',ctrlKey:true,bubbles:true}));
  el.dispatchEvent(new KeyboardEvent('keyup',  {key:'a',ctrlKey:true,bubbles:true}));
  if (el.tagName==='INPUT'||el.tagName==='TEXTAREA') {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')?.set?.call(el,value);
    el.dispatchEvent(new Event('input',{bubbles:true}));
    el.dispatchEvent(new Event('change',{bubbles:true}));
    return true;
  }
  if (el.contentEditable==='true'||el.isContentEditable) { el.innerText=value; el.dispatchEvent(new InputEvent('input',{data:value,bubbles:true})); return true; }
  for (let i=0;i<18;i++) { el.dispatchEvent(new KeyboardEvent('keydown',{key:'Backspace',bubbles:true})); el.dispatchEvent(new KeyboardEvent('keyup',{key:'Backspace',bubbles:true})); }
  for (const ch of value) { el.dispatchEvent(new KeyboardEvent('keydown',{key:ch,bubbles:true})); el.dispatchEvent(new InputEvent('beforeinput',{data:ch,inputType:'insertText',bubbles:true})); el.dispatchEvent(new InputEvent('input',{data:ch,inputType:'insertText',bubbles:true})); el.dispatchEvent(new KeyboardEvent('keyup',{key:ch,bubbles:true})); }
  return true;
}
function verifyElementContainsValue(el, expected, done, attempt=0) {
  const txt=textOf(el).replace(/[$,\s]/g,''), want=String(expected).replace(/[$,\s]/g,''), val=String(el?.value||'').replace(/[$,\s]/g,'');
  if (txt.includes(want)||val.includes(want)) { done(true); return; }
  if (attempt>=VALUE_VERIFY_ATTEMPTS) { done(false); return; }
  setTimeout(()=>verifyElementContainsValue(el,expected,done,attempt+1),VALUE_VERIFY_INTERVAL_MS);
}
function verifyStopLossVisible(expectedStr, done, attempt=0) {
  const body=document.body.innerText||'', norm=expectedStr.replace(/\.?0+$/,'');
  const ok=(body.includes('Stop-Loss Price')||body.includes('Stop Loss Price')||body.includes('Stop-Loss'))
    &&(body.includes(expectedStr)||body.includes(norm)||!!findContaining(expectedStr));
  if (ok) { done(true); return; }
  if (attempt>=VERIFY_SL_ATTEMPTS) { done(false); return; }
  setTimeout(()=>verifyStopLossVisible(expectedStr,done,attempt+1),VERIFY_SL_INTERVAL_MS);
}
function setPositionSize(callback) {
  badge('⚡ CHECK SIZE','#7c3aed');
  let attempts=0;
  const trySet = () => {
    if (++attempts>24) { logAct('SIZE_WARN','Field not found'); callback?.(false,null); return; }
    const total=readWalletTotal();
    if (!total||total<1) { setTimeout(trySet,300); return; }
    const traderPct=readTraderPositionPct();
    let finalPct;
    if (FORCE_POSITION_PCT!==null) finalPct=FORCE_POSITION_PCT;
    else if (traderPct!==null&&traderPct<=MAX_POSITION_PCT) finalPct=traderPct;
    else finalPct=MAX_POSITION_PCT;
    const targetAmount=Math.floor((total*finalPct/100)*100)/100;
    const inputEl=findPositionSizeInput();
    if (!inputEl) { setTimeout(trySet,300); return; }
    injectValue(inputEl,targetAmount.toFixed(2));
    verifyElementContainsValue(inputEl,targetAmount.toFixed(2),ok=>{
      logAct('SIZE_SET',`${finalPct}% = $${targetAmount.toFixed(2)} of $${total} | verify=${ok}`);
      badge(`⚡ $${targetAmount.toFixed(2)} (${finalPct}%)`,ok?'#7c3aed':'#b45309');
      callback?.(ok,{total,traderPct,finalPct,targetAmount:targetAmount.toFixed(2)});
    });
  };
  setTimeout(trySet,300);
}
function setStopLoss(callback) {
  if (!MANAGE_STOP_LOSS) { callback?.(true,null); return; }
  badge('⚡ SL CHECK','#dc2626');
  let attempts=0;
  const trySet = () => {
    if (++attempts>28) { logAct('SL_WARN','SL not found'); callback?.(false,null); return; }
    const currentPrice=readCurrentPrice(), direction=readTradeDirection();
    if (!currentPrice||!direction) { setTimeout(trySet,350); return; }
    const slStr=computeStopLossPrice(currentPrice,direction);
    const body=document.body.innerText||'';
    const toggleIsOff=body.includes('Stop-Loss Price')&&/Stop-Loss Price[\s\S]{0,50}-?\$?0\b/.test(body);
    if (toggleIsOff) { const sl=findByText('Stop-Loss')||findContaining('Stop-Loss'); if (sl) { click(sl); setTimeout(trySet,900); return; } }
    const slField=findStopLossInput();
    if (!slField) { setTimeout(trySet,350); return; }
    injectValue(slField,slStr);
    verifyElementContainsValue(slField,slStr,okField=>{
      verifyStopLossVisible(slStr,okVisible=>{
        const ok=okField||okVisible;
        logAct('SL_SET',`${direction} @ ${currentPrice} → ${slStr} | verify=${ok}`);
        badge(ok?`⚡ SL ${slStr}`:'⚠️ SL not verified',ok?'#dc2626':'#b45309');
        callback?.(ok,{direction,currentPrice,slStr,okField,okVisible});
      });
    });
  };
  setTimeout(trySet,400);
}
function shouldBlockOpenFromCurrentView() {
  const symbol=inferCurrentSymbol(), lev=inferLeverageFromBody();
  if (symbol&&!symbolAllowed(symbol)) return `Symbol ${symbol} blocked`;
  if (lev&&MAX_ALLOWED_LEVERAGE&&lev>MAX_ALLOWED_LEVERAGE) return `Leverage ${lev}X > max ${MAX_ALLOWED_LEVERAGE}X`;
  return null;
}
function abortForWalletEmergency(reason) {
  emergencyMode=true; logAct('EMERGENCY',reason); showEmergencyBanner(reason);
  if (!localStorage.getItem(EMERGENCY_BEEP_KEY)) { playAlert(1); try { localStorage.setItem(EMERGENCY_BEEP_KEY,String(Date.now())); } catch {} }
  badge('🚨 LOSS ALERT','#991b1b');
}

// ════════════════════════════════════════════════════════════════════════════
// TAB 1 — /notifications
// ════════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════════
// v22.11 FIX #2 — scanNotifs() ACC GUARD
//
// If acc hasn't activated yet, scanNotifs used to run anyway, find zero
// notifications (because innerText was empty), and do nothing. Each page
// reload reset acc. Now scanNotifs() checks accOn first and triggers an
// immediate enableAcc() attempt when not yet active, then bails early.
// Once acc activates, the follow-up in enableAcc() calls scanNotifs()
// directly so there's zero delay between acc-on and first real scan.
// ════════════════════════════════════════════════════════════════════════════
function scanNotifs() {
  if (!onPage('/notifications')) return;
  if (opensPaused()) { badge('⏸ PAUSED','#991b1b'); return; }

  // Guard: if acc not on yet, try enabling it and bail — don't waste scan
  if (!accOn) {
    enableAcc();
    badge('⏳ Waiting for acc...', '#6b7280');
    return;
  }

  const freshTrades=[];
  const addTrade = (el,label) => {
    if (!label||label.length<5||label.length>600) return;
    if (!isOpenPhrase(label)) return;
    const key=stableKey(label);
    if (seenNotifs.has(key)) return;
    const age=ageMins(label);
    if (age>MAX_AGE_MINUTES) { seenNotifs.add(key); saveSeenNotifs(); if (age<30) logAct('STALE',`${age.toFixed(1)}m`); return; }
    freshTrades.push({el,label,key,age});
  };
  document.querySelectorAll('[aria-label]').forEach(el=>addTrade(el,el.getAttribute('aria-label')||''));
  document.querySelectorAll('flt-semantics,flt-semantics-container').forEach(el=>{
    const txt=textOf(el);
    if (!txt||txt.length<5||txt.length>400||!isOpenPhrase(txt)||seenNotifs.has(stableKey(txt))) return;
    addTrade(findClickableParent(el),txt);
  });
  if (!freshTrades.length) return;
  const seen=new Set();
  const unique=freshTrades.filter(t=>seen.has(t.key)?false:(seen.add(t.key),true));
  unique.sort((a,b)=>a.age-b.age);
  if (isExec) {
    unique.forEach(t=>{ if (!pendingTrades.some(p=>p.key===t.key)) { t.savedAt=Date.now(); pendingTrades.push(t); logAct('QUEUED',t.label.substring(0,60)); } });
    savePendingTrades(); return;
  }
  unique.forEach(t=>{ seenNotifs.add(t.key); }); saveSeenNotifs();

  // ★ v22.12 FIX A — purge pendingTrades of stale or already-seen entries.
  // pendingTrades stores the ORIGINAL detection age (e.g. age:2 for "2 min ago").
  // Without this purge, a trade queued hours ago with age:2 passes the freshness
  // filter indefinitely, causing the script to loop back to the same stale post page.
  // Effective age = original_age + minutes elapsed since it was queued.
  const _now = Date.now();
  pendingTrades = pendingTrades.filter(t => {
    if (seenNotifs.has(t.key)) return false;                              // already stale
    const effectiveAge = (t.age||0) + (_now - (t.savedAt||_now))/60000;
    if (effectiveAge > MAX_AGE_MINUTES) {
      seenNotifs.add(t.key);                                              // mark stale permanently
      logAct('PURGE_PENDING', `${t.label?.substring(0,40)} — ${effectiveAge.toFixed(1)}m old`);
      return false;
    }
    return true;
  });
  savePendingTrades();

  const target=pendingTrades.length>0?pendingTrades.shift():unique[0];

  // Guard: if the selected target was just marked stale during purge above, skip it
  if (seenNotifs.has(target.key)) {
    logAct('SKIP_STALE_TARGET', target.label?.substring(0,40)||'');
    setTimeout(scanNotifs,800);
    return;
  }
  if (!target.el) {
    const found=[...document.querySelectorAll('[aria-label]')].find(el=>stableKey(el.getAttribute('aria-label')||'')===target.key);
    target.el=found?findClickableParent(found):null;
    if (!target.el) { W(`pendingTrades: cannot re-find — skipping`); savePendingTrades(); setTimeout(scanNotifs,800); return; }
  }
  seenNotifs.add(target.key); saveSeenNotifs();
  L(`🚨 FRESH (${target.age.toFixed(1)}m): ${target.label.substring(0,80)}`);
  logAct('OPENING',target.label.substring(0,80));
  lock('OPENING');
  click(target.el);
  setTimeout(()=>doOpen(target),1700);
  if (seenNotifs.size>1000) { const trimmed=[...seenNotifs].slice(-500); seenNotifs=new Set(trimmed); saveSeenNotifs(); }
}

function extractTraderFromLabel(label) {
  const m=label.match(/@([A-Za-z0-9_]+)/);
  return m?m[1]:'';
}
function doOpen(tradeTarget=null) {
  const preBlock=shouldBlockOpenFromCurrentView();
  if (preBlock) { W(`Risk block: ${preBlock}`); logAct('RISK_SKIP',preBlock); badge('⏭ SKIPPED','#b45309'); unlock(); return; }
  waitForPredicate(
    ()=>findMimicButton(),
    (mimicBtn)=>{
      L('→ Mimic Trade button found');
      click(mimicBtn);
      setTimeout(()=>{
        setPositionSize((sizeOK,sizeCtx)=>{
          if (!sizeOK) logAct('SIZE_WARN','Proceeding without verified size');
          setTimeout(()=>{
            setStopLoss((slOK,slCtx)=>{
              const openCtx={ts:Date.now(),symbol:inferCurrentSymbol(),leverage:inferLeverageFromBody(),direction:readTradeDirection(),size:sizeCtx,sl:slCtx,slVerified:slOK};
              lastOpenContext=openCtx;
              if (MANAGE_STOP_LOSS&&REQUIRE_SL_BEFORE_CONFIRM&&!slOK) { W('SL required not verified'); logAct('SL_SKIP','SL required'); badge('⏭ SL SKIP','#b45309'); unlock(); return; }
              setTimeout(()=>{
                waitForEl(['Confirm Position','Confirm'],()=>{
                  lastActionTime=Date.now();
                  logAct('SUCCESS',`Opened ${openCtx.symbol||''} ${openCtx.direction||''} ${new Date().toLocaleTimeString()}`);
                  if (tradeTarget?.key) openAttempts.delete(tradeTarget.key);
                  setRiskState({lastOpenContext:openCtx,needWalletVerify:MANAGE_STOP_LOSS,expectedStopLoss:slCtx?.slStr||null});
                  if (openCtx.symbol) {
                    const trader=tradeTarget?.label?extractTraderFromLabel(tradeTarget.label):'';
                    registerOpenMimicPosition(openCtx.symbol,trader,openCtx.leverage,openCtx.direction||'long');
                  }
                  setTimeout(unlock,OPEN_CONFIRM_MS);
                },CONFIRM_BUTTON_TIMEOUT_MS);
              },1000);
            });
          },1400);
        });
      },MODAL_SETTLE_MS);
    },
    OPEN_BUTTON_TIMEOUT_MS, 300,
    ()=>{
      const key=tradeTarget?.key;
      const prev=openAttempts.get(key)||0, attempts=prev+1;
      if (key) openAttempts.set(key,attempts);
      // ★ v22.13 FIX 1: Save BEFORE calling unlock() which navigates the page.
      // Without this, the Map is wiped on the next page load and attempts stays
      // at 1 forever — seenNotifs.delete() always fires — infinite retry loop.
      saveOpenAttempts();
      if (attempts<MAX_OPEN_ATTEMPTS&&key) { seenNotifs.delete(key); saveSeenNotifs(); W(`doOpen: retry ${attempts}/${MAX_OPEN_ATTEMPTS}`); logAct('RETRY_OPEN',`${attempts}/${MAX_OPEN_ATTEMPTS}`); badge(`⏭ RETRY ${attempts}/${MAX_OPEN_ATTEMPTS}`,'#b45309'); }
      else { W('doOpen: exhausted'); logAct('SKIP_PERM',`${attempts} attempts`); badge('⏭ NO MIMIC BTN','#b45309'); }
      unlock();
    }
  );
}

// ════════════════════════════════════════════════════════════════════════════
// TAB 2 — /wallet
// ════════════════════════════════════════════════════════════════════════════
function verifyPostOpenRiskIfNeeded() {
  const st=getRiskState();
  if (!st.needWalletVerify) return;
  if (Date.now()-(st.ts||0)>5*60*1000) { setRiskState({needWalletVerify:false}); return; }
  const expected=st.expectedStopLoss, body=document.body.innerText||'';
  if (expected&&(body.includes(expected)||!!findContaining(expected))) { logAct('WALLET_VERIFY',`SL ${expected} confirmed`); setRiskState({needWalletVerify:false}); clearEmergencyBanner(); return; }
  const lossPct=readLossPctFromWalletBody(), lossUsd=extractWorstLossUsd();
  if ((lossPct!==null&&Math.abs(lossPct)>=STOP_LOSS_PCT+1.5)||(lossUsd!==null&&lossUsd>=EMERGENCY_MAX_LOSS_USD)) {
    setRiskState({needWalletVerify:false});
    attemptEmergencyClose(`SL not confirmed, loss=${lossPct??'?'}% / -$${lossUsd??'?'}`);
  }
}
function attemptEmergencyClose(reason) {
  if (isExec) return;
  abortForWalletEmergency(reason);
  const directBtn=findByText('Close Position')||findContaining('Close Position');
  if (directBtn&&!menuOpen()) { lock('EMERGENCY CLOSE'); click(directBtn); setTimeout(()=>doCloseConfirm(0,null,null),1800); return; }
  const worst=findWorstTradeCard();
  if (worst?.el) {
    click(worst.el); logAct('EMERGENCY',`Worst: ${worst.symbol} -$${worst.usd} ${worst.pct}%`);
    setTimeout(()=>{
      const btn=findByText('Close Position')||findContaining('Close Position');
      if (btn) { lock('EMERGENCY CLOSE'); click(btn); setTimeout(()=>doCloseConfirm(0,worst.symbol,worst.direction),1800); }
      else if (RESUME_WALLET_UPDATES_AFTER_EMERGENCY) unlock();
    },1400);
    return;
  }
  if (RESUME_WALLET_UPDATES_AFTER_EMERGENCY) setTimeout(()=>unlock(),2000);
}
function doCloseConfirm(attempt=0, symbol=null, direction=null) {
  if (attempt>28) { W('Close confirm not found'); unlock(); return; }
  const body=document.body.innerText||'';
  const modal=body.includes('Exit Price')||body.includes('Position Size:')||body.includes('Confirm');
  const btn=findByText('Confirm')||findByText('Confirm Position');
  if (btn&&modal) { click(btn); lastActionTime=Date.now(); logAct('CLOSED',`${symbol||''} ${new Date().toLocaleTimeString()}`); clearEmergencyBanner(); setTimeout(()=>closeDone(symbol,direction),CONFIRM_WAIT_MS); }
  else { setTimeout(()=>doCloseConfirm(attempt+1,symbol,direction),600); }
}

function findTradeUpdateGroups() {
  const RE=/^Trade Updates?\s*\((\d+)\)$/i;
  const candidates=[];
  for (const el of document.querySelectorAll('flt-semantics,flt-semantics-container,div,span,button,a')) {
    const t=textOf(el); const m=t.match(RE);
    if (!m||!visible(el)) continue;
    const count=parseInt(m[1],10); if (count<1) continue;
    candidates.push({label:t,count,el,r:el.getBoundingClientRect()});
  }
  if (!candidates.length) return [];
  const kept=[];
  for (const c of candidates) {
    let dup=false;
    for (const k of kept) {
      const ox=Math.max(0,Math.min(c.r.right,k.r.right)-Math.max(c.r.left,k.r.left));
      const oy=Math.max(0,Math.min(c.r.bottom,k.r.bottom)-Math.max(c.r.top,k.r.top));
      if (ox*oy>0.7*Math.min(c.r.width*c.r.height,k.r.width*k.r.height)) { if (c.r.width*c.r.height<k.r.width*k.r.height) kept.splice(kept.indexOf(k),1,c); dup=true; break; }
    }
    if (!dup) kept.push(c);
  }
  kept.sort((a,b)=>a.r.top-b.r.top);
  L(`findTradeUpdateGroups: ${kept.length} group(s)`);
  return kept;
}
function expandTradeUpdateGroup(group) {
  if (!group.el||!visible(group.el)) return false;
  click(group.el); logAct('EXPAND',group.label); return true;
}
function findVisibleCopyButtons() { return [...document.querySelectorAll('flt-semantics,div,span,button')].filter(el=>textOf(el)==='Copy'&&visible(el)); }
function findVisibleCopiedButtons() { return [...document.querySelectorAll('flt-semantics,div,span,button')].filter(el=>textOf(el)==='Copied'&&visible(el)); }
function countGroupCopyState(groupEl, windowPx=400) {
  if (!groupEl) { return {copyCount:findVisibleCopyButtons().length,copiedCount:findVisibleCopiedButtons().length}; }
  const headerBottom=groupEl.getBoundingClientRect().bottom, scanBottom=headerBottom+windowPx;
  let copyCount=0, copiedCount=0;
  for (const el of document.querySelectorAll('flt-semantics,div,span,button')) {
    if (!visible(el)) continue;
    const t=textOf(el); if (t!=='Copy'&&t!=='Copied') continue;
    const r=el.getBoundingClientRect();
    if (r.top<headerBottom-10||r.top>scanBottom) continue;
    if (t==='Copy') copyCount++; else copiedCount++;
  }
  return {copyCount,copiedCount};
}
function waitForGroupExpansion(group, onReady, onFail) {
  const POLL_MS=300, TIMEOUT_MS=6000, MAX_ATTEMPTS=2;
  const {copyCount:preCopy,copiedCount:preCopied}=countGroupCopyState(group.el);
  if (preCopy+preCopied>0) { logAct('ALREADY_EXPANDED',`${group.label}: ${preCopy} Copy, ${preCopied} Copied`); onReady(preCopy); return; }
  let attempt=0, elapsed=0;
  function tryExpand() { attempt++; expandTradeUpdateGroup(group); elapsed=0; poll(); }
  function poll() {
    const {copyCount,copiedCount}=countGroupCopyState(group.el);
    if (copyCount+copiedCount>0) { logAct('GROUP_ROWS',`${group.label}: ${copyCount} Copy, ${copiedCount} Copied`); onReady(copyCount); return; }
    elapsed+=POLL_MS;
    if (elapsed>=TIMEOUT_MS) {
      if (attempt<MAX_ATTEMPTS) { logAct('EXPAND_RETRY',`${group.label}: retry`); tryExpand(); }
      else { W(`waitForGroupExpansion: timeout "${group.label}"`); onFail?.(); }
      return;
    }
    setTimeout(poll,POLL_MS);
  }
  tryExpand();
}

// ════════════════════════════════════════════════════════════════════════════
// classifyCopyAction — v22.10 version (all signals intact)
// ════════════════════════════════════════════════════════════════════════════
function classifyCopyAction(modalBodyText) {
  const b = modalBodyText || document.body.innerText || '';
  const hasCloseLong  = /close\s+long/i.test(b);
  const hasOpenShort  = /open\s+short/i.test(b);
  const hasCloseShort = /close\s+short/i.test(b);
  const hasOpenLong   = /open\s+long/i.test(b);
  const hasFlipPhrase = /flip|switch|reverse\s+direction/i.test(b);
  const symbolM       = b.match(/\b([A-Z]{2,10})\s+\d+\s*[Xx]\s+(Long|Short)\b/);
  const symbol        = symbolM ? symbolM[1] : null;
  const newDirection  = symbolM ? symbolM[2].toLowerCase() : null;
  if ((hasCloseLong&&hasOpenShort)||(hasCloseShort&&hasOpenLong)||hasFlipPhrase) {
    return { action: COPY_ACTION_FLIP, symbol, newDirection, oldDirection: newDirection==='short'?'long':'short', reason: 'direction flip' };
  }
  if (symbol && /\bLong\b/i.test(b) && /\bShort\b/i.test(b)) {
    return { action: COPY_ACTION_FLIP, symbol, newDirection, oldDirection: newDirection==='short'?'long':'short', reason: 'Long+Short in modal' };
  }
  const hasCloseSignal  = /\b(close\s+(trade|position)|exit\s+(trade|position)|closing\s+(trade|position))\b/i.test(b);
  const hasZeroSize     = /\b0\.?0*\s*%|\$\s*0\.?0*\b|to\s+0\b|→\s*0\b|size[:\s]+0\b/i.test(b);
  const hasReduceToZero = /reduce[\s\S]{0,40}0\s*%/i.test(b) || /reduce[\s\S]{0,40}\$\s*0/i.test(b);
  const hasCloseButton  = /\bClose Position\b|\bClose Trade\b/i.test(b);
  const hasExitPrice    = /\bExit Price\b/i.test(b);
  const hasPositionSz   = /\bPosition Size\b/i.test(b);
  const isCloseModal    = hasExitPrice && !hasPositionSz;
  if (hasCloseSignal || hasZeroSize || hasReduceToZero || hasCloseButton || isCloseModal) {
    const reason = [
      hasCloseSignal  ?'close/exit language':'',
      hasZeroSize     ?'zero position size':'',
      hasReduceToZero ?'reduce-to-zero':'',
      hasCloseButton  ?'Close Position button':'',
      isCloseModal    ?'Exit Price/no size field':'',
    ].filter(Boolean).join(', ');
    return { action: COPY_ACTION_SKIP, symbol, newDirection: null, oldDirection: null, reason };
  }
  return { action: COPY_ACTION_COPY, symbol, newDirection, oldDirection: null, reason: 'normal adjustment' };
}

function detectModalType() {
  const keywords=['Confirm','Reset','Adjust Position Size','Go Back','Exit Price','Cancel','Position Size','Close Position','Close Trade'];
  const found=new Set();
  for (const el of document.querySelectorAll('*')) {
    if (!visible(el)) continue;
    const t=(el.innerText||el.textContent||'').trim();
    if (!t||t.length>600) continue;
    for (const kw of keywords) { if (t===kw||t.includes(kw)) found.add(kw); }
  }
  const body=document.body.innerText||document.body.textContent||'';
  for (const kw of keywords) { if (body.includes(kw)) found.add(kw); }
  const hasConfirm=found.has('Confirm'), hasReset=found.has('Reset'), hasAdjust=found.has('Adjust Position Size');
  const hasGoBack=found.has('Go Back'), hasExitPrice=found.has('Exit Price'), hasCancel=found.has('Cancel');
  const hasPositionSz=found.has('Position Size'), hasClosePos=found.has('Close Position'), hasCloseTrade=found.has('Close Trade');
  if (found.size>0) L(`detectModalType: [${[...found].join(', ')}]`);
  if (hasAdjust||(hasReset&&hasPositionSz&&hasConfirm&&!hasGoBack)) return 'adjust';
  if (hasExitPrice&&hasConfirm) {
    const isGenuineClose=(hasClosePos||hasCloseTrade)&&!hasPositionSz;
    if (isGenuineClose) return 'close';
    return 'adjust';
  }
  if (hasConfirm&&(hasGoBack||hasCancel)) return 'confirm';
  if (hasPositionSz&&hasConfirm&&!hasGoBack) return 'position';
  if (hasConfirm&&hasReset&&!hasGoBack&&!hasCancel&&!hasExitPrice) return 'adjust';
  return null;
}

function processSingleCopy(loop, maxLoops, groupEl, onDone) {
  if (loop>=maxLoops) { onDone(); return; }
  if (checkModals()) return;
  const copies=findVisibleCopyButtons();
  if (!copies.length) { const {copiedCount}=countGroupCopyState(groupEl); logAct('COPY_DONE',`No more Copy at loop ${loop} — ${copiedCount} Copied`); onDone(); return; }
  click(copies[0]);
  const {copiedCount:doneSoFar}=countGroupCopyState(groupEl);
  logAct('COPY_CLICK',`Copy ${loop+1}/${maxLoops}`);

  function afterConfirm() {
    const VERIFY_MS=300, VERIFY_MAX=10; let v=0;
    const verifyCopied=()=>{
      const nowCopies=findVisibleCopyButtons().length;
      const {copiedCount:nowCopied}=countGroupCopyState(groupEl);
      if (nowCopies<copies.length||nowCopied>doneSoFar) { logAct('COPY_VERIFIED','Copied'); setTimeout(()=>processSingleCopy(loop+1,maxLoops,groupEl,onDone),CONFIRM_WAIT_MS); }
      else if (++v>=VERIFY_MAX) { W('Copy→Copied unconfirmed'); setTimeout(()=>processSingleCopy(loop+1,maxLoops,groupEl,onDone),CONFIRM_WAIT_MS); }
      else { setTimeout(verifyCopied,VERIFY_MS); }
    };
    setTimeout(verifyCopied,600);
  }

  const MODAL_POLL_MS=300, MODAL_MAX_WAIT=10000;
  let modalElapsed=0;

  function pollForModal() {
    if (checkModals()) return;
    const modalType=detectModalType();
    if (!modalType) {
      modalElapsed+=MODAL_POLL_MS;
      if (modalElapsed>=MODAL_MAX_WAIT) { W(`No modal after ${MODAL_MAX_WAIT}ms`); logAct('COPY_NO_MODAL',`Loop ${loop}`); setTimeout(()=>processSingleCopy(loop+1,maxLoops,groupEl,onDone),500); }
      else { setTimeout(pollForModal,MODAL_POLL_MS); }
      return;
    }
    logAct('COPY_MODAL',`Modal: "${modalType}" at ${modalElapsed}ms`);
    const bodyNow = document.body.innerText || '';
    const copyInfo = classifyCopyAction(bodyNow);
    L(`classifyCopyAction: ${copyInfo.action} sym=${copyInfo.symbol||'?'} — ${copyInfo.reason}`);
    logAct('COPY_CLASSIFY', `${copyInfo.action} — ${copyInfo.symbol||'?'} — ${copyInfo.reason}`);

    if (copyInfo.action === COPY_ACTION_SKIP) {
      W(`⛔ SKIP Copy — would close ${copyInfo.symbol||'?'} (${copyInfo.reason})`);
      logAct('COPY_SKIP', `⛔ ${copyInfo.symbol||'?'}: ${copyInfo.reason}`);
      dismissMenu();
      // v22.10 FIX: Do NOT set urgentCloseSignalTs — that would trigger a close scan
      setTimeout(() => processSingleCopy(loop+1, maxLoops, groupEl, onDone), 1500);
      return;
    }
    if (copyInfo.action === COPY_ACTION_FLIP) {
      W(`🔄 FLIP — ${copyInfo.symbol} ${copyInfo.oldDirection}→${copyInfo.newDirection}`);
      logAct('FLIP_DETECTED', `${copyInfo.symbol}: ${copyInfo.oldDirection}→${copyInfo.newDirection}`);
      if (copyInfo.oldDirection) unregisterOpenMimicPosition(copyInfo.symbol, copyInfo.oldDirection);
      if (copyInfo.newDirection) registerOpenMimicPosition(copyInfo.symbol, '', 0, copyInfo.newDirection);
    }
    // v22.10 FIX: 'close' modal mid-Copy — dismiss, do NOT set urgentCloseSignalTs
    if (modalType === 'close') {
      W(`processSingleCopy: 'close' modal mid-Copy — REFUSING`);
      logAct('COPY_CLOSE_GUARD',`Loop ${loop}: dismissed — NOT setting urgentCloseSignalTs`);
      dismissMenu();
      setTimeout(()=>processSingleCopy(loop+1, maxLoops, groupEl, onDone), 1500);
      return;
    }
    if (modalType==='adjust') {
      const btn=findByText('Confirm')||findContaining('Confirm');
      if (btn) { click(btn); lastActionTime=Date.now(); } afterConfirm();
    }
    else if (modalType==='position') {
      setPositionSize(()=>{ const btn=findByText('Confirm')||findContaining('Confirm'); if (btn) { click(btn); lastActionTime=Date.now(); } afterConfirm(); });
    }
    else if (modalType==='confirm') {
      const btn=findByText('Confirm')||findContaining('Confirm');
      if (btn) { click(btn); lastActionTime=Date.now(); } else W('confirm modal — Confirm not found');
      afterConfirm();
    }
    else {
      const btn=findByText('Confirm')||findContaining('Confirm');
      if (btn) { click(btn); lastActionTime=Date.now(); } afterConfirm();
    }
  }
  setTimeout(pollForModal,400);
}

function processGroupQueue(groups, groupIdx) {
  if (groupIdx>=groups.length) {
    const remaining=findVisibleCopyButtons();
    if (remaining.length>0) {
      logAct('COPY_SWEEP',`Final sweep: ${remaining.length} Copy remaining`);
      processSingleCopy(0,remaining.length+3,null,()=>{ logAct('UPDATED',`Done — ${findVisibleCopiedButtons().length} Copied`); unlock(); });
    } else { logAct('UPDATED',`All done — ${findVisibleCopiedButtons().length} Copied`); unlock(); }
    return;
  }
  const group=groups[groupIdx];
  logAct('EXPAND_GROUP',`${groupIdx+1}/${groups.length}: ${group.label}`);
  waitForGroupExpansion(group,
    (copyCount)=>{
      if (copyCount===0) { logAct('GROUP_ALL_COPIED',`${group.label}: done`); processGroupQueue(groups,groupIdx+1); return; }
      logAct('GROUP_NEEDS_COPY',`${group.label}: ${copyCount} to Copy`);
      processSingleCopy(0,copyCount+3,group.el,()=>{ logAct('GROUP_DONE',`${group.label}: done`); processGroupQueue(groups,groupIdx+1); });
    },
    ()=>{ processGroupQueue(groups,groupIdx+1); }
  );
}
function handleWalletTradeUpdates() {
  const groups=findTradeUpdateGroups();
  if (!groups.length) return false;
  groups.sort((a,b)=>b.count-a.count);
  const pendingCopyCount=findVisibleCopyButtons().length;
  if (pendingCopyCount>0) { lock('UPDATING'); logAct('UPDATING',`${groups.length} group(s) | ${pendingCopyCount} Copy`); processGroupQueue(groups,0); return true; }
  const compositeKey='wallet-groups::'+groups.map(g=>g.label).sort().join('|')+'::copies=0';
  if (seenWallet.has(compositeKey)) return false;
  seenWallet.add(compositeKey);
  setTimeout(()=>seenWallet.delete(compositeKey),60000); // ★ v22.12: was 4000ms — shorter than one copy cycle causing duplicate queue runs
  lock('UPDATING'); logAct('UPDATING',`${groups.length} group(s) | expanding`);
  processGroupQueue(groups,0); return true;
}

// ── DOLLAR STOP-LOSS ───────────────────────────────────────────────────────────
function findTradesExceedingUsdThreshold(threshold) {
  const body=document.body.innerText||'', results=[];
  const re=/\b([A-Z]{2,10})\s+(\d+)\s*[Xx]\s*(Long|Short)[\s\S]{0,300}?-\$([\d,]+(?:\.\d+)?)/g;
  let m;
  while ((m=re.exec(body))!==null) {
    const usd=parseFloat(m[4].replace(/,/g,''));
    if (!isNaN(usd)&&usd>=threshold&&isMimicPosition(m[1])) results.push({symbol:m[1],direction:m[3],usd,el:findContaining(m[1])||null});
  }
  return results;
}
function checkDollarStopLoss() {
  if (!ENABLE_DOLLAR_STOP_LOSS||!AUTO_CLOSE_USD_THRESHOLD||AUTO_CLOSE_USD_THRESHOLD<=0) return false;
  const trades=findTradesExceedingUsdThreshold(AUTO_CLOSE_USD_THRESHOLD);
  if (!trades.length) return false;
  trades.sort((a,b)=>b.usd-a.usd);
  const target=trades[0];
  const cooldownKey=`dollar-stop-${target.symbol}`;
  if (seenWallet.has(cooldownKey)) return false;
  seenWallet.add(cooldownKey);
  setTimeout(()=>seenWallet.delete(cooldownKey),3*60*1000);
  L(`🛑 Dollar stop: ${target.symbol} -$${target.usd.toFixed(2)}`);
  logAct('DOLLAR_STOP',`${target.symbol} -$${target.usd.toFixed(2)}`);
  playAlert(1);
  if (!target.el) { seenWallet.delete(cooldownKey); return false; }
  lock('DOLLAR STOP-LOSS');
  click(target.el);
  setTimeout(()=>{
    const closeTradeBtn=findByText('Close Trade')||findContaining('Close Trade');
    if (closeTradeBtn) { click(closeTradeBtn); setTimeout(()=>doCloseConfirm(0,target.symbol,target.direction),1800); return; }
    const closePosBtn=findByText('Close Position')||findContaining('Close Position');
    if (closePosBtn) { click(closePosBtn); setTimeout(()=>doCloseConfirm(0,target.symbol,target.direction),1800); return; }
    seenWallet.delete(cooldownKey); unlock();
  },1400);
  return true;
}

// ── WALLET SCROLL SWEEP ───────────────────────────────────────────────────────
function getFlutterGlassPane() { return document.querySelector('flt-glass-pane')||document.body; }
function flutterWheel(deltaY) {
  const target=getFlutterGlassPane();
  const cx=window.innerWidth/2, cy=window.innerHeight/2;
  target.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY,deltaMode:0,clientX:cx,clientY:cy,screenX:cx,screenY:cy}));
}
function flutterScrollToTop() {
  return new Promise(resolve=>{
    for (let i=0;i<60;i++) flutterWheel(-300);
    const isUrgent=urgentCloseSignalTs&&Date.now()-urgentCloseSignalTs<URGENT_CLOSE_SIGNAL_TTL;
    setTimeout(resolve,isUrgent?150:400);
  });
}
function walletChecksAtCurrentPosition() {
  if (isExec) return true;
  if (checkClosePosition()) return true;
  if (checkDollarStopLoss()) return true;
  const worstTrade=findWorstTradeCard();
  if (worstTrade) {
    const pctBreach=worstTrade.pct!==null&&Math.abs(worstTrade.pct)>=EMERGENCY_WALLET_LOSS_PCT;
    const usdBreach=worstTrade.usd!==null&&worstTrade.usd>=EMERGENCY_MAX_LOSS_USD;
    const triggered=EMERGENCY_REQUIRES_BOTH?(pctBreach&&usdBreach):(pctBreach||usdBreach);
    if (triggered) { attemptEmergencyClose(`${worstTrade.symbol} ${worstTrade.pct??'?'}% / -$${worstTrade.usd?.toFixed(2)??'?'}`); return true; }
  }
  return false;
}
function runWalletScrollSweep(onActionFired, onComplete) {
  if (walletScrollSweepActive) { onComplete?.(); return; }
  walletScrollSweepActive=true;
  const isUrgent=!!(urgentCloseSignalTs&&Date.now()-urgentCloseSignalTs<URGENT_CLOSE_SIGNAL_TTL);
  const pauseMs=isUrgent?URGENT_SCROLL_PAUSE_MS:WALLET_SCROLL_PAUSE_MS;
  logAct('SCROLL_SWEEP',`${isUrgent?'URGENT':'normal'} — ${pauseMs}ms/pos`);
  const maxSweepMs=WALLET_SCROLL_MAX_POS*Math.max(pauseMs,80)+5000;
  const safetyTimer=setTimeout(()=>{ if (walletScrollSweepActive) { walletScrollSweepActive=false; onComplete?.(); } },maxSweepMs);
  flutterScrollToTop().then(()=>{
    let pos=0;
    function step() {
      try {
        if (isExec) { clearTimeout(safetyTimer); walletScrollSweepActive=false; onActionFired?.(); return; }
        if (pos>=WALLET_SCROLL_MAX_POS) { walletScrollLastSeenBody=document.body.innerText||''; clearTimeout(safetyTimer); walletScrollSweepActive=false; onComplete?.(); return; }
        if (walletChecksAtCurrentPosition()) { clearTimeout(safetyTimer); walletScrollSweepActive=false; onActionFired?.(); return; }
        const closeSignalHotNow=urgentCloseSignalTs&&Date.now()-urgentCloseSignalTs<URGENT_CLOSE_SIGNAL_TTL;
        if (!closeSignalHotNow&&!isExec&&handleWalletTradeUpdates()) { clearTimeout(safetyTimer); walletScrollSweepActive=false; onActionFired?.(); return; }
        for (let i=0;i<WALLET_SCROLL_STEPS;i++) flutterWheel(300);
        pos++;
        setTimeout(step,pauseMs);
      } catch(e) { W(`sweep error pos ${pos}: ${e.message}`); clearTimeout(safetyTimer); walletScrollSweepActive=false; onComplete?.(); }
    }
    step();
  });
}

// ── checkClosePosition (v22.10 fixes fully retained) ─────────────────────────
function readSymbolFromCloseButton(btn) {
  if (!btn) return null;
  const btnRect = btn.getBoundingClientRect();
  let el = btn;
  for (let i = 0; i < 18; i++) {
    if (!el.parentElement) break;
    el = el.parentElement;
    const t = textOf(el);
    const m = t.match(/\b([A-Z]{2,10})\s+\d+\s*[Xx]\s+(Long|Short)\b/);
    if (m) return { symbol: m[1], direction: m[2].toLowerCase() };
    if (t.length > 800) break;
  }
  // Proximity-based fallback (v22.10 fix)
  const btnY = btnRect.top;
  const SCAN_WINDOW_PX = 400;
  let best = null, bestDist = Infinity;
  for (const candidate of document.querySelectorAll('flt-semantics,flt-semantics-container,div,span')) {
    if (!visible(candidate)) continue;
    const r = candidate.getBoundingClientRect();
    if (r.bottom < btnY - SCAN_WINDOW_PX) continue;
    if (r.top > btnY + 60) continue;
    if (r.width < 20 || r.height < 4) continue;
    const t = textOf(candidate);
    if (!t || t.length < 4 || t.length > 250) continue;
    const m = t.match(/\b([A-Z]{2,10})\s+\d+\s*[Xx]\s+(Long|Short)\b/);
    if (!m) continue;
    const dist = Math.abs(r.top - btnY);
    if (dist < bestDist) { bestDist = dist; best = { symbol: m[1], direction: m[2].toLowerCase() }; }
  }
  return best || null;
}
function checkClosePosition() {
  const body=document.body.innerText||'';
  const hasClosePos=body.includes('Close Position'), hasTraderClosed=body.includes('Trader Closed');
  if (!hasClosePos&&!hasTraderClosed) return false;
  if (hasTraderClosed) {
    urgentCloseSignalTs=Date.now();
    if (!hasClosePos) { L(`checkClosePosition: "Trader Closed" — urgent`); logAct('TRADER_CLOSED_BADGE','Urgent mode'); return false; }
  }
  try {
    const lastCloseTs=parseInt(localStorage.getItem(CLOSE_POSITION_TS_KEY)||'0',10);
    if (lastCloseTs&&Date.now()-lastCloseTs<CLOSE_POSITION_COOLDOWN_MS) return false;
  } catch {}
  if (menuOpen()) return false;
  const btn=findByText('Close Position')||findContaining('Close Position');
  if (!btn) {
    urgentCloseSignalTs=Date.now();
    L(`checkClosePosition: 🔴 off-screen — urgent sweep`);
    logAct('CLOSE_SIGNAL_OFFSCREEN','Urgent sweep');
    return false;
  }
  const cardInfo=readSymbolFromCloseButton(btn);
  const symbol=cardInfo?.symbol||null, direction=cardInfo?.direction||null;
  // v22.10 FIX: null symbol = hard abort, never close blind
  if (!symbol) {
    W(`checkClosePosition: ⛔ ABORT — symbol unreadable. Refusing blind close.`);
    logAct('CLOSE_GUARD_NULL','symbol=null — skipped');
    urgentCloseSignalTs=Date.now(); // keep sweeping for fresh DOM
    return false;
  }
  if (!isMimicPosition(symbol)) {
    W(`checkClosePosition: ⚠️ SKIP — ${symbol} not in registry`);
    logAct('CLOSE_GUARD',`Skipped ${symbol}`);
    return false;
  }
  L(`checkClosePosition: ✅ ${symbol} in registry — closing NOW`);
  urgentCloseSymbol=symbol;
  urgentCloseSignalTs=Date.now();
  try { localStorage.setItem(CLOSE_POSITION_TS_KEY,String(Date.now())); } catch {}
  logAct('CLOSING',`${symbol} ${direction||''} at ${new Date().toLocaleTimeString()}`);
  lock('CLOSING');
  click(btn);
  setTimeout(()=>doCloseConfirm(0,symbol,direction),2000);
  return true;
}

// ── MAIN WALLET SCAN ───────────────────────────────────────────────────────────
function scanWallet() {
  if (!onPage('/wallet')) return;
  if (isExec) return;
  if (walletScrollSweepActive) return;
  if (lastActionTime&&Date.now()-lastActionTime<POST_ACTION_COOL) return;
  lastActivity=Date.now();
  storeWalletBalance();
  if (menuOpen()) { dismissMenu(); return; }
  if (checkModals()) return;
  const bodyNow=document.body.innerText||'';
  if (bodyNow.includes('Close Position')||bodyNow.includes('Trader Closed')) urgentCloseSignalTs=Date.now();
  const closeSignalHot=!!(urgentCloseSignalTs&&Date.now()-urgentCloseSignalTs<URGENT_CLOSE_SIGNAL_TTL);
  verifyPostOpenRiskIfNeeded();
  if (checkClosePosition()) return;
  if (checkDollarStopLoss()) return;
  const worstTrade=findWorstTradeCard();
  if (worstTrade) {
    const pctBreach=worstTrade.pct!==null&&Math.abs(worstTrade.pct)>=EMERGENCY_WALLET_LOSS_PCT;
    const usdBreach=worstTrade.usd!==null&&worstTrade.usd>=EMERGENCY_MAX_LOSS_USD;
    const triggered=EMERGENCY_REQUIRES_BOTH?(pctBreach&&usdBreach):(pctBreach||usdBreach);
    if (triggered) { attemptEmergencyClose(`${worstTrade.symbol} ${worstTrade.pct??'?'}% / -$${worstTrade.usd?.toFixed(2)??'?'}`); return; }
  }
  if (!closeSignalHot&&handleWalletTradeUpdates()) return;
  runWalletScrollSweep(
    ()=>{ L('sweep: action found'); },
    ()=>{ if (isExec) return; if (!closeSignalHot&&handleWalletTradeUpdates()) return; L('sweep: complete'); }
  );
}

function scan() {
  try {
    if (!accOn) enableAcc();
    if (onPage('/notifications')) scanNotifs();
    else if (onPage('/wallet')) scanWallet();
  } catch(e) { W(`scan() error: ${e.message}`); }
}

// ── WATCHDOGS ──────────────────────────────────────────────────────────────────
setInterval(()=>{
  if (isExec&&execStart&&Date.now()-execStart>MAX_EXEC_MS) { W(`Stuck — force-unlock`); isExec=false; execStart=0; badge('🟢 Active'); window.location.href=HOME_URL; }
},10000);

// ★ v22.13 FIX B — Post-page stuck watchdog
// Scenario: unlock() fires, sets window.location.href = NOTIFICATIONS_URL,
// but a Flutter SPA navigation intercepts or the redirect beats the page load,
// leaving the script idle on /post/ with isExec=false. '/post/' is in SAFE_PATHS
// so the wrong-page watchdog never triggers. This dedicated watchdog detects that
// state and forces the redirect home after POST_STUCK_MS of inactivity.
let postStuckSince = 0;
setInterval(()=>{
  if (IS_WALLET) return;                          // only for notifications tab
  if (isExec) { postStuckSince = 0; return; }    // executing = intentional, no redirect
  if (!onPage('/post/')) { postStuckSince = 0; return; }
  if (!reloadSafe()) { postStuckSince = 0; return; }
  if (!postStuckSince) { postStuckSince = Date.now(); return; }
  if (Date.now() - postStuckSince > POST_STUCK_MS) {
    postStuckSince = 0;
    W('Post-page stuck detected — redirecting to notifications');
    logAct('POST_STUCK_REDIRECT', window.location.href);
    window.location.href = NOTIFICATIONS_URL;
  }
},2000);
setInterval(()=>{
  if (!reloadSafe()) { wrongSince=null; return; }
  if (isExec) { wrongSince=null; return; }
  const url=window.location.href;
  if (url.includes('/share_out')) { window.location.href=HOME_URL; return; }
  if (!url.includes(HOME_PATH)&&!SAFE_PATHS.some(p=>url.includes(p))) {
    if (!wrongSince) wrongSince=Date.now();
    if (Date.now()-wrongSince>WRONG_PAGE_MS) { wrongSince=null; window.location.href=HOME_URL; }
  } else { wrongSince=null; }
},2000);
setInterval(()=>{
  if (!reloadSafe()||!onPage(HOME_PATH)) return;
  if (Date.now()-lastActivity>STALE_MS) { W('Stale — reloading'); location.reload(); }
},20000);
setInterval(()=>{
  const body=document.body?.innerText||'', title=document.title||'';
  const is404=body.includes('404')||body.toLowerCase().includes('page not found')||title.includes('404');
  if (is404&&!window._404recovering) { window._404recovering=true; logAct('404','Recovering'); badge('⚠️ 404','#dc2626'); setTimeout(()=>{ window._404recovering=false; window.location.href=HOME_URL; },1500); }
  else if (!is404) { window._404recovering=false; }
},5000);

// ── SESSION WATCHDOG ──────────────────────────────────────────────────────────
function startAuthWatchdog() {
  if (!SESSION_WATCHDOG_ENABLED) return;
  let failCount=0, firstFailAt=0, reloadPending=false;
  function handleAuthFailure(url) {
    const now=Date.now();
    if (firstFailAt&&now-firstFailAt>SESSION_RELOAD_WINDOW_MS) { failCount=0; firstFailAt=0; }
    if (failCount===0) firstFailAt=now;
    failCount++;
    W(`AUTH 401 (${failCount}/${SESSION_RELOAD_THRESHOLD})`);
    if (failCount>=SESSION_RELOAD_THRESHOLD&&!reloadPending) {
      reloadPending=true; badge('🔄 Session expired','#b45309');
      const doReload=()=>{ if (isExec) { setTimeout(doReload,3000); return; } location.reload(); };
      setTimeout(doReload,2500);
    }
  }
  function handleAuthSuccess() { if (failCount>0) { failCount=0; firstFailAt=0; reloadPending=false; } }
  const _origFetch=window.fetch;
  window.fetch=function(...args) {
    return _origFetch.apply(this,args).then(res=>{
      const url=String(args[0]||'');
      if (url.includes('invoapp.com')) { if (res.status===401) handleAuthFailure(url); else if (res.ok) handleAuthSuccess(); }
      return res;
    }).catch(err=>{ throw err; });
  };
  const _origOpen=XMLHttpRequest.prototype.open, _origSend=XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open=function(method,url,...rest) { this._amUrl=String(url||''); return _origOpen.apply(this,[method,url,...rest]); };
  XMLHttpRequest.prototype.send=function(...args) {
    this.addEventListener('load',function() { if ((this._amUrl||'').includes('invoapp.com')) { if (this.status===401) handleAuthFailure(this._amUrl); else if (this.status>=200&&this.status<300) handleAuthSuccess(); } });
    return _origSend.apply(this,args);
  };
  L('Auth watchdog: ACTIVE');
}
function startWebLocksKeepalive() {
  if (!navigator.locks?.request) return;
  navigator.locks.request('am-tab-alive',{mode:'shared'},()=>new Promise(()=>{})).catch(e=>W(`Web Locks: ${e.message}`));
  L('Web Locks: ACTIVE');
}
function scheduleReload() {
  const delay=(Math.floor(Math.random()*(RELOAD_MAX_S-RELOAD_MIN_S+1))+RELOAD_MIN_S)*1000;
  L(`Next reload in ${Math.round(delay/1000)}s`);
  setTimeout(()=>{
    // ★ v22.13: If the notifications tab booted/landed on a /post/ page without
    // executing (e.g. script was still running when the browser landed here), redirect
    // home immediately instead of looping the reload timer. This is the fix for the
    // "Next reload in Xs... Next reload in Xs... Next reload in Xs" infinite console log.
    if (!IS_WALLET && !isExec && reloadSafe() && onPage('/post/')) {
      L('scheduleReload: stranded on /post/ — redirecting to notifications');
      logAct('RELOAD_POST_REDIRECT', window.location.href);
      window.location.href = NOTIFICATIONS_URL;
      return;
    }
    if (reloadSafe()&&onPage(HOME_PATH)) { L('Keepalive reload'); location.reload(); }
    else scheduleReload();
  },delay);
}

// ════════════════════════════════════════════════════════════════════════════
// v22.11 FIX #3 — MutationObserver rewrite
//
// The wallet MutationObserver was throttled to 200ms which meant close signals
// could sit undetected for up to 200ms per DOM mutation. More critically, the
// NOTIFICATIONS MutationObserver didn't check accOn — so it would fire, call
// scanNotifs(), which bailed early because accOn=false, causing a tight loop
// of wasted scan calls while producing nothing useful.
//
// v22.11 FIX: Both observers now check accOn before calling their scan
// functions. The wallet observer throttle is tightened to 100ms for faster
// close/update detection. The notification observer only fires scanNotifs
// when accOn is confirmed true, otherwise it calls enableAcc() instead.
// ════════════════════════════════════════════════════════════════════════════
function startMutationWatcher() {
  if (!onPage('/notifications')) return;
  const target=document.querySelector('flt-glass-pane')||document.body;
  if (!target) return;
  const THROTTLE_MS=200; let lastRun=0, trailingTimer=null;
  const runScan=()=>{
    lastRun=Date.now();
    if (isExec||!onPage('/notifications')||opensPaused()) return;
    if (!accOn) { enableAcc(); return; } // try to activate, skip this scan cycle
    try { scanNotifs(); } catch(e) { W(`mutation notifs: ${e.message}`); }
  };
  const observer=new MutationObserver(()=>{
    const now=Date.now();
    if (now-lastRun>=THROTTLE_MS) runScan();
    else if (!trailingTimer) trailingTimer=setTimeout(()=>{ trailingTimer=null; runScan(); },THROTTLE_MS);
  });
  observer.observe(target,{childList:true,subtree:true,attributes:false,characterData:false});
  L('Notifications MutationObserver: ACTIVE (200ms throttle)');
}
function startWalletMutationWatcher() {
  if (!IS_WALLET) return;
  const target=document.querySelector('flt-glass-pane')||document.body;
  if (!target) return;
  const THROTTLE_MS=100; let lastRun=0, trailingTimer=null; // v22.11: 100ms (was 200)
  const runCheck=()=>{
    lastRun=Date.now();
    if (isExec||walletScrollSweepActive||!onPage('/wallet')) return;
    if (lastActionTime&&Date.now()-lastActionTime<POST_ACTION_COOL) return;
    const body=document.body.innerText||'';
    const hasSignal=body.includes('Close Position')||body.includes('Trade Updates')||body.includes('Trader Closed');
    if (!hasSignal) return;
    lastActivity=Date.now();
    if (body.includes('Close Position')||body.includes('Trader Closed')) urgentCloseSignalTs=Date.now();
    try { scanWallet(); } catch(e) { W(`mutation wallet: ${e.message}`); }
  };
  const observer=new MutationObserver(()=>{
    const now=Date.now();
    if (now-lastRun>=THROTTLE_MS) runCheck();
    else if (!trailingTimer) trailingTimer=setTimeout(()=>{ trailingTimer=null; runCheck(); },THROTTLE_MS);
  });
  observer.observe(target,{childList:true,subtree:true,attributes:false,characterData:false});
  L('Wallet MutationObserver: ACTIVE (100ms throttle)');
}

document.addEventListener('visibilitychange',()=>{
  if (document.visibilityState==='visible') {
    lastActivity=Date.now();
    // v22.11: Reset acc state on tab visible so it re-confirms
    if (!accOn) { accAttempts=0; enableAcc(); }
    scan();
    const fresh=pendingTrades.filter(t=>t.age<=MAX_AGE_MINUTES);
    if (fresh.length<pendingTrades.length) { logAct('CLEAR_STALE',`Removed ${pendingTrades.length-fresh.length}`); pendingTrades=fresh; }
  }
});
function startAntiThrottleWorker() {
  try {
    const blob=new Blob([`setInterval(()=>{ self.postMessage('ping'); },10000);`],{type:'application/javascript'});
    const worker=new Worker(URL.createObjectURL(blob));
    worker.onmessage=()=>{ lastActivity=Date.now(); };
    L('Anti-throttle worker: ACTIVE');
  } catch(e) { W(`Anti-throttle worker: ${e.message}`); }
}

// ── BOOT ──────────────────────────────────────────────────────────────────────
clearEmergencyBanner();
badge('⏳ Starting...', '#6b7280');
lastActivity=Date.now();
loadSeenNotifs();
loadPendingTrades();
loadOpenAttempts(); // ★ v22.13: restore persisted retry counters
const bootState=getRiskState();
if (bootState.openPauseUntil&&Date.now()<bootState.openPauseUntil) {
  openPauseUntil=bootState.openPauseUntil;
  L(`Restored pause — ${Math.round((openPauseUntil-Date.now())/1000)}s remaining`);
}
try {
  const lastCloseTs=parseInt(localStorage.getItem(CLOSE_POSITION_TS_KEY)||'0',10);
  if (lastCloseTs&&Date.now()-lastCloseTs>CLOSE_POSITION_COOLDOWN_MS) { localStorage.removeItem(CLOSE_POSITION_TS_KEY); L('Boot: stale close TS cleared'); }
} catch {}
{ const positions=loadOpenMimicPositions(); L(`Boot: registry — ${positions.length}: ${positions.map(p=>`${p.symbol}/${p.direction}`).join(', ')||'none'}`); }

// v22.11: Start acc retry immediately on boot — don't wait for first scan tick
startAccRetry();

setTimeout(()=>{
  startWebLocksKeepalive();
  startAuthWatchdog();
  startAntiThrottleWorker();

  if (IS_WALLET) {
    setInterval(()=>{
      if (!onPage('/wallet')||isExec||walletScrollSweepActive) return;
      if (lastActionTime&&Date.now()-lastActionTime<POST_ACTION_COOL) return;
      const body=document.body.innerText||'';
      const hasClosePos=body.includes('Close Position'), hasTraderClosed=body.includes('Trader Closed');
      if (hasClosePos||hasTraderClosed) {
        urgentCloseSignalTs=Date.now();
        if (hasClosePos&&!menuOpen()) { if (checkClosePosition()) return; }
        return;
      }
      if (!isExec) {
        const copies=findVisibleCopyButtons();
        if (copies.length>0) {
          logAct('URGENT_COPY',`${copies.length} Copy visible`);
          lock('URGENT UPDATING');
          const groups=findTradeUpdateGroups();
          if (groups.length>0) processGroupQueue(groups,0);
          else processSingleCopy(0,copies.length+3,null,unlock);
        }
      }
    },URGENT_SCAN_INTERVAL_MS);
  }

  setTimeout(()=>{
    scan();
    setInterval(scan, SCAN_MS);
    startMutationWatcher();
    startWalletMutationWatcher();
    scheduleReload();

    L(`v${VERSION} booted: ${location.pathname}`);
    L(`Poll: ${SCAN_MS}ms | Reload: ${RELOAD_MIN_S}-${RELOAD_MAX_S}s | MaxAge: ${MAX_AGE_MINUTES}min | Leverage: ${MAX_ALLOWED_LEVERAGE}X`);
    L(`Size: CAP ${MAX_POSITION_PCT}% | Emergency: ${EMERGENCY_WALLET_LOSS_PCT}% + $${EMERGENCY_MAX_LOSS_USD} (BOTH required)`);
    L(`Commands: _status() | _forceAcc() | _pauseOpens(min) | _unpause() | _clearSeen() | _clearMimicRegistry() | _addMimicPosition(sym,dir,trader)`);
  },2200);
},1000);

})();
