# Involio Auto Mimic Trader (Tampermonkey)

This project turns **Involio Mimic Trades into fully automated Mimic Trades** using a Tampermonkey userscript running in Chrome. It watches your Involio notifications and wallet pages, then automatically opens, updates, and closes copy trades based on the traders you follow. [file:1][file:3]

> **WARNING – USE AT YOUR OWN RISK**  
> This script automates real trades in your Involio account. You are responsible for your own risk, position sizing, and losses. Test with small size first and monitor it. This is not financial advice. [file:1][file:2]

---

## What this script does

- Runs as a **Tampermonkey userscript** in Chrome. [file:1][file:2][web:14]  
- Uses **two Chrome windows**:
  - `app.invoapp.com/notifications` – detects new “opened new trade” notifications and clicks **Mimic Trade** for you. [file:1][file:2][file:3]  
  - `app.invoapp.com/wallet` – tracks **Trade Updates** and **Trader Closed** and copies updates / closes your copies. [file:1][file:2][file:3]  
- Automatically:
  - Opens new mimic trades for the trade profiles you are **watching** on Involio.  
  - Copies trader updates to those trades (size changes, etc.).  
  - Closes your copy when the trader closes. [file:1][file:2][file:3]  

It does all of this by simulating clicks and keyboard events in the browser – **no Involio API needed**. [file:1][file:3]

---

## Quick install steps

1. **Install Tampermonkey in Chrome**  
   - Go to the Chrome Web Store and install **Tampermonkey**. [file:1][file:2][web:14]  
   - Make sure the extension is enabled and active in Chrome.

2. **Create the userscript and add the code**  
   - Click the Tampermonkey icon in Chrome → choose **“Dashboard”**. [web:14]  
   - Click **“+” (Add a new script)**.  
   - Delete any default code.  
   - Copy all of the code from `Invoapp-Auto-Mimic-Trader-19.0-3.js` in this repo and paste it into the new script. [file:3]  
   - Click **File → Save** (or the save icon).  

3. **Open the two required Chrome windows**  
   - **Window 1**:  
     - Go to `https://app.invoapp.com/notifications`  
     - This window is for **new trades** and Mimic Trade actions. [file:1][file:2]  
   - **Window 2**:  
     - Go to `https://app.invoapp.com/wallet`  
     - This window is for **Trade Updates** and **Trader Closed** (modifications and closes). [file:1][file:2]

4. **Pick your trade profiles on Involio**  
   - In your Involio account, **only watch the trade profiles you actually want to automate**. [file:1][file:2]  
   - If you **watch** a profile, this script will try to mimic its trades automatically.  
   - If you do **not** want a trader automated, **do not add them to your watch list**.  

5. **Keep the machine awake and Chrome active**  
   - Run this on a Windows PC that:
     - Does **not** go to sleep.  
     - Keeps Chrome running and the two tabs active (disable or whitelist Chrome’s “Memory Saver” for `app.invoapp.com`). [file:1][file:2]  
   - The script refreshes pages on its own to avoid things going stale. [file:1][file:3]

For full screenshots and more detailed Windows / Chrome sleep settings, see the PDF and DOCX in this repo. [file:1][file:2]

---

## Adjustable script settings (version 21.7)

All user settings live near the top of `Invoapp-Auto-Mimic-Trader-21_7.js`, under the big **“USER SETTINGS – SAFE KNOBS TO EDIT”** comment. You only need to change numbers on the right side of those `const` lines. [file:50]

### 1) Position size

- `FORCE_POSITION_PCT`  
  - `null` = **CAP mode**: follow trader size but cap it with `MAX_POSITION_PCT`.  
  - Number (e.g. `2.0`) = **FIXED mode**: always use that percent of your wallet per trade. [file:50]

- `MAX_POSITION_PCT`  
  - Used only in CAP mode.  
  - Example: `4.0` = “never use more than 4% position size, even if trader uses more.” [file:50]

### 2) Stop loss

- `MANAGE_STOP_LOSS`  
  - `true` = script sets a stop‑loss price automatically.  
  - `false` = script does not touch stop loss. [file:50]

- `STOP_LOSS_PCT`  
  - Percent distance from entry price.  
  - Example: `4.0` = 4% stop loss. [file:50]

- `REQUIRE_SL_BEFORE_CONFIRM`  
  - `true` = if the script cannot verify the stop loss, it **skips confirming** the trade.  
  - `false` = script will still confirm the trade even if SL verification is uncertain. [file:50]

