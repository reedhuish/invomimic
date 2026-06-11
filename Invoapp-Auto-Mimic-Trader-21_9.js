// ==UserScript==
// @name         Invoapp Auto Mimic Trader
// @namespace    http://tampermonkey.net/
// @version      21.9
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

// ── POSITION SIZE ───────────────────────────────────────────────────────────
// null = CAP mode: scales to never exceed MAX_POSITION_PCT % of your wallet
// number = FIXED mode: always opens at exactly this % (e.g. 2.0 = always 2%)
const FORCE_POSITION_PCT        = null;
const MAX_POSITION_PCT          = 4.0;    // max % of wallet per trade (CAP mode)

// ── STOP LOSS ───────────────────────────────────────────────────────────────
// Automatically sets a stop-loss at STOP_LOSS_PCT% from entry after each open.
const MANAGE_STOP_LOSS          = true;
const STOP_LOSS_PCT             = 4.0;    // % away from entry price
const REQUIRE_SL_BEFORE_CONFIRM = false;  // true = skip trade if SL fails to set

// ── DOLLAR STOP-LOSS ────────────────────────────────────────────────────────
// Auto-close any trade whose dollar loss hits AUTO_CLOSE_USD_THRESHOLD.
// "Never lose more than $X on any single trade."
const ENABLE_DOLLAR_STOP_LOSS   = true;
const AUTO_CLOSE_USD_THRESHOLD  = 7.5;   // close any trade losing >= this amount ($)

// ── EMERGENCY ALERT ─────────────────────────────────────────────────────────
// Beep + red banner when a trade exceeds BOTH % AND $ thresholds.
// Set EMERGENCY_REQUIRES_BOTH = false if you want either alone to trigger.
const EMERGENCY_WALLET_LOSS_PCT = 8.0;   // % loss on a single trade
const EMERGENCY_MAX_LOSS_USD    = 10.0;  // $ loss on a single trade
const EMERGENCY_REQUIRES_BOTH   = true;  // true = BOTH must breach | false = EITHER
const ENABLE_AUDIO_ALERTS       = true;
const ENABLE_EMERGENCY_BANNER   = true;

// ── SYMBOL FILTERS ──────────────────────────────────────────────────────────
// SYMBOL_WHITELIST: only trade these. Empty [] = trade all.
// SYMBOL_BLACKLIST: never trade these. Empty [] = no blacklist.
// MAX_ALLOWED_LEVERAGE: skip any trade above this leverage.
const SYMBOL_WHITELIST          = [];     // e.g. ['BTC','ETH']
const SYMBOL_BLACKLIST          = [];     // e.g. ['DOGE','XRP']
const MAX_ALLOWED_LEVERAGE      = 20;

// ── RELOAD TIMING ──────────────────────────────────────────────────────────
// Both tabs reload every 15-45 seconds. DO NOT set above 60s — trades will be missed.
const RELOAD_MIN_S              = 15;
const RELOAD_MAX_S              = 45;

// ── NOTIFICATION AGE LIMIT ──────────────────────────────────────────────────
// Ignore notifications older than this many minutes. Do not set below 5.
const MAX_AGE_MINUTES           = 10;

// ── ADVANCED TIMING (do not change unless you know what you're doing) ───────
const SCAN_MS                   = 1500;
const MAX_EXEC_MS               = 90000;
const STALE_MS                  = 20 * 60000;
const CONFIRM_WAIT_MS           = 3500;
const OPEN_CONFIRM_MS           = 6500;
const WRONG_PAGE_MS             = 30000;
const POST_ACTION_COOL          = 5000;
const MODAL_SETTLE_MS           = 5500;
const OPEN_BUTTON_TIMEOUT_MS    = 22000;
const CONFIRM_BUTTON_TIMEOUT_MS = 30000;
const VERIFY_SL_ATTEMPTS        = 14;
const VERIFY_SL_INTERVAL_MS     = 500;
const VALUE_VERIFY_ATTEMPTS     = 8;
const VALUE_VERIFY_INTERVAL_MS  = 350;

// ── SESSION WATCHDOG ────────────────────────────────────────────────────────
// Detects expired sessions (HTTP 401) and reloads to re-authenticate.
const SESSION_WATCHDOG_ENABLED  = true;
const SESSION_RELOAD_WINDOW_MS  = 60000;
const SESSION_RELOAD_THRESHOLD  = 2;

// ════════════════════════════════════════════════════════════════════════════
// END OF USER SETTINGS
// ════════════════════════════════════════════════════════════════════════════

// Internal — not user-facing
const PAUSE_NEW_OPENS_AFTER_EMERGENCY       = false;
const RESUME_WALLET_UPDATES_AFTER_EMERGENCY = true;

// ── INTERNALS ───────────────────────────────────────────────────────────────
const NOTIFICATIONS_URL = 'https://app.invoapp.com/notifications';
const WALLET_URL        = 'https://app.invoapp.com/wallet';
const IS_WALLET         = window.location.href.includes('/wallet');
const HOME_URL          = IS_WALLET ? WALLET_URL : NOTIFICATIONS_URL;
const HOME_PATH         = IS_WALLET ? '/wallet' : '/notifications';
const SAFE_PATHS        = ['/notifications', '/wallet', '/post/', '/portfolio/'];
const VERSION           = '21.9';
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

