// ==UserScript==
// @name         Invoapp Auto Mimic Trader
// @namespace    http://tampermonkey.net/
// @version      22.5
// @description  Auto-mimics trades on app.invoapp.com via Tampermonkey. Two-tab setup: notifications tab opens trades, wallet tab closes/updates.
// @author       Reed Huish reed@zpower.com
// @match        https://app.invoapp.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
'use strict';

// ════════════════════════════════════════════════════════════════════════════
// ★★★  USER SETTINGS — EDIT ONLY THIS SECTION  ★★★
// ════════════════════════════════════════════════════════════════════════════

const FORCE_POSITION_PCT        = null;   // null = CAP mode, number = FIXED % (e.g. 2.0)
const MAX_POSITION_PCT          = 4.0;    // max % of wallet per trade (CAP mode)

const MANAGE_STOP_LOSS          = true;
const STOP_LOSS_PCT             = 4.0;    // % away from entry price
const REQUIRE_SL_BEFORE_CONFIRM = false;  // true = skip trade if SL fails to set

const ENABLE_DOLLAR_STOP_LOSS   = true;
const AUTO_CLOSE_USD_THRESHOLD  = 7.5;   // auto-close any trade losing >= this ($)

const EMERGENCY_WALLET_LOSS_PCT = 8.0;
const EMERGENCY_MAX_LOSS_USD    = 10.0;
const EMERGENCY_REQUIRES_BOTH   = true;  // true = BOTH must breach, false = EITHER
const ENABLE_AUDIO_ALERTS       = true;
const ENABLE_EMERGENCY_BANNER   = true;

const SYMBOL_WHITELIST          = [];     // e.g. ['BTC','ETH'] — empty = trade all
const SYMBOL_BLACKLIST          = [];     // e.g. ['DOGE','XRP'] — empty = no blacklist
const MAX_ALLOWED_LEVERAGE      = 20;

const RELOAD_MIN_S              = 15;
const RELOAD_MAX_S              = 45;
const MAX_AGE_MINUTES           = 10;

// ── ADVANCED TIMING ─────────────────────────────────────────────────────────
const SCAN_MS                   = 1500;
const MAX_EXEC_MS               = 90000;
const STALE_MS                  = 8 * 60000;
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
const CLOSE_POSITION_COOLDOWN_MS = 12000;

const WALLET_SCROLL_STEPS       = 3;
const WALLET_SCROLL_PAUSE_MS    = 400;
const WALLET_SCROLL_MAX_POS     = 35;

const SESSION_WATCHDOG_ENABLED  = true;
const SESSION_RELOAD_WINDOW_MS  = 60000;
const SESSION_RELOAD_THRESHOLD  = 2;

// ════════════════════════════════════════════════════════════════════════════
// END OF USER SETTINGS
// ════════════════════════════════════════════════════════════════════════════

const NOTIFICATIONS_URL = 'https://app.invoapp.com/notifications';
const WALLET_URL        = 'https://app.invoapp.com/wallet';
const IS_WALLET         = window.location.href.includes('/wallet');
const HOME_URL          = IS_WALLET ? WALLET_URL : NOTIFICATIONS_URL;
const HOME_PATH         = IS_WALLET ? '/wallet' : '/notifications';
const SAFE_PATHS        = ['/notifications', '/wallet', '/post/', '/portfolio/'];
const VERSION           = '22.5';
const OPEN_PHRASE_RE    = /opened (?:a )?new (?:trade|position)|opened a trade/i;

const RISK_STATE_KEY        = '__AM_V22_RISK_STATE__';
const SEEN_NOTIFS_KEY       = '__AM_V22_SEEN_NOTIFS__';
const PENDING_TRADES_KEY    = '__AM_V22_PENDING_TRADES__';
const EMERGENCY_BEEP_KEY    = '__AM_V22_EMERGENCY_BEEPED__';
const CLOSE_POSITION_TS_KEY = '__AM_V22_LAST_CLOSE_TS__';

// Broad DOM selectors used repeatedly — defined once, reused everywhere
const SEL_SEMANTIC  = 'flt-semantics,flt-semantics-container';
const SEL_CLICKABLE = `${SEL_SEMANTIC},[role="button"],button,div,span,a`;
const SEL_COPYBTN   = `${SEL_SEMANTIC},div,span,button`;

let walletScrollSweepActive = false;
let isExec        = false;
let execStart     = 0;
let lastActivity  = Date.now();
let lastActionTime = 0;
let wrongSince    = null;
let pendingTrades = [];
let accOn         = false;
let emergencyMode = false;
let openPauseUntil = 0;
const actLog = [];

const L = msg => console.log(`[v${VERSION}] ${msg}`);
const W = msg => console.warn(`[v${VERSION}] ${msg}`);

let seenNotifs = new Set();
let seenWallet = new Set();

// ── BODY CACHE ─────────────────────────────────────────────────────────────
// body.innerText on a Flutter page with thousands of flt-semantics nodes
// forces a full DOM serialization + layout flush every call. We cache it
// once per scan tick and pass it through the call chain rather than
// re-reading it in every helper function.
let _bodyCache = '';
let _bodyCacheTs = 0;
const BODY_CACHE_TTL = 200; // ms — stale after 200ms (within a single scan tick)

function getBody() {
  const now = Date.now();
  if (now - _bodyCacheTs > BODY_CACHE_TTL) {
    _bodyCache = document.body.innerText || '';
    _bodyCacheTs = now;
  }
  return _bodyCache;
}

// Call this at the start of each scan tick to ensure helpers within
// the same tick all read the same snapshot.
function refreshBody() {
  _bodyCache = document.body.innerText || '';
  _bodyCacheTs = Date.now();
  return _bodyCache;
}

// ── STORAGE ────────────────────────────────────────────────────────────────
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
    if (raw) { seenNotifs = new Set(JSON.parse(raw)); L(`Restored ${seenNotifs.size} seen notification keys`); }
  } catch {}
}

function savePendingTrades() {
  try {
    localStorage.setItem(PENDING_TRADES_KEY, JSON.stringify(
      pendingTrades.map(t => ({ key: t.key, label: t.label, savedAt: t.savedAt || Date.now() }))
    ));
  } catch {}
}

function loadPendingTrades() {
  try {
    const raw = localStorage.getItem(PENDING_TRADES_KEY);
    if (!raw) return;
    localStorage.removeItem(PENDING_TRADES_KEY);
    let restored = 0;
    for (const entry of JSON.parse(raw)) {
      const ageMinsVal = (Date.now() - (entry.savedAt || 0)) / 60000;
      if (ageMinsVal > MAX_AGE_MINUTES) continue;
      if (!pendingTrades.some(p => p.key === entry.key)) {
        pendingTrades.push({ key: entry.key, label: entry.label, age: ageMinsVal, el: null, savedAt: entry.savedAt });
        restored++;
      }
    }
    if (restored > 0) { L(`Restored ${restored} pending trade(s)`); logAct('PENDING_RESTORED', `${restored} re-queued`); }
  } catch {}
}

function logAct(type, detail) {
  actLog.push({ t: new Date().toLocaleTimeString(), type, detail });
  if (actLog.length > 500) actLog.shift();
}

