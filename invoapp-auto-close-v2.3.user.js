// ==UserScript==
// @name         Invoapp Wallet Auto Close
// @namespace    http://tampermonkey.net/
// @version      2.3
// @author       Reed Huish, ZPower (reed@zpower.com)
// @description  Wallet page only: scrolls through all pages of active trades, watches for "Close Position", clicks Close then Confirm (scoped to the active modal, fail-closed), verifies the trade actually left the list, and guarantees return to /wallet after every close.
// @match        https://app.invoapp.com/wallet
// @match        https://app.invoapp.com/wallet*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ============================================================
  // CONFIG
  // ============================================================
  const WALLET_URL = 'https://app.invoapp.com/wallet';
  const ACTION_WAIT_MS = 3800;
  const CLICK_SETTLE_MS = 350;
  const IDLE_RELOAD_GRACE_MS = 15000;
  const SCAN_DEBOUNCE_MS = 800;
  const SCAN_DEBOUNCE_MAX_WAIT_MS = 3000;
  const POLL_INTERVAL_MS = 2000;
  const IDLE_CHECK_INTERVAL_MS = 1000;
  const URL_WATCHDOG_INTERVAL_MS = 500;
  const POST_CLOSE_RETURN_DELAY_MS = 500;
  const DRAG_DISTANCE_PX = 350;
  const DRAG_STEPS = 12;
  const DRAG_STEP_DELAY_MS = 16;
  const SCROLL_SETTLE_MS = 450;
  const MAX_SCROLL_STEPS = 30;
  const STUCK_FLAG_TIMEOUT_MS = 25000;
  const FAST_PATH_MIN_INTERVAL_MS = 150;
  const RELOAD_COOLDOWN_MS = 4000; // v2.3: minimum gap between ANY two reload triggers, whatever the source

  const LOG_PREFIX = '[InvoAutoClose]';
  const STORAGE_KEY = 'invoAutoCloseEnabled';
  const AUDIT_LOG_KEY = 'invoAutoCloseAuditLog';
  const MAX_AUDIT_ENTRIES = 200;

  const BACKOFF_SCHEDULE_MS = [15000, 30000, 60000, 120000];
  const CIRCUIT_TRIP_THRESHOLD = 3;

  // v2.3: post-close verification
  const POST_CLOSE_VERIFY_TIMEOUT_MS = 6000;
  const POST_CLOSE_VERIFY_POLL_MS = 250;

  // ============================================================
  // STATE
  // ============================================================
  let isProcessing = false;
  let isScrollScanning = false;
  let isReturningToWallet = false;
  let lastActionTime = Date.now();
  let lastReloadAttempt = 0; // v2.3: this now gates ALL reload sources, not just idle-reload
  let processingStartedAt = null;
  let scrollScanningStartedAt = null;
  let returningToWalletStartedAt = null;
  let semanticsForced = false;
  let scanTimer = null;
  let scanTimerArmedAt = null;
  let lastFastPathCheck = 0;
  let scanGeneration = 0;

  let consecutiveFailures = 0;
  let circuitTripped = false;
  let circuitBackoffIndex = 0;

  // ============================================================
  // AUDIT LOG (persists across reloads)
  // ============================================================
  function auditLog(event, detail) {
    try {
      const raw = localStorage.getItem(AUDIT_LOG_KEY);
      const entries = raw ? JSON.parse(raw) : [];
      entries.push({ t: new Date().toISOString(), event, detail: detail || '' });
      while (entries.length > MAX_AUDIT_ENTRIES) entries.shift();
      localStorage.setItem(AUDIT_LOG_KEY, JSON.stringify(entries));
    } catch (e) {
      // storage full or blocked -- non-fatal
    }
  }

  function log(...args) {
    console.log(LOG_PREFIX, ...args);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ============================================================
  // WEB WORKER FOR TIMING (immune to background-tab throttling)
  // ============================================================
  const workerCode = `
    let intervalIds = {};
    self.onmessage = function(e) {
      const { cmd, name, ms } = e.data;
      if (cmd === 'start') {
        if (intervalIds[name]) clearInterval(intervalIds[name]);
        intervalIds[name] = setInterval(() => { self.postMessage({ tick: name }); }, ms);
      } else if (cmd === 'stop') {
        if (intervalIds[name]) { clearInterval(intervalIds[name]); delete intervalIds[name]; }
      }
    };
  `;

  let worker = null;

  function createTickWorker() {
    const blob = new Blob([workerCode], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    worker = new Worker(url);
    URL.revokeObjectURL(url);

    worker.onmessage = (e) => {
      const tick = e.data && e.data.tick;
      if (tick === 'scanPoll') {
        if (!isProcessing && !isScrollScanning && !isReturningToWallet && isEnabled() && !circuitTripped) scheduleScan();
      } else if (tick === 'idleReload') {
        idleReloadTick();
      } else if (tick === 'urlWatchdog') {
        urlWatchdogTick();
      } else if (tick === 'stuckFlagWatchdog') {
        stuckFlagWatchdogTick();
      } else if (tick === 'statusPulse') {
        pulseStatusDot();
      } else if (tick === 'sessionCheck') {
        sessionExpiryTick();
      }
    };

    worker.postMessage({ cmd: 'start', name: 'scanPoll', ms: POLL_INTERVAL_MS });
    worker.postMessage({ cmd: 'start', name: 'idleReload', ms: IDLE_CHECK_INTERVAL_MS });
    worker.postMessage({ cmd: 'start', name: 'urlWatchdog', ms: URL_WATCHDOG_INTERVAL_MS });
    worker.postMessage({ cmd: 'start', name: 'stuckFlagWatchdog', ms: 5000 });
    worker.postMessage({ cmd: 'start', name: 'statusPulse', ms: 700 });
    worker.postMessage({ cmd: 'start', name: 'sessionCheck', ms: 3000 });

    log('Tick worker started.');
  }

  // ============================================================
  // PERSISTED ON/OFF STATE
  // ============================================================
  function isEnabled() {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === null ? true : stored === 'true';
  }

  function setEnabled(value) {
    localStorage.setItem(STORAGE_KEY, value ? 'true' : 'false');
    updatePanelUI();
    log(value ? 'Script ENABLED by user.' : 'Script DISABLED by user.');
    auditLog('user_toggle', value ? 'enabled' : 'disabled');
  }

  // ============================================================
  // WALLET / LOGIN PAGE DETECTION
  // ============================================================
  function isOnWalletPage() {
    const path = window.location.pathname.replace(/\/+$/, '');
    return path === '/wallet';
  }

  function looksLikeLoginPage() {
    const path = window.location.pathname.toLowerCase();
    return /login|signin|sign-in|auth/.test(path);
  }

  function sessionExpiryTick() {
    if (!isEnabled()) return;
    if (looksLikeLoginPage()) {
      log('SESSION EXPIRED: login page detected. Disabling script to prevent reload loop.');
      auditLog('session_expired', window.location.href);
      setEnabled(false);
      showSessionExpiredAlert();
    }
  }

  function showSessionExpiredAlert() {
    const text = document.getElementById('invo-status-text');
    if (text) {
      text.textContent = 'SESSION EXPIRED -- please log in manually';
      text.style.color = '#ff4d4f';
    }
  }

  // ============================================================
  // CIRCUIT BREAKER
  // ============================================================
  function recordFailure(reason) {
    consecutiveFailures++;
    auditLog('failure', `${reason} (streak: ${consecutiveFailures})`);
    if (consecutiveFailures >= CIRCUIT_TRIP_THRESHOLD) {
      circuitTripped = true;
      circuitBackoffIndex = Math.min(consecutiveFailures - CIRCUIT_TRIP_THRESHOLD, BACKOFF_SCHEDULE_MS.length - 1);
      const waitMs = BACKOFF_SCHEDULE_MS[circuitBackoffIndex];
      log(`CIRCUIT BREAKER TRIPPED after ${consecutiveFailures} consecutive failures. Pausing ${waitMs / 1000}s. Reason: ${reason}`);
      updatePanelUI();
      setTimeout(() => {
        circuitTripped = false;
        log('Circuit breaker reset -- resuming scans.');
        auditLog('circuit_reset', `after ${waitMs}ms pause`);
        updatePanelUI();
        if (isEnabled()) scheduleScan();
      }, waitMs);
    }
  }

  function recordSuccess() {
    if (consecutiveFailures > 0) auditLog('recovered', `after ${consecutiveFailures} failures`);
    consecutiveFailures = 0;
    circuitBackoffIndex = 0;
  }

  // ============================================================
  // GUARANTEED RETURN TO WALLET
  // v2.3: single cooldown (RELOAD_COOLDOWN_MS) now gates every caller --
  // idle-reload, URL watchdog, and the crash handler all funnel through
  // here and can no longer stack a second reload on top of one that
  // hasn't finished yet.
  // ============================================================
  function forceReturnToWallet(reason) {
    if (isReturningToWallet) return;

    const sinceLastReload = Date.now() - lastReloadAttempt;
    if (sinceLastReload < RELOAD_COOLDOWN_MS) {
      log(`Reload suppressed (cooldown, ${Math.round(sinceLastReload)}ms since last). Reason was: ${reason}`);
      return;
    }

    isReturningToWallet = true;
    log(`Forcing return to wallet page. Reason: ${reason}`);
    auditLog('return_to_wallet', reason);
    lastReloadAttempt = Date.now();
    lastActionTime = Date.now();
    updatePanelUI();

    try {
      if (window.location.href.split('#')[0].split('?')[0] !== WALLET_URL) {
        window.location.href = WALLET_URL;
      } else {
        window.location.reload();
      }
    } finally {
      setTimeout(() => { isReturningToWallet = false; }, RELOAD_COOLDOWN_MS);
    }
  }

  // ============================================================
  // FLOATING ON/OFF PANEL
  // ============================================================
  function createControlPanel() {
    if (document.getElementById('invo-auto-close-panel')) return;

    const panel = document.createElement('div');
    panel.id = 'invo-auto-close-panel';
    panel.style.cssText = `
      position: fixed; bottom: 20px; right: 20px; z-index: 2147483647;
      background: #111318; border: 2px solid #2ee6a6; border-radius: 12px;
      padding: 10px 14px; font-family: -apple-system, Segoe UI, Roboto, sans-serif;
      font-size: 13px; color: #fff; box-shadow: 0 4px 16px rgba(0,0,0,0.5);
      min-width: 190px; user-select: none;
    `;
    panel.innerHTML = `
      <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
        <span id="invo-status-dot" style="width:10px; height:10px; border-radius:50%; background:#2ee6a6; display:inline-block; box-shadow:0 0 6px #2ee6a6;"></span>
        <strong style="font-size:13px;">Invo Auto-Close</strong>
      </div>
      <div id="invo-status-text" style="font-size:12px; color:#aaa; margin-bottom:6px;">Initializing...</div>
      <div id="invo-heartbeat-text" style="font-size:10px; color:#666; margin-bottom:8px;">Last tick: --</div>
      <button id="invo-toggle-btn" style="width:100%; padding:6px 10px; border-radius:8px; border:none; font-weight:600; font-size:12px; cursor:pointer; margin-bottom:6px;">Toggle</button>
      <button id="invo-log-btn" style="width:100%; padding:4px 10px; border-radius:8px; border:1px solid #555; background:transparent; color:#aaa; font-size:10px; cursor:pointer;">View Audit Log</button>
    `;

    document.body.appendChild(panel);
    document.getElementById('invo-toggle-btn').addEventListener('click', () => setEnabled(!isEnabled()));
    document.getElementById('invo-log-btn').addEventListener('click', () => {
      const raw = localStorage.getItem(AUDIT_LOG_KEY);
      console.log(LOG_PREFIX, 'AUDIT LOG:', raw ? JSON.parse(raw) : []);
      alert('Audit log printed to console (F12).');
    });
    updatePanelUI();
  }

  function updatePanelUI() {
    const dot = document.getElementById('invo-status-dot');
    const text = document.getElementById('invo-status-text');
    const btn = document.getElementById('invo-toggle-btn');
    if (!dot || !text || !btn) return;

    const enabled = isEnabled();

    if (circuitTripped) {
      dot.style.background = '#ff8c00'; dot.style.boxShadow = '0 0 6px #ff8c00';
      text.textContent = `CIRCUIT BREAKER: paused after ${consecutiveFailures} failures`;
      text.style.color = '#ff8c00';
      btn.textContent = 'Turn OFF'; btn.style.background = '#ff4d4f'; btn.style.color = '#fff';
    } else if (!enabled) {
      dot.style.background = '#ff4d4f'; dot.style.boxShadow = '0 0 6px #ff4d4f';
      text.textContent = 'OFF \u2014 manual mode'; text.style.color = '#aaa';
      btn.textContent = 'Turn ON'; btn.style.background = '#2ee6a6'; btn.style.color = '#111318';
    } else if (isReturningToWallet) {
      dot.style.background = '#b57bff'; dot.style.boxShadow = '0 0 6px #b57bff';
      text.textContent = 'Returning to wallet...'; text.style.color = '#aaa';
      btn.textContent = 'Turn OFF'; btn.style.background = '#ff4d4f'; btn.style.color = '#fff';
    } else if (isProcessing) {
      dot.style.background = '#ffd83d'; dot.style.boxShadow = '0 0 6px #ffd83d';
      text.textContent = 'Working: closing trade...'; text.style.color = '#aaa';
      btn.textContent = 'Turn OFF'; btn.style.background = '#ff4d4f'; btn.style.color = '#fff';
    } else if (isScrollScanning) {
      dot.style.background = '#4dc3ff'; dot.style.boxShadow = '0 0 6px #4dc3ff';
      text.textContent = 'Scanning pages...'; text.style.color = '#aaa';
      btn.textContent = 'Turn OFF'; btn.style.background = '#ff4d4f'; btn.style.color = '#fff';
    } else {
      dot.style.background = '#2ee6a6'; dot.style.boxShadow = '0 0 6px #2ee6a6';
      text.textContent = 'Running \u2014 watching for closes'; text.style.color = '#aaa';
      btn.textContent = 'Turn OFF'; btn.style.background = '#ff4d4f'; btn.style.color = '#fff';
    }
  }

  function pulseStatusDot() {
    const dot = document.getElementById('invo-status-dot');
    const hb = document.getElementById('invo-heartbeat-text');
    if (dot && isEnabled() && !circuitTripped) {
      dot.style.opacity = dot.style.opacity === '0.4' ? '1' : '0.4';
    }
    if (hb) hb.textContent = 'Last tick: ' + new Date().toLocaleTimeString();
  }

  // ============================================================
  // FLUTTER SEMANTICS ACTIVATION
  // ============================================================
  function forceEnableFlutterSemantics() {
    if (semanticsForced) return true;

    const placeholder = document.querySelector('flt-semantics-placeholder');
    if (placeholder) {
      try {
        const rect = placeholder.getBoundingClientRect();
        dispatchPointerClick(placeholder, rect.left + rect.width / 2 || 0, rect.top + rect.height / 2 || 0);
        semanticsForced = true;
        log('Flutter semantics placeholder activated.');
        return true;
      } catch (e) {
        log('Error activating semantics placeholder:', e);
      }
    }

    const glassPane = document.querySelector('flt-glass-pane');
    if (glassPane && glassPane.querySelector('flt-semantics')) {
      semanticsForced = true;
      return true;
    }
    return false;
  }

  function getGlassPane() {
    return document.querySelector('flt-glass-pane') || document.body;
  }

  function isElementStillUsable(el) {
    if (!el || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  // ============================================================
  // POINTER EVENT DISPATCH (CLICK)
  // ============================================================
  function dispatchPointerClick(el, x, y) {
    if (!isElementStillUsable(el)) {
      log('Skipped click: element no longer in DOM or has zero size.');
      return false;
    }
    if (typeof x !== 'number' || typeof y !== 'number') {
      const rect = el.getBoundingClientRect();
      x = rect.left + rect.width / 2; y = rect.top + rect.height / 2;
    }
    const p = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1, view: window };
    el.dispatchEvent(new PointerEvent('pointerover', p));
    el.dispatchEvent(new PointerEvent('pointerenter', p));
    el.dispatchEvent(new PointerEvent('pointerdown', p));
    el.dispatchEvent(new MouseEvent('mousedown', p));
    el.dispatchEvent(new PointerEvent('pointerup', p));
    el.dispatchEvent(new MouseEvent('mouseup', p));
    el.dispatchEvent(new MouseEvent('click', p));
    return true;
  }

  // ============================================================
  // SIMULATED DRAG-SCROLL
  // ============================================================
  async function dragScroll(el, x, y, direction) {
    if (!el || !el.isConnected) {
      log('Skipped drag-scroll: target element no longer in DOM.');
      return;
    }
    const totalDelta = DRAG_DISTANCE_PX * direction * -1;
    const stepDelta = totalDelta / DRAG_STEPS;
    const pointerId = 9001;
    const baseP = { bubbles: true, cancelable: true, composed: true, pointerId, pointerType: 'touch', isPrimary: true, button: 0, buttons: 1, view: window };

    el.dispatchEvent(new PointerEvent('pointerdown', { ...baseP, clientX: x, clientY: y }));
    el.dispatchEvent(new MouseEvent('mousedown', { ...baseP, clientX: x, clientY: y }));

    let currentY = y;
    for (let i = 0; i < DRAG_STEPS; i++) {
      currentY += stepDelta;
      el.dispatchEvent(new PointerEvent('pointermove', { ...baseP, clientX: x, clientY: currentY }));
      await sleep(DRAG_STEP_DELAY_MS);
    }

    el.dispatchEvent(new PointerEvent('pointerup', { ...baseP, clientX: x, clientY: currentY, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('mouseup', { ...baseP, clientX: x, clientY: currentY, buttons: 0 }));
  }

  function dispatchWheelScroll(el, x, y, deltaY) {
    if (!el || !el.isConnected) return;
    el.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, deltaX: 0, deltaY, deltaMode: 0, view: window }));
  }

  // ============================================================
  // TEXT-BASED SEMANTICS SEARCH
  // ============================================================
  function findSemanticsButtonsByText(targetText, root) {
    const scope = root || document;
    const normalizedTarget = targetText.trim().toLowerCase();

    let candidates = Array.from(scope.querySelectorAll('flt-semantics')).filter((node) => {
      const label = (node.getAttribute('aria-label') || node.textContent || '').trim().toLowerCase();
      return label === normalizedTarget;
    });

    if (candidates.length === 0) {
      const all = Array.from(scope.querySelectorAll('[aria-label], flt-semantics, button, div, span'));
      candidates = all.filter((node) => {
        const label = (node.getAttribute('aria-label') || '').trim().toLowerCase();
        const text = (node.textContent || '').trim().toLowerCase();
        return label === normalizedTarget || text === normalizedTarget;
      });
    }

    const visible = candidates.filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });

    visible.sort((a, b) => {
      const ra = a.getBoundingClientRect(); const rb = b.getBoundingClientRect();
      return (ra.width * ra.height) - (rb.width * rb.height);
    });

    return visible.length ? visible : candidates;
  }

  function findFirstSemanticsButtonByText(targetText, root) {
    return findSemanticsButtonsByText(targetText, root)[0] || null;
  }

  // ------------------------------------------------------------
  // v2.3 KEY FIX: modal scoping is now FAIL-CLOSED.
  // v2.2 fell back to a global "Confirm" search across the entire page
  // if no modal-like container was found -- which meant one slow render
  // frame could make it click a Confirm button belonging to some other
  // element on the page. That is exactly the failure mode this scoping
  // exists to prevent, so it must never silently fall back to global.
  // If we can't prove which Confirm belongs to the modal we just opened,
  // we report "not found" and let the retry timeout (waitForElement)
  // keep polling for the modal to actually appear -- we do NOT guess.
  // ------------------------------------------------------------
  function findActiveModalScope() {
    const dialogSelectors = '[role="dialog"], [role="alertdialog"], flt-semantics[role="dialog"]';
    const dialogs = Array.from(document.querySelectorAll(dialogSelectors)).filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    if (dialogs.length) {
      dialogs.sort((a, b) => {
        const za = parseInt(getComputedStyle(a).zIndex) || 0;
        const zb = parseInt(getComputedStyle(b).zIndex) || 0;
        return zb - za;
      });
      return dialogs[0];
    }

    // Fallback heuristic: newest flt-semantics subtree with large z-index
    // or covering a big portion of viewport (typical modal overlay).
    const allSemantics = Array.from(document.querySelectorAll('flt-semantics')).filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > window.innerWidth * 0.4 && r.height > window.innerHeight * 0.15;
    });
    if (allSemantics.length) {
      allSemantics.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
      return allSemantics[0];
    }

    return null; // no modal-like scope found -- caller must NOT fall back to global search
  }

  function findConfirmButtonScoped() {
    const modalScope = findActiveModalScope();
    if (!modalScope) return null; // v2.3: fail closed, no global fallback
    return findFirstSemanticsButtonByText('Confirm', modalScope);
  }

  function findTradesListAnchorPoint() {
    const tradeNodes = Array.from(document.querySelectorAll('flt-semantics')).filter((n) => {
      const label = (n.getAttribute('aria-label') || n.textContent || '');
      const r = n.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && /short|long|close position|trader closed/i.test(label);
    });

    if (tradeNodes.length) {
      tradeNodes.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
      const anchor = tradeNodes[tradeNodes.length - 1];
      const r = anchor.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: Math.min(r.top + r.height - 10, window.innerHeight - 40) };
    }

    return { x: window.innerWidth * 0.35, y: window.innerHeight * 0.6 };
  }

  function getVisibleTradesSignature() {
    const nodes = Array.from(document.querySelectorAll('flt-semantics'))
      .filter((n) => {
        const r = n.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.top < window.innerHeight && r.bottom > 0;
      })
      .map((n) => (n.getAttribute('aria-label') || n.textContent || '').trim())
      .filter(Boolean);
    return nodes.join('|').slice(0, 2000);
  }

  // ------------------------------------------------------------
  // v2.3 NEW: identify the specific trade row a Close Position button
  // belongs to, so we can verify afterward that THAT row is actually
  // gone -- not just that click events fired.
  // ------------------------------------------------------------
  function findOwningTradeLabel(closeBtn) {
    if (!closeBtn) return null;
    let node = closeBtn;
    for (let hops = 0; hops < 6 && node; hops++) {
      const label = (node.getAttribute && node.getAttribute('aria-label')) || '';
      if (/short|long|trader/i.test(label)) return label.trim();
      node = node.parentElement;
    }
    return null;
  }

  function tradeStillPresent(tradeLabel) {
    if (!tradeLabel) return null; // unknown -- caller should treat as "can't verify"
    const nodes = Array.from(document.querySelectorAll('flt-semantics'));
    return nodes.some((n) => (n.getAttribute('aria-label') || n.textContent || '').trim() === tradeLabel);
  }

  // ============================================================
  // MAIN ACTION SEQUENCE
  // ============================================================
  async function processClose(closeBtn, myGeneration) {
    if (isProcessing || !isEnabled() || circuitTripped) return false;
    if (!isElementStillUsable(closeBtn)) {
      log('processClose: Close Position button no longer usable, aborting.');
      return false;
    }

    isProcessing = true; lastActionTime = Date.now(); updatePanelUI();
    log('Found "Close Position" button. Clicking...');

    // v2.3: capture which trade row this button belongs to BEFORE we click,
    // so we can verify the close actually took effect afterward.
    const tradeLabel = findOwningTradeLabel(closeBtn);

    let clickedConfirm = false;

    try {
      closeBtn.scrollIntoView({ block: 'center' });
      await sleep(150);

      if (myGeneration !== undefined && myGeneration !== scanGeneration) return false;
      if (!isElementStillUsable(closeBtn)) {
        log('Close Position button disappeared before click could fire.');
        return false;
      }

      const rect = closeBtn.getBoundingClientRect();
      const clicked = dispatchPointerClick(closeBtn, rect.left + rect.width / 2, rect.top + rect.height / 2);
      if (!clicked) return false;
      await sleep(CLICK_SETTLE_MS);

      // v2.3: fail-closed modal-scoped Confirm search -- see findConfirmButtonScoped.
      const confirmBtn = await waitForElement(() => findConfirmButtonScoped(), 4000);
      if (myGeneration !== undefined && myGeneration !== scanGeneration) return false;

      if (confirmBtn && isElementStillUsable(confirmBtn)) {
        log('Found "Confirm" button (modal-scoped). Clicking...');
        const crect = confirmBtn.getBoundingClientRect();
        clickedConfirm = dispatchPointerClick(confirmBtn, crect.left + crect.width / 2, crect.top + crect.height / 2);
      } else {
        log('Confirm button not found inside a modal scope after clicking Close Position. Not clicking anything -- aborting this close.');
      }

      await sleep(ACTION_WAIT_MS);
    } catch (err) {
      log('Error during close/confirm sequence:', err);
      auditLog('close_confirm_error', String(err));
    } finally {
      lastActionTime = Date.now(); isProcessing = false; updatePanelUI();
    }

    if (!clickedConfirm) {
      auditLog('close_failed', `confirm not clicked${tradeLabel ? ' (' + tradeLabel + ')' : ''}`);
      recordFailure('close/confirm sequence failed');
      return false;
    }

    // v2.3 NEW: post-close verification. Clicking Confirm only proves the
    // events fired, not that Invoapp accepted the close. Poll until the
    // owning trade row is actually gone from the list, up to a timeout.
    if (tradeLabel) {
      const verified = await waitForCondition(() => !tradeStillPresent(tradeLabel), POST_CLOSE_VERIFY_TIMEOUT_MS, POST_CLOSE_VERIFY_POLL_MS);
      if (!verified) {
        log(`VERIFICATION FAILED: trade "${tradeLabel}" still present ${POST_CLOSE_VERIFY_TIMEOUT_MS}ms after Confirm click.`);
        auditLog('close_unverified', tradeLabel);
        recordFailure('post-close verification timed out');
        return false;
      }
      log(`Verified: trade "${tradeLabel}" is gone from the list.`);
      auditLog('close_confirmed', tradeLabel);
    } else {
      // Could not identify which row this button belonged to -- we still
      // clicked Confirm, but log this as unverified rather than claiming
      // success we can't actually prove.
      log('Could not identify owning trade row -- close click fired but is UNVERIFIED.');
      auditLog('close_confirmed_unverified', 'owning trade label not found');
    }

    recordSuccess();
    return true;
  }

  function waitForElement(finderFn, timeoutMs) {
    return new Promise((resolve) => {
      const start = Date.now();
      const interval = setInterval(() => {
        const el = finderFn();
        if (el) { clearInterval(interval); resolve(el); }
        else if (Date.now() - start > timeoutMs) { clearInterval(interval); resolve(null); }
      }, 150);
    });
  }

  function waitForCondition(conditionFn, timeoutMs, pollMs) {
    return new Promise((resolve) => {
      const start = Date.now();
      const interval = setInterval(() => {
        let result = false;
        try { result = !!conditionFn(); } catch (e) { result = false; }
        if (result) { clearInterval(interval); resolve(true); }
        else if (Date.now() - start > timeoutMs) { clearInterval(interval); resolve(false); }
      }, pollMs);
    });
  }

  // ============================================================
  // SCROLL THROUGH ALL TRADES, PROCESS CLOSES
  // ============================================================
  async function scrollAndProcessAll(myGeneration) {
    isScrollScanning = true;
    updatePanelUI();

    const glassPane = getGlassPane();
    let steps = 0;
    let lastSignature = null;
    let unchangedCount = 0;
    let foundAny = false;

    try {
      while (steps < MAX_SCROLL_STEPS) {
        if (myGeneration !== scanGeneration) {
          log('Scan cancelled: superseded by watchdog (generation changed).');
          return foundAny;
        }
        if (!isEnabled() || !isOnWalletPage() || circuitTripped) break;

        forceEnableFlutterSemantics();

        const closeBtn = findFirstSemanticsButtonByText('Close Position');
        if (closeBtn && isElementStillUsable(closeBtn)) {
          foundAny = true;
          const closedOk = await processClose(closeBtn, myGeneration);
          if (myGeneration !== scanGeneration) return foundAny;

          if (closedOk) {
            await sleep(POST_CLOSE_RETURN_DELAY_MS);
            forceReturnToWallet('post-close guaranteed return');
            return true;
          }

          const { x, y } = findTradesListAnchorPoint();
          for (let i = 0; i < steps + 3; i++) {
            if (myGeneration !== scanGeneration) return foundAny;
            await dragScroll(glassPane, x, y, -1);
            await sleep(120);
          }
          await sleep(SCROLL_SETTLE_MS);
          steps = 0; lastSignature = null; unchangedCount = 0;
          continue;
        }

        const signature = getVisibleTradesSignature();
        if (signature === lastSignature) {
          unchangedCount++;
          if (unchangedCount >= 2) {
            log('Reached bottom of trade list (no new content after scroll).');
            break;
          }
        } else {
          unchangedCount = 0;
        }
        lastSignature = signature;

        const { x, y } = findTradesListAnchorPoint();
        await dragScroll(glassPane, x, y, 1);
        dispatchWheelScroll(glassPane, x, y, 350);
        await sleep(SCROLL_SETTLE_MS);
        steps++;
      }

      if (myGeneration === scanGeneration && isOnWalletPage()) {
        const { x, y } = findTradesListAnchorPoint();
        for (let i = 0; i < steps + 6; i++) {
          if (myGeneration !== scanGeneration) break;
          await dragScroll(glassPane, x, y, -1);
          await sleep(80);
        }
      }
    } catch (err) {
      log('Error during scroll/scan pass:', err);
      auditLog('scan_error', String(err));
    } finally {
      if (myGeneration === scanGeneration) {
        isScrollScanning = false;
        updatePanelUI();
      }
    }

    return foundAny;
  }

  // ============================================================
  // MAIN SCAN CYCLE
  // ============================================================
  async function runScanCycle() {
    if (isProcessing || isScrollScanning || isReturningToWallet || circuitTripped) return;
    if (!isEnabled()) { updatePanelUI(); return; }
    if (!isOnWalletPage()) {
      if (!looksLikeLoginPage()) forceReturnToWallet('scan cycle detected non-wallet URL');
      return;
    }

    const myGeneration = scanGeneration;
    try {
      forceEnableFlutterSemantics();
      await scrollAndProcessAll(myGeneration);
    } catch (err) {
      log('runScanCycle: uncaught error, flags will be cleared by watchdog if stuck:', err);
      auditLog('scan_cycle_error', String(err));
    } finally {
      if (myGeneration === scanGeneration) updatePanelUI();
    }
  }

  function scheduleScan() {
    if (circuitTripped) return;

    const now = Date.now();
    if (scanTimerArmedAt === null) scanTimerArmedAt = now;

    const elapsedSinceArmed = now - scanTimerArmedAt;
    if (elapsedSinceArmed >= SCAN_DEBOUNCE_MAX_WAIT_MS) {
      if (scanTimer) clearTimeout(scanTimer);
      scanTimer = null;
      scanTimerArmedAt = null;
      runScanCycle();
      return;
    }

    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      scanTimerArmedAt = null;
      runScanCycle();
    }, SCAN_DEBOUNCE_MS);
  }

  // ============================================================
  // IDLE-RELOAD
  // ============================================================
  function idleReloadTick() {
    if (!isEnabled() || isReturningToWallet || circuitTripped) return;
    if (isProcessing || isScrollScanning) { lastActionTime = Date.now(); return; }

    const stillHasClose = !!findFirstSemanticsButtonByText('Close Position');
    if (stillHasClose) { lastActionTime = Date.now(); return; }

    const idleFor = Date.now() - lastActionTime;
    if (idleFor >= IDLE_RELOAD_GRACE_MS) {
      // forceReturnToWallet applies its own shared cooldown check now.
      forceReturnToWallet(`idle for ${Math.round(idleFor / 1000)}s, refreshing for latest data`);
    }
  }

  // ============================================================
  // URL WATCHDOG
  // ============================================================
  function urlWatchdogTick() {
    if (!isEnabled()) return;
    if (isReturningToWallet) return;
    if (looksLikeLoginPage()) return; // handled by sessionExpiryTick instead
    if (!isOnWalletPage()) {
      forceReturnToWallet(`URL watchdog detected drift to ${window.location.pathname}`);
    }
  }

  // ============================================================
  // STUCK-FLAG WATCHDOG
  // ============================================================
  function stuckFlagWatchdogTick() {
    const now = Date.now();
    let hadStuckFlag = false;

    if (isProcessing) {
      if (processingStartedAt === null) processingStartedAt = now;
      else if (now - processingStartedAt > STUCK_FLAG_TIMEOUT_MS) {
        log('WATCHDOG: isProcessing stuck. Force-clearing + cancelling stale scan.');
        auditLog('watchdog_stuck', 'isProcessing');
        isProcessing = false; processingStartedAt = null; hadStuckFlag = true;
        scanGeneration++;
        recordFailure('processing watchdog timeout');
      }
    } else {
      processingStartedAt = null;
    }

    if (isScrollScanning) {
      if (scrollScanningStartedAt === null) scrollScanningStartedAt = now;
      else if (now - scrollScanningStartedAt > STUCK_FLAG_TIMEOUT_MS) {
        log('WATCHDOG: isScrollScanning stuck. Force-clearing + cancelling stale scan.');
        auditLog('watchdog_stuck', 'isScrollScanning');
        isScrollScanning = false; scrollScanningStartedAt = null; hadStuckFlag = true;
        scanGeneration++;
      }
    } else {
      scrollScanningStartedAt = null;
    }

    if (isReturningToWallet) {
      if (returningToWalletStartedAt === null) returningToWalletStartedAt = now;
      else if (now - returningToWalletStartedAt > STUCK_FLAG_TIMEOUT_MS) {
        log('WATCHDOG: isReturningToWallet stuck. Force-clearing.');
        auditLog('watchdog_stuck', 'isReturningToWallet');
        isReturningToWallet = false; returningToWalletStartedAt = null; hadStuckFlag = true;
      }
    } else {
      returningToWalletStartedAt = null;
    }

    if (hadStuckFlag) {
      updatePanelUI();
      if (isEnabled() && !circuitTripped) scheduleScan();
    }
  }

  // ============================================================
  // OBSERVERS
  // ============================================================
  function fastPathCheckForImmediateClose() {
    const now = Date.now();
    if (now - lastFastPathCheck < FAST_PATH_MIN_INTERVAL_MS) return;
    lastFastPathCheck = now;

    if (isProcessing || isReturningToWallet || !isEnabled() || !isOnWalletPage() || circuitTripped) return;

    forceEnableFlutterSemantics();
    const closeBtn = findFirstSemanticsButtonByText('Close Position');
    if (!closeBtn || !isElementStillUsable(closeBtn)) return;

    if (isScrollScanning) return;

    log('FAST-PATH: Close Position button detected via mutation -- closing immediately.');
    const myGeneration = scanGeneration;
    (async () => {
      isScrollScanning = true;
      updatePanelUI();
      try {
        const closedOk = await processClose(closeBtn, myGeneration);
        if (myGeneration !== scanGeneration) return;
        if (closedOk) {
          await sleep(POST_CLOSE_RETURN_DELAY_MS);
          forceReturnToWallet('fast-path post-close guaranteed return');
        }
      } catch (err) {
        log('FAST-PATH: error during immediate close:', err);
        auditLog('fast_path_error', String(err));
      } finally {
        if (myGeneration === scanGeneration) {
          isScrollScanning = false;
          updatePanelUI();
        }
      }
    })();
  }

  const observer = new MutationObserver(() => {
    fastPathCheckForImmediateClose();
    if (!isProcessing && !isScrollScanning && !isReturningToWallet && isEnabled() && !circuitTripped) scheduleScan();
  });

  function startObserving() {
    const target = getGlassPane();
    observer.observe(target, { childList: true, subtree: true, attributes: true, characterData: true });
    log('MutationObserver attached to', target.tagName || 'body');
  }

  function patchHistoryForWatchdog() {
    const origPushState = history.pushState;
    const origReplaceState = history.replaceState;

    history.pushState = function (...args) {
      const ret = origPushState.apply(this, args);
      setTimeout(urlWatchdogTick, 50);
      return ret;
    };
    history.replaceState = function (...args) {
      const ret = origReplaceState.apply(this, args);
      setTimeout(urlWatchdogTick, 50);
      return ret;
    };
    window.addEventListener('popstate', () => setTimeout(urlWatchdogTick, 50));
  }

  function attachVisibilityRecovery() {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && isEnabled() && !circuitTripped) {
        log('Tab became visible again -- running immediate catch-up scan.');
        scheduleScan();
        urlWatchdogTick();
      }
    });
    window.addEventListener('focus', () => {
      if (isEnabled() && !circuitTripped) scheduleScan();
    });
  }

  // ------------------------------------------------------------
  // v2.3 KEY FIX: crash handlers no longer treat every uncaught error
  // on the page as a reason to reload. Invoapp's own Flutter app can
  // throw benign, non-fatal errors during normal rendering; reacting to
  // ALL of them by force-navigating away mid-render can interrupt
  // Invoapp's own state and cause the exact instability we're trying to
  // avoid. We now only react to errors/rejections that originate from
  // OUR script (this file, or the tick worker), identified by filename/
  // stack containing our known markers, or an explicit LOG_PREFIX tag
  // on the error message. Everything else is logged for visibility but
  // does not trigger a reload.
  // ------------------------------------------------------------
  const OWN_SCRIPT_MARKER = 'invoapp-auto-close';

  function errorLooksLikeOurs(source, message) {
    if (typeof source === 'string' && source.includes(OWN_SCRIPT_MARKER)) return true;
    if (typeof message === 'string' && message.includes(LOG_PREFIX)) return true;
    return false;
  }

  function attachCrashHandlers() {
    window.addEventListener('error', (e) => {
      const msg = e && e.message ? e.message : 'unknown error';
      const src = e && e.filename ? e.filename : '';
      log('GLOBAL ERROR OBSERVED:', msg, src);
      auditLog('global_error_observed', `${msg} @ ${src}`);

      if (!errorLooksLikeOurs(src, msg)) {
        // Not clearly ours -- most likely Invoapp's own app code. Do not reload.
        return;
      }
      log('Error attributed to this script -- recovering via wallet return.');
      auditLog('global_error_own', msg);
      if (isEnabled() && !isReturningToWallet) {
        forceReturnToWallet('recovering from uncaught error in this script');
      }
    });

    window.addEventListener('unhandledrejection', (e) => {
      const msg = e && e.reason ? String(e.reason) : 'unknown rejection';
      log('UNHANDLED PROMISE REJECTION OBSERVED:', msg);
      auditLog('unhandled_rejection_observed', msg);

      if (!errorLooksLikeOurs('', msg)) {
        // Can't confirm this came from our code -- don't reload on Invoapp's behalf.
        return;
      }
      log('Rejection attributed to this script -- recovering via wallet return.');
      auditLog('unhandled_rejection_own', msg);
      if (isEnabled() && !isReturningToWallet) {
        forceReturnToWallet('recovering from unhandled promise rejection in this script');
      }
    });
  }

  // ============================================================
  // INIT
  // ============================================================
  function init() {
    log('Invoapp Wallet Auto Close initialized (v2.3 -- fail-closed modal-scoped Confirm matching, post-close verification against the trade list, narrowed crash-handler scope, unified reload cooldown across all trigger sources).');
    auditLog('init', 'script started v2.3');
    createControlPanel();
    forceEnableFlutterSemantics();
    startObserving();
    patchHistoryForWatchdog();
    attachVisibilityRecovery();
    attachCrashHandlers();
    createTickWorker();

    setTimeout(() => runScanCycle(), 1500);
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') init();
  else window.addEventListener('DOMContentLoaded', init);
})();
