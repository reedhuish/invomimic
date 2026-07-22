# Invo Mimic – Wallet Auto Close

Automated **Close Position + Confirm** handling for [Invoapp](https://app.invoapp.com) mimicked trades — scoped to the **Wallet page only**.

This repo gives you **two ways to run the exact same automation**. Both options do the identical job — pick whichever fits your setup:

- **Option A — Chrome Extension** (`invo-auto-close-extension.zip`): no third-party tools needed, load it directly into Chrome as an unpacked extension.
- **Option B — Tampermonkey Script** (`invoapp-auto-close-v2.3.user.js`): if you already use Tampermonkey for other scripts, install this one alongside them.

Both options watch `https://app.invoapp.com/wallet`, detect "Close Position" buttons the instant a mimicked trader closes a position, click Close then Confirm inside the correct modal, verify the trade actually left your list, and return you to a freshly refreshed wallet page — fully hands-off.

> **Scope note:** This version does NOT open new trades and does NOT watch the Notifications page. It only handles closing existing mimic positions on the Wallet page. Auto-open/auto-mimic behavior is a separate, older script and is intentionally excluded from this repo.

> **IMPORTANT:** Only run ONE option at a time on the Wallet tab. Running both the Chrome extension and the Tampermonkey script together will cause them to compete for the same clicks.

---

## Features

- **Automatic Close + Confirm** — detects "Close Position" the moment it renders (via MutationObserver fast-path) and clicks Close, then Confirm, inside the correct modal only.
- **Modal-scoped Confirm matching** — never clicks a stray "Confirm" element elsewhere on the page; scoped strictly to the active close-position dialog.
- **Post-close verification** — confirms the trade actually disappeared from your list before considering the close successful.
- **Session-expiry protection** — detects if you've been logged out and stops automation instead of reload-looping against Invoapp's servers.
- **Circuit breaker with backoff** — pauses automatically (15s -> 30s -> 60s -> 120s) after repeated failures instead of hammering the site.
- **Persistent audit log** — every close attempt (success or fail) is timestamped and stored locally so you can verify exactly what happened and when.
- **Auto-return to wallet** — after every close, forces a full page refresh back to /wallet to pull the latest trade data.
- **On/off control panel** — a small floating panel on the page shows live status and lets you pause/resume instantly.

---

## What's in this repo

| File | Purpose |
|---|---|
| invo-auto-close-extension.zip | Chrome extension (Manifest V3) — Option A, no Tampermonkey needed |
| invoapp-auto-close-v2.3.user.js | Tampermonkey userscript — Option B, requires Tampermonkey extension |
| Invo-Wallet-Auto-Close-Setup-Guide.docx | Full setup instructions for BOTH options (Word document) |
| README.md | This file |

---

## What You Need

- A Windows or Mac computer that can stay on and awake while automation is running.
- Google Chrome (latest version).
- An Invoapp account (https://app.invoapp.com) with trade profiles already added to your watch list.
- If choosing Option B: the Tampermonkey extension for Chrome.

You only need to download the file for the option you choose, not both.

---

## Option A: Chrome Extension Install (no Tampermonkey required)

1. Download `invo-auto-close-extension.zip` from this repo.
2. Unzip it anywhere on your computer. Right-click the ZIP file and choose "Extract All" (Windows) or double-click it (Mac).
3. Open Google Chrome.
4. Type `chrome://extensions` into the address bar and press Enter.
5. Turn on **Developer mode** using the toggle switch in the top-right corner of the page.
6. Click the **Load unpacked** button that appears.
7. Select the unzipped extension folder and click "Select Folder".
8. The extension will now appear in your list of installed extensions, named "Invoapp Wallet Auto Close".
9. Go to https://app.invoapp.com/wallet and log in.
10. A small floating panel will appear in the bottom-right corner labeled "Invo Auto-Close" — that means it's running.

---

## Option B: Tampermonkey Script Install

1. Install the [Tampermonkey extension](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo) for Chrome, if you don't already have it.
2. Make sure the Tampermonkey icon appears in your Chrome extensions bar and is enabled.
3. Download `invoapp-auto-close-v2.3.user.js` from this repo.
4. Click the Tampermonkey icon in Chrome -> select **Dashboard**.
5. Click **"+" (Add a new script)** and delete any default code that appears.
6. Open the downloaded `.user.js` file in a text editor and copy ALL of its contents.
7. Paste the copied code into the Tampermonkey editor, replacing everything.
8. Click **File -> Save** (or the save icon).
9. Go to https://app.invoapp.com/wallet and log in, or refresh the page if it's already open.
10. The same floating "Invo Auto-Close" panel will appear in the bottom-right corner.

---

## Choose Which Traders to Automate

Both options act only on trades that already exist in your Invoapp wallet. Those trades exist because you are watching specific trade profiles in Invoapp.

- To automate a trader: add their trade profile to your watch list inside Invoapp.
- To avoid automating a trader: do not watch that trade profile.
- Anything on your watch list will be treated as approved for automated closing — good or bad.

---

## Keep Your Computer and Chrome Awake

This automation only works while your computer is on, Chrome is open, and the Wallet tab is not put to sleep. This applies to BOTH options equally.

**Windows power settings:**
- Open Settings -> System -> Power & Sleep.
- Set Sleep to "Never" while plugged in.

**Chrome tab sleeping:**
- Go to Chrome Settings -> Performance.
- Under "Always keep these sites active," add app.invoapp.com.

---

## Understanding the Floating Status Panel

Whether you use Option A or Option B, the same panel appears in the corner of the Wallet page and shows the current state at all times:

- Green dot — running normally, watching for closes.
- Yellow dot — actively closing a trade right now.
- Blue dot — scanning through your trade list.
- Purple dot — returning to the wallet page (refreshing).
- Orange dot — circuit breaker paused after repeated failures; resumes automatically.
- Red dot — turned off, or session expired (log in again manually).

Click "Toggle" on the panel to turn automation on or off at any time. Click "View Audit Log" to see a full history of every close attempt in the browser console (press F12 to view it).

---

## How It Works (Plain English)

- The automation only runs on the Wallet page — it never touches Notifications or any other page.
- It continuously scans (and instantly reacts via a mutation observer) for a "Close Position" button next to any of your open mimic trades.
- When found, it clicks Close Position, waits for the confirmation popup, and clicks Confirm — scoped strictly to that popup so it can never misfire on an unrelated button.
- It waits a few seconds for Invoapp to process the close, verifies the trade is gone, then refreshes the wallet page to pull the latest data.
- If something goes wrong repeatedly (session expired, site changed, network issue) it pauses itself and shows a warning instead of retrying forever.

---

## Safety & Disclaimer

- This is experimental browser automation. It can fail, mis-click, or stop working if Invoapp changes its site.
- You are fully responsible for any trades, gains, or losses that result from using this tool.
- Start by watching the floating status panel closely for the first few closes before trusting it unattended.
- Check the audit log regularly to confirm closes are actually happening as expected.
- Do not run Option A and Option B at the same time on the same Wallet tab.

---

## Support / Contact

**Reed Huish**
Email: [reed@zpower.com](mailto:reed@zpower.com)
GitHub: [github.com/reedhuish/invomimic](https://github.com/reedhuish/invomimic)

---

## Version

Current release: **v2.3** — modal-scoped Confirm matching, post-close verification, session-expiry detection, circuit breaker, persistent audit log. Identical logic shipped as both a Chrome extension and a Tampermonkey script.