function getRiskState() {
  try { return JSON.parse(localStorage.getItem(RISK_STATE_KEY) || '{}'); } catch { return {}; }
}
function setRiskState(patch) {
  try { localStorage.setItem(RISK_STATE_KEY, JSON.stringify({ ...getRiskState(), ...patch, ts: Date.now() })); } catch {}
}

// ── CONSOLE HELPERS ────────────────────────────────────────────────────────
window._status = () => {
  console.log(`\n=== v${VERSION} ${IS_WALLET ? 'WALLET' : 'NOTIFICATIONS'} ===`);
  console.log(`State: ${isExec ? 'EXECUTING' : 'WATCHING'} | Queue: ${pendingTrades.length} | Seen: ${seenNotifs.size}`);
  console.log(`Size: ${FORCE_POSITION_PCT !== null ? `FIXED ${FORCE_POSITION_PCT}%` : `CAP ${MAX_POSITION_PCT}%`}`);
  console.log(`Stop loss: ${MANAGE_STOP_LOSS ? `${STOP_LOSS_PCT}% | require verify=${REQUIRE_SL_BEFORE_CONFIRM}` : 'manual'}`);
  console.log(`Dollar stop-loss: ${ENABLE_DOLLAR_STOP_LOSS ? `ACTIVE — auto-close >= $${AUTO_CLOSE_USD_THRESHOLD}` : 'DISABLED'}`);
  console.log(`Open pause active: ${opensPaused()} | Emergency mode: ${emergencyMode}`);
  console.log(`Commands: window._pauseOpens(minutes) | window._unpause() | window._clearSeen()`);
  console.log(`Activity (${actLog.length} events):`);
  actLog.slice(-80).forEach(e => console.log(`  [${e.t}] ${e.type}: ${e.detail}`));
  console.log('===================\n');
  return actLog;
};
window._unpause = () => {
  openPauseUntil = 0; setRiskState({ openPauseUntil: 0 });
  clearEmergencyBanner(); badge('🟢 Active'); L('Open pause cleared manually');
};
window._pauseOpens = (minutes = 30, reason = 'manual pause') => setOpenPause(minutes * 60000, reason);
window._clearSeen  = () => { seenNotifs = new Set(); saveSeenNotifs(); L('seenNotifs cleared'); };

