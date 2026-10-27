/**
 * Musee Musical – Masterclass booking backend (Google Apps Script)
 *
 * Bind this script to the Google Sheet that should store the bookings
 * (Sheet > Extensions > Apps Script), then follow README.md.
 *
 * What it does
 *  - Serves slot availability (one-on-one = exclusive, group = capacity based)
 *  - Reserves a slot/seat under a script lock (no double booking), holding it
 *    for CONFIG.HOLD_MINUTES while the person pays
 *  - Confirms payments by asking Razorpay's API (never trusts the browser)
 *  - Writes every booking to the "Bookings" sheet
 *  - Sends the confirmation email and adds the session to Google Calendar
 */

/* ============================== CONFIG ============================== */

var CONFIG = {
  EVENT_TITLE: 'Unleash Your Voice – A Masterclass',
  HOST_NAME: 'Deirdre',
  ORGANISATION: 'Musee Musical',
  TIMEZONE: 'Asia/Kolkata',

  // Dates (yyyy-mm-dd) people can book. Replace with your real masterclass date(s).
  EVENT_DATES: ['2026-11-21'],

  SLOT_MINUTES: 30,   // length of every slot
  HOLD_MINUTES: 15,   // how long a slot is held while someone pays
  GST_RATE: 0.18,     // shown on the site and used to check the paid amount

  TYPES: {
    individual: { label: 'One-on-One Coaching', base: 3000, capacity: 1,  start: '10:00', end: '18:00' },
    group:      { label: 'Group Coaching',      base: 1500, capacity: 10, start: '10:00', end: '18:00' }
  },

  // Reject payments whose amount differs from base + GST. Set false if your
  // Razorpay buttons use a different amount.
  CHECK_AMOUNT: true,

  ADMIN_EMAIL: '',    // '' = the Google account that owns this script
  REPLY_TO: '',       // '' = same as admin email
  VENUE_NOTE: '',     // optional line added to the confirmation email, e.g. venue / address
  ADD_TO_CALENDAR: true,

  SHEET_BOOKINGS: 'Bookings',
  SHEET_BLOCKED: 'Blocked'
};

var STATUS = {
  PENDING: 'PENDING_PAYMENT',
  PAID: 'PAID',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED',
  REVIEW: 'PAYMENT_REVIEW',
  LOST: 'PAID_SLOT_LOST'
};

var FIELDS = [
  ['id', 'Booking ID'], ['created', 'Created'], ['status', 'Status'],
  ['type', 'Type'], ['date', 'Date'], ['time', 'Time'],
  ['firstName', 'First Name'], ['lastName', 'Last Name'], ['email', 'Email'],
  ['age', 'Age'], ['mobile', 'Mobile'], ['level', 'Singer Level'],
  ['reason', 'What brings you'], ['goal', 'Aim in music journey'],
  ['challenges', 'Daily challenges'], ['focus', 'Specific focus'],
  ['firstTime', 'First time with host'], ['heard', 'Heard about us'],
  ['amount', 'Amount (INR incl. GST)'], ['paymentId', 'Payment ID'],
  ['paidAt', 'Paid at'], ['holdUntil', 'Hold expires'],
  ['calendarId', 'Calendar event ID'], ['notes', 'Notes']
];
var COL = {};
FIELDS.forEach(function (f, i) { COL[f[0]] = i; });

var LEVELS = ['Beginner singer', 'Intermediate singer', 'Professional singer', 'Advanced singer', 'Semi-professional singer'];
var HEARD = ['Facebook', 'Instagram', 'Linkedin', 'Other'];

/* ============================== HTTP ============================== */

function doGet(e) {
  var p = (e && e.parameter) || {};
  try {
    switch (p.action) {
      case 'config': return json_(getConfig_());
      case 'slots': return json_(getSlots_(p.date));
      case 'status': return json_(getStatus_(p.id));
      default: return json_({ ok: false, code: 'BAD_ACTION' });
    }
  } catch (err) { return fail_(err); }
}

function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    switch (body.action) {
      case 'reserve': return json_(reserve_(body));
      case 'verify': return json_(verify_(String(body.bookingId || ''), body.paymentId));
      case 'release': return json_(release_(String(body.bookingId || '')));
      default: return json_({ ok: false, code: 'BAD_ACTION' });
    }
  } catch (err) { return fail_(err); }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function fail_(err) {
  console.error(err && err.stack ? err.stack : err);
  return json_({ ok: false, code: 'SERVER_ERROR', message: 'Something went wrong on our side. Please try again in a moment.' });
}

/* ============================== PUBLIC DATA ============================== */

