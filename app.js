/* Musee Musical masterclass booking: frontend logic */
(() => {
  'use strict';

  const CFG = Object.assign({ SLOT_REFRESH_MS: 8000, STATUS_POLL_MS: 6000, PAYMENT_BUTTON_IDS: {} }, window.APP_CONFIG || {});
  const DEMO = !CFG.API_URL || /PASTE|YOUR_/i.test(CFG.API_URL);
  const STORE_KEY = 'musee_booking_v1';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /* ---------- formatting ---------- */
  const rs = n => 'Rs. ' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
  const fmtTime = t => { const [h, m] = t.split(':').map(Number); return `${(h + 11) % 12 + 1}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`; };
  const addMin = (t, mins) => { const [h, m] = t.split(':').map(Number); const x = h * 60 + m + mins; return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`; };
  const range = (t, mins) => `${fmtTime(t).replace(/ (AM|PM)$/, '')} – ${fmtTime(addMin(t, mins))}`;
  const dateLong = d => new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const dateShort = d => new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });

  /* ---------- state ---------- */
  const state = {
    cfg: null, step: 1, type: null, date: null, selected: null,
    prev: {}, slotReq: 0, lastOk: 0, liveFail: false,
    booking: null, slotTimer: null, statusTimer: null, holdTimer: null, liveTimer: null
  };

  /* ---------- API ---------- */
  async function api(method, action, params = {}) {
    if (DEMO) return Demo.handle(action, params);
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 25000);
    try {
      let res;
      if (method === 'GET') {
        res = await fetch(`${CFG.API_URL}?${new URLSearchParams(Object.assign({ action }, params))}`, { signal: ctrl.signal });
      } else {
        res = await fetch(CFG.API_URL, {
          method: 'POST', signal: ctrl.signal,
          headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // avoids a CORS preflight; Apps Script reads the raw body
          body: JSON.stringify(Object.assign({ action }, params))
        });
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } finally { clearTimeout(to); }
  }

  /* ---------- small UI helpers ---------- */
  function toast(msg, bad) {
    const el = document.createElement('div');
    el.className = 'toast' + (bad ? ' bad' : '');
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => { el.classList.add('leave'); setTimeout(() => el.remove(), 320); }, 5200);
  }
  function setLoading(btn, on) { btn.classList.toggle('loading', on); btn.disabled = on; }
  function rows(dl, list) {
    dl.replaceChildren(...list.map(([k, v, cls]) => {
      const d = document.createElement('div'); if (cls) d.className = cls;
      const dt = document.createElement('dt'); dt.textContent = k;
      const dd = document.createElement('dd'); dd.textContent = v;
      d.append(dt, dd); return d;
    }));
  }
  const save = b => { try { localStorage.setItem(STORE_KEY, JSON.stringify(b)); } catch (e) { /* private mode */ } };
  const load = () => { try { return JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch (e) { return null; } };
  const wipe = () => { try { localStorage.removeItem(STORE_KEY); } catch (e) { /* ignore */ } };
  const typeLabel = t => (state.cfg.types[t] || {}).label || t;

  /* ---------- steps ---------- */
  function goStep(n, opts = {}) {
    state.step = n;
    $$('.step').forEach(s => { s.hidden = Number(s.dataset.step) !== n; });
    $$('#stepper li').forEach(li => {
      const s = Number(li.dataset.s);
      li.classList.toggle('done', s < n || n === 4);
      if (s === n && n < 4) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
    });
    stopTimers();
    if (n === 1) startSlotPolling();
    if (n === 3) startPaymentTimers();
    tickLive();
    const h = $(`#step-${n} h3`);
    if (h && !opts.silent) {
      h.focus({ preventScroll: true });
      const top = $('#booking').getBoundingClientRect().top;
      if (top < 0 || top > 120) $('#booking').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }
  function stopTimers() {
    clearInterval(state.slotTimer); clearInterval(state.statusTimer); clearInterval(state.holdTimer);
  }

  /* ---------- step 1: type, date, slots ---------- */
  function renderPrices() {
    Object.entries(state.cfg.types).forEach(([k, t]) => {
      $$(`[data-price="${k}"]`).forEach(el => { el.textContent = `${rs(t.base)} + GST`; });
    });
    $('#hold-min').textContent = state.cfg.holdMinutes;
  }

  function renderDates() {
    const box = $('#dates');
    const dates = state.cfg.dates;
    if (!dates.length) { box.hidden = true; return; }
    box.hidden = false;
    box.replaceChildren(...dates.map(d => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'date-pill'; b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(d === state.date)); b.dataset.date = d; b.textContent = dateShort(d);
      b.title = dateLong(d);
      return b;
    }));
  }

  function chooseType(t) {
    if (state.type !== t) { state.type = t; state.selected = null; state.prev = {}; }
    if (!state.cfg.dates.length) { $('#sel-summary').textContent = 'No dates are open for booking right now.'; return; }
    if (!state.date) state.date = state.cfg.dates[0];
    renderDates();
    $('#slot-area').hidden = false;
    $('#slot-title').textContent = t === 'group' ? 'Group sessions' : 'Available one-on-one times';
    const host = $('#slots');
    host.dataset.key = '';
    host.className = 'slots' + (t === 'group' ? ' sessions' : '');
    host.replaceChildren(...Array.from({ length: t === 'group' ? 4 : 8 }, () => Object.assign(document.createElement('div'), { className: 'skeleton' })));
    updateSummary();
    refreshSlots();
    startSlotPolling();
  }

  function slotButton(s) {
    const b = document.createElement('button');
    b.type = 'button'; b.dataset.time = s.time; b.setAttribute('aria-pressed', 'false');
    b.className = 'slot' + (state.type === 'group' ? ' session' : '');
    const ban = '<svg class="ban" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/></svg>';
    if (state.type === 'group') {
      b.innerHTML = `<span class="when"><span class="t"></span><span class="s">Group session, ${state.cfg.slotMinutes} min</span></span><span class="cap"><span class="bar-cap"><i></i></span><span class="left"></span></span>${ban}`;
    } else {
      b.innerHTML = `<span class="t"></span><span class="s"></span>${ban}`;
    }
    return b;
  }

  function updateSlot(b, s) {
    const grp = state.type === 'group', open = s.status === 'open';
    $('.t', b).textContent = grp ? range(s.time, state.cfg.slotMinutes) + ' ' + fmtTime(addMin(s.time, state.cfg.slotMinutes)).slice(-2) : fmtTime(s.time);
    b.disabled = !open;
    b.setAttribute('aria-pressed', String(open && state.selected === s.time));
    b.title = open ? '' : (s.status === 'full' ? (grp ? 'This session is full' : 'Already booked') : 'Not available');
    b.setAttribute('aria-label', `${fmtTime(s.time)}, ${open ? (grp ? s.remaining + ' spots left' : 'available') : (s.status === 'full' ? (grp ? 'full' : 'booked') : 'not available')}`);
    if (grp) {
      const taken = s.capacity - s.remaining;
      b.style.setProperty('--p', `${Math.round(taken / s.capacity * 100)}%`);
      b.classList.toggle('low', open && s.remaining <= 3);
      $('.left', b).textContent = open ? `${s.remaining} of ${s.capacity} spot${s.remaining === 1 ? '' : 's'} left` : (s.status === 'full' ? 'Full' : 'Not available');
    } else {
      $('.s', b).textContent = open ? `${state.cfg.slotMinutes} min` : (s.status === 'full' ? 'Booked' : 'Unavailable');
    }
  }

  function renderSlots(data) {
    const list = data[state.type] || [];
    const host = $('#slots'), key = `${state.type}|${state.date}`;
    if (host.dataset.key !== key) {
      host.dataset.key = key;
      host.className = 'slots' + (state.type === 'group' ? ' sessions' : '');
      host.replaceChildren(...list.map(slotButton));
      if (!list.length) host.innerHTML = '<p class="empty">No times are scheduled for this date.</p>';
    }
    list.forEach(s => {
      const b = host.querySelector(`[data-time="${s.time}"]`);
      if (!b) return;
      const was = state.prev[s.time];
      if (was === 'open' && s.status !== 'open') {
        b.classList.remove('just-taken'); void b.offsetWidth; b.classList.add('just-taken');
        if (state.selected === s.time) {
          state.selected = null;
          toast(state.type === 'group' ? 'That session just filled up. Pick another time.' : 'Someone just booked that slot. Pick another time.', true);
        }
      }
      state.prev[s.time] = s.status;
      updateSlot(b, s);
    });
    updateSummary();
  }

  async function refreshSlots() {
    if (!state.type || !state.date || state.step !== 1) return;
    const token = ++state.slotReq;
    try {
      const data = await api('GET', 'slots', { date: state.date });
      if (token !== state.slotReq) return;
      if (!data.ok) throw new Error(data.message || 'slots');
      state.lastOk = Date.now(); state.liveFail = false;
      renderSlots(data);
    } catch (e) {
      if (token !== state.slotReq) return;
      state.liveFail = true;
      if (!$('#slots').dataset.key) $('#slots').innerHTML = '<p class="empty">We could not load times. Check your connection; we will keep trying.</p>';
    }
    tickLive();
  }

  function startSlotPolling() {
    clearInterval(state.slotTimer);
    if (state.step !== 1 || !state.type) return;
    state.slotTimer = setInterval(() => { if (!document.hidden) refreshSlots(); }, CFG.SLOT_REFRESH_MS);
    clearInterval(state.liveTimer);
    state.liveTimer = setInterval(tickLive, 1000);
  }

  function tickLive() {
    const el = $('#live');
    if (state.step !== 1 || !state.type) { el.hidden = true; return; }
    el.hidden = false; el.classList.toggle('off', state.liveFail);
    const s = Math.round((Date.now() - state.lastOk) / 1000);
    $('#live-text').textContent = state.liveFail ? 'Reconnecting' : (!state.lastOk || s < 2 ? 'Live: just updated' : `Live: updated ${s}s ago`);
  }

  function updateSummary() {
    const sum = $('#sel-summary'), btn = $('#to-details');
    if (!state.type) { sum.textContent = 'Pick a coaching type to see times.'; btn.disabled = true; return; }
    if (!state.selected) { sum.textContent = state.type === 'group' ? 'Pick a group session.' : 'Pick a time that suits you.'; btn.disabled = true; return; }
    sum.textContent = '';
    const b = document.createElement('b'); b.textContent = typeLabel(state.type);
    sum.append(b, ` on ${dateShort(state.date)}, ${range(state.selected, state.cfg.slotMinutes)} ${fmtTime(addMin(state.selected, state.cfg.slotMinutes)).slice(-2)}`);
    btn.disabled = false;
  }

  /* ---------- step 2: form ---------- */
  const form = $('#reg-form');
  const NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M}\s'.\-]*$/u;
  const normMobile = v => v.replace(/[\s\-().]/g, '');
  const val = n => (form.elements[n].value || '').trim();
  const long = (v, msg) => (v.length < 3 ? msg : '');
  const RULES = {
    firstName: v => !v ? 'Enter your first name.' : !NAME_RE.test(v) ? 'Use letters only.' : '',
    lastName: v => !v ? 'Enter your last name.' : !NAME_RE.test(v) ? 'Use letters only.' : '',
    email: v => !v ? 'Enter your email address.' : !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) ? 'Enter a valid email address, like you@example.com.' : '',
    age: v => !v ? 'Enter your age.' : (!/^\d{1,3}$/.test(v) || +v < 5 || +v > 100) ? 'Enter an age between 5 and 100.' : '',
    mobile: v => !v ? 'Enter your mobile number.' : !/^\+[1-9]\d{7,14}$/.test(normMobile(v)) ? 'Start with the country code, for example +91 98765 43210.' : '',
    level: v => v ? '' : 'Select your level.',
    goal: v => long(v, 'Tell us what you aim to achieve.'),
    challenges: v => long(v, 'Tell us about your challenges.'),
    focus: v => long(v, 'Tell us what you would like to work on.'),
    firstTime: v => v ? '' : 'Select yes or no.',
    heard: v => v ? '' : 'Select where you heard about it.',
    heardOther: v => (val('heard') === 'Other' && v.length < 2) ? 'Tell us where you heard about it.' : ''
  };

  function check(name, show = true) {
    const rule = RULES[name]; if (!rule) return '';
    const msg = rule(val(name));
    if (!show) return msg;
    const wrap = name === 'heardOther' ? $('#other-wrap') : $(`[data-field="${name}"]`);
    const field = name === 'heardOther' ? $('[data-field="heard"]') : wrap;
    const err = $(`#e-${name}`);
    err.textContent = msg;
    if (name === 'heardOther') field.classList.toggle('invalid', !!msg || field.classList.contains('invalid-heard'));
    else field.classList.toggle('invalid', !!msg);
    field.classList.toggle('valid', !msg && !!val(name));
    const input = form.elements[name]; const first = input && (input.length && input[0] ? input[0] : input);
    if (first && first.setAttribute) { if (msg) first.setAttribute('aria-invalid', 'true'); else first.removeAttribute('aria-invalid'); }
    return msg;
  }

  function validateAll() {
    let firstBad = null;
    Object.keys(RULES).forEach(n => {
      if (n === 'heardOther' && val('heard') !== 'Other') return;
      if (check(n) && !firstBad) firstBad = n;
    });
    return firstBad;
  }

  form.addEventListener('focusout', e => { const n = e.target.name; if (RULES[n] && e.target.type !== 'radio') check(n); });
  form.addEventListener('input', e => {
    const n = e.target.name;
    if (RULES[n] && e.target.type !== 'radio') {
      const f = $(`[data-field="${n}"]`);
      if (f && f.classList.contains('invalid')) check(n);
    }
    if (n === 'age') e.target.value = e.target.value.replace(/\D/g, '');
  });
  form.addEventListener('change', e => {
    const n = e.target.name;
    if (n === 'heard') {
      const other = e.target.value === 'Other';
      $('#other-wrap').hidden = !other;
      if (other) form.elements.heardOther.focus(); else { form.elements.heardOther.value = ''; $('#e-heardOther').textContent = ''; }
    }
    if (RULES[n]) check(n);
  });

  function applyServerErrors(errors) {
    let first = null;
    Object.entries(errors).forEach(([n, msg]) => {
      const f = n === 'heardOther' ? $('[data-field="heard"]') : $(`[data-field="${n}"]`);
      if (!f) return;
      f.classList.add('invalid'); const err = $(`#e-${n}`); if (err) err.textContent = msg;
      if (!first) first = n;
    });
    return first;
  }

  function focusField(n) {
    const el = form.elements[n];
    const target = el && el.length && el[0] ? el[0] : el;
    if (target) { target.focus({ preventScroll: true }); target.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  }

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const fe = $('#form-error'); fe.hidden = true;
    const bad = validateAll();
    if (bad) { focusField(bad); return; }
    if (!state.selected) { goStep(1); return; }

    const btn = $('#submit'); setLoading(btn, true);
    const payload = {
      type: state.type, date: state.date, time: state.selected,
      firstName: val('firstName'), lastName: val('lastName'), email: val('email').toLowerCase(), age: val('age'),
      mobile: normMobile(val('mobile')), level: val('level'), reason: val('reason'), goal: val('goal'),
      challenges: val('challenges'), focus: val('focus'), firstTime: val('firstTime'), heard: val('heard'),
      heardOther: val('heardOther'), website: form.elements.website.value
    };
    try {
      const res = await api('POST', 'reserve', payload);
      if (res.ok) {
        state.booking = {
          id: res.bookingId, reference: res.reference, type: res.type, date: res.date, time: res.time, amount: res.amount,
          holdUntil: res.holdUntil, skew: Date.parse(res.serverNow) - Date.now(),
          email: payload.email, firstName: payload.firstName, lastName: payload.lastName
        };
        save(state.booking);
        showPayment();
      } else if (res.code === 'VALIDATION') {
        const first = applyServerErrors(res.errors || {});
        if (first) focusField(first);
      } else if (res.code === 'SLOT_TAKEN' || res.code === 'ALREADY_BOOKED') {
        state.selected = null;
        toast(res.message, true); goStep(1); refreshSlots();
      } else {
        fe.textContent = res.message || 'We could not save your booking. Please try again.'; fe.hidden = false;
      }
    } catch (err) {
      fe.textContent = 'We could not reach the booking server. Check your connection and try again. Your answers are still here.'; fe.hidden = false;
    } finally { setLoading(btn, false); }
  });

  /* ---------- step 3: payment ---------- */
  function showPayment() {
    const b = state.booking, t = state.cfg.types[b.type];
    rows($('#summary'), [
      ['Reference', b.reference],
      ['Session', typeLabel(b.type)],
      ['Date', dateLong(b.date)],
      ['Your slot', `${range(b.time, state.cfg.slotMinutes)} ${fmtTime(addMin(b.time, state.cfg.slotMinutes)).slice(-2)}`],
      ['Fee', rs(b.amount.base)],
      [`GST (${Math.round(state.cfg.gstRate * 100)}%)`, rs(b.amount.gst)],
      ['Total to pay', rs(b.amount.total), 'total']
    ]);
    $('#pay-email').textContent = b.email;
    $('#pay-live').hidden = false; $('#expired').hidden = true;
    $('#pay-status').textContent = ''; $('#pay-status').className = 'status';
    mountPayButton(b.type);
    goStep(3);
    void t;
  }

  function mountPayButton(type) {
    const host = $('#pay-host'); host.replaceChildren();
    const id = (CFG.PAYMENT_BUTTON_IDS || {})[type];
    if (DEMO) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'pay-demo'; b.textContent = 'Pay now (demo)';
      b.addEventListener('click', async () => { await Demo.pay(state.booking.id); setStatus('Demo payment made. Checking it now...', ''); verify(); });
      host.appendChild(b); return;
    }
    if (!id || /PASTE/i.test(id)) {
      host.style.background = 'rgba(255,255,255,.12)';
      host.textContent = `Add your Razorpay button ID for "${typeLabel(type)}" in config.js.`;
      return;
    }
    host.style.background = '';
    const f = document.createElement('form'), s = document.createElement('script');
    s.src = 'https://checkout.razorpay.com/v1/payment-button.js';
    s.setAttribute('data-payment_button_id', id);
    s.async = true; f.appendChild(s); host.appendChild(f);
  }

  function setStatus(msg, cls) { const el = $('#pay-status'); el.textContent = msg; el.className = 'status ' + (cls || ''); }

  function startPaymentTimers() {
    const b = state.booking; if (!b) return;
    const total = state.cfg.holdMinutes * 60;
    const tick = () => {
      const left = Math.max(0, Math.round((Date.parse(b.holdUntil) - (Date.now() + b.skew)) / 1000));
      $('#hold-time').textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
      $('#hold-fill').style.width = `${Math.min(100, left / total * 100)}%`;
      $('#hold').classList.toggle('low', left <= 120);
      if (left === 0) { showExpired(); }
    };
    tick(); state.holdTimer = setInterval(tick, 1000);
    state.statusTimer = setInterval(pollStatus, CFG.STATUS_POLL_MS);
  }

  function showExpired(msg) {
    clearInterval(state.holdTimer);
    $('#pay-live').hidden = true; $('#expired').hidden = false; $('#hold').hidden = true;
    if (msg) $('#expired p').textContent = msg;
  }

  async function pollStatus() {
    if (!state.booking || document.hidden) return;
    try { handleStatus(await api('GET', 'status', { id: state.booking.id })); } catch (e) { /* try again next tick */ }
  }

  function handleStatus(res) {
    if (!res || !res.ok) { if (res && res.code === 'NOT_FOUND') { wipe(); } return; }
    if (res.status === 'PAID') return showSuccess();
    if (res.status === 'PAID_SLOT_LOST') return showExpired('Your payment arrived after the hold ended and the slot was taken. We will contact you shortly to move you to another slot or refund you in full.');
    if (res.status === 'PAYMENT_REVIEW') { setStatus('We received your payment and are matching it to your booking. You will get an email shortly.', 'warn'); return; }
    if (res.status === 'EXPIRED') showExpired();
  }

  async function verify(paymentId) {
    if (!state.booking) return;
    const btns = [$('#verify'), $('#expired-verify')]; btns.forEach(b => setLoading(b, true));
    try {
      const res = await api('POST', 'verify', { bookingId: state.booking.id, paymentId: paymentId || undefined });
      if (!res.ok) { setStatus(res.message || 'We could not check that payment.', 'warn'); return; }
      if (res.status === 'PAID') return showSuccess();
      if (res.status === 'PAID_SLOT_LOST') return showExpired('Your payment arrived after the hold ended and the slot was taken. We will contact you shortly to move you to another slot or refund you in full.');
      if (res.status === 'PAYMENT_REVIEW') return setStatus('We received your payment and are matching it to your booking. You will get an email shortly.', 'warn');
      if (res.manual) return setStatus('Payments are confirmed by our team. You will get an email as soon as yours is confirmed.', 'warn');
      setStatus('We have not seen your payment yet. If you just paid, wait a minute and check again.', 'warn');
    } catch (e) {
      setStatus('Could not reach the server. Check your connection and try again.', 'warn');
    } finally { btns.forEach(b => setLoading(b, false)); }
  }

  async function restart() {
    const id = state.booking && state.booking.id;
    state.booking = null; wipe();
    if (id) { try { await api('POST', 'release', { bookingId: id }); } catch (e) { /* hold will expire by itself */ } }
    $('#hold').hidden = false;
    state.selected = null; state.prev = {};
    goStep(1); if (state.type) { $('#slots').dataset.key = ''; refreshSlots(); }
  }

  /* ---------- step 4: success ---------- */
  function showSuccess() {
    const b = state.booking || load(); if (!b) return;
    stopTimers(); wipe();
    const end = addMin(b.time, state.cfg.slotMinutes);
    $('#success-lead').textContent = `Thank you, ${b.firstName}. A confirmation email is on its way to ${b.email}. If you do not see it in a few minutes, check your spam folder.`;
    rows($('#success-summary'), [
      ['Reference', b.reference], ['Session', typeLabel(b.type)], ['Date', dateLong(b.date)],
      ['Your slot', `${range(b.time, state.cfg.slotMinutes)} ${fmtTime(end).slice(-2)}`],
      ['Amount paid', rs(b.amount.total) + ' incl. GST']
    ]);
    const ds = t => b.date.replace(/-/g, '') + 'T' + t.replace(':', '') + '00';
    $('#add-cal').href = 'https://calendar.google.com/calendar/render?action=TEMPLATE'
      + '&text=' + encodeURIComponent(`${state.cfg.title}: ${typeLabel(b.type)}`)
      + `&dates=${ds(b.time)}/${ds(end)}&ctz=Asia%2FKolkata&details=` + encodeURIComponent('Booking reference ' + b.reference);
    state.booking = null;
    goStep(4);
  }

  /* ---------- wiring ---------- */
  // $$('input[name="type"]').forEach(r => r.addEventListener('change', () => chooseType(r.value)));
  /* ---------- wiring ---------- */
  const typeSelect = $('select[name="type"]');

  if (typeSelect) {
    typeSelect.addEventListener('change', () => {
      const selectedType = typeSelect.value;

      if (selectedType === 'individual' || selectedType === 'group') {
        chooseType(selectedType);
      } else {
        state.type = null;
        state.selected = null;

        $('#slot-area').hidden = true;
        updateSummary();
      }
    });

    // Restore the initial selection, if one exists.
    if (typeSelect.value === 'individual' || typeSelect.value === 'group') {
      chooseType(typeSelect.value);
    }
  }
  $('#dates').addEventListener('click', e => {
    const b = e.target.closest('.date-pill'); if (!b || b.dataset.date === state.date) return;
    state.date = b.dataset.date; state.selected = null; state.prev = {};
    $$('.date-pill').forEach(p => p.setAttribute('aria-checked', String(p === b)));
    $('#slots').dataset.key = ''; updateSummary(); refreshSlots();
  });
  $('#slots').addEventListener('click', e => {
    const b = e.target.closest('.slot'); if (!b || b.disabled) return;
    state.selected = b.dataset.time;
    $$('.slot', $('#slots')).forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    updateSummary();
  });
  $('#to-details').addEventListener('click', () => {
    if (!state.selected) return;
    $('#chosen').textContent = `${typeLabel(state.type)} on ${dateLong(state.date)}, ${range(state.selected, state.cfg.slotMinutes)} ${fmtTime(addMin(state.selected, state.cfg.slotMinutes)).slice(-2)}`;
    goStep(2);
  });
  $('#back-1').addEventListener('click', () => goStep(1));
  $('#back-2').addEventListener('click', restart);
  $('#expired-restart').addEventListener('click', restart);
  $('#verify').addEventListener('click', () => verify());
  $('#expired-verify').addEventListener('click', () => verify());
  $('#book-another').addEventListener('click', () => {
    form.reset(); $$('.field').forEach(f => f.classList.remove('invalid', 'valid')); $('#other-wrap').hidden = true;
    state.selected = null; state.prev = {}; $('#hold').hidden = false;
    goStep(1); if (state.type) { $('#slots').dataset.key = ''; refreshSlots(); }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { if (state.step === 1) refreshSlots(); if (state.step === 3) pollStatus(); } });

  /* ---------- boot ---------- */
  async function boot() {
    $('#demo-note').hidden = !DEMO;
    try {
      state.cfg = await api('GET', 'config');
      if (!state.cfg.ok) throw new Error('config');
    } catch (e) {
      $('#step-1').innerHTML = '<h3>We could not load bookings</h3><p class="hint">Please check your connection and reload this page. If it keeps happening, contact Musee Musical.</p>';
      return;
    }
    renderPrices();

    const params = new URLSearchParams(location.search);
    const paymentId = params.get('razorpay_payment_id');
    if (paymentId) history.replaceState(null, '', location.pathname);

    const saved = load();
    if (saved) {
      try {
        const st = await api('GET', 'status', { id: saved.id });
        if (st.ok) {
          saved.skew = Date.parse(st.serverNow) - Date.now();
          state.booking = saved;
          if (st.status === 'PAID') { showSuccess(); return; }
          if (['PENDING_PAYMENT', 'EXPIRED', 'PAYMENT_REVIEW', 'PAID_SLOT_LOST'].includes(st.status)) {
            showPayment(); handleStatus(st);
            if (paymentId) verify(paymentId);
            return;
          }
        }
      } catch (e) { /* fall through to a fresh start */ }
      wipe(); state.booking = null;
    } else if (paymentId) {
      toast('We could not find a reservation in this browser. If you paid, a confirmation email will arrive shortly; otherwise contact us with your payment ID.', true);
    }
    goStep(1, { silent: true });
  }

  /* ---------- preview mode (no server yet) ---------- */
  const Demo = (() => {
    // const cfg = {
    //   ok: true, title: 'Unleash Your Voice', host: 'Deirdre', dates: ['2026-11-15'], slotMinutes: 30, holdMinutes: 15, gstRate: .18,
    //   types: {
    //     individual: { label: 'One-on-One Coaching', capacity: 1, base: 3000, gst: 540, total: 3540, start: '10:00', end: '18:00' },
    //     group: { label: 'Group Coaching', capacity: 10, base: 1500, gst: 270, total: 1770, start: '10:00', end: '18:00' }
    //   }
    // };
    const cfg = {
      ok: true,
      title: 'Unleash Your Voice',
      host: 'Deirdre',
      dates: ['2026-11-15'],
      slotMinutes: 30,
      holdMinutes: 15,
      gstRate: 0.18,

      types: {
        individual: {
          label: 'One-on-One Coaching',
          capacity: 1,
          base: 3000,
          gst: 540,
          total: 3540,
          start: '14:00',
          end: '18:00'
        },

        group: {
          label: 'Group Coaching',
          capacity: 10,
          base: 1500,
          gst: 270,
          total: 1770,
          start: '10:00',
          end: '13:00'
        }
      }
    };
    const db = { count: {}, bookings: {} };
    const key = (t, d, tm) => `${t}|${d}|${tm}`;
    // const times = () => { const o = []; for (let m = 600; m < 1080; m += 30) o.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`); return o; };
    // cfg.dates.forEach(d => {
    //   ['10:00', '11:30', '14:00', '15:30'].forEach(t => { db.count[key('individual', d, t)] = 1; });
    //   db.count[key('group', d, '10:00')] = 9; db.count[key('group', d, '11:00')] = 4; db.count[key('group', d, '13:00')] = 10;
    // });
    cfg.dates.forEach((d) => {
      // Simulated individual coaching bookings
      ['14:00', '15:30', '16:00'].forEach((t) => {
        db.count[key('individual', d, t)] = 1;
      });

      // Simulated group coaching bookings
      db.count[key('group', d, '10:00')] = 9;
      db.count[key('group', d, '11:00')] = 4;
      db.count[key('group', d, '12:00')] = 10;
    });
    const times = (type) => {
    const o = [];

    const start = cfg.types[type].start
      .split(':')
      .reduce((h, m) => Number(h) * 60 + Number(m));

    const end = cfg.types[type].end
      .split(':')
      .reduce((h, m) => Number(h) * 60 + Number(m));

    for (let m = start; m + cfg.slotMinutes <= end; m += cfg.slotMinutes) {
      o.push(
        `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
      );
    }

    return o;
  };
    // const slots = d => {
    //   const out = { ok: true, date: d, serverNow: new Date().toISOString() };
    //   Object.keys(cfg.types).forEach(t => {
    //     const cap = cfg.types[t].capacity;
    //     out[t] = times().map(tm => {
    //       const rem = Math.max(0, cap - (db.count[key(t, d, tm)] || 0));
    //       return { time: tm, end: '', capacity: cap, remaining: rem, status: rem ? 'open' : 'full' };
    //     });
    //   });
    //   return out;
    // };
    const slots = (d) => {
    const out = {
      ok: true,
      date: d,
      serverNow: new Date().toISOString()
    };

    Object.keys(cfg.types).forEach((t) => {
      const cap = cfg.types[t].capacity;

      out[t] = times(t).map((tm) => {
        const rem = Math.max(
          0,
          cap - (db.count[key(t, d, tm)] || 0)
        );

        return {
          time: tm,
          end: '',
          capacity: cap,
          remaining: rem,
          status: rem > 0 ? 'open' : 'full'
        };
      });
    });

    return out;
  };
    const release = b => { if (b.status === 'PENDING_PAYMENT') { db.count[key(b.type, b.date, b.time)]--; b.status = 'CANCELLED'; } };
    let started = false;
    function start() {
      if (started) return; started = true;
      setInterval(() => { // other visitors booking, so the live updates can be seen
        if (document.hidden || Math.random() > .5) return;
        const d = cfg.dates[0], t = Math.random() > .5 ? 'individual' : 'group';
        // const open = times().filter(tm => (db.count[key(t, d, tm)] || 0) < cfg.types[t].capacity);
        const open = times(t).filter(
          (tm) => (db.count[key(t, d, tm)] || 0) < cfg.types[t].capacity
        );
        if (open.length > 3) { const tm = open[Math.floor(Math.random() * open.length)]; db.count[key(t, d, tm)] = (db.count[key(t, d, tm)] || 0) + 1; }
      }, 15000);
    }
    return {
      async handle(action, p) {
        await sleep(250); start();
        if (action === 'config') return Object.assign({ serverNow: new Date().toISOString() }, cfg);
        if (action === 'slots') return slots(p.date);
        if (action === 'reserve') {
          const k = key(p.type, p.date, p.time), cap = cfg.types[p.type].capacity;
          if ((db.count[k] || 0) >= cap) return { ok: false, code: 'SLOT_TAKEN', message: p.type === 'group' ? 'That group session just filled up. Please pick another.' : 'That slot was just booked. Please pick another.' };
          db.count[k] = (db.count[k] || 0) + 1;
          const id = 'demo' + Math.random().toString(16).slice(2, 12);
          db.bookings[id] = { id, type: p.type, date: p.date, time: p.time, status: 'PENDING_PAYMENT', holdEnd: Date.now() + cfg.holdMinutes * 60000, paid: false };
          return {
            ok: true, bookingId: id, reference: 'MM-' + id.slice(4, 10).toUpperCase(), type: p.type, date: p.date, time: p.time,
            amount: { base: cfg.types[p.type].base, gst: cfg.types[p.type].gst, total: cfg.types[p.type].total },
            holdUntil: new Date(db.bookings[id].holdEnd).toISOString(), serverNow: new Date().toISOString()
          };
        }
        const b = db.bookings[p.id || p.bookingId];
        if (!b) return { ok: false, code: 'NOT_FOUND' };
        if (action === 'status' || action === 'verify') {
          if (b.paid && b.status !== 'PAID') b.status = 'PAID';
          if (b.status === 'PENDING_PAYMENT' && Date.now() > b.holdEnd) { release(b); b.status = 'EXPIRED'; }
          if (action === 'verify' && !b.paid) return { ok: true, status: b.status, waiting: true };
          return { ok: true, status: b.status, serverNow: new Date().toISOString() };
        }
        if (action === 'release') { release(b); return { ok: true }; }
        return { ok: false };
      },
      async pay(id) { await sleep(900); if (db.bookings[id]) db.bookings[id].paid = true; }
    };
  })();

  /* gallery: if a photo file is missing, drop the broken image so the illustration shows */
  $$('.shot img').forEach(img => {
    const drop = () => img.remove();
    if (img.complete && img.naturalWidth === 0) drop(); else img.addEventListener('error', drop, { once: true });
  });

  boot();
})();