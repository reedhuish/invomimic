# Involio Auto Mimic Trader

Automatically opens, updates, and closes Involio mimic trades based on the traders you follow — no manual clicking required.

> **USE AT YOUR OWN RISK**  
> This script automates real trades in your Involio account. You are responsible for all losses. Test with small size first and keep an eye on it. This is not financial advice.

---

## How it works

The script runs as a Tampermonkey userscript in Chrome across two tabs:

| Tab | URL | What it does |
|-----|-----|--------------|
| Notifications | `app.invoapp.com/notifications` | Watches for new "opened trade" notifications and clicks Mimic Trade |
| Wallet | `app.invoapp.com/wallet` | Copies trade updates (size changes etc.) and closes your copy when the trader closes |

Everything works by simulating clicks and keyboard events — no Involio API access needed.

---

## Setup

### 1. Install Tampermonkey
Install the [Tampermonkey extension](https://chrome.google.com/webstore) in Chrome and make sure it's enabled.

### 2. Add the script
1. Click the Tampermonkey icon → **Dashboard**
2. Click **+** to create a new script
3. Delete the default code
4. Paste in the contents of `invoapp-mimic-trader-v22.5.user.js`
5. Save

### 3. Open both tabs
- Tab 1: `https://app.invoapp.com/notifications`
- Tab 2: `https://app.invoapp.com/wallet`

Keep both tabs open and visible. The script needs both running at the same time.

### 4. Choose who to follow
The script mimics trades from **everyone you follow** on Involio. Only follow traders you actually want automated.

### 5. Keep your machine awake
- Disable sleep on your PC
- Disable Chrome's Memory Saver for `app.invoapp.com` (or whitelist the domain)
- The script reloads pages on its own to stay fresh — just leave it running

---

## Settings

All settings are at the top of the script. Only edit the values on the right side of each `const` line.

### Position size

```js
FORCE_POSITION_PCT = null   // null = CAP mode (recommended), or set a fixed % e.g. 2.0
MAX_POSITION_PCT   = 4.0    // CAP mode only — never exceed this % of your wallet per trade
```

### Stop loss

```js
MANAGE_STOP_LOSS          = true    // automatically set a stop loss after each open
STOP_LOSS_PCT             = 4.0     // how far from entry price (%)
REQUIRE_SL_BEFORE_CONFIRM = false   // true = skip the trade if SL can't be verified
```

### Per-trade dollar stop loss

```js
ENABLE_DOLLAR_STOP_LOSS   = true    // auto-close any trade that hits the dollar loss limit
AUTO_CLOSE_USD_THRESHOLD  = 7.5     // close the trade when loss reaches this amount ($)
```

### Emergency guard

Triggers when a single trade loss exceeds both thresholds at once (or either, if you change `EMERGENCY_REQUIRES_BOTH`).

```js
EMERGENCY_WALLET_LOSS_PCT = 8.0     // % loss on a single trade
EMERGENCY_MAX_LOSS_USD    = 10.0    // $ loss on a single trade
EMERGENCY_REQUIRES_BOTH   = true    // true = both must breach, false = either triggers it
ENABLE_AUDIO_ALERTS       = true    // beep when emergency triggers
ENABLE_EMERGENCY_BANNER   = true    // show red banner when emergency triggers
```

When an emergency fires, the wallet tab keeps watching so the trader can still close at a better price. New opens are not paused — the script just alerts you.

### Symbol and leverage filters

```js
SYMBOL_WHITELIST    = []     // only trade these symbols — empty = trade all
SYMBOL_BLACKLIST    = []     // never trade these symbols — e.g. ['DOGE', 'PEPE']
MAX_ALLOWED_LEVERAGE = 20    // skip any trade above this leverage
```

### Notification age

```js
MAX_AGE_MINUTES = 10    // ignore notifications older than this
```

### Reload timing

```js
RELOAD_MIN_S = 15    // minimum seconds between page reloads
RELOAD_MAX_S = 45    // maximum seconds between page reloads
```

Don't set these above 60 — trades will be missed.

---

## Console commands

Open DevTools on either tab and run these at any time:

```js
window._status()           // print current state, queue, and activity log
window._pauseOpens(30)     // pause new trade opens for 30 minutes
window._unpause()          // clear the pause immediately
window._clearSeen()        // reset seen notifications (re-scans everything)
```

---

## Contributing

1. Fork this repo
2. Make your changes
3. Open a pull request with a short description of what changed and why

Please keep everything open source so the community can review it.

---

## Disclaimer

This is experimental automation that may break if the Involio UI changes. There is no guarantee of correctness, uptime, or profit. Use small size, monitor your account, and take full responsibility for running it.