function getConfig_() {
  var types = {};
  Object.keys(CONFIG.TYPES).forEach(function (k) {
    var t = CONFIG.TYPES[k], pr = priceFor_(k);
    types[k] = { label: t.label, capacity: t.capacity, base: pr.base, gst: pr.gst, total: pr.total, start: t.start, end: t.end };
  });
  var today = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd');
  return {
    ok: true,
    title: CONFIG.EVENT_TITLE,
    host: CONFIG.HOST_NAME,
    dates: CONFIG.EVENT_DATES.filter(function (d) { return d >= today; }),
    slotMinutes: CONFIG.SLOT_MINUTES,
    holdMinutes: CONFIG.HOLD_MINUTES,
    gstRate: CONFIG.GST_RATE,
    types: types,
    serverNow: nowIso_()
  };
}

function getSlots_(date) {
  date = String(date || '');
  if (CONFIG.EVENT_DATES.indexOf(date) < 0) return { ok: false, code: 'BAD_DATE', message: 'That date is not available.' };
  var cache = CacheService.getScriptCache(), key = 'slots:' + date;
  var hit = cache.get(key);
  if (hit) return JSON.parse(hit);
  var res = computeSlots_(date);
  cache.put(key, JSON.stringify(res), 5);
  return res;
}

function computeSlots_(date) {
  var now = Date.now();
  var all = readBookings_(bookingsSheet_());
  var blocked = readBlocked_();
  var out = { ok: true, date: date, serverNow: nowIso_() };
  Object.keys(CONFIG.TYPES).forEach(function (k) { out[k] = buildSlots_(k, date, all, blocked, now); });
  return out;
}

function buildSlots_(typeKey, date, bookings, blocked, nowMs) {
  var t = CONFIG.TYPES[typeKey], out = [];
  for (var m = toMin_(t.start); m + CONFIG.SLOT_MINUTES <= toMin_(t.end); m += CONFIG.SLOT_MINUTES) {
    var time = fromMin_(m), taken = 0;
    bookings.forEach(function (b) {
      if (b.type === typeKey && b.date === date && b.time === time && isActive_(b, nowMs)) taken++;
    });
    var remaining = Math.max(0, t.capacity - taken), status = 'open';
    if (isBlocked_(blocked, typeKey, date, time)) status = 'blocked';
    else if (slotStart_(date, time).getTime() <= nowMs) status = 'past';
    else if (remaining <= 0) status = 'full';
    out.push({ time: time, end: fromMin_(m + CONFIG.SLOT_MINUTES), capacity: t.capacity, remaining: status === 'open' ? remaining : 0, status: status });
  }
  return out;
}

function getStatus_(id) {
  var b = findBooking_(bookingsSheet_(), String(id || ''));
  if (!b) return { ok: false, code: 'NOT_FOUND' };
  var status = b.status;
  if (status === STATUS.PENDING && Date.parse(b.holdUntil) <= Date.now()) status = STATUS.EXPIRED;
  return { ok: true, status: status, type: b.type, date: b.date, time: b.time, reference: reference_(b.id), holdUntil: b.holdUntil, serverNow: nowIso_() };
}

/* ============================== RESERVE / RELEASE ============================== */

function reserve_(raw) {
  if (raw.website) return { ok: false, code: 'REJECTED', message: 'We could not process this request.' }; // honeypot
  var d = clean_(raw);
  var errors = validate_(d);
  if (Object.keys(errors).length) return { ok: false, code: 'VALIDATION', errors: errors, message: 'Please check the highlighted fields.' };

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, code: 'BUSY', message: 'We are handling a lot of bookings right now. Please try again in a few seconds.' };
  var booking, price;
  try {
    var sh = bookingsSheet_(), now = Date.now(), all = readBookings_(sh);

    // Their own earlier unpaid holds don't count against them.
    var others = all.filter(function (b) { return !(b.status === STATUS.PENDING && b.email === d.email); });
    var dupPaid = others.some(function (b) {
      return b.status === STATUS.PAID && b.email === d.email && b.type === d.type && b.date === d.date && b.time === d.time;
    });
    if (dupPaid) return { ok: false, code: 'ALREADY_BOOKED', message: 'This email already has a confirmed booking for that slot.' };

    var slot = buildSlots_(d.type, d.date, others, readBlocked_(), now).filter(function (s) { return s.time === d.time; })[0];
    if (!slot || slot.status !== 'open') {
      return { ok: false, code: 'SLOT_TAKEN', message: d.type === 'group' ? 'That group session just filled up. Please pick another.' : 'That slot was just booked. Please pick another.' };
    }

    // release this person's previous unpaid holds
    all.forEach(function (b) {
      if (b.status === STATUS.PENDING && b.email === d.email) {
        patchBooking_(sh, b, { status: STATUS.CANCELLED, notes: addNote_(b.notes, 'Replaced by a newer reservation') });
        clearCache_(b.date);
      }
    });

    price = priceFor_(d.type);
    booking = {
      id: Utilities.getUuid().replace(/-/g, '').slice(0, 20),
      created: nowIso_(),
      status: STATUS.PENDING,
      type: d.type, date: d.date, time: d.time,
      firstName: d.firstName, lastName: d.lastName, email: d.email, age: d.age, mobile: d.mobile,
      level: d.level, reason: d.reason, goal: d.goal, challenges: d.challenges, focus: d.focus,
      firstTime: d.firstTime,
      heard: d.heard === 'Other' ? 'Other: ' + d.heardOther : d.heard,
      amount: String(price.total), paymentId: '', paidAt: '',
      holdUntil: nowIso_(new Date(now + CONFIG.HOLD_MINUTES * 60000)),
      calendarId: '', notes: ''
    };
    appendBooking_(sh, booking);
    clearCache_(d.date);
  } finally { lock.releaseLock(); }

  return {
    ok: true, bookingId: booking.id, reference: reference_(booking.id),
    type: booking.type, date: booking.date, time: booking.time,
    amount: price, holdUntil: booking.holdUntil, serverNow: nowIso_()
  };
}

