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

## Adjustable settings (at the top of the script)

At the top of `Invoapp-Auto-Mimic-Trader-19.0-3.js` you will see simple settings you can edit with a text editor like Notepad. Change values, save, and refresh the tabs. [file:1][file:2][file:3]

Examples:

- **Position size mode**  
  - `FORCEPOSITIONPCT` – set a fixed position size in percent, e.g. `2.0` to always use 2%. [file:3]  
  - `MAXPOSITIONPCT` – cap trader size, e.g. `4.0` means “follow trader size but never above 4%”. [file:1][file:2][file:3]

- **Stop loss**  
  - `MANAGESTOPLOSS` – `true` or `false` to let the script inject a stop‑loss price.  
  - `STOPLOSSPCT` – percent distance from entry, e.g. `5.0` for 5%. [file:1][file:2][file:3]

- **Timing / safety** (examples)  
  - `SCANMS` – how often the script scans the page (default 2000 ms).  
  - `MAXAGEMINUTES` – ignore old notifications older than this.  
  - `RELOADMINS`, `RELOADMAXS` – random reload window to keep things fresh. [file:1][file:2][file:3]

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
