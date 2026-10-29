/* Musee Musical masterclass booking: frontend logic */
(() => {
  'use strict';

  const CFG = Object.assign({
    SLOT_REFRESH_MS: 8000,
    STATUS_POLL_MS: 6000,
    PAYMENT_BUTTON_IDS: {},
    DEMO_MODE: undefined
  }, window.APP_CONFIG || {});

  const DEMO = CFG.DEMO_MODE === true ||
    (CFG.DEMO_MODE !== false &&
      (!CFG.API_URL || /PASTE|YOUR_/i.test(CFG.API_URL)));

  const STORE_KEY = 'musee_booking_v1';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  /* ---------- formatting ---------- */

  const rs = n => 'Rs. ' + Number(n).toLocaleString('en-IN', {
    minimumFractionDigits: Number(n) % 1 ? 2 : 0,
    maximumFractionDigits: 2
  });

  const fmtTime = t => {
    const [h, m] = t.split(':').map(Number);
    return `${(h + 11) % 12 + 1}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
  };

  const addMin = (t, mins) => {
    const [h, m] = t.split(':').map(Number);
    const total = h * 60 + m + mins;
    return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  };

  const range = (t, mins) => {
    const end = addMin(t, mins);
    const startPeriod = Number(t.split(':')[0]) >= 12 ? 'PM' : 'AM';
    const endPeriod = Number(end.split(':')[0]) >= 12 ? 'PM' : 'AM';

    if (startPeriod === endPeriod) {
      return `${fmtTime(t).replace(/ (AM|PM)$/, '')} – ${fmtTime(end)}`;
    }

    return `${fmtTime(t)} – ${fmtTime(end)}`;
  };

  const dateLong = d => new Date(d + 'T00:00:00').toLocaleDateString('en-IN', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  });

  const dateShort = d => new Date(d + 'T00:00:00').toLocaleDateString('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short'
  });

  /* ---------- state ---------- */

  const state = {
    cfg: null,
    step: 1,
    type: null,
    date: null,
    selected: null,
    prev: {},
    slotReq: 0,
    lastOk: 0,
    liveFail: false,
    booking: null,
    slotTimer: null,
    statusTimer: null,
    holdTimer: null,
    liveTimer: null
  };

  /* ---------- API ---------- */

  async function api(method, action, params = {}) {
    if (DEMO) return Demo.handle(action, params);

    if (!CFG.API_URL || /PASTE|YOUR_/i.test(CFG.API_URL)) {
      throw new Error('Booking API URL is not configured.');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);

    try {
      let response;

      if (method === 'GET') {
        const query = new URLSearchParams(
          Object.assign({ action }, params)
        );

        response = await fetch(`${CFG.API_URL}?${query}`, {
          signal: controller.signal
        });
      } else {
        response = await fetch(CFG.API_URL, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'text/plain;charset=utf-8'
          },
          body: JSON.stringify(Object.assign({ action }, params))
        });
      }

      if (!response.ok) {
        throw new Error('HTTP ' + response.status);
      }

      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  /* ---------- small UI helpers ---------- */

  function toast(message, bad = false) {
    const host = $('#toasts');
    if (!host) return;

    const el = document.createElement('div');
    el.className = 'toast' + (bad ? ' bad' : '');
    el.textContent = message;
    host.appendChild(el);

    setTimeout(() => {
      el.classList.add('leave');
      setTimeout(() => el.remove(), 320);
    }, 5200);
  }

  function setLoading(button, on) {
    if (!button) return;
    button.classList.toggle('loading', on);
    button.disabled = on;
  }

  function rows(container, list) {
    if (!container) return;

    container.replaceChildren(...list.map(([key, value, cls]) => {
      const div = document.createElement('div');
      if (cls) div.className = cls;

      const dt = document.createElement('dt');
      dt.textContent = key;

      const dd = document.createElement('dd');
      dd.textContent = value == null ? '' : String(value);

      div.append(dt, dd);
      return div;
    }));
  }

  const save = booking => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(booking));
    } catch (_) {}
  };

  const load = () => {
    try {
      return JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    } catch (_) {
      return null;
    }
  };

  const wipe = () => {
    try {
      localStorage.removeItem(STORE_KEY);
    } catch (_) {}
  };

  const typeLabel = type =>
    (state.cfg.types[type] || {}).label || type;

  /* ---------- steps ---------- */

  function stopTimers() {
    clearInterval(state.slotTimer);
    clearInterval(state.statusTimer);
    clearInterval(state.holdTimer);
    clearInterval(state.liveTimer);

    state.slotTimer = null;
    state.statusTimer = null;
    state.holdTimer = null;
    state.liveTimer = null;
  }

  function goStep(number, options = {}) {
    state.step = number;

    $$('.step').forEach(el => {
      el.hidden = Number(el.dataset.step) !== number;
    });

    $$('#stepper li').forEach(li => {
      const step = Number(li.dataset.s);

      li.classList.toggle('done', step < number || number === 4);

      if (step === number && number < 4) {
        li.setAttribute('aria-current', 'step');
      } else {
        li.removeAttribute('aria-current');
      }
    });

    stopTimers();

    if (number === 1) startSlotPolling();
    if (number === 3) startPaymentTimers();

    tickLive();

    const heading = $(`#step-${number} h3`);

    if (heading && !options.silent) {
      heading.focus({ preventScroll: true });

      const booking = $('#booking');

      if (booking) {
        const top = booking.getBoundingClientRect().top;

        if (top < 0 || top > 120) {
          booking.scrollIntoView({
            behavior: 'smooth',
            block: 'start'
          });
        }
      }
    }
  }

  /* ---------- step 1: type, date, slots ---------- */

  function renderPrices() {
    Object.entries(state.cfg.types).forEach(([key, type]) => {
      $$(`[data-price="${key}"]`).forEach(el => {
        el.textContent = `${rs(type.base)} + GST`;
      });
    });

    const hold = $('#hold-min');
    if (hold) hold.textContent = state.cfg.holdMinutes;
  }

  function renderDates() {
    const box = $('#dates');
    if (!box) return;

    const dates = state.cfg.dates || [];

    if (!dates.length) {
      box.hidden = true;
      return;
    }

    box.hidden = false;

    box.replaceChildren(...dates.map(date => {
      const button = document.createElement('button');

      button.type = 'button';
      button.className = 'date-pill';
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-checked', String(date === state.date));
      button.dataset.date = date;
      button.textContent = dateShort(date);
      button.title = dateLong(date);

      return button;
    }));
  }

  function chooseType(type) {
    if (!state.cfg || !state.cfg.types[type]) return;

    if (state.type !== type) {
      state.type = type;
      state.selected = null;
      state.prev = {};
    }

    if (!state.cfg.dates.length) {
      $('#sel-summary').textContent =
        'No dates are open for booking right now.';
      return;
    }

    if (!state.date || !state.cfg.dates.includes(state.date)) {
      state.date = state.cfg.dates[0];
    }

    renderDates();

    $('#slot-area').hidden = false;
    $('#slot-title').textContent =
      type === 'group'
        ? 'Group sessions'
        : 'Available one-on-one times';

    const host = $('#slots');

    host.dataset.key = '';
    host.className = 'slots' + (type === 'group' ? ' sessions' : '');

    host.replaceChildren(
      ...Array.from(
        { length: type === 'group' ? 4 : 8 },
        () => Object.assign(document.createElement('div'), {
          className: 'skeleton'
        })
      )
    );

    updateSummary();
    refreshSlots();
    startSlotPolling();
  }

  function slotButton(slot) {
    const button = document.createElement('button');

    button.type = 'button';
    button.dataset.time = slot.time;
    button.setAttribute('aria-pressed', 'false');
    button.className = 'slot' + (
      state.type === 'group' ? ' session' : ''
    );

    const ban = '<svg class="ban" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/></svg>';

    if (state.type === 'group') {
      button.innerHTML =
        '<span class="when"><span class="t"></span>' +
        `<span class="s">Group session</span>` +
        '</span><span class="cap"><span class="bar-cap"><i></i></span>' +
        '<span class="left"></span></span>' + ban;
    } else {
      button.innerHTML =
        '<span class="t"></span><span class="s"></span>' + ban;
    }

    return button;
  }

  
  function updateSlot(button, slot) {
    const group = state.type === 'group';
    const open = slot.status === 'open';

    // Display the actual slot start and end times for group sessions.
    $('.t', button).textContent = group
      ? range(slot.time, state.cfg.types?.[state.type]?.slotMinutes || 180)
      : fmtTime(slot.time);

    button.disabled = !open;

    button.setAttribute(
      'aria-pressed',
      String(open && state.selected === slot.time)
    );

    button.title = open
      ? ''
      : slot.status === 'full'
        ? (group ? 'This session is full' : 'Already booked')
        : 'Not available';

    button.setAttribute(
      'aria-label',
      `${fmtTime(slot.time)}, ${
        open
          ? (group ? slot.remaining + ' spots left' : 'available')
          : (slot.status === 'full'
            ? (group ? 'full' : 'booked')
            : 'not available')
      }`
    );

    if (group) {
      const capacity = Number(slot.capacity) || 1;
      const remaining = Number(slot.remaining) || 0;
      const taken = capacity - remaining;

      button.style.setProperty(
        '--p',
        `${Math.round(taken / capacity * 100)}%`
      );

      button.classList.toggle('low', open && remaining <= 3);

      $('.left', button).textContent = open
        ? 'Few seats left'
        : slot.status === 'full'
          ? 'Full'
          : 'Not available';
    } else {
      $('.s', button).textContent = open
        ? `${state.cfg.types?.[state.type]?.slotMinutes || state.cfg.slotMinutes} min`
        : slot.status === 'full'
          ? 'Booked'
          : 'Unavailable';
    }
  }


  function renderSlots(data) {
    const list = data[state.type] || [];
    const host = $('#slots');
    const key = `${state.type}|${state.date}`;

    if (host.dataset.key !== key) {
      host.dataset.key = key;
      host.className = 'slots' + (
        state.type === 'group' ? ' sessions' : ''
      );

      host.replaceChildren(...list.map(slotButton));

      if (!list.length) {
        host.innerHTML =
          '<p class="empty">No times are scheduled for this date.</p>';
      }
    }

    list.forEach(slot => {
      const button = host.querySelector(
        `[data-time="${slot.time}"]`
      );

      if (!button) return;

      const previous = state.prev[slot.time];

      if (previous === 'open' && slot.status !== 'open') {
        button.classList.remove('just-taken');
        void button.offsetWidth;
        button.classList.add('just-taken');

        if (state.selected === slot.time) {
          state.selected = null;

          toast(
            state.type === 'group'
              ? 'That session just filled up. Pick another time.'
              : 'Someone just booked that slot. Pick another time.',
            true
          );
        }
      }

      state.prev[slot.time] = slot.status;
      updateSlot(button, slot);
    });

    updateSummary();
  }

  async function refreshSlots() {
    if (!state.type || !state.date || state.step !== 1) return;

    const token = ++state.slotReq;

    try {
      const data = await api('GET', 'slots', {
        date: state.date
      });

      if (token !== state.slotReq) return;
      if (!data.ok) throw new Error(data.message || 'Could not load slots');

      state.lastOk = Date.now();
      state.liveFail = false;
      renderSlots(data);
    } catch (_) {
      if (token !== state.slotReq) return;

      state.liveFail = true;

      if (!$('#slots').dataset.key) {
        $('#slots').innerHTML =
          '<p class="empty">We could not load times. Check your connection; we will keep trying.</p>';
      }
    }

    tickLive();
  }

  function startSlotPolling() {
    clearInterval(state.slotTimer);

    if (state.step !== 1 || !state.type) return;

    state.slotTimer = setInterval(() => {
      if (!document.hidden) refreshSlots();
    }, CFG.SLOT_REFRESH_MS);

    clearInterval(state.liveTimer);
    state.liveTimer = setInterval(tickLive, 1000);
  }

  function tickLive() {
    const el = $('#live');
    if (!el) return;

    if (state.step !== 1 || !state.type) {
      el.hidden = true;
      return;
    }

    el.hidden = false;
    el.classList.toggle('off', state.liveFail);

    const seconds = Math.round((Date.now() - state.lastOk) / 1000);

    $('#live-text').textContent = state.liveFail
      ? 'Reconnecting'
      : (!state.lastOk || seconds < 2
        ? 'Live: just updated'
        : `Live: updated ${seconds}s ago`);
  }

  
  function updateSummary() {
    const summary = $('#sel-summary');
    const button = $('#to-details');

    if (!summary || !button) return;

    if (!state.type) {
      summary.textContent = 'Pick a coaching type to see times.';
      button.disabled = true;
      return;
    }

    if (!state.selected) {
      summary.textContent = state.type === 'group'
        ? 'Pick a group session.'
        : 'Pick a time that suits you.';
      button.disabled = true;
      return;
    }

    summary.replaceChildren();

    const bold = document.createElement('b');
    bold.textContent = typeLabel(state.type);

    const duration = state.type === 'group'
      ? (state.cfg.types?.[state.type]?.slotMinutes || 180)
      : (state.cfg.types?.[state.type]?.slotMinutes || state.cfg.slotMinutes);

    summary.append(
      bold,
      ` on ${dateShort(state.date)}, ${range(state.selected, duration)}`
    );

    button.disabled = false;
  }


    /* ---------- step 2: form ---------- */

  const form = $('#reg-form');

  const NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M}\s'.\-]*$/u;
  const normMobile = value => value.replace(/[\s\-().]/g, '');
  const val = name => (form.elements[name].value || '').trim();
  const long = (value, message) => value.length < 3 ? message : '';

  const RULES = {
    firstName: value =>
      !value ? 'Enter your first name.' :
      !NAME_RE.test(value) ? 'Use letters only.' : '',

    lastName: value =>
      !value ? 'Enter your last name.' :
      !NAME_RE.test(value) ? 'Use letters only.' : '',

    email: value =>
      !value ? 'Enter your email address.' :
      !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)
        ? 'Enter a valid email address, like you@example.com.'
        : '',

    age: value =>
      !value ? 'Enter your age.' :
      (!/^\d{1,3}$/.test(value) || +value < 5 || +value > 100)
        ? 'Enter an age between 5 and 100.'
        : '',

    mobile: value =>
      !value ? 'Enter your mobile number.' :
      !/^[6-9]\d{9}$/.test(normMobile(value))
        ? 'Enter a valid 10-digit mobile number.'
        : '',


    level: value => value ? '' : 'Select your level.',
    goal: value => long(value, 'Tell us what you aim to achieve.'),
    challenges: value => long(value, 'Tell us about your challenges.'),
    focus: value => long(value, 'Tell us what you would like to work on.'),
    firstTime: value => value ? '' : 'Select yes or no.',
    heard: value => value ? '' : 'Select where you heard about it.',

    heardOther: value =>
      val('heard') === 'Other' && value.length < 2
        ? 'Tell us where you heard about it.'
        : ''
  };

  function check(name, show = true) {
    const rule = RULES[name];
    if (!rule) return '';

    const message = rule(val(name));
    if (!show) return message;

    const wrapper = name === 'heardOther'
      ? $('#other-wrap')
      : $(`[data-field="${name}"]`);

    const field = name === 'heardOther'
      ? $('[data-field="heard"]')
      : wrapper;

    const error = $(`#e-${name}`);

    if (error) error.textContent = message;

    if (field) {
      field.classList.toggle(
        'invalid',
        name === 'heardOther'
          ? !!message || field.classList.contains('invalid-heard')
          : !!message
      );

      field.classList.toggle('valid', !message && !!val(name));
    }

    const input = form.elements[name];
    const first = input && input.length && input[0] ? input[0] : input;

    if (first && first.setAttribute) {
      if (message) {
        first.setAttribute('aria-invalid', 'true');
      } else {
        first.removeAttribute('aria-invalid');
      }
    }

    return message;
  }

  function validateAll() {
    let firstBad = null;

    Object.keys(RULES).forEach(name => {
      if (name === 'heardOther' && val('heard') !== 'Other') return;

      if (check(name) && !firstBad) {
        firstBad = name;
      }
    });

    return firstBad;
  }

  form.addEventListener('focusout', event => {
    const name = event.target.name;

    if (RULES[name] && event.target.type !== 'radio') {
      check(name);
    }
  });

  form.addEventListener('input', event => {
    const name = event.target.name;

    if (name === 'age') {
      event.target.value = event.target.value.replace(/\D/g, '');
    }

    if (RULES[name] && event.target.type !== 'radio') {
      const field = $(`[data-field="${name}"]`);

      if (field && field.classList.contains('invalid')) {
        check(name);
      }
    }
  });

  form.addEventListener('change', event => {
    const name = event.target.name;

    if (name === 'heard') {
      const other = event.target.value === 'Other';

      $('#other-wrap').hidden = !other;

      if (other) {
        form.elements.heardOther.focus();
      } else {
        form.elements.heardOther.value = '';
        $('#e-heardOther').textContent = '';
      }
    }

    if (RULES[name]) check(name);
  });

  function applyServerErrors(errors) {
    let first = null;

    Object.entries(errors).forEach(([name, message]) => {
      const field = name === 'heardOther'
        ? $('[data-field="heard"]')
        : $(`[data-field="${name}"]`);

      if (!field) return;

      field.classList.add('invalid');

      const error = $(`#e-${name}`);
      if (error) error.textContent = message;

      if (!first) first = name;
    });

    return first;
  }

  function focusField(name) {
    const element = form.elements[name];
    const target = element && element.length && element[0]
      ? element[0]
      : element;

    if (target) {
      target.focus({ preventScroll: true });
      target.scrollIntoView({
        behavior: 'smooth',
        block: 'center'
      });
    }
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();

    const formError = $('#form-error');
    formError.hidden = true;

    const bad = validateAll();

    if (bad) {
      focusField(bad);
      return;
    }

    if (!state.selected) {
      goStep(1);
      return;
    }

    const button = $('#submit');
    setLoading(button, true);

    const payload = {
      type: state.type,
      date: state.date,
      time: state.selected,
      firstName: val('firstName'),
      lastName: val('lastName'),
      email: val('email').toLowerCase(),
      age: val('age'),
      mobile: normMobile(val('mobile')),
      level: val('level'),
      reason: val('reason'),
      goal: val('goal'),
      challenges: val('challenges'),
      focus: val('focus'),
      firstTime: val('firstTime'),
      heard: val('heard'),
      heardOther: val('heardOther'),
      website: form.elements.website.value
    };

    try {
      const response = await api('POST', 'reserve', payload);

      if (response.ok) {
        state.booking = {
          id: response.bookingId,
          reference: response.reference,
          type: response.type,
          date: response.date,
          time: response.time,
          amount: response.amount,
          holdUntil: response.holdUntil,
          skew: Date.parse(response.serverNow) - Date.now(),
          email: payload.email,
          firstName: payload.firstName,
          lastName: payload.lastName
        };

        save(state.booking);
        showPayment();

      } else if (response.code === 'VALIDATION') {
        const first = applyServerErrors(response.errors || {});
        if (first) focusField(first);

      } else if (
        response.code === 'SLOT_TAKEN' ||
        response.code === 'ALREADY_BOOKED'
      ) {
        state.selected = null;
        toast(response.message || 'That slot is no longer available.', true);
        goStep(1);
        refreshSlots();

      } else {
        formError.textContent =
          response.message || 'We could not save your booking. Please try again.';
        formError.hidden = false;
      }

    } catch (_) {
      formError.textContent =
        'We could not reach the booking server. Check your connection and try again. Your answers are still here.';
      formError.hidden = false;

    } finally {
      setLoading(button, false);
    }
  });

  /* ---------- step 3: payment ---------- */

  function showPayment() {
    const booking = state.booking;
    if (!booking) return;

    rows($('#summary'), [
      ['Reference', booking.reference],
      ['Session', typeLabel(booking.type)],
      ['Date', dateLong(booking.date)],
      ['Your slot', range(booking.time, state.cfg.slotMinutes)],
      ['Fee', rs(booking.amount.base)],
      [`GST (${Math.round(state.cfg.gstRate * 100)}%)`, rs(booking.amount.gst)],
      ['Total to pay', rs(booking.amount.total), 'total']
    ]);

    $('#pay-email').textContent = booking.email;
    $('#pay-live').hidden = false;
    $('#expired').hidden = true;
    $('#pay-status').textContent = '';
    $('#pay-status').className = 'status';

    mountPayButton(booking.type);
    goStep(3);
  }

  function mountPayButton(type) {
    const host = $('#pay-host');
    host.replaceChildren();

    const buttonId = (CFG.PAYMENT_BUTTON_IDS || {})[type];

    if (DEMO) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'pay-demo';
      button.textContent = 'Pay now (demo)';

      button.addEventListener('click', async () => {
        await Demo.pay(state.booking.id);
        setStatus('Demo payment made. Checking it now...', '');
        verify();
      });

      host.appendChild(button);
      return;
    }

    if (!buttonId || /PASTE|YOUR_/i.test(buttonId)) {
      host.style.background = 'rgba(255,255,255,.12)';
      host.textContent =
        `Add your Razorpay button ID for "${typeLabel(type)}" in config.js.`;
      return;
    }

    host.style.background = '';

    const paymentForm = document.createElement('form');
    const script = document.createElement('script');

    script.src = 'https://checkout.razorpay.com/v1/payment-button.js';
    script.setAttribute('data-payment_button_id', buttonId);
    script.async = true;

    paymentForm.appendChild(script);
    host.appendChild(paymentForm);
  }

  function setStatus(message, className) {
    const element = $('#pay-status');
    element.textContent = message;
    element.className = 'status ' + (className || '');
  }

  