function release_(id) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var sh = bookingsSheet_(), b = findBooking_(sh, id);
    if (!b) return { ok: false, code: 'NOT_FOUND' };
    if (b.status === STATUS.PENDING) {
      patchBooking_(sh, b, { status: STATUS.CANCELLED, notes: addNote_(b.notes, 'Released by visitor') });
      clearCache_(b.date);
    }
    return { ok: true, status: b.status };
  } finally { lock.releaseLock(); }
}

/* ============================== PAYMENT ============================== */

/** Called by the page ("I've completed my payment", or after Razorpay redirects back). */
function verify_(id, paymentId) {
  var sh = bookingsSheet_(), b = findBooking_(sh, id);
  if (!b) return { ok: false, code: 'NOT_FOUND', message: 'We could not find this reservation.' };
  if (b.status === STATUS.PAID) return { ok: true, status: STATUS.PAID };
  if (b.status === STATUS.CANCELLED) return { ok: false, code: 'CANCELLED', message: 'This reservation was released. Please choose a slot again.' };
  if (!rzAuth_()) return { ok: true, status: b.status, manual: true };

  var all = readBookings_(sh), used = usedPaymentIds_(all, b.id), pay = null;

  if (paymentId) {
    paymentId = String(paymentId);
    if (!/^pay_[A-Za-z0-9]{8,24}$/.test(paymentId)) return { ok: false, code: 'BAD_PAYMENT', message: 'That payment reference looks invalid.' };
    pay = rzGet_('/payments/' + paymentId);
    if (!pay || pay.notFound) return { ok: false, code: 'PAYMENT_NOT_FOUND', message: 'Razorpay does not know that payment yet.' };
    var why = checkPayment_(pay, b, used);
    if (why === 'NOT_CAPTURED') return { ok: true, status: b.status, waiting: true };
    if (why === 'IDENTITY') {
      patchBooking_(sh, b, { status: STATUS.REVIEW, paymentId: pay.id, notes: addNote_(b.notes, 'Payment email/phone did not match - review manually') });
      adminAlert_('Payment needs review', 'Payment ' + pay.id + ' looks valid but its email/phone does not match booking ' + reference_(b.id) + ' (' + b.email + '). Check it in Razorpay, then use Bookings > Mark selected row as PAID.');
      return { ok: true, status: STATUS.REVIEW };
    }
    if (why) return { ok: false, code: 'PAYMENT_INVALID', message: 'We could not match that payment to this booking.' };
  } else {
    pay = findPaymentFor_(b, used);
    if (!pay) return { ok: true, status: b.status, waiting: true };
  }
  var r = finalizePaid_(b.id, pay.id, 'razorpay');
  return { ok: true, status: r.status };
}

/** Returns '' when the payment is valid for this booking, otherwise a reason code. */
function checkPayment_(p, b, used) {
  if (!(p.status === 'captured' || p.captured === true)) return 'NOT_CAPTURED';
  if (p.currency && p.currency !== 'INR') return 'CURRENCY';
  if (CONFIG.CHECK_AMOUNT && p.amount !== Math.round(priceFor_(b.type).total * 100)) return 'AMOUNT';
  if (p.created_at * 1000 < Date.parse(b.created) - 120000) return 'OLD';
  if (used[p.id]) return 'USED';
  var sameEmail = String(p.email || '').trim().toLowerCase() === b.email;
  var l10 = last10_(p.contact), samePhone = l10.length >= 8 && l10 === last10_(b.mobile);
  if (!sameEmail && !samePhone) return 'IDENTITY';
  return '';
}