// ── BADGE ──────────────────────────────────────────────────────────────────
function badge(text, color = '#16a34a') {
  let b = document.getElementById('am-badge');
  if (!b) {
    b = document.createElement('div');
    b.id = 'am-badge';
    b.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:99999;color:white;font-size:12px;font-weight:bold;padding:6px 12px;border-radius:20px;box-shadow:0 2px 8px rgba(0,0,0,0.35);font-family:sans-serif;cursor:pointer;user-select:none;';
    b.title = 'Click for log | window._status() | window._pauseOpens(min) | window._unpause()';
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
  el.textContent = `⚠️ INVO LOSS ALERT: ${message} | Watching — trader may close at profit`;
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
      o.type = 'square'; o.frequency.value = i % 2 ? 660 : 880;
      g.gain.setValueAtTime(0.001, t);
      g.gain.exponentialRampToValueAtTime(0.12, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
      o.connect(g); g.connect(ctx.destination);
      o.start(t); o.stop(t + 0.24); t += 0.28;
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
  return !isExec && !(lastActionTime && Date.now() - lastActionTime < POST_ACTION_COOL);
}

// ── LOCK / UNLOCK ──────────────────────────────────────────────────────────
function lock(label) {
  isExec = true; execStart = Date.now(); wrongSince = null; lastActivity = Date.now();
  badge(`⚡ ${label}`, '#b45309'); L(`lock: ${label}`);
}

function unlock() {
  isExec = false; execStart = 0; lastActionTime = Date.now();
  badge('🟢 Active'); L('unlocked');
  if (!onPage(HOME_PATH)) { window.location.href = HOME_URL; return; }
  if (pendingTrades.length > 0 && onPage('/notifications') && !opensPaused()) setTimeout(scanNotifs, 800);
}

function closeDone() {
  isExec = false; execStart = 0; seenWallet = new Set(); lastActionTime = Date.now();
  badge('🟢 Active'); clearEmergencyBanner();
  try { localStorage.removeItem(CLOSE_POSITION_TS_KEY); } catch {}
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

function textOf(el) { return (el?.innerText || el?.textContent || el?.value || '').trim(); }
function ariaOf(el) { return (el?.getAttribute?.('aria-label') || '').trim(); }

// Fast-gate: check body string before entering expensive DOM iteration.
// If the text isn't in the page at all, skip the loop entirely.
function findByText(text, body) {
  if (body !== undefined && !body.includes(text)) return null;
  const lo = text.toLowerCase();
  let best = null, bestArea = Infinity;
  for (const el of document.querySelectorAll(SEL_CLICKABLE)) {
    if (textOf(el).toLowerCase() !== lo || !visible(el)) continue;
    const r = el.getBoundingClientRect();
    const area = r.width * r.height;
    if (area < bestArea) { bestArea = area; best = el; }
  }
  return best;
}

function findContaining(phrase, body) {
  if (body !== undefined && !body.includes(phrase)) return null;
  const lo = phrase.toLowerCase();
  let best = null, bestArea = Infinity;
  for (const el of document.querySelectorAll(SEL_CLICKABLE)) {
    const t = textOf(el).toLowerCase();
    if (!t.includes(lo) || t.length > 450 || !visible(el)) continue;
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
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
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
  L(`clicked: "${(textOf(el) || ariaOf(el) || '(no text)').substring(0, 60)}"`);
  return true;
}

// ── WAIT HELPERS ───────────────────────────────────────────────────────────
function waitForPredicate(fn, onSuccess, timeout = 12000, interval = 300, onTimeout = null) {
  const start = Date.now();
  const iv = setInterval(() => {
    let result = null;
    try { result = fn(); } catch {}
    if (result) { clearInterval(iv); onSuccess(result); }
    else if (Date.now() - start > timeout) { clearInterval(iv); (onTimeout || unlock)(); }
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

function menuOpen(body) {
  const b = body || getBody();
  return b.includes('Share Trade') && b.includes('Close Trade');
}

function checkModals(body) {
  const b = body || getBody();
  if (b.includes('Not Enough Funds')) {
    logAct('BLOCKED', 'Not Enough Funds');
    const btn = findByText('Go Back', b) || findByText('Close', b) || findContaining('Go Back', b);
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
  const v = parseInt(m[1], 10), u = m[2].toLowerCase();
  return u === 's' ? v / 60 : u === 'm' ? v : u === 'h' ? v * 60 : v * 1440;
}

function stableKey(label) {
  const prefix = label.substring(0, 20).toLowerCase().replace(/\s+/g, '_');
  const stripped = label
    .replace(/[·•‧･∙⋅\-–|]\s*\d+\s*(s|m|h|d)\b/gi, '')
    .replace(/\b\d+\s*(s|m|h|d)\s*ago\b/gi, '')
    .replace(/\s+/g, ' ').trim().toLowerCase();
  return `${prefix}::${stripped}`;
}

function findClickableParent(el) {
  let cur = el;
  for (let i = 0; i < 8; i++) {
    if (!cur?.parentElement) break;
    cur = cur.parentElement;
    const role = cur.getAttribute?.('role') || '', tag = (cur.tagName || '').toLowerCase();
    if (role === 'button' || role === 'link' || tag === 'button' || tag === 'a') return cur;
    const r = cur.getBoundingClientRect();
    if (r.width > 200 && r.height > 40) return cur;
  }
  return el;
}

// ── READ HELPERS (all accept pre-read body string) ─────────────────────────
function readTraderPositionPct(body) {
  const m = (body || getBody()).match(/Position Size\s*\((\d+(?:\.\d+)?)%\)/i);
  return m ? parseFloat(m[1]) : null;
}

function readWalletTotal(body) {
  const m = (body || getBody()).match(/\$[\d.]+\s*\/\s*\$([\d,]+\.?\d*)/);
  return m ? parseFloat(m[1].replace(/,/g, '')) : null;
}

function readCurrentPrice(body) {
  const m = (body || getBody()).match(/Current\s*Price\s*[:\s]+\$([\d,]+\.?\d*)/i);
  return m ? parseFloat(m[1].replace(/,/g, '')) : null;
}

function readTradeDirection(body) {
  const b = body || getBody();
  const dirMatch = b.match(/\b\d+\s*[Xx]\s*(Long|Short)\b/);
  if (dirMatch) return dirMatch[1].toLowerCase();
  if (/\bshort\b/i.test(b)) return 'short';
  if (/\blong\b/i.test(b)) return 'long';
  return null;
}

function inferCurrentSymbol(body) {
  const m = (body || getBody()).match(/\b([A-Z]{2,10})\s+\d+\s*[Xx]\s+(Long|Short)\b/);
  return m ? m[1] : null;
}

function inferLeverageFromBody(body) {
  const m = (body || getBody()).match(/\b(\d+)\s*[Xx]\s*(Long|Short)\b/);
  return m ? parseInt(m[1], 10) : null;
}

function computeStopLossPrice(currentPrice, direction) {
  const p = direction === 'short'
    ? currentPrice * (1 + STOP_LOSS_PCT / 100)
    : currentPrice * (1 - STOP_LOSS_PCT / 100);
  const decimals = p < 0.1 ? 6 : p < 1 ? 5 : p < 10 ? 4 : 2;
  return p.toFixed(decimals);
}

function readLossPctFromWalletBody(body) {
  const matches = [...(body || getBody()).matchAll(/\((-?\d+(?:\.\d+)?)%\)/g)].map(m => parseFloat(m[1]));
  const negs = matches.filter(v => !isNaN(v) && v < 0);
  return negs.length ? Math.min(...negs) : null;
}

function extractWorstLossUsd(body) {
  const vals = [...(body || getBody()).matchAll(/-\$([\d,]+(?:\.\d+)?)/g)]
    .map(m => parseFloat(m[1].replace(/,/g, ''))).filter(v => !isNaN(v));
  return vals.length ? Math.max(...vals) : null;
}

function findWorstTradeCard(body) {
  const b = body || getBody();
  const re = /\b([A-Z]{2,10})\s+\d+\s*[Xx]\s+(Long|Short)[\s\S]{0,220}?-\$([\d,]+(?:\.\d+)?)[\s\S]{0,120}?\((-?\d+(?:\.\d+)?)%\)/gi;
  let m, best = null;
  while ((m = re.exec(b)) !== null) {
    const usd = parseFloat(String(m[3]).replace(/,/g, ''));
    if (isNaN(usd)) continue;
    if (!best || usd > best.usd) best = { symbol: m[1], direction: m[2], usd, pct: parseFloat(m[4]) };
  }
  if (!best) return null;
  best.el = findContaining(best.symbol, b) || findContaining(`${best.symbol} `, b);
  return best;
}

// ── FIND MIMIC TRADE BUTTON ─────────────────────────────────────────────────
function findMimicButton() {
  // Single loop — check exact text, containing text, aria-label, all in one pass
  let exactMatch = null, containsMatch = null, ariaMatch = null;
  for (const el of document.querySelectorAll(`${SEL_CLICKABLE},[aria-label]`)) {
    if (!visible(el)) continue;
    const t = textOf(el), tlo = t.toLowerCase();
    const a = ariaOf(el).toLowerCase();
    if (tlo === 'mimic trade' || tlo === 'mimic') { exactMatch = el; break; }
    if (!containsMatch && (tlo.includes('mimic trade') && t.length < 80)) containsMatch = el;
    if (!ariaMatch && a.includes('mimic')) ariaMatch = el;
  }
  return exactMatch || containsMatch || ariaMatch;
}

// ── INPUT HELPERS ──────────────────────────────────────────────────────────
function findPositionSizeInput() {
  for (const el of document.querySelectorAll(`[role="textbox"],[role="spinbutton"],input[type="number"],input[type="text"],${SEL_SEMANTIC}[contenteditable="true"]`)) {
    if (visible(el)) return el;
  }
  const lbl = findContaining('Position Size');
  if (lbl) {
    const r = lbl.getBoundingClientRect();
    for (const el of document.querySelectorAll(`${SEL_SEMANTIC},div,span,input`)) {
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
    for (const el of document.querySelectorAll(`[role="textbox"],[role="spinbutton"],input,${SEL_SEMANTIC}[contenteditable="true"],div,span`)) {
      if (!visible(el)) continue;
      const er = el.getBoundingClientRect(), t = textOf(el);
      if (er.top > r.top - 10 && er.top < r.bottom + 160 && er.width > 30 && /^[\$\d\-.]/.test(t) && t !== textOf(lbl)) return el;
    }
  }
  const inputs = [...document.querySelectorAll(`[role="textbox"],[role="spinbutton"],input[type="number"],input[type="text"],${SEL_SEMANTIC}[contenteditable="true"]`)].filter(visible);
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
  const want = String(expected).replace(/[$,\s]/g, '');
  if (textOf(el).replace(/[$,\s]/g, '').includes(want) || String(el?.value || '').replace(/[$,\s]/g, '').includes(want)) { done(true); return; }
  if (attempt >= VALUE_VERIFY_ATTEMPTS) { done(false); return; }
  setTimeout(() => verifyElementContainsValue(el, expected, done, attempt + 1), VALUE_VERIFY_INTERVAL_MS);
}

function verifyStopLossVisible(expectedStr, done, attempt = 0) {
  const body = getBody();
  const norm = expectedStr.replace(/\.?0+$/, '');
  const ok = (body.includes('Stop-Loss') || body.includes('Stop Loss'))
    && (body.includes(expectedStr) || body.includes(norm));
  if (ok) { done(true); return; }
  if (attempt >= VERIFY_SL_ATTEMPTS) { done(false); return; }
  setTimeout(() => verifyStopLossVisible(expectedStr, done, attempt + 1), VERIFY_SL_INTERVAL_MS);
}

// ── POSITION SIZE ──────────────────────────────────────────────────────────
function setPositionSize(callback) {
  badge('⚡ CHECK SIZE', '#7c3aed');
  let attempts = 0;
  const trySet = () => {
    if (++attempts > 24) { logAct('SIZE_WARN', 'Field not found — proceeding'); callback?.(false, null); return; }
    const body = refreshBody();
    const total = readWalletTotal(body);
    if (!total || total < 1) { setTimeout(trySet, 300); return; }
    const traderPct = readTraderPositionPct(body);
    const finalPct = FORCE_POSITION_PCT !== null ? FORCE_POSITION_PCT
      : (traderPct !== null && traderPct <= MAX_POSITION_PCT) ? traderPct : MAX_POSITION_PCT;
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
    if (++attempts > 28) { logAct('SL_WARN', 'SL field not found — proceeding'); callback?.(false, null); return; }
    const body = refreshBody();
    const currentPrice = readCurrentPrice(body);
    const direction = readTradeDirection(body);
    if (!currentPrice || !direction) { setTimeout(trySet, 350); return; }
    const slStr = computeStopLossPrice(currentPrice, direction);
    const toggleIsOff = body.includes('Stop-Loss Price') && /Stop-Loss Price[\s\S]{0,50}-?\$?0\b/.test(body);
    if (toggleIsOff) {
      const slToggle = findByText('Stop-Loss', body) || findContaining('Stop-Loss', body);
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
        callback?.(ok, { direction, currentPrice, slStr });
      });
    });
  };
  setTimeout(trySet, 400);
}

// ── RISK BLOCK ─────────────────────────────────────────────────────────────
function shouldBlockOpenFromCurrentView(body) {
  const b = body || getBody();
  const symbol = inferCurrentSymbol(b);
  const lev = inferLeverageFromBody(b);
  if (symbol && !symbolAllowed(symbol)) return `Symbol ${symbol} blocked`;
  if (lev && MAX_ALLOWED_LEVERAGE && lev > MAX_ALLOWED_LEVERAGE) return `Leverage ${lev}X exceeds max ${MAX_ALLOWED_LEVERAGE}X`;
  return null;
}

function abortForWalletEmergency(reason) {
  emergencyMode = true;
  logAct('EMERGENCY', reason);
  showEmergencyBanner(reason);
  if (!localStorage.getItem(EMERGENCY_BEEP_KEY)) {
    playAlert(1);
    try { localStorage.setItem(EMERGENCY_BEEP_KEY, String(Date.now())); } catch {}
    logAct('EMERGENCY_BEEP', 'Alert fired');
  } else {
    logAct('EMERGENCY_SILENT', 'Already alerted');
  }
  badge('🚨 LOSS ALERT (watching)', '#991b1b');
}

// ════════════════════════════════════════════════════════════════════════════
// TAB 1 — /notifications
// ════════════════════════════════════════════════════════════════════════════
function scanNotifs() {
  if (!onPage('/notifications')) return;
  if (opensPaused()) {
    const st = getRiskState();
    badge(`⏸ OPEN PAUSED ${Math.round((Math.max(openPauseUntil || 0, st.openPauseUntil || 0) - Date.now()) / 1000)}s`, '#991b1b');
    return;
  }

  const freshTrades = [];
  const seenKeys = new Set();

  // Single pass over all aria-label and semantic elements at once
  const allEls = [
    ...document.querySelectorAll('[aria-label]'),
    ...document.querySelectorAll(SEL_SEMANTIC),
  ];

  for (const el of allEls) {
    const label = ariaOf(el) || textOf(el);
    if (!label || label.length < 5 || label.length > 600 || !OPEN_PHRASE_RE.test(label)) continue;
    const key = stableKey(label);
    if (seenKeys.has(key) || seenNotifs.has(key)) continue;
    seenKeys.add(key);
    const age = ageMins(label);
    if (age > MAX_AGE_MINUTES) {
      seenNotifs.add(key); saveSeenNotifs();
      if (age < 30) logAct('STALE', `${age.toFixed(1)}m: ${label.substring(0, 60)}`);
      continue;
    }
    freshTrades.push({ el: findClickableParent(el), label, key, age });
  }

  if (!freshTrades.length) return;
  freshTrades.sort((a, b) => a.age - b.age);

  if (isExec) {
    freshTrades.forEach(t => {
      if (!pendingTrades.some(p => p.key === t.key)) { t.savedAt = Date.now(); pendingTrades.push(t); logAct('QUEUED', t.label.substring(0, 60)); }
    });
    savePendingTrades();
    return;
  }

  freshTrades.forEach(t => seenNotifs.add(t.key));
  saveSeenNotifs();

  const target = pendingTrades.length > 0 ? pendingTrades.shift() : freshTrades[0];
  if (!target.el) {
    const found = [...document.querySelectorAll('[aria-label]')].find(el => stableKey(ariaOf(el)) === target.key);
    target.el = found ? findClickableParent(found) : null;
    if (!target.el) { W(`Cannot re-find "${target.label?.substring(0, 50)}" — skipping`); savePendingTrades(); setTimeout(scanNotifs, 800); return; }
  }
  seenNotifs.add(target.key); saveSeenNotifs();
  L(`🚨 FRESH (${target.age.toFixed(1)}m): ${target.label.substring(0, 80)}`);
  logAct('OPENING', target.label.substring(0, 80));
  lock('OPENING'); click(target.el); setTimeout(doOpen, 1700);
  if (seenNotifs.size > 1000) { seenNotifs = new Set([...seenNotifs].slice(-500)); saveSeenNotifs(); }
}

// ── doOpen ─────────────────────────────────────────────────────────────────
function doOpen() {
  const body = refreshBody();
  const preBlock = shouldBlockOpenFromCurrentView(body);
  if (preBlock) { W(`Risk block: ${preBlock}`); logAct('RISK_SKIP', preBlock); badge('⏭ SKIPPED', '#b45309'); unlock(); return; }

  waitForPredicate(
    () => findMimicButton(),
    (mimicBtn) => {
      click(mimicBtn);
      setTimeout(() => {
        setPositionSize((sizeOK) => {
          if (!sizeOK) logAct('SIZE_WARN', 'Proceeding without verified size');
          setTimeout(() => {
            setStopLoss((slOK, slCtx) => {
              if (MANAGE_STOP_LOSS && REQUIRE_SL_BEFORE_CONFIRM && !slOK) {
                W('SL not verified — skipping'); logAct('SL_SKIP', 'SL required but not verified');
                badge('⏭ SL SKIP', '#b45309'); unlock(); return;
              }
              setTimeout(() => {
                waitForEl(['Confirm Position', 'Confirm'], () => {
                  lastActionTime = Date.now();
                  logAct('SUCCESS', `Trade opened ${inferCurrentSymbol(refreshBody()) || ''} ${new Date().toLocaleTimeString()}`);
                  setRiskState({ needWalletVerify: MANAGE_STOP_LOSS, expectedStopLoss: slCtx?.slStr || null });
                  setTimeout(unlock, OPEN_CONFIRM_MS);
                }, CONFIRM_BUTTON_TIMEOUT_MS);
              }, 1000);
            });
          }, 1400);
        });
      }, MODAL_SETTLE_MS);
    },
    OPEN_BUTTON_TIMEOUT_MS, 300,
    () => { W('Mimic Trade not found — skipping'); logAct('SKIP', 'Mimic Trade not found'); badge('⏭ NO MIMIC BTN', '#b45309'); unlock(); }
  );
}

// ════════════════════════════════════════════════════════════════════════════
// TAB 2 — /wallet
// ════════════════════════════════════════════════════════════════════════════
function verifyPostOpenRiskIfNeeded(body) {
  const st = getRiskState();
  if (!st.needWalletVerify) return;
  if (Date.now() - (st.ts || 0) > 5 * 60 * 1000) { setRiskState({ needWalletVerify: false }); logAct('WALLET_VERIFY', 'Flag stale — cleared'); return; }
  const expected = st.expectedStopLoss;
  const b = body || getBody();
  if (expected && b.includes(expected)) {
    logAct('WALLET_VERIFY', `SL ${expected} confirmed`); setRiskState({ needWalletVerify: false, walletVerifiedAt: Date.now() }); clearEmergencyBanner(); return;
  }
  const lossPct = readLossPctFromWalletBody(b);
  const lossUsd = extractWorstLossUsd(b);
  if ((lossPct !== null && Math.abs(lossPct) >= STOP_LOSS_PCT + 1.5) || (lossUsd !== null && lossUsd >= EMERGENCY_MAX_LOSS_USD)) {
    setRiskState({ needWalletVerify: false });
    attemptEmergencyClose(`SL not confirmed, loss=${lossPct ?? '?'}% / -$${lossUsd ?? '?'}`, b);
  }
}

function attemptEmergencyClose(reason, body) {
  if (isExec) return;
  abortForWalletEmergency(reason);
  const b = body || getBody();
  const directBtn = findByText('Close Position', b) || findContaining('Close Position', b);
  if (directBtn && !menuOpen(b)) { lock('EMERGENCY CLOSE'); click(directBtn); setTimeout(doCloseConfirm, 1800); return; }
  const worst = findWorstTradeCard(b);
  if (worst?.el) {
    click(worst.el);
    logAct('EMERGENCY', `Worst: ${worst.symbol} -$${worst.usd} ${worst.pct}%`);
    setTimeout(() => {
      const body2 = refreshBody();
      const btn = findByText('Close Position', body2) || findContaining('Close Position', body2);
      if (btn) { lock('EMERGENCY CLOSE'); click(btn); setTimeout(doCloseConfirm, 1800); }
      else unlock();
    }, 1400);
    return;
  }
  setTimeout(() => unlock(), 2000);
}

function doCloseConfirm(attempt = 0) {
  if (attempt > 28) { W('Close confirm not found'); unlock(); return; }
  const body = refreshBody();
  const modal = body.includes('Exit Price') || body.includes('Position Size:') || body.includes('Confirm');
  const btn = findByText('Confirm', body) || findByText('Confirm Position', body);
  if (btn && modal) {
    click(btn); lastActionTime = Date.now();
    logAct('CLOSED', `Position closed ${new Date().toLocaleTimeString()}`);
    clearEmergencyBanner(); setTimeout(() => closeDone(), CONFIRM_WAIT_MS);
  } else {
    setTimeout(() => doCloseConfirm(attempt + 1), 600);
  }
}

// ── TRADE UPDATES — single-pass scan ──────────────────────────────────────
// One QSA pass collects Trade Update group headers AND Copy/Copied buttons
// simultaneously, rather than three separate passes.
function scanWalletElements() {
  const GROUP_RE = /^Trade Updates?\s*\((\d+)\)$/i;
  const groupCandidates = [], copyEls = [], copiedEls = [];

  for (const el of document.querySelectorAll(SEL_COPYBTN)) {
    if (!visible(el)) continue;
    const t = textOf(el);
    if (t === 'Copy') { copyEls.push(el); continue; }
    if (t === 'Copied') { copiedEls.push(el); continue; }
    const m = t.match(GROUP_RE);
    if (m) {
      const count = parseInt(m[1], 10);
      if (count >= 1) groupCandidates.push({ label: t, count, el, r: el.getBoundingClientRect() });
    }
  }

  // Deduplicate overlapping group nodes — keep smallest area
  const groups = [];
  for (const c of groupCandidates) {
    let dup = false;
    for (const k of groups) {
      const ox = Math.max(0, Math.min(c.r.right, k.r.right) - Math.max(c.r.left, k.r.left));
      const oy = Math.max(0, Math.min(c.r.bottom, k.r.bottom) - Math.max(c.r.top, k.r.top));
      if (ox * oy > 0.7 * Math.min(c.r.width * c.r.height, k.r.width * k.r.height)) {
        if (c.r.width * c.r.height < k.r.width * k.r.height) groups.splice(groups.indexOf(k), 1, c);
        dup = true; break;
      }
    }
    if (!dup) groups.push(c);
  }
  groups.sort((a, b) => a.r.top - b.r.top);

  return { groups, copyEls, copiedEls };
}

function countGroupCopyState(groupEl, copyEls, copiedEls, windowPx = 400) {
  if (!groupEl) return { copyCount: copyEls.length, copiedCount: copiedEls.length };
  const headerBottom = groupEl.getBoundingClientRect().bottom;
  const scanBottom = headerBottom + windowPx;
  let copyCount = 0, copiedCount = 0;
  for (const el of copyEls) { const r = el.getBoundingClientRect(); if (r.top >= headerBottom - 10 && r.top <= scanBottom) copyCount++; }
  for (const el of copiedEls) { const r = el.getBoundingClientRect(); if (r.top >= headerBottom - 10 && r.top <= scanBottom) copiedCount++; }
  return { copyCount, copiedCount };
}

function waitForGroupExpansion(group, onReady, onFail) {
  const POLL_MS = 300, TIMEOUT_MS = 6000, MAX_ATTEMPTS = 2;
  let attempt = 0, elapsed = 0;

  function check() {
    const { groups: _, copyEls, copiedEls } = scanWalletElements();
    const { copyCount, copiedCount } = countGroupCopyState(group.el, copyEls, copiedEls);
    return { copyCount, copiedCount, total: copyCount + copiedCount };
  }

  const pre = check();
  if (pre.total > 0) { logAct('ALREADY_EXPANDED', `${group.label}: ${pre.copyCount} Copy, ${pre.copiedCount} Copied`); onReady(pre.copyCount); return; }

  function tryExpand() {
    attempt++;
    if (!group.el || !visible(group.el)) { W(`expandGroup: "${group.label}" not visible`); onFail?.(); return; }
    click(group.el); logAct('EXPAND', group.label);
    elapsed = 0; poll();
  }

  function poll() {
    const { copyCount, copiedCount, total } = check();
    if (total > 0) { logAct('GROUP_ROWS', `${group.label}: ${copyCount} Copy, ${copiedCount} Copied`); onReady(copyCount); return; }
    elapsed += POLL_MS;
    if (elapsed >= TIMEOUT_MS) {
      if (attempt < MAX_ATTEMPTS) { logAct('EXPAND_RETRY', group.label); tryExpand(); }
      else { W(`waitForGroupExpansion: timeout "${group.label}"`); onFail?.(); }
      return;
    }
    setTimeout(poll, POLL_MS);
  }
  tryExpand();
}

// detectModalType — body string only (Flutter accessibility tree text is
// always present in body.innerText regardless of scroll position, so the
// expensive querySelectorAll('*') DOM scan Strategy A from v22.4 is removed).
function detectModalType(body) {
  const b = body || refreshBody();
  const has = kw => b.includes(kw);
  if (has('Adjust Position Size') || (has('Reset') && has('Position Size') && has('Confirm') && !has('Go Back'))) return 'adjust';
  if (has('Exit Price') && has('Confirm')) return 'close';
  if (has('Confirm') && (has('Go Back') || has('Cancel'))) return 'confirm';
  if (has('Position Size') && has('Confirm') && !has('Go Back')) return 'position';
  if (has('Confirm') && has('Reset') && !has('Go Back') && !has('Cancel') && !has('Exit Price')) return 'adjust';
  return null;
}

function processSingleCopy(loop, maxLoops, groupEl, onDone) {
  if (loop >= maxLoops) { onDone(); return; }
  const body = refreshBody();
  if (checkModals(body)) return;

  const { copyEls, copiedEls } = scanWalletElements();
  if (!copyEls.length) { logAct('COPY_DONE', `No more Copy buttons at loop ${loop}`); onDone(); return; }

  const { copiedCount: doneSoFar } = countGroupCopyState(groupEl, copyEls, copiedEls);
  click(copyEls[0]);
  logAct('COPY_CLICK', `Copy ${loop + 1}/${maxLoops}`);

  function afterConfirm() {
    let v = 0;
    const verifyCopied = () => {
      const { copyEls: nowCopyEls, copiedEls: nowCopiedEls } = scanWalletElements();
      const { copiedCount: nowCopied } = countGroupCopyState(groupEl, nowCopyEls, nowCopiedEls);
      if (nowCopyEls.length < copyEls.length || nowCopied > doneSoFar) {
        logAct('COPY_VERIFIED', `Confirmed (Copy left: ${nowCopyEls.length}, Copied: ${nowCopied})`);
        setTimeout(() => processSingleCopy(loop + 1, maxLoops, groupEl, onDone), CONFIRM_WAIT_MS);
      } else if (++v >= 10) {
        W('Copy→Copied not confirmed — proceeding');
        setTimeout(() => processSingleCopy(loop + 1, maxLoops, groupEl, onDone), CONFIRM_WAIT_MS);
      } else { setTimeout(verifyCopied, 300); }
    };
    setTimeout(verifyCopied, 600);
  }

  let modalElapsed = 0;
  function pollForModal() {
    const b = refreshBody();
    if (checkModals(b)) return;
    const modalType = detectModalType(b);
    if (!modalType) {
      modalElapsed += 300;
      if (modalElapsed >= 6000) { W(`No modal after 6s — skipping loop ${loop}`); logAct('COPY_NO_MODAL', `Loop ${loop}`); setTimeout(() => processSingleCopy(loop + 1, maxLoops, groupEl, onDone), 500); }
      else setTimeout(pollForModal, 300);
      return;
    }
    logAct('COPY_MODAL', `Modal: "${modalType}"`);
    if (modalType === 'position') {
      setPositionSize(() => { const btn = findByText('Confirm', b) || findContaining('Confirm', b); if (btn) { click(btn); lastActionTime = Date.now(); } afterConfirm(); });
    } else {
      const btn = findByText('Confirm', b) || findContaining('Confirm', b);
      if (btn) { click(btn); lastActionTime = Date.now(); }
      else W(`${modalType} modal — Confirm not found`);
      afterConfirm();
    }
  }
  setTimeout(pollForModal, 400);
}

function processGroupQueue(groups, groupIdx, copyEls, copiedEls) {
  if (groupIdx >= groups.length) {
    // Final sweep using already-scanned copyEls
    if (copyEls.length > 0) {
      logAct('COPY_SWEEP', `Final sweep: ${copyEls.length} remaining`);
      processSingleCopy(0, copyEls.length + 3, null, () => { logAct('UPDATED', 'All groups + sweep complete'); unlock(); });
    } else { logAct('UPDATED', `All ${groups.length} group(s) processed`); unlock(); }
    return;
  }
  const group = groups[groupIdx];
  logAct('EXPAND_GROUP', `${groupIdx + 1}/${groups.length}: ${group.label}`);
  waitForGroupExpansion(group,
    (copyCount) => {
      if (copyCount === 0) { logAct('GROUP_ALL_COPIED', `${group.label}: all Copied`); processGroupQueue(groups, groupIdx + 1, copyEls, copiedEls); return; }
      logAct('GROUP_NEEDS_COPY', `${group.label}: ${copyCount} unconfirmed`);
      processSingleCopy(0, copyCount + 3, group.el, () => {
        const { groups: _, copyEls: newCopyEls, copiedEls: newCopiedEls } = scanWalletElements();
        logAct('GROUP_DONE', `${group.label}: ${newCopyEls.length} Copy remaining`);
        processGroupQueue(groups, groupIdx + 1, newCopyEls, newCopiedEls);
      });
    },
    () => processGroupQueue(groups, groupIdx + 1, copyEls, copiedEls)
  );
}

function handleWalletTradeUpdates(groups, copyEls, copiedEls) {
  if (!groups.length) return false;
  groups.sort((a, b) => b.count - a.count);

  if (copyEls.length > 0) {
    lock('UPDATING');
    logAct('UPDATING', `${groups.length} group(s) | ${copyEls.length} Copy pending`);
    processGroupQueue(groups, 0, copyEls, copiedEls);
    return true;
  }

  const compositeKey = 'wallet-groups::' + groups.map(g => g.label).sort().join('|') + '::copies=0';
  if (seenWallet.has(compositeKey)) return false;
  seenWallet.add(compositeKey);
  setTimeout(() => seenWallet.delete(compositeKey), 20000);

  lock('UPDATING');
  logAct('UPDATING', `${groups.length} group(s) — checking hidden`);
  processGroupQueue(groups, 0, copyEls, copiedEls);
  return true;
}

// ── DOLLAR STOP-LOSS ────────────────────────────────────────────────────────
function findTradesExceedingUsdThreshold(threshold, body) {
  const b = body || getBody();
  const results = [];
  const re = /\b([A-Z]{2,10})\s+(\d+)\s*[Xx]\s*(Long|Short)[\s\S]{0,300}?-\$([\d,]+(?:\.\d+)?)/g;
  let m;
  while ((m = re.exec(b)) !== null) {
    const usd = parseFloat(m[4].replace(/,/g, ''));
    if (!isNaN(usd) && usd >= threshold) results.push({ symbol: m[1], direction: m[3], usd, el: findContaining(m[1], b) || null });
  }
  return results;
}

function checkDollarStopLoss(body) {
  if (!ENABLE_DOLLAR_STOP_LOSS || !AUTO_CLOSE_USD_THRESHOLD || AUTO_CLOSE_USD_THRESHOLD <= 0) return false;
  const b = body || getBody();
  if (!b.includes('-$')) return false; // fast gate: no dollar loss strings at all
  const trades = findTradesExceedingUsdThreshold(AUTO_CLOSE_USD_THRESHOLD, b);
  if (!trades.length) return false;

  trades.sort((a, b) => b.usd - a.usd);
  const target = trades[0];
  const cooldownKey = `dollar-stop-${target.symbol}`;
  if (seenWallet.has(cooldownKey)) return false;
  seenWallet.add(cooldownKey);
  setTimeout(() => seenWallet.delete(cooldownKey), 3 * 60 * 1000);

  L(`🛑 Dollar stop-loss: ${target.symbol} ${target.direction} -$${target.usd.toFixed(2)}`);
  logAct('DOLLAR_STOP', `${target.symbol} -$${target.usd.toFixed(2)} (threshold $${AUTO_CLOSE_USD_THRESHOLD})`);
  badge(`🛑 AUTO-CLOSE ${target.symbol} -$${target.usd.toFixed(2)}`, '#dc2626');
  playAlert(1);

  if (!target.el) { W(`Dollar stop: no DOM el for ${target.symbol}`); seenWallet.delete(cooldownKey); return false; }

  lock('DOLLAR STOP-LOSS');
  click(target.el);
  setTimeout(() => {
    const b2 = refreshBody();
    const closeBtn = findByText('Close Trade', b2) || findContaining('Close Trade', b2)
      || findByText('Close Position', b2) || findContaining('Close Position', b2);
    if (closeBtn) { click(closeBtn); setTimeout(doCloseConfirm, 1800); }
    else { W(`Dollar stop: Close button not found for ${target.symbol}`); logAct('DOLLAR_STOP_RETRY', target.symbol); seenWallet.delete(cooldownKey); unlock(); }
  }, 1400);
  return true;
}

// ── WALLET SCROLL SWEEP ───────────────────────────────────────────────────
function getFlutterGlassPane() { return document.querySelector('flt-glass-pane') || document.body; }

function flutterWheel(deltaY) {
  const target = getFlutterGlassPane();
  const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
  target.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY, deltaMode: 0, clientX: cx, clientY: cy, screenX: cx, screenY: cy }));
}

function flutterScrollToTop() {
  return new Promise(resolve => { for (let i = 0; i < 60; i++) flutterWheel(-300); setTimeout(resolve, 500); });
}

function walletChecksAtCurrentPosition(body) {
  if (isExec) return true;
  if (checkClosePosition(body)) return true;
  if (checkDollarStopLoss(body)) return true;
  const worst = findWorstTradeCard(body);
  if (worst) {
    const pctB = worst.pct !== null && Math.abs(worst.pct) >= EMERGENCY_WALLET_LOSS_PCT;
    const usdB = worst.usd !== null && worst.usd >= EMERGENCY_MAX_LOSS_USD;
    if (EMERGENCY_REQUIRES_BOTH ? (pctB && usdB) : (pctB || usdB)) {
      attemptEmergencyClose(`Trade ${worst.symbol || '?'} loss ${worst.pct ?? '?'}% / -$${worst.usd?.toFixed(2) ?? '?'} exceeded threshold`, body);
      return true;
    }
  }
  return false;
}

function runWalletScrollSweep(onActionFired, onComplete) {
  if (walletScrollSweepActive) { onComplete?.(); return; }
  walletScrollSweepActive = true;
  logAct('SCROLL_SWEEP', `Starting (${WALLET_SCROLL_MAX_POS} positions)`);

  flutterScrollToTop().then(() => {
    let pos = 0;
    function step() {
      if (isExec) { walletScrollSweepActive = false; onActionFired?.(); return; }
      if (pos >= WALLET_SCROLL_MAX_POS) { walletScrollSweepActive = false; onComplete?.(); return; }

      const body = refreshBody();
      if (walletChecksAtCurrentPosition(body)) { logAct('SCROLL_FOUND', `Action at pos ${pos}`); walletScrollSweepActive = false; onActionFired?.(); return; }

      const { groups, copyEls, copiedEls } = scanWalletElements();
      if (!isExec && handleWalletTradeUpdates(groups, copyEls, copiedEls)) {
        logAct('SCROLL_FOUND', `Trade Updates at pos ${pos}`); walletScrollSweepActive = false; onActionFired?.(); return;
      }

      for (let i = 0; i < WALLET_SCROLL_STEPS; i++) flutterWheel(300);
      pos++;
      setTimeout(step, WALLET_SCROLL_PAUSE_MS);
    }
    step();
  });
}

// ── CLOSE POSITION ─────────────────────────────────────────────────────────
function checkClosePosition(body) {
  const b = body || getBody();
  if (!b.includes('Close Position')) return false;
  try {
    const lastCloseTs = parseInt(localStorage.getItem(CLOSE_POSITION_TS_KEY) || '0', 10);
    if (lastCloseTs && Date.now() - lastCloseTs < CLOSE_POSITION_COOLDOWN_MS) {
      L(`checkClosePosition: cooldown (${Math.round((CLOSE_POSITION_COOLDOWN_MS - (Date.now() - lastCloseTs)) / 1000)}s)`);
      return false;
    }
  } catch {}
  if (menuOpen(b)) return false;
  const btn = findByText('Close Position', b) || findContaining('Close Position', b);
  if (!btn) return false;
  try { localStorage.setItem(CLOSE_POSITION_TS_KEY, String(Date.now())); } catch {}
  logAct('CLOSING', 'Direct Close Position found');
  lock('CLOSING'); click(btn); setTimeout(doCloseConfirm, 2000);
  return true;
}

// ── SCAN WALLET ─────────────────────────────────────────────────────────────
function scanWallet() {
  if (!onPage('/wallet') || isExec || walletScrollSweepActive) return;
  if (lastActionTime && Date.now() - lastActionTime < POST_ACTION_COOL) return;
  lastActivity = Date.now();

  // Single body read for entire scan tick
  const body = refreshBody();

  if (menuOpen(body)) { dismissMenu(); return; }
  if (checkModals(body)) return;

  verifyPostOpenRiskIfNeeded(body);

  // Pass A: on-screen checks (all reuse the same body string)
  if (checkClosePosition(body)) return;
  if (checkDollarStopLoss(body)) return;

  const worst = findWorstTradeCard(body);
  if (worst) {
    const pctB = worst.pct !== null && Math.abs(worst.pct) >= EMERGENCY_WALLET_LOSS_PCT;
    const usdB = worst.usd !== null && worst.usd >= EMERGENCY_MAX_LOSS_USD;
    if (EMERGENCY_REQUIRES_BOTH ? (pctB && usdB) : (pctB || usdB)) {
      attemptEmergencyClose(`Trade ${worst.symbol || '?'} loss ${worst.pct ?? '?'}% / -$${worst.usd?.toFixed(2) ?? '?'} exceeded threshold`, body);
      return;
    }
  }

  // Single DOM pass for groups + Copy buttons
  const { groups, copyEls, copiedEls } = scanWalletElements();
  if (handleWalletTradeUpdates(groups, copyEls, copiedEls)) return;

  // Pass B: scroll sweep
  runWalletScrollSweep(
    () => L('scanWallet: sweep found action'),
    () => {
      if (isExec) return;
      const { groups: g2, copyEls: c2, copiedEls: d2 } = scanWalletElements();
      handleWalletTradeUpdates(g2, c2, d2);
    }
  );
}

// ── MAIN LOOP ──────────────────────────────────────────────────────────────
function scan() {
  try {
    enableAcc();
    if (onPage('/notifications')) scanNotifs();
    else if (onPage('/wallet')) scanWallet();
  } catch (e) { W(`scan() error: ${e.message}`); }
}

// ── WATCHDOGS ──────────────────────────────────────────────────────────────
setInterval(() => {
  if (isExec && execStart && Date.now() - execStart > MAX_EXEC_MS) {
    W(`Stuck ${MAX_EXEC_MS / 1000}s — force-unlock`); isExec = false; execStart = 0; badge('🟢 Active'); window.location.href = HOME_URL;
  }
}, 10000);

setInterval(() => {
  if (!reloadSafe() || isExec) { wrongSince = null; return; }
  const url = window.location.href;
  if (url.includes('/share_out')) { window.location.href = HOME_URL; return; }
  if (!url.includes(HOME_PATH) && !SAFE_PATHS.some(p => url.includes(p))) {
    if (!wrongSince) wrongSince = Date.now();
    if (Date.now() - wrongSince > WRONG_PAGE_MS) { wrongSince = null; window.location.href = HOME_URL; }
  } else { wrongSince = null; }
}, 2000);

setInterval(() => {
  if (!reloadSafe() || !onPage(HOME_PATH)) return;
  if (Date.now() - lastActivity > STALE_MS) { W('Stale — reloading'); location.reload(); }
}, 20000);

setInterval(() => {
  const body = document.body?.innerText || '', title = document.title || '';
  const is404 = body.includes('404') || body.toLowerCase().includes('page not found') || title.includes('404');
  if (is404 && !window._404recovering) {
    window._404recovering = true; logAct('404', 'Recovering'); badge('⚠️ 404', '#dc2626');
    setTimeout(() => { window._404recovering = false; window.location.href = HOME_URL; }, 1500);
  } else if (!is404) { window._404recovering = false; }
}, 5000);

// ── SESSION WATCHDOG ────────────────────────────────────────────────────────
function startAuthWatchdog() {
  if (!SESSION_WATCHDOG_ENABLED) { L('Auth watchdog: DISABLED'); return; }
  let failCount = 0, firstFailAt = 0, reloadPending = false;

  function handleAuthFailure(url) {
    const now = Date.now();
    if (firstFailAt && now - firstFailAt > SESSION_RELOAD_WINDOW_MS) { failCount = 0; firstFailAt = 0; }
    if (failCount === 0) firstFailAt = now;
    failCount++;
    W(`AUTH: 401 (${failCount}/${SESSION_RELOAD_THRESHOLD})`);
    logAct('AUTH_401', `${failCount}/${SESSION_RELOAD_THRESHOLD}: ${String(url).substring(0, 80)}`);
    if (failCount >= SESSION_RELOAD_THRESHOLD && !reloadPending) {
      reloadPending = true; badge('🔄 Session expired', '#b45309');
      const doReload = () => { if (isExec) { setTimeout(doReload, 3000); return; } location.reload(); };
      setTimeout(doReload, 2500);
    }
  }
  function handleAuthSuccess() { if (failCount > 0) { failCount = 0; firstFailAt = 0; reloadPending = false; } }

  const _origFetch = window.fetch;
  window.fetch = function (...args) {
    return _origFetch.apply(this, args).then(res => {
      const url = String(args[0] || '');
      if (url.includes('invoapp.com')) { if (res.status === 401) handleAuthFailure(url); else if (res.ok) handleAuthSuccess(); }
      return res;
    }).catch(err => { throw err; });
  };

  const _origOpen = XMLHttpRequest.prototype.open, _origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) { this._amUrl = String(url || ''); return _origOpen.apply(this, [method, url, ...rest]); };
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', function () {
      if ((this._amUrl || '').includes('invoapp.com')) {
        if (this.status === 401) handleAuthFailure(this._amUrl);
        else if (this.status >= 200 && this.status < 300) handleAuthSuccess();
      }
    });
    return _origSend.apply(this, args);
  };
  L('Auth watchdog: ACTIVE');
}