function startPaymentTimers() {
  const booking = state.booking;

  if (!booking || !booking.holdUntil) {
    console.error("Cannot start countdown: booking or holdUntil is missing.");
    return;
  }

  // Prevent duplicate countdowns and status polling.
  clearInterval(state.holdTimer);
  clearInterval(state.statusTimer);

  state.holdTimer = null;
  state.statusTimer = null;

  const holdElement = $("#hold");
  const timeElement = $("#hold-time");
  const fillElement = $("#hold-fill");

  const endTime = Date.parse(booking.holdUntil);
  const totalSeconds = Math.max(
    1,
    Number(state.cfg?.holdMinutes || 15) * 60
  );

  if (!Number.isFinite(endTime) || !timeElement) {
    console.error("Invalid hold timer data:", {
      holdUntil: booking.holdUntil,
      timerElementFound: Boolean(timeElement)
    });
    if (timeElement) timeElement.textContent = "--:--";
    return;
  }

  function tick() {
    // Stop updating when the user leaves the payment step.
    if (state.step !== 3 || !state.booking) {
      clearInterval(state.holdTimer);
      state.holdTimer = null;
      return;
    }

    const serverNow = Date.now() + Number(booking.skew || 0);
    const remainingMs = Math.max(0, endTime - serverNow);
    const secondsLeft = Math.ceil(remainingMs / 1000);

    const minutes = Math.floor(secondsLeft / 60);
    const seconds = secondsLeft % 60;

    timeElement.textContent =
      String(minutes).padStart(2, "0") +
      ":" +
      String(seconds).padStart(2, "0");

    if (fillElement) {
      fillElement.style.width =
        Math.min(100, (secondsLeft / totalSeconds) * 100) + "%";
    }

    if (holdElement) {
      holdElement.classList.toggle("low", secondsLeft <= 120);
    }

    if (secondsLeft <= 0) {
      clearInterval(state.holdTimer);
      state.holdTimer = null;

      // Check payment status before displaying an expiry message.
      pollStatus().then(() => {
        if (
          state.booking &&
          state.step === 3 &&
          !["PAID", "PAID_SLOT_LOST", "PAYMENT_REVIEW"].includes(
            String(state.booking.status || "").toUpperCase()
          )
        ) {
          showExpired(
            "Your booking hold has expired. Please check availability before booking again. If you have paid, verify your payment before making another payment."
          );
        }
      });

      return;
    }
  }

  tick();

  if (state.step === 3 && state.booking) {
    state.holdTimer = setInterval(tick, 1000);
    state.statusTimer = setInterval(pollStatus, CFG.STATUS_POLL_MS);
  }
}