function findPaymentFor_(b, used) {
  var list = listPayments_(Math.floor(Date.parse(b.created) / 1000) - 120);
  var hits = list.filter(function (p) { return !checkPayment_(p, b, used); });
  hits.sort(function (a, c) { return a.created_at - c.created_at; });
  return hits[0] || null;
}

/**
 * Marks a booking paid (or flags it if the slot was lost while the hold lapsed).
 * Sends the confirmation email and calendar entry.
 */
function finalizePaid_(id, paymentId, via) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  var sh, b, status, already = false;
  try {
    sh = bookingsSheet_();
    var all = readBookings_(sh), nowMs = Date.now();
    b = all.filter(function (x) { return x.id === id; })[0];
    if (!b) return { ok: false, status: 'NOT_FOUND' };
    if (b.status === STATUS.PAID) { already = true; status = STATUS.PAID; }
    else {
      var ok = b.status === STATUS.PENDING && Date.parse(b.holdUntil) > nowMs;
      if (!ok) { // hold lapsed: reclaim only if nobody else took the place
        var taken = 0;
        all.forEach(function (x) {
          if (x.id !== id && x.type === b.type && x.date === b.date && x.time === b.time && isActive_(x, nowMs)) taken++;
        });
        ok = taken < CONFIG.TYPES[b.type].capacity;
      }
      status = ok ? STATUS.PAID : STATUS.LOST;
      patchBooking_(sh, b, ok
        ? { status: STATUS.PAID, paymentId: paymentId, paidAt: nowIso_(), holdUntil: '', notes: addNote_(b.notes, 'Paid via ' + via) }
        : { status: STATUS.LOST, paymentId: paymentId, notes: addNote_(b.notes, 'Paid after the hold expired and the slot was taken') });
      clearCache_(b.date);
    }
  } finally { lock.releaseLock(); }

  if (already) return { ok: true, status: status };
  if (status === STATUS.PAID) afterPaid_(sh, b);
  else lostSlot_(b);
  return { ok: true, status: status };
}

function afterPaid_(sh, b) {
  try { calendarSync_(sh, b); } catch (e) { console.error('Calendar: ' + e); patchBooking_(sh, b, { notes: addNote_(b.notes, 'Calendar failed: ' + e) }); }
  try { sendConfirmationEmail_(b); } catch (e) { console.error('Email: ' + e); patchBooking_(sh, b, { notes: addNote_(b.notes, 'Email failed: ' + e) }); }
  try {
    adminAlert_('New booking: ' + b.firstName + ' ' + b.lastName + ' (' + typeLabel_(b) + ')',
      reference_(b.id) + '\n' + typeLabel_(b) + ' on ' + b.date + ' at ' + b.time + '\n' + b.firstName + ' ' + b.lastName + ' <' + b.email + '> ' + b.mobile + '\nPayment: ' + b.paymentId);
  } catch (e) { console.error('Admin mail: ' + e); }
}

function lostSlot_(b) {
  adminAlert_('Refund needed: slot lost', 'Payment ' + b.paymentId + ' for ' + b.firstName + ' ' + b.lastName + ' <' + b.email + '> arrived after the hold expired and the slot ' + b.date + ' ' + b.time + ' (' + b.type + ') was taken. Please refund or rebook them.');
  try {
    MailApp.sendEmail({
      to: b.email, name: CONFIG.ORGANISATION, replyTo: replyTo_(),
      subject: 'About your booking – ' + CONFIG.EVENT_TITLE,
      body: 'Hi ' + b.firstName + ',\n\nYour payment reached us just after your reserved slot was released, and the slot has since been booked by someone else. We will contact you shortly to move you to another slot or refund you in full.\n\n' + CONFIG.ORGANISATION
    });
  } catch (e) { console.error(e); }
}

/* ============================== RAZORPAY API ============================== */

function rzAuth_() {
  var p = PropertiesService.getScriptProperties();
  var k = p.getProperty('RAZORPAY_KEY_ID'), s = p.getProperty('RAZORPAY_KEY_SECRET');
  return (k && s) ? 'Basic ' + Utilities.base64Encode(k + ':' + s) : null;
}

function rzGet_(path) {
  var auth = rzAuth_();
  if (!auth) return null;
  var res = UrlFetchApp.fetch('https://api.razorpay.com/v1' + path, { method: 'get', headers: { Authorization: auth }, muteHttpExceptions: true });
  var code = res.getResponseCode();
  if (code === 404 || code === 400) return { notFound: true };
  if (code >= 300) throw new Error('Razorpay API returned ' + code);
  return JSON.parse(res.getContentText());
}

function listPayments_(fromSec) {
  var out = [], to = Math.floor(Date.now() / 1000) + 60;
  for (var skip = 0; skip < 300; skip += 100) {
    var r = rzGet_('/payments?from=' + fromSec + '&to=' + to + '&count=100&skip=' + skip);
    if (!r || !r.items) break;
    out = out.concat(r.items);
    if (r.items.length < 100) break;
  }
  return out;
}