function startWebLocksKeepalive() {
  if (!navigator.locks?.request) return;
  navigator.locks.request('am-tab-alive', { mode: 'shared' }, () => new Promise(() => {})).catch(e => W(`Web Locks: ${e.message}`));
  L('Web Locks: ACTIVE');
}

function scheduleReload() {
  const delay = (Math.floor(Math.random() * (RELOAD_MAX_S - RELOAD_MIN_S + 1)) + RELOAD_MIN_S) * 1000;
  setTimeout(() => { if (reloadSafe() && onPage(HOME_PATH)) { L('Keepalive reload'); location.reload(); } else scheduleReload(); }, delay);
}

function startMutationWatcher() {
  if (!onPage('/notifications')) return;
  const target = document.querySelector('flt-glass-pane') || document.body;
  if (!target) return;
  const THROTTLE_MS = 250;
  let lastRun = 0, trailingTimer = null;
  const runScan = () => {
    lastRun = Date.now();
    if (isExec || !onPage('/notifications') || opensPaused()) return;
    try { scanNotifs(); } catch (e) { W(`mutation scan: ${e.message}`); }
  };
  new MutationObserver(() => {
    const now = Date.now();
    if (now - lastRun >= THROTTLE_MS) runScan();
    else if (!trailingTimer) trailingTimer = setTimeout(() => { trailingTimer = null; runScan(); }, THROTTLE_MS);
  }).observe(target, { childList: true, subtree: true });
  L('MutationObserver: ACTIVE');
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    L('Tab visible — scanning'); lastActivity = Date.now(); scan();
    if (pendingTrades.length > 0) {
      const fresh = pendingTrades.filter(t => t.age <= MAX_AGE_MINUTES);
      if (fresh.length < pendingTrades.length) { logAct('CLEAR_STALE', `Removed ${pendingTrades.length - fresh.length} stale`); pendingTrades = fresh; }
    }
  }
});