function waitForGroupExpansion(group, onReady, onFail) {
  const EXPAND_POLL_MS = 300;
  const EXPAND_TIMEOUT_MS = 6000;
  const MAX_ATTEMPTS = 2;

  // v21.5: Check BEFORE clicking — if already expanded, don't collapse it
  const { copyCount: preCopy, copiedCount: preCopied } = countGroupCopyState(group.el);
  if (preCopy + preCopied > 0) {
    logAct(
      'ALREADY_EXPANDED',
      `${group.label}: already open — ${preCopy} Copy, ${preCopied} Copied — skipping click`
    );
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
      logAct(
        'GROUP_ROWS',
        `${group.label}: ${copyCount} Copy, ${copiedCount} Copied after expand`
      );
      onReady(copyCount);
      return;
    }
    elapsed += EXPAND_POLL_MS;
    if (elapsed >= EXPAND_TIMEOUT_MS) {
      if (attempt < MAX_ATTEMPTS) {
        logAct('EXPAND_RETRY', `${group.label}: no rows visible, retrying expand`);
        tryExpand();
      } else {
        W(`waitForGroupExpansion: timeout for "${group.label}"`);
        onFail?.();
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


const pendingCopyCount = findVisibleCopyButtons().length;

// If there is any Copy button, always process; better to double‑click than skip
if (pendingCopyCount > 0) {
  lock('UPDATING');
  logAct(
    'UPDATING',
    `${groups.length} group(s): ${groups.map(g => g.label).join(', ')} | ${pendingCopyCount} Copy pending`
  );
  processGroupQueue(groups, 0);
  return true;
}

// Only use compositeKey when there are zero Copy buttons (pure bookkeeping)
const compositeKey =
  'wallet-groups::' +
  groups.map(g => g.label).sort().join('|') +
  '::copies=0';

if (seenWallet.has(compositeKey)) return false;

seenWallet.add(compositeKey);
setTimeout(() => seenWallet.delete(compositeKey), 20000);

function handleWalletTradeUpdates() {
  const groups = findTradeUpdateGroups();
  if (!groups.length) return false;

  groups.sort((a, b) => b.count - a.count);

  const pendingCopyCount = findVisibleCopyButtons().length;

  // If there is any Copy button, always process; better to double-click than skip
  if (pendingCopyCount > 0) {
    lock('UPDATING');
    logAct(
      'UPDATING',
      `${groups.length} group(s): ${groups.map(g => g.label).join(', ')} | ${pendingCopyCount} Copy pending`
    );
    processGroupQueue(groups, 0);
    return true;
  }

  // Only use compositeKey when there are zero Copy buttons (pure bookkeeping)
  const compositeKey =
    'wallet-groups::' +
    groups.map(g => g.label).sort().join('|') +
    '::copies=0';

  if (seenWallet.has(compositeKey)) return false;

  seenWallet.add(compositeKey);
  setTimeout(() => seenWallet.delete(compositeKey), 20000);

  lock('UPDATING');
  logAct(
    'UPDATING',
    `${groups.length} group(s): ${groups.map(g => g.label).join(', ')} | ${pendingCopyCount} Copy pending`
  );
  processGroupQueue(groups, 0);
  return true;
}

  lock('UPDATING');
  logAct('UPDATING', `${groups.length} group(s): ${groups.map(g => g.label).join(', ')} | ${pendingCopyCount} Copy pending`);
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
    L(`★ Reload: ${RELOAD_MIN_S}-${RELOAD_MAX_S}s | MAX_AGE: ${MAX_AGE_MINUTES}min | Seen: ${seenNotifs.size} | Pending: ${pendingTrades.length}`);
    L(`★ Size: ${FORCE_POSITION_PCT !== null ? `FIXED ${FORCE_POSITION_PCT}%` : `CAP ${MAX_POSITION_PCT}%`} | SL: ${MANAGE_STOP_LOSS ? `${STOP_LOSS_PCT}%` : 'off'} | Dollar stop: ${ENABLE_DOLLAR_STOP_LOSS ? `$${AUTO_CLOSE_USD_THRESHOLD}` : 'off'}`);
    L(`★ Emergency: ${EMERGENCY_REQUIRES_BOTH ? 'BOTH' : 'EITHER'} ${EMERGENCY_WALLET_LOSS_PCT}% + $${EMERGENCY_MAX_LOSS_USD} | Leverage max: ${MAX_ALLOWED_LEVERAGE}X`);
    L(`★ Trade Updates: composite key includes Copy count — close rows never skipped (v21.8)`);
    L(`★ Auth watchdog: ${SESSION_WATCHDOG_ENABLED ? `ACTIVE (${SESSION_RELOAD_THRESHOLD} consecutive 401s)` : 'DISABLED'} | Web Locks: ACTIVE`);
    L(`★ window._clearSeen() to reset seen keys | window._status() for full state`);
  }, 2200);
}, 1000);

})();