function usedPaymentIds_(all, exceptBookingId) {
  var used = {};
  all.forEach(function (x) { if (x.paymentId && x.id !== exceptBookingId) used[x.paymentId] = true; });
  return used;
}

/* ============================== TRIGGER: runs every minute ============================== */

/** Expires lapsed holds and confirms payments even when the visitor closed the page. */
function reconcile() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  var candidates, used;
  try {
    var sh = bookingsSheet_(), all = readBookings_(sh), now = Date.now();
    all.forEach(function (b) {
      if (b.status === STATUS.PENDING && Date.parse(b.holdUntil) <= now) {
        patchBooking_(sh, b, { status: STATUS.EXPIRED });
        b.status = STATUS.EXPIRED;
        clearCache_(b.date);
      }
    });
    var dayAgo = now - 24 * 3600 * 1000;
    candidates = all.filter(function (b) {
      return (b.status === STATUS.PENDING || b.status === STATUS.EXPIRED) && !b.paymentId && Date.parse(b.created) > dayAgo;
    });
    used = usedPaymentIds_(all, '');
  } finally { lock.releaseLock(); }

  if (!candidates.length || !rzAuth_()) return;
  var from = Math.min.apply(null, candidates.map(function (b) { return Date.parse(b.created); })) / 1000 - 120;
  var payments = listPayments_(Math.floor(from));
  candidates.forEach(function (b) {
    var p = payments.filter(function (x) { return !checkPayment_(x, b, used); })[0];
    if (p) { used[p.id] = true; finalizePaid_(b.id, p.id, 'razorpay-auto'); }
  });
}

function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'reconcile') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('reconcile').timeBased().everyMinutes(1).create();
  try { SpreadsheetApp.getUi().alert('Done. Payments are now checked every minute.'); } catch (e) { /* run from the editor */ }
}

/* ============================== EMAIL ============================== */

function typeLabel_(b) { return CONFIG.TYPES[b.type].label; }
function replyTo_() { return CONFIG.REPLY_TO || adminEmail_(); }
function adminEmail_() { return CONFIG.ADMIN_EMAIL || Session.getEffectiveUser().getEmail(); }

function adminAlert_(subject, body) {
  MailApp.sendEmail({ to: adminEmail_(), subject: '[' + CONFIG.ORGANISATION + '] ' + subject, body: body, name: CONFIG.ORGANISATION });
}

function esc_(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
}

function sendConfirmationEmail_(b) {
  var start = slotStart_(b.date, b.time), end = addMinutes_(start, CONFIG.SLOT_MINUTES);
  var dateLong = Utilities.formatDate(start, CONFIG.TIMEZONE, 'EEEE, d MMMM yyyy');
  var when = Utilities.formatDate(start, CONFIG.TIMEZONE, 'h:mm a') + ' – ' + Utilities.formatDate(end, CONFIG.TIMEZONE, 'h:mm a');
  var ref = reference_(b.id);
  var calUrl = 'https://calendar.google.com/calendar/render?action=TEMPLATE'
    + '&text=' + encodeURIComponent(CONFIG.EVENT_TITLE + ' – ' + typeLabel_(b))
    + '&dates=' + Utilities.formatDate(start, CONFIG.TIMEZONE, "yyyyMMdd'T'HHmmss") + '/' + Utilities.formatDate(end, CONFIG.TIMEZONE, "yyyyMMdd'T'HHmmss")
    + '&ctz=' + encodeURIComponent(CONFIG.TIMEZONE)
    + '&details=' + encodeURIComponent('Booking reference ' + ref);
  var rows = [
    ['Reference', ref], ['Session', typeLabel_(b)], ['Date', dateLong], ['Your slot', when],
    ['Masterclass hours', '10:00 am – 6:00 pm'], ['Amount paid', 'Rs. ' + b.amount + ' (incl. GST)'], ['Payment ID', b.paymentId]
  ];
  var tr = rows.map(function (r) {
    return '<tr><td style="padding:8px 0;color:#6b6480;width:42%">' + esc_(r[0]) + '</td><td style="padding:8px 0;color:#1d1530;font-weight:600">' + esc_(r[1]) + '</td></tr>';
  }).join('');
  var html = '<div style="background:#f3f1f8;padding:24px 12px;font-family:Arial,Helvetica,sans-serif">'
    + '<div style="max-width:560px;margin:auto;background:#fff;border-radius:16px;overflow:hidden">'
    + '<div style="background:#1a0f33;color:#fff;padding:28px"><div style="font-size:13px;opacity:.75">' + esc_(CONFIG.ORGANISATION) + '</div>'
    + '<div style="font-size:24px;font-weight:700;margin-top:6px">You\'re booked in, ' + esc_(b.firstName) + '</div></div>'
    + '<div style="padding:24px 28px;color:#1d1530;line-height:1.55">'
    + '<p style="margin:0 0 16px">Thank you for registering for <b>' + esc_(CONFIG.EVENT_TITLE) + '</b> with ' + esc_(CONFIG.HOST_NAME) + '. Your payment is confirmed and your place is reserved.</p>'
    + '<table style="width:100%;border-collapse:collapse;font-size:15px;border-top:1px solid #e8e4f2;border-bottom:1px solid #e8e4f2">' + tr + '</table>'
    + (CONFIG.VENUE_NOTE ? '<p style="margin:16px 0 0">' + esc_(CONFIG.VENUE_NOTE) + '</p>' : '')
    + '<p style="margin:20px 0"><a href="' + calUrl + '" style="background:#f3b562;color:#2a1200;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:999px;display:inline-block">Add to Google Calendar</a></p>'
    + '<p style="margin:0;color:#6b6480;font-size:14px">Need to change something? Reply to this email and quote ' + esc_(ref) + '.</p>'
    + '</div></div></div>';
  var plain = 'Hi ' + b.firstName + ',\n\nYour booking is confirmed.\n\n'
    + rows.map(function (r) { return r[0] + ': ' + r[1]; }).join('\n')
    + (CONFIG.VENUE_NOTE ? '\n\n' + CONFIG.VENUE_NOTE : '')
    + '\n\nAdd to calendar: ' + calUrl + '\n\n' + CONFIG.ORGANISATION;
  MailApp.sendEmail({
    to: b.email, name: CONFIG.ORGANISATION, replyTo: replyTo_(),
    subject: 'Booking confirmed – ' + CONFIG.EVENT_TITLE + ' (' + ref + ')',
    body: plain, htmlBody: html
  });
}