function startAntiThrottleWorker() {
  try {
    const worker = new Worker(URL.createObjectURL(new Blob(['setInterval(()=>self.postMessage("p"),10000)'], { type: 'application/javascript' })));
    worker.onmessage = () => { lastActivity = Date.now(); };
    L('Anti-throttle worker: ACTIVE');
  } catch (e) { W(`Anti-throttle worker: ${e.message}`); }
}

// ── BOOT ──────────────────────────────────────────────────────────────────
clearEmergencyBanner(); badge('🟢 Active'); lastActivity = Date.now();
loadSeenNotifs(); loadPendingTrades();

const bootState = getRiskState();
if (bootState.openPauseUntil && Date.now() < bootState.openPauseUntil) {
  openPauseUntil = bootState.openPauseUntil;
  L(`Restored open pause — ${Math.round((openPauseUntil - Date.now()) / 1000)}s remaining`);
}

try {
  const lastCloseTs = parseInt(localStorage.getItem(CLOSE_POSITION_TS_KEY) || '0', 10);
  if (lastCloseTs && Date.now() - lastCloseTs > CLOSE_POSITION_COOLDOWN_MS) { localStorage.removeItem(CLOSE_POSITION_TS_KEY); L('Boot: stale close-position TS cleared'); }
  else if (lastCloseTs) L(`Boot: close-position cooldown (${Math.round((CLOSE_POSITION_COOLDOWN_MS - (Date.now() - lastCloseTs)) / 1000)}s remaining)`);
} catch {}

setTimeout(() => {
  enableAcc(); startWebLocksKeepalive(); startAuthWatchdog(); startAntiThrottleWorker();
  setTimeout(() => {
    scan(); setInterval(scan, SCAN_MS); startMutationWatcher(); scheduleReload();
    L(`v${VERSION} booted | ${location.pathname} | Seen: ${seenNotifs.size} | Pending: ${pendingTrades.length}`);
    L(`Size: ${FORCE_POSITION_PCT !== null ? `FIXED ${FORCE_POSITION_PCT}%` : `CAP ${MAX_POSITION_PCT}%`} | SL: ${MANAGE_STOP_LOSS ? `${STOP_LOSS_PCT}%` : 'off'} | Dollar stop: ${ENABLE_DOLLAR_STOP_LOSS ? `$${AUTO_CLOSE_USD_THRESHOLD}` : 'off'}`);
    L(`Commands: window._status() | window._pauseOpens(min) | window._unpause() | window._clearSeen()`);
  }, 2200);
}, 1000);

})();