async function pollStatus() {
  if (!state.booking?.id) return;

  // Avoid overlapping requests if the server responds slowly.
  if (state.statusChecking) return;

  state.statusChecking = true;

  try {
    const response = await api("GET", "status", {
      id: state.booking.id
    });

    if (!response || !response.ok) {
      console.warn("Booking status check returned an unsuccessful response:", response);
      return;
    }

    const status = String(response.status || "").toUpperCase();

    // Keep the local booking status current.
    if (state.booking) {
      state.booking.status = status;
    }

    if (status === "PAID") {
      stopTimers();
      showSuccess();
      return;
    }

    if (
      status === "PAID_SLOT_LOST" ||
      status === "PAYMENT_REVIEW" ||
      status === "EXPIRED"
    ) {
      handleStatus(response);
    }
  } catch (error) {
    console.error("Could not check booking payment status:", error);
  } finally {
    state.statusChecking = false;
  }
}

  function showExpired(message) {
    clearInterval(state.holdTimer);
    state.holdTimer = null;

    $('#pay-live').hidden = true;
    $('#expired').hidden = false;
    $('#hold').hidden = true;

    if (message) $('#expired p').textContent = message;
  }

  // async function pollStatus() {
  //   if (!state.booking || document.hidden) return;

  //   try {
  //     handleStatus(await api('GET', 'status', {
  //       id: state.booking.id
  //     }));
  //   } catch (_) {
  //     // Retry on the next polling interval.
  //   }
  // }

  function handleStatus(response) {
    if (!response || !response.ok) {
      if (response && response.code === 'NOT_FOUND') wipe();
      return;
    }

    if (response.status === 'PAID') return showSuccess();

    if (response.status === 'PAID_SLOT_LOST') {
      return showExpired(
        'Your payment arrived after the hold ended and the slot was taken. We will contact you shortly to move you to another slot or refund you in full.'
      );
    }

    if (response.status === 'PAYMENT_REVIEW') {
      setStatus(
        'We received your payment and are matching it to your booking. You will get an email shortly.',
        'warn'
      );
      return;
    }

    if (response.status === 'EXPIRED') showExpired();
  }

  
  async function verify(paymentId) {
    if (!state.booking) return;

    const buttons = [$('#verify'), $('#expired-verify')];
    buttons.forEach(button => setLoading(button, true));

    try {
      const response = await api('POST', 'verify', {
        bookingId: state.booking.id,
        paymentId: paymentId || undefined
      });

      if (!response.ok) {
        setStatus(
          response.message ||
            'We could not confirm your payment. Please contact support before paying again.',
          'warn'
        );
        return;
      }

      if (response.status === 'PAID') return showSuccess();

      if (response.status === 'PAID_SLOT_LOST') {
        return showExpired(
          'Your payment arrived after the hold ended and the slot was taken. We will contact you shortly to move you to another slot or refund you in full.'
        );
      }

      if (response.status === 'PAYMENT_REVIEW') {
        return setStatus(
          'We received your payment and are matching it to your booking. You will get an email shortly.',
          'warn'
        );
      }

      if (response.manual) {
        return setStatus(
          'Payments are confirmed by our team. You will get an email as soon as yours is confirmed.',
          'warn'
        );
      }

      setStatus(
        'We have not seen your payment yet. If you just paid, wait a minute and check again.',
        'warn'
      );

    } catch (_) {
      setStatus(
        'Could not reach the server. Check your connection and try again.',
        'warn'
      );

    } finally {
      buttons.forEach(button => setLoading(button, false));
    }
  }

    async function restart() {
    const id = state.booking && state.booking.id;

    state.booking = null;
    wipe();

    if (id) {
      try {
        await api('POST', 'release', { bookingId: id });
      } catch (_) {
        // The server can release the hold when it expires.
      }
    }

    $('#hold').hidden = false;
    state.selected = null;
    state.prev = {};

    goStep(1);

    if (state.type) {
      $('#slots').dataset.key = '';
      refreshSlots();
    }
  }

  /* ---------- step 4: success ---------- */

  function showSuccess() {
    const booking = state.booking || load();

    if (!booking || !state.cfg) return;

    stopTimers();
    wipe();

    // const end = addMin(booking.time, state.cfg.slotMinutes);

    const successLead = $("#success-lead");

    if (successLead) {
      successLead.textContent =
        `Thank you, ${booking.firstName}. A confirmation email is on its way to ${booking.email}. If you do not see it in a few minutes, check your spam folder.`;
    }

    const successSummary = $("#success-summary");

    if (successSummary) {
      rows(successSummary, [
        ["Reference", booking.reference],
        ["Session", typeLabel(booking.type)],
        ["Date", dateLong(booking.date)],
        ["Your slot", range(booking.time, state.cfg.slotMinutes)],
        ["Amount paid", rs(booking.amount.total) + " incl. GST"]
      ]);
    }

    const calendarDate = time =>
      booking.date.replace(/-/g, "") +
      "T" +
      time.replace(":", "") +
      "00";

    // const calendarUrl =
    //   "https://calendar.google.com/calendar/render?action=TEMPLATE" +
    //   "&text=" +
    //   encodeURIComponent(
    //     `${state.cfg.title}: ${typeLabel(booking.type)}`
    //   ) +
    //   `&dates=${calendarDate(booking.time)}/${calendarDate(end)}` +
    //   "&ctz=Asia%2FKolkata&details=" +
    //   encodeURIComponent("Booking reference " + booking.reference);

    const calendarLink = $("#add-cal");

    if (calendarLink) {
      calendarLink.href = calendarUrl;
      calendarLink.target = "_blank";
      calendarLink.rel = "noopener noreferrer";
    } else {
      console.warn(
        'Calendar link element "#add-cal" was not found in the HTML.'
      );
    }

    state.booking = null;
    goStep(4);
  }


  /* ---------- wiring ---------- */

  const typeSelect = $('select[name="type"]');

  if (typeSelect) {
    typeSelect.addEventListener('change', () => {
      const type = typeSelect.value;

      if (type === 'individual' || type === 'group') {
        chooseType(type);
      } else {
        state.type = null;
        state.selected = null;
        state.slotReq++;

        $('#slot-area').hidden = true;
        updateSummary();
      }
    });
  }

  $('#dates').addEventListener('click', event => {
    const button = event.target.closest('.date-pill');

    if (!button || button.dataset.date === state.date) return;

    state.date = button.dataset.date;
    state.selected = null;
    state.prev = {};
    state.slotReq++;

    $$('.date-pill').forEach(pill => {
      pill.setAttribute('aria-checked', String(pill === button));
    });

    $('#slots').dataset.key = '';
    updateSummary();
    refreshSlots();
  });

  $('#slots').addEventListener('click', event => {
    const button = event.target.closest('.slot');

    if (!button || button.disabled) return;

    state.selected = button.dataset.time;

    $$('.slot', $('#slots')).forEach(slot => {
      slot.setAttribute(
        'aria-pressed',
        String(slot === button)
      );
    });

    updateSummary();
  });

  $('#to-details').addEventListener('click', () => {
    if (!state.selected) return;

    $('#chosen').textContent =
      `${typeLabel(state.type)} on ${dateLong(state.date)}, ` +
      range(state.selected, state.cfg.slotMinutes);

    goStep(2);
  });

  $('#back-1').addEventListener('click', () => goStep(1));
  $('#back-2').addEventListener('click', restart);
  $('#expired-restart').addEventListener('click', restart);

  $('#verify').addEventListener('click', () => verify());
  $('#expired-verify').addEventListener('click', () => verify());

  $('#book-another').addEventListener('click', () => {
    form.reset();

    $$('.field').forEach(field => {
      field.classList.remove('invalid', 'valid');
    });

    Object.keys(RULES).forEach(name => {
      const error = $(`#e-${name}`);
      if (error) error.textContent = '';
    });

    $('#other-wrap').hidden = true;

    state.selected = null;
    state.prev = {};

    $('#hold').hidden = false;

    if (typeSelect) {
      typeSelect.value = state.type || '';
    }

    goStep(1);

    if (state.type) {
      $('#slots').dataset.key = '';
      refreshSlots();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;

    if (state.step === 1) refreshSlots();
    if (state.step === 3) pollStatus();
  });

    /* ---------- preview mode ---------- */

  const Demo = (() => {
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
          capacity: 40,
          base: 1500,
          gst: 270,
          total: 1770,
          start: '10:00',
          end: '13:00'
        }
      }
    };

    const db = { count: {}, bookings: {} };

    const key = (type, date, time) => `${type}|${date}|${time}`;

    cfg.dates.forEach(date => {
      ['14:00', '15:30', '16:00'].forEach(time => {
        db.count[key('individual', date, time)] = 1;
      });

      db.count[key('group', date, '10:00')] = 9;
      db.count[key('group', date, '11:00')] = 4;
      db.count[key('group', date, '12:00')] = 10;
    });

    function times(type) {
      const start = cfg.types[type].start.split(':')
        .reduce((hours, minutes) => Number(hours) * 60 + Number(minutes));

      const end = cfg.types[type].end.split(':')
        .reduce((hours, minutes) => Number(hours) * 60 + Number(minutes));

      const result = [];

      for (
        let minutes = start;
        minutes + cfg.slotMinutes <= end;
        minutes += cfg.slotMinutes
      ) {
        result.push(
          `${String(Math.floor(minutes / 60)).padStart(2, '0')}:` +
          `${String(minutes % 60).padStart(2, '0')}`
        );
      }

      return result;
    }

    function slots(date) {
      const result = {
        ok: true,
        date,
        serverNow: new Date().toISOString()
      };

      Object.keys(cfg.types).forEach(type => {
        const capacity = cfg.types[type].capacity;

        result[type] = times(type).map(time => {
          const remaining = Math.max(
            0,
            capacity - (db.count[key(type, date, time)] || 0)
          );

          return {
            time,
            end: '',
            capacity,
            remaining,
            status: remaining > 0 ? 'open' : 'full'
          };
        });
      });

      return result;
    }

    function release(booking) {
      if (booking.status !== 'PENDING_PAYMENT') return;

      const bookingKey = key(
        booking.type,
        booking.date,
        booking.time
      );

      db.count[bookingKey] = Math.max(
        0,
        (db.count[bookingKey] || 0) - 1
      );

      booking.status = 'CANCELLED';
    }

    let started = false;

    function start() {
      if (started) return;
      started = true;

      setInterval(() => {
        if (document.hidden || Math.random() > 0.5) return;

        const date = cfg.dates[0];
        const type = Math.random() > 0.5 ? 'individual' : 'group';

        const open = times(type).filter(time =>
          (db.count[key(type, date, time)] || 0) <
          cfg.types[type].capacity
        );

        if (open.length > 3) {
          const time = open[Math.floor(Math.random() * open.length)];
          const bookingKey = key(type, date, time);

          db.count[bookingKey] = (db.count[bookingKey] || 0) + 1;
        }
      }, 15000);
    }

    return {
      async handle(action, params) {
        await sleep(250);
        start();

        if (action === 'config') {
          return Object.assign(
            { serverNow: new Date().toISOString() },
            cfg
          );
        }

        if (action === 'slots') {
          return slots(params.date);
        }

        if (action === 'reserve') {
          const bookingKey = key(
            params.type,
            params.date,
            params.time
          );

          const capacity = cfg.types[params.type]?.capacity;

          if (!capacity) {
            return {
              ok: false,
              message: 'Invalid session type.'
            };
          }

          if ((db.count[bookingKey] || 0) >= capacity) {
            return {
              ok: false,
              code: 'SLOT_TAKEN',
              message: params.type === 'group'
                ? 'That group session just filled up. Please pick another.'
                : 'That slot was just booked. Please pick another.'
            };
          }

          db.count[bookingKey] = (db.count[bookingKey] || 0) + 1;

          const id = 'demo' + Math.random().toString(16).slice(2, 12);

          db.bookings[id] = {
            id,
            type: params.type,
            date: params.date,
            time: params.time,
            status: 'PENDING_PAYMENT',
            holdEnd: Date.now() + cfg.holdMinutes * 60000,
            paid: false,
            customer: params
          };

          return {
            ok: true,
            bookingId: id,
            reference: 'MM-' + id.slice(4, 10).toUpperCase(),
            type: params.type,
            date: params.date,
            time: params.time,
            amount: {
              base: cfg.types[params.type].base,
              gst: cfg.types[params.type].gst,
              total: cfg.types[params.type].total
            },
            holdUntil: new Date(db.bookings[id].holdEnd).toISOString(),
            serverNow: new Date().toISOString()
          };
        }

        const booking = db.bookings[params.id || params.bookingId];

        if (!booking) {
          return { ok: false, code: 'NOT_FOUND' };
        }

        if (action === 'status' || action === 'verify') {
          if (
            booking.status === 'PENDING_PAYMENT' &&
            Date.now() > booking.holdEnd
          ) {
            release(booking);
            booking.status = 'EXPIRED';
          }

          if (booking.paid) {
            booking.status = 'PAID';
          }

          return {
            ok: true,
            status: booking.status,
            serverNow: new Date().toISOString()
          };
        }

        if (action === 'release') {
          release(booking);
          return { ok: true };
        }

        return { ok: false, message: 'Unknown action.' };
      },

      async pay(id) {
        await sleep(900);

        const booking = db.bookings[id];

        if (
          booking &&
          booking.status === 'PENDING_PAYMENT' &&
          Date.now() <= booking.holdEnd
        ) {
          booking.paid = true;
        }
      }
    };
  })();

  /* ---------- gallery image fallback ---------- */

  $$('.shot img').forEach(image => {
    const removeBrokenImage = () => image.remove();

    if (image.complete && image.naturalWidth === 0) {
      removeBrokenImage();
    } else {
      image.addEventListener('error', removeBrokenImage, {
        once: true
      });
    }
  });

  /* ---------- boot ---------- */

  async function boot() {
    $('#demo-note').hidden = !DEMO;

    try {
      state.cfg = await api('GET', 'config');

      if (!state.cfg || !state.cfg.ok) {
        throw new Error('Could not load booking configuration.');
      }
    } catch (_) {
      $('#step-1').innerHTML =
        '<h3>We could not load bookings</h3>' +
        '<p class="hint">Please check your connection and reload this page. If it keeps happening, contact Musee Musical.</p>';

      return;
    }

    renderPrices();

    // Initialise the session only after configuration has loaded.
    if (typeSelect &&
        (typeSelect.value === 'individual' ||
         typeSelect.value === 'group')) {
      chooseType(typeSelect.value);
    }

    const params = new URLSearchParams(location.search);
    // const paymentId = params.get('razorpay_payment_id');
    
    const paymentId =
      params.get('razorpay_payment_id') ||
      params.get('payment_id');


    if (paymentId) {
      history.replaceState(null, '', location.pathname);
    }

    const saved = load();

    if (saved) {
      try {
        const status = await api('GET', 'status', {
          id: saved.id
        });

        if (status.ok) {
          saved.skew = Date.parse(status.serverNow) - Date.now();
          state.booking = saved;

          if (status.status === 'PAID') {
            showSuccess();
            return;
          }

          if ([
            'PENDING_PAYMENT',
            'EXPIRED',
            'PAYMENT_REVIEW',
            'PAID_SLOT_LOST'
          ].includes(status.status)) {
            showPayment();
            handleStatus(status);

            if (paymentId) {
              verify(paymentId);
            } else if (status.status === 'EXPIRED') {
              showExpired(
                'Your booking hold has expired. Please check availability before trying again.'
              );
            }

            return;
          }
        }
      } catch (_) {
        // Start fresh if the saved booking cannot be recovered.
      }

      wipe();
      state.booking = null;

    } else if (paymentId) {
      toast(
        'We could not find a reservation in this browser. If you paid, a confirmation email will arrive shortly; otherwise contact us with your payment ID.',
        true
      );
    }

    goStep(1, { silent: true });
  }

  boot();
})();