/* ============================== CALENDAR ============================== */

function describe_(b) {
  return 'Reference ' + reference_(b.id) + '\n' + b.firstName + ' ' + b.lastName + '\n' + b.email + '\n' + b.mobile
    + '\nLevel: ' + b.level + '\nFocus: ' + b.focus;
}

function calendarSync_(sh, b) {
  if (!CONFIG.ADD_TO_CALENDAR) return;
  var start = slotStart_(b.date, b.time), end = addMinutes_(start, CONFIG.SLOT_MINUTES);
  if (b.type === 'individual') {
    var ev = CalendarApp.getDefaultCalendar().createEvent(typeLabel_(b) + ' – ' + b.firstName + ' ' + b.lastName, start, end, { description: describe_(b) });
    patchBooking_(sh, b, { calendarId: ev.getId() });
  } else {
    var id = syncGroupEvent_(sh, b.date, b.time);
    if (id) patchBooking_(sh, b, { calendarId: id });
  }
}

/** One calendar event per group session; title shows how many are booked. */
function syncGroupEvent_(sh, date, time) {
  var t = CONFIG.TYPES.group, cal = CalendarApp.getDefaultCalendar();
  var start = slotStart_(date, time), end = addMinutes_(start, CONFIG.SLOT_MINUTES);
  var people = readBookings_(sh).filter(function (x) {
    return x.type === 'group' && x.date === date && x.time === time && x.status === STATUS.PAID;
  });
  var ev = cal.getEvents(start, end, { search: t.label }).filter(function (e) {
    return e.getTitle().indexOf(t.label) === 0 && e.getStartTime().getTime() === start.getTime();
  })[0];
  if (!people.length) { if (ev) ev.deleteEvent(); return ''; }
  var title = t.label + ' (' + people.length + '/' + t.capacity + ')';
  var desc = people.map(function (p) { return p.firstName + ' ' + p.lastName + ' <' + p.email + '> ' + p.mobile; }).join('\n');
  if (!ev) ev = cal.createEvent(title, start, end, { description: desc });
  else { ev.setTitle(title); ev.setDescription(desc); }
  return ev.getId();
}

/* ============================== SHEET HELPERS ============================== */

function spreadsheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    var id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
    if (!id) throw new Error('Open this script from a Google Sheet (Extensions > Apps Script) or set the SHEET_ID script property.');
    ss = SpreadsheetApp.openById(id);
  }
  return ss;
}