### 3) Emergency wallet guard (account‑wide)

- `EMERGENCY_WALLET_LOSS_PCT`  
  - Example: `8.0` = trigger emergency if wallet loss is around −8% or worse. [file:50]

- `EMERGENCY_MAX_LOSS_USD`  
  - Example: `10.0` = trigger emergency if wallet loss is around −$10 or worse. [file:50]

- `EMERGENCY_REQUIRES_BOTH`  
  - `true` = emergency triggers only if **both** the percent and dollar limits are hit.  
  - `false` = emergency triggers if **either** limit is hit. [file:50]

- `PAUSE_NEW_OPENS_AFTER_EMERGENCY`  
  - `true` = pause opening **new** trades after an emergency event.  
  - `false` = do not pause new opens. [file:50]

- `RESUME_WALLET_UPDATES_AFTER_EMERGENCY`  
  - `true` = wallet tab continues watching so trader can close at profit even in emergency.  
  - `false` = stop wallet updates after emergency. [file:50]

- `ENABLE_AUDIO_ALERTS`  
  - `true` = play a **single beep** when emergency triggers (once per browser session).  
  - `false` = no sound. [file:50]

- `ENABLE_EMERGENCY_BANNER`  
  - `true` = show a red “LOSS ALERT” banner when in emergency mode.  
  - `false` = no banner. [file:50]

### 4) Per‑trade dollar stop loss (your $7.50 rule)

- `ENABLE_DOLLAR_STOP_LOSS`  
  - `true` = enable per‑trade dollar auto‑close.  
  - `false` = disable dollar‑based auto close. [file:50]

- `AUTO_CLOSE_USD_THRESHOLD`  
  - **Per‑trade dollar loss limit.**  
  - Example: `7.5` = close a trade when its loss reaches about **−$7.50**.  
  - To change to $25, set: `AUTO_CLOSE_USD_THRESHOLD = 25.0;` [file:50]

### 5) Symbol and leverage filters

- `SYMBOL_BLACKLIST`  
  - Array of symbols to block entirely.  
  - Example: `['DOGE', 'PEPE']` means those symbols will be skipped. [file:50]

- `MAX_ALLOWED_LEVERAGE`  
  - Maximum leverage allowed.  
  - Example: `20` = allow up to 20x; set `5` or `10` if you want it more conservative. [file:50]

### 6) Notification age

- `MAX_AGE_MINUTES`  
  - Ignore notifications older than this many minutes.  
  - Example: `10` = skip trades older than 10 minutes. [file:50]

**Advanced settings** (`SCAN_MS`, `RELOAD_MIN_S`, `RELOAD_MAX_S`, `MAX_EXEC_MS`, etc.) control timing and internal safety logic and should normally be left at their defaults unless you are comfortable tuning them. [file:50]


### Execution safety (locks, stuck flows, emergency)

- `MAX_EXEC_MS`  
  - Maximum time in milliseconds that any single “locked” action (open/update/close) is allowed to run before the script assumes it is stuck. Past this, it force‑resets the lock and returns to the home page. [file:50]

- Emergency loss handling and beep  
  - When the wallet hits certain emergency conditions, `abortForWalletEmergency(reason)` is called:  
    - Sets an `emergencyMode` flag.  
    - Logs an `EMERGENCY` entry.  
    - Shows a red emergency banner and plays a **single** alert beep for that browser session (tracked in `sessionStorage` so reloads don’t keep beeping). [file:50]

There is **no long pause on the wallet tab** anymore: version 20.5+ keeps wallet watching so the trader can still close at profit while you are in an emergency‑watch mode. [file:50]


---

## How to contribute or improve

If you are comfortable with code and want to improve this:

- **Fork** this repo on GitHub. [web:43]  
- Make your changes in your fork.  
- Open a **Pull Request** back to `reedhuish/invomimic` with:
  - A short description of what you changed.  
  - Why it’s safer or better.  

Please keep everything **open‑source and transparent** so the Involio community can review the script and avoid malicious changes. [file:3]

---

## Disclaimer

This project is **experimental automation** for Involio and may break if the site UI changes. [file:1][file:3]  
There is **no guarantee** of correctness, uptime, or profit. Do your own testing, use small size first, and monitor your account. You accept full responsibility for using this script.
