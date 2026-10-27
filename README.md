# Musee Musical masterclass booking

A static site (HTML, CSS, JS) plus a Google Apps Script backend.

```
index.html, styles.css, app.js, config.js   the website (host anywhere)
apps-script/Code.gs, appsscript.json        backend, paste into Apps Script
```

Open `index.html` before any setup and it runs in **preview mode** with fake slots and a fake pay button, so you can check the design.

## How a booking flows

1. The visitor picks **One-on-one** or **Group**, a date, and a 30 minute slot.
2. They fill in the form (validated in the browser and again on the server).
3. The server **holds the slot for 15 minutes** and writes a `PENDING_PAYMENT` row to the sheet. One-on-one slots are exclusive; group sessions count seats up to the capacity.
4. They pay with your Razorpay button. The server asks Razorpay's API whether a matching captured payment exists (the browser is never trusted), marks the row `PAID`, emails the confirmation, and adds the session to Google Calendar.
5. The page shows the success screen.

Slot boards re-check every 8 seconds and when the tab regains focus, so a slot booked by someone else greys out with a slash symbol within seconds. Apps Script has no push channel, so this is polling, not websockets. The server re-checks under a lock at reserve time, so two people can never get the same slot even if their screens were stale.

## Setup

1. **Sheet.** Create a Google Sheet. Open *Extensions > Apps Script*.
2. **Code.** Paste `apps-script/Code.gs` over the default file. In *Project Settings* tick "Show appsscript.json" and paste `apps-script/appsscript.json`.
3. **Edit `CONFIG`** at the top of `Code.gs`: your real `EVENT_DATES`, group `capacity`, `ADMIN_EMAIL`, and `VENUE_NOTE` if you want a venue line in the email.
4. **Razorpay keys.** *Project Settings > Script properties*: add `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` (use `rzp_test_` keys first). They stay on the server only.
5. **Authorise.** Select `checkSetup` in the editor and Run. Approve the permissions (Sheets, Mail, Calendar, external requests). It creates the `Bookings` and `Blocked` tabs.
6. **Auto payment checks.** Run `setupTriggers` once. Every minute it confirms payments (even if the visitor closed the page) and releases expired holds.
7. **Deploy.** *Deploy > New deployment > Web app*, execute as **Me**, access **Anyone**. Copy the `/exec` URL.
8. **Website.** Put the URL in `config.js` as `API_URL`, and your two Razorpay Payment Button IDs (`pl_...`). Upload the four site files to any static host (Netlify, GitHub Pages, your own server).

After changing `Code.gs` later, use *Deploy > Manage deployments > Edit > New version*, or your changes will not go live.

## Razorpay checklist

- **Amount.** The server only accepts a payment equal to base + 18% GST: Rs. 3,540 (one-on-one) and Rs. 1,770 (group). Set your buttons to those amounts, or change `GST_RATE` / set `CHECK_AMOUNT: false` in `CONFIG`. If your buttons charge the base price only, the website total shown would be wrong, so decide this first.
- **Auto-capture.** Payments must be captured, not just authorised. Check *Settings > Configuration > Payment capture*.
- **Matching.** Razorpay Payment Buttons cannot be pre-filled, so a payment is matched to a booking by the **email or mobile number** entered at checkout, plus the amount and time. The payment step tells visitors to use the same email. If neither matches, the row becomes `PAYMENT_REVIEW` and you get an email.
- **After payment.** If your button has a success-redirect URL setting, point it at your site: the page then verifies automatically. Without it, the "I have paid, check my payment" button and the one-minute trigger do the same job.

## Managing slots

- **Block a time** (Deirdre unavailable, lunch): add a row to the `Blocked` tab: date `2026-11-21`, time `13:00` (blank = whole day), type `individual`, `group` or `both`.
- **Bookings menu** (in the sheet): mark a row paid (for cash or bank transfers), cancel a row and free the slot, resend a confirmation.
- **Statuses:** `PENDING_PAYMENT`, `PAID`, `EXPIRED`, `CANCELLED`, `PAYMENT_REVIEW`, `PAID_SLOT_LOST` (paid after the hold lapsed and someone else took the slot: refund or rebook; you get an email).

## Things to know

- Both coaching types use the same 10:00 to 18:00 grid by default. If Deirdre cannot do a one-on-one and a group session at the same time, change the windows in `CONFIG.TYPES` or block times.
- Gmail limits `MailApp` to about 100 emails a day on a free account (1,500 on Workspace). Each booking sends 2 emails (participant and you).
- Add a CAPTCHA if you see abuse; slots are only held after the form is submitted, and one email can hold one unpaid slot at a time.