function bookingsSheet_() {
  var ss = spreadsheet_(), sh = ss.getSheetByName(CONFIG.SHEET_BOOKINGS);
  if (!sh) {
    sh = ss.insertSheet(CONFIG.SHEET_BOOKINGS);
    sh.getRange(1, 1, sh.getMaxRows(), FIELDS.length).setNumberFormat('@'); // plain text: keeps "+91…" and blocks formulas
    sh.getRange(1, 1, 1, FIELDS.length).setValues([FIELDS.map(function (f) { return f[1]; })]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function blockedSheet_() {
  var ss = spreadsheet_(), sh = ss.getSheetByName(CONFIG.SHEET_BLOCKED);
  if (!sh) {
    sh = ss.insertSheet(CONFIG.SHEET_BLOCKED);
    sh.getRange(1, 1, sh.getMaxRows(), 4).setNumberFormat('@');
    sh.getRange(1, 1, 1, 4).setValues([['Date (yyyy-mm-dd)', 'Time (hh:mm, blank = whole day)', 'Type (individual / group / both)', 'Reason']]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function readBlocked_() {
  var sh = blockedSheet_(), last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, 3).getDisplayValues().filter(function (r) { return r[0]; }).map(function (r) {
    var m = /^(\d{1,2}):(\d{2})/.exec(String(r[1]).trim());
    return { date: String(r[0]).trim(), time: m ? pad_(+m[1]) + ':' + m[2] : '', type: String(r[2]).trim().toLowerCase() };
  });
}

function isBlocked_(blocked, type, date, time) {
  return blocked.some(function (b) {
    return b.date === date && (!b.time || b.time === time) && (!b.type || b.type === 'both' || b.type === type);
  });
}

function readBookings_(sh) {
  var last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, FIELDS.length).getDisplayValues().map(function (r, i) {
    var o = { _row: i + 2 };
    FIELDS.forEach(function (f, j) { o[f[0]] = r[j]; });
    return o;
  });
}

function findBooking_(sh, id) {
  if (!/^[a-f0-9]{20}$/.test(id || '')) return null;
  return readBookings_(sh).filter(function (b) { return b.id === id; })[0] || null;
}

function appendBooking_(sh, o) {
  var row = sh.getLastRow() + 1;
  sh.getRange(row, 1, 1, FIELDS.length).setNumberFormat('@')
    .setValues([FIELDS.map(function (f) { return o[f[0]] == null ? '' : String(o[f[0]]); })]);
  o._row = row;
}

function patchBooking_(sh, b, patch) {
  Object.keys(patch).forEach(function (k) {
    sh.getRange(b._row, COL[k] + 1).setNumberFormat('@').setValue(String(patch[k]));
    b[k] = String(patch[k]);
  });
}

function isActive_(b, nowMs) {
  if (b.status === STATUS.PAID || b.status === STATUS.REVIEW) return true;
  if (b.status === STATUS.PENDING) return Date.parse(b.holdUntil) > nowMs;
  return false;
}

function clearCache_(date) { CacheService.getScriptCache().remove('slots:' + date); }
function addNote_(old, add) { return (old ? old + ' | ' : '') + add; }
function reference_(id) { return 'MM-' + String(id).slice(0, 6).toUpperCase(); }

/* ============================== VALUES ============================== */

function pad_(n) { return (n < 10 ? '0' : '') + n; }
function toMin_(t) { var p = t.split(':'); return +p[0] * 60 + +p[1]; }
function fromMin_(m) { return pad_(Math.floor(m / 60)) + ':' + pad_(m % 60); }
function slotStart_(date, time) { return Utilities.parseDate(date + ' ' + time, CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm'); }
function addMinutes_(d, m) { return new Date(d.getTime() + m * 60000); }
function nowIso_(d) { return Utilities.formatDate(d || new Date(), CONFIG.TIMEZONE, "yyyy-MM-dd'T'HH:mm:ssXXX"); }
function last10_(s) { return String(s || '').replace(/\D/g, '').slice(-10); }

function priceFor_(typeKey) {
  var base = CONFIG.TYPES[typeKey].base;
  var gst = Math.round(base * CONFIG.GST_RATE * 100) / 100;
  return { base: base, gst: gst, total: Math.round((base + gst) * 100) / 100 };
}

function str_(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
}

function clean_(r) {
  return {
    type: str_(r.type, 20), date: str_(r.date, 10), time: str_(r.time, 5),
    firstName: str_(r.firstName, 60), lastName: str_(r.lastName, 60),
    email: str_(r.email, 254).toLowerCase(), age: str_(r.age, 3),
    mobile: str_(r.mobile, 25).replace(/[\s\-().]/g, ''),
    level: str_(r.level, 40), reason: str_(r.reason, 1500), goal: str_(r.goal, 1500),
    challenges: str_(r.challenges, 1500), focus: str_(r.focus, 1500),
    firstTime: str_(r.firstTime, 3), heard: str_(r.heard, 20), heardOther: str_(r.heardOther, 100)
  };
}

function validate_(d) {
  var e = {};
  var nameRe = /^[\p{L}\p{M}][\p{L}\p{M}\s'.\-]*$/u;
  if (!Object.prototype.hasOwnProperty.call(CONFIG.TYPES, d.type)) e.type = 'Choose a coaching type.';
  if (CONFIG.EVENT_DATES.indexOf(d.date) < 0) e.date = 'Choose a date.';
  if (!/^\d{2}:\d{2}$/.test(d.time)) e.time = 'Choose a time slot.';
  if (!d.firstName || !nameRe.test(d.firstName)) e.firstName = 'Enter your first name.';
  if (!d.lastName || !nameRe.test(d.lastName)) e.lastName = 'Enter your last name.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(d.email)) e.email = 'Enter a valid email address.';
  var age = +d.age;
  if (!/^\d{1,3}$/.test(d.age) || age < 5 || age > 100) e.age = 'Enter an age between 5 and 100.';
  if (!/^\+[1-9]\d{7,14}$/.test(d.mobile)) e.mobile = 'Include the country code, for example +91 98765 43210.';
  if (LEVELS.indexOf(d.level) < 0) e.level = 'Select your level.';
  if (d.goal.length < 3) e.goal = 'Tell us what you aim to achieve.';
  if (d.challenges.length < 3) e.challenges = 'Tell us about your challenges.';
  if (d.focus.length < 3) e.focus = 'Tell us what you would like to work on.';
  if (['Yes', 'No'].indexOf(d.firstTime) < 0) e.firstTime = 'Select one.';
  if (HEARD.indexOf(d.heard) < 0) e.heard = 'Select one.';
  else if (d.heard === 'Other' && d.heardOther.length < 2) e.heardOther = 'Tell us where you heard about it.';
  return e;
}

/* ============================== SHEET MENU ============================== */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Bookings')
    .addItem('Mark selected row as PAID (sends email)', 'menuMarkPaid')
    .addItem('Cancel selected row (frees the slot)', 'menuCancel')
    .addItem('Resend confirmation email', 'menuResend')
    .addSeparator()
    .addItem('Turn on automatic payment checks', 'setupTriggers')
    .addItem('Check setup', 'checkSetup')
    .addToUi();
}

function selectedBooking_() {
  var sh = SpreadsheetApp.getActiveSheet();
  if (sh.getName() !== CONFIG.SHEET_BOOKINGS) throw new Error('Click a row on the "' + CONFIG.SHEET_BOOKINGS + '" sheet first.');
  var row = sh.getActiveRange().getRow();
  var b = readBookings_(sh).filter(function (x) { return x._row === row; })[0];
  if (!b) throw new Error('Click a booking row (not the header).');
  return b;
}

function menuMarkPaid() {
  var ui = SpreadsheetApp.getUi();
  try {
    var b = selectedBooking_();
    var r = finalizePaid_(b.id, b.paymentId || 'MANUAL', 'manual');
    ui.alert(r.status === STATUS.PAID ? 'Marked as paid. Confirmation email sent.' : 'Could not mark as paid: status is ' + r.status + '.');
  } catch (e) { ui.alert(e.message); }
}

function menuCancel() {
  var ui = SpreadsheetApp.getUi();
  try {
    var b = selectedBooking_(), sh = bookingsSheet_();
    var wasPaid = b.status === STATUS.PAID;
    patchBooking_(sh, b, { status: STATUS.CANCELLED, notes: addNote_(b.notes, 'Cancelled from sheet') });
    clearCache_(b.date);
    try {
      if (b.type === 'group') syncGroupEvent_(sh, b.date, b.time);
      else if (b.calendarId) { var ev = CalendarApp.getDefaultCalendar().getEventById(b.calendarId); if (ev) ev.deleteEvent(); }
    } catch (e) { console.error(e); }
    ui.alert('Cancelled. The slot is open again.' + (wasPaid ? ' Remember to refund the payment in Razorpay.' : ''));
  } catch (e) { ui.alert(e.message); }
}

function menuResend() {
  var ui = SpreadsheetApp.getUi();
  try {
    var b = selectedBooking_();
    if (b.status !== STATUS.PAID) throw new Error('Only PAID bookings get a confirmation email.');
    sendConfirmationEmail_(b);
    ui.alert('Confirmation email sent to ' + b.email + '.');
  } catch (e) { ui.alert(e.message); }
}

function checkSetup() {
  bookingsSheet_(); blockedSheet_();
  var msgs = [];
  msgs.push(rzAuth_() ? 'Razorpay keys: found' : 'Razorpay keys: MISSING (payments must be marked paid by hand)');
  msgs.push('Event dates: ' + CONFIG.EVENT_DATES.join(', '));
  msgs.push('Auto payment check: ' + (ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'reconcile'; }) ? 'on' : 'OFF (run Bookings > Turn on automatic payment checks)'));
  try { SpreadsheetApp.getUi().alert(msgs.join('\n')); } catch (e) { console.log(msgs.join('\n')); }
}
