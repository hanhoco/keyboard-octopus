/**
 * Stage 6 — the interactive shell.
 *
 * Renders the board and feeds keyboard events into the game state machine.
 * It owns no rules: every decision about right/wrong, advancing and which
 * line to draw comes back from game.submit().
 */
import { createGame, PLAYING, COMPLETE } from './game.js';
import { joinGameData, detectLayout, loadConfig } from './data.js';

const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};
const $ = id => document.getElementById(id);

/* Keys that are the operating system's or the browser's, not ours. Swallowing
   these would trap a child in the page. */
const PASSTHROUGH_KEYS = new Set([
  'F1','F2','F3','F4','F5','F6','F7','F8','F9','F10','F11','F12',
  'Escape','Tab','PrintScreen',
]);
const PASSTHROUGH_WITH_PRIMARY = new Set(['KeyR','KeyW','KeyT','KeyN','KeyQ','KeyL']);
const MODIFIER_KEYS = new Set([
  'Shift','Control','Alt','Meta','AltGraph','CapsLock','NumLock','ScrollLock','Dead',
]);

/* Readable names for keys that produce no visible character, so the live
   readout can still say what the browser reported. */
const KEY_GLYPH = {
  ' ': 'Space', Enter: 'Enter', Backspace: 'Backspace', Tab: 'Tab', Escape: 'Esc',
  Delete: 'Delete', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  ArrowUp: '\u2191', ArrowDown: '\u2193', ArrowLeft: '\u2190', ArrowRight: '\u2192',
};

/* The four modifier flags every KeyboardEvent carries, under the name each one
   actually goes by on this platform. */
const MODIFIER_CHIPS = {
  windows: [['shiftKey','Shift'], ['ctrlKey','Ctrl'], ['altKey','Alt'], ['metaKey','Win']],
  mac:     [['shiftKey','Shift'], ['ctrlKey','Control'], ['altKey','Option'], ['metaKey','Cmd']],
};

/**
 * Is this keypress the browser's business rather than the game's?
 *
 * AltGr arrives as Ctrl+Alt on Windows and it PRODUCES CHARACTERS, so it is
 * never a browser shortcut. Without that exception every AltGr character a
 * Spanish or Latin American keyboard makes — @ among them — was thrown away
 * here, before the game ever saw it, and the child got silence.
 *
 * Exported so it can be tested. It used to be a closure, and that is precisely
 * how the bug hid.
 */
/**
 * Is this keypress only a modifier settling, with no answer in it?
 *
 * 'Dead' lives in that set because an accent key normally produces nothing.
 * But on a Latin American keyboard the answer to ^ IS the dead key, and
 * bailing here meant it never reached the game at all: the code written to
 * accept it was unreachable, and five dots could not be solved by anyone.
 */
export function isIdleModifier(e, wantsDead = false) {
  if (e.key === 'Dead') return !wantsDead;
  return MODIFIER_KEYS.has(e.key);
}

export function shouldPassThrough(e, layouts, platformId, expectedCode = null) {
  // A key normally left to the browser stops being the browser's when it is
  // the answer being asked for. PrintScreen sat on this list, which would have
  // made a screenshot challenge unsolvable the same way ^ was.
  if (PASSTHROUGH_KEYS.has(e.key)) return e.code !== expectedCode;
  if (e.altKey && e.ctrlKey) return false;                 // AltGr: a character
  const primary = e[layouts.platforms[platformId].primaryModifier];
  if (primary && PASSTHROUGH_WITH_PRIMARY.has(e.code)) return true;
  if (primary && e.shiftKey && e.altKey) return true;      // devtools-ish combos
  return false;
}

/**
 * A MEASUREMENT BEATS A MEMORY.
 *
 * getLayoutMap() reports what this machine's keys really do. A remembered
 * choice is only ever a guess, and a stale one is worse than none: a link
 * handed out once pinned "Latin American" onto a computer whose Windows was
 * set to US English, and from then on the child was asked for AltGr + { on a
 * keyboard where that produces nothing at all.
 *
 * So a stored or URL layout fills in ONLY when the keyboard could not be
 * measured. The modifier key is different: it comes from the user agent, is
 * never measured, and a person may legitimately pin it.
 */
export function resolveSetup({ measured, url = {}, remembered = {}, known }) {
  const ok = (kind, id) => (id && known[kind]?.[id] ? id : null);
  const asked = ok('layouts', url.layout) ?? ok('layouts', remembered.layoutId);
  return {
    layoutId: measured.confirmed ? measured.layoutId : (asked ?? measured.layoutId),
    platformId: ok('platforms', url.keys)
             ?? ok('platforms', remembered.platformId)
             ?? measured.platformId,
  };
}

/**
 * Which combinations cost the most time, worst first.
 *
 * Grouped by the combination rather than by dot, and averaged, because the
 * same keys come round several times and one unlucky dot proves nothing. The
 * attempt count rides along: it is usually the reason a combination was slow,
 * and it is what a teacher acts on next lesson.
 */
export function slowestCombinations(records, limit = 3) {
  const byLabel = new Map();
  for (const r of records) {
    const e = byLabel.get(r.label) ?? { total: 0, tries: 0, count: 0 };
    e.total += r.ms;
    e.tries += r.tries;
    e.count += 1;
    byLabel.set(r.label, e);
  }
  return [...byLabel.entries()]
    .map(([label, e]) => ({
      label, count: e.count, tries: e.tries,
      seconds: e.total / e.count / 1000,
    }))
    .sort((a, b) => b.seconds - a.seconds)
    .slice(0, limit);
}

/**
 * What the student refused most, worst first.
 *
 * Grouped by the combination, because pressing Skip four times on AltGr + Q is
 * one lesson to teach, not four separate incidents.
 */
export function mostSkipped(records, limit = 3) {
  const byLabel = new Map();
  for (const r of records) {
    const key = `${r.label}\u0000${r.target}`;
    const e = byLabel.get(key) ?? { label: r.label, target: r.target, count: 0, dots: [] };
    e.count += 1;
    if (!e.dots.includes(r.sequence)) e.dots.push(r.sequence);
    byLabel.set(key, e);
  }
  return [...byLabel.values()].sort((a, b) => b.count - a.count).slice(0, limit);
}

/** m:ss, for a clock a seven-year-old reads across the room. */
export function formatClock(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function startUI(initialData) {
  let data = initialData;
  let game, layouts;
  let refs = {};
  let chips = [];                 // [modifier flag, chip node]
  let lastMeasured = null;        // what the machine reported last time we looked
  let rechecking = false;
  let run = null;                 // the timed challenge, null while playing freely
  let dotStartedAt = 0;           // when the current dot became the one to solve

  // the raw config is needed again if the student switches platform
  const layoutsPromise = fetch('keyboard-layouts.json').then(r => r.json());
  const configPromise = loadConfig();          // what this classroom asked us to skip
  let config = { ignore: [] };
  configPromise.then(c => { config = c; });

  layoutsPromise.then(cfg => {
    layouts = cfg;
    fillLayoutMenu();
    build();

    // A teacher's explicit choice outranks anything the browser worked out.
    const wanted = chosenSetup();
    if (wanted.layoutId !== data.layoutId || wanted.platformId !== data.platformId) {
      switchConfig(wanted);
    }

    $('layout').addEventListener('change', e => {
      switchConfig({ layoutId: e.target.value });
    });
    $('platform').addEventListener('change', e => {
      switchConfig({ platformId: e.target.value });
    });
    $('restart').addEventListener('click', () => {
      cancelChallenge();
      build();
      $('restart').blur();
    });
    $('skip').addEventListener('click', () => {
      const r = game.skip();
      $('skip').blur();
      if (!r.skipped) { setStatus('There is nothing else to ask here.', 'bad'); return; }
      renderStep();
      setStatus('New one. That dot is still waiting.', '');
      showHint(null);
      dotStartedAt = now();
    });
    for (const b of $('chal').querySelectorAll('button')) {
      b.addEventListener('click', () => {
        startChallenge(Number(b.dataset.min));
        b.blur();
      });
    }

    /* Windows can hold several layouts at once and swap them mid-game with
       Win+Space or Alt+Shift — and Alt and Shift are keys this game asks for
       constantly. Measuring once at load is therefore not enough: the child
       flips the keyboard by accident and every hint silently goes stale. */
    lastMeasured = data.layoutConfirmed ? data.layoutId : null;
    navigator.keyboard?.addEventListener?.('layoutchange', recheckLayout);
    window.addEventListener('focus', recheckLayout);
    window.addEventListener('keydown', onKey, { capture: true });
    // Separate from onKey on purpose: the readout must also see the keys the
    // game ignores — modifiers on their own, and browser pass-throughs.
    window.addEventListener('keydown', onLiveKey, { capture: true });
    window.addEventListener('keyup', onLiveKey, { capture: true });
    window.addEventListener('blur', releaseModifiers);
  });

  /* The keyboard on the desk and the modifier key are two separate axes: a
     Latin American keyboard is just as common on Windows as on a Mac. */
  const STORE = 'keyboard-octopus:setup';

  function saved() {
    try { return JSON.parse(localStorage.getItem(STORE)) ?? {}; } catch { return {}; }
  }

  function valid(kind, id) {
    return id && layouts[kind][id] ? id : null;
  }

  function chosenSetup() {
    const q = new URLSearchParams(location.search);
    if (q.get('layout') === 'auto') forget();
    return resolveSetup({
      measured: { layoutId: data.layoutId, platformId: data.platformId,
                  confirmed: data.layoutConfirmed !== false },
      url: { layout: q.get('layout'), keys: q.get('keys') },
      remembered: saved(),
      known: layouts,
    });
  }

  function forget() {
    try { localStorage.removeItem(STORE); } catch { /* nothing to forget */ }
  }

  /**
   * Has the keyboard changed under us? Only a genuine change is acted on: if
   * the machine still reports what it reported before, a teacher's own choice
   * is left alone.
   */
  async function recheckLayout() {
    if (rechecking) return;
    rechecking = true;
    try {
      const now = await detectLayout(layouts, navigator);
      if (now && now !== lastMeasured) {
        lastMeasured = now;
        if (now !== data.layoutId) switchConfig({ layoutId: now, announce: true });
      }
    } finally {
      rechecking = false;
    }
  }

  function fillLayoutMenu() {
    const sel = $('layout');
    sel.replaceChildren();
    for (const [id, l] of Object.entries(layouts.layouts)) {
      const o = document.createElement('option');
      o.value = id;
      // Named by what a teacher can SEE on the desk. Brand names would lie:
      // the Logitech in the next room is a Spanish board, not this one.
      o.textContent = l.recognise ? `${l.name} — ${l.recognise}` : l.name;
      sel.appendChild(o);
    }
  }

  function switchConfig({ layoutId, platformId, keepProgress = true,
                          confirmed = true, announce = false }) {
    const lid = layoutId ?? data.layoutId;
    const pid = platformId ?? data.platformId;
    Promise.all([
      fetch('octopus-path-LOCKED.json').then(r => r.json()),
      fetch('keyboard-curriculum.json').then(r => r.json()),
    ]).then(([geometry, curriculum]) => {
      const resume = keepProgress ? game.state : null;
      data = joinGameData({ geometry, curriculum, layouts, config,
                            layoutId: lid, platformId: pid });
      data.layoutConfirmed = confirmed;
      try { localStorage.setItem(STORE, JSON.stringify({ layoutId: lid, platformId: pid })); }
      catch { /* a locked-down school profile is not a reason to stop playing */ }
      build(resume);
      if (announce) {
        setStatus(`Your keyboard changed to ${data.layoutName}. The keys below ` +
                  `now match it.`, 'good');
      }
    });
  }

  /* ------------------------------------------------------------- render -- */

  function build(resume = null) {
    game = createGame(data, layouts, { resume });
    refs = drawBoard(data);
    if (resume) replayEarnedSegments();
    $('layout').value = data.layoutId;
    $('platform').value = data.platformId;
    $('layoutName').textContent = `${data.layoutName} · ${data.platformName}`;
    renderStep();
    setStatus('', '');
    $('hint').hidden = true;
    $('layoutWarn').hidden = data.layoutConfirmed !== false;
    $('report').hidden = true;
    resetLive();
    dotStartedAt = now();
    updateProgress();
  }

  function drawBoard(d) {
    const svg = $('board');
    svg.replaceChildren();
    svg.setAttribute('viewBox', `0 0 ${d.canvas.width} ${d.canvas.height}`);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

    // Face layer — pre-printed on the paper worksheet, so it is here from the
    // start too. The silhouette is still hidden: no lines exist yet.
    const gFace = el('g');
    const t = d.face.transform;
    const T = (px, py) => [px * t.scale + t.offsetX, py * t.scale + t.offsetY];
    for (const eye of [d.face.leftEye, d.face.rightEye]) {
      const [cx, cy] = T(eye.cx, eye.cy);
      gFace.appendChild(el('ellipse', {
        cx, cy, rx: eye.rx * t.scale, ry: eye.ry * t.scale, class: 'face',
      }));
    }
    const s = d.face.smileBox;
    const [sx0, sy0] = T(s.x, s.y), [sx1, sy1] = T(s.x + s.w, s.y + s.h);
    gFace.appendChild(el('path', {
      d: `M ${sx0} ${sy0} Q ${(sx0 + sx1) / 2} ${sy1 + (sy1 - sy0) * 0.55} ${sx1} ${sy0}`,
      class: 'smile',
    }));

    const gSeg = el('g');                       // lines, added as they are earned
    const gHalo = el('circle', { id: 'halo', r: 15, cx: -100, cy: -100 });
    const gDots = el('g'), gNums = el('g');
    const dots = new Map(), nums = new Map();

    for (const step of d.steps) {
      const { x, y } = step.position;
      const c = el('circle', { cx: x, cy: y, class: 'dot' });
      const n = el('text', { x: x + 7, y: y - 6, class: 'num' });
      n.textContent = step.sequence;
      gDots.appendChild(c); gNums.appendChild(n);
      dots.set(step.sequence, c); nums.set(step.sequence, n);
    }

    // the challenge shown at the active dot itself
    const gBadge = el('g');
    const badgeRect = el('rect', { class: 'badge', rx: 9, height: 30, width: 0, x: -200, y: -200 });
    const badgeText = el('text', { class: 'badgeText', x: -200, y: -200 });
    gBadge.append(badgeRect, badgeText);

    svg.append(gFace, gSeg, gHalo, gDots, gNums, gBadge);
    return { svg, gSeg, gHalo, dots, nums, badgeRect, badgeText };
  }

  function renderStep() {
    const { dots, nums } = refs;
    const completed = new Set(game.state.completedDots);
    const bySeq = new Map(data.steps.map(s => [s.sequence, s.position]));
    for (const [seq, c] of dots) {
      const done = completed.has(seq);
      const active = seq === game.state.currentSequence;
      c.setAttribute('class', `dot${done ? ' done' : ''}${active ? ' active' : ''}`);
      const n = nums.get(seq);
      n.setAttribute('class', `num${done ? ' done' : ''}${active ? ' active' : ''}`);
      if (!active) {                       // restore the default label placement
        const p = bySeq.get(seq);
        n.setAttribute('x', p.x + 7);
        n.setAttribute('y', p.y - 6);
        n.setAttribute('text-anchor', 'start');
      }
    }

    const step = game.currentStep();
    if (!step) { hideActiveMarkers(); return; }
    $('skip').hidden = false;

    const { x, y } = step.position;
    refs.gHalo.setAttribute('cx', x);
    refs.gHalo.setAttribute('cy', y);

    // badge beside the active dot, flipped to stay inside the canvas
    const label = step.challenge.prompt;
    const w = Math.max(34, label.length * 10 + 20);
    const left = x > data.canvas.width - w - 40;
    const bx = left ? x - w - 18 : x + 18;
    refs.badgeRect.setAttribute('width', w);
    refs.badgeRect.setAttribute('x', bx);
    refs.badgeRect.setAttribute('y', y - 15);
    refs.badgeText.setAttribute('x', bx + w / 2);
    refs.badgeText.setAttribute('y', y);
    refs.badgeText.textContent = label;

    // Keep the sequence number clear of the badge — it lands on the opposite
    // side, otherwise the one number the student needs sits under the label.
    const num = nums.get(step.sequence);
    num.setAttribute('x', left ? x + 12 : x - 12);
    num.setAttribute('y', y - 13);
    num.setAttribute('text-anchor', left ? 'start' : 'end');

    const isWord = /^[A-Z ]{2,}$/.test(label) || label.includes('+');
    $('prompt').textContent = label;
    $('prompt').className = `prompt${isWord ? ' word' : ''}`;
    $('challengeKind').textContent = ({
      'character-recall': 'Which keys make this?',
      'combination-recall': 'What does this type?',
      'shortcut-recall': 'What is the shortcut for',
    })[step.challenge.challengeType];
    $('ask').textContent = step.challenge.expected.dead
      ? 'Careful: this is a dead key. Nothing appears until you press the next key.'
      : ({
          'character-recall': 'Press the combination on your keyboard.',
          'combination-recall': 'Press it, and see what appears.',
          'shortcut-recall': 'Press the shortcut.',
        })[step.challenge.challengeType];
  }

  function hideActiveMarkers() {
    $('skip').hidden = true;
    refs.gHalo.setAttribute('cx', -100);
    refs.badgeRect.setAttribute('x', -300);
    refs.badgeText.textContent = '';
  }

  /* After a rebuild the SVG is empty again, so the lines a child already won
     are drawn back from the run itself. Which dots are joined is a fact about
     progress, never about the keyboard. */
  function replayEarnedSegments() {
    const done = game.state.completedDots;
    const pairs = done.filter(seq => seq > 1).map(seq => [seq - 1, seq]);
    if (game.state.status === COMPLETE && data.closed) {
      pairs.push([data.steps[data.steps.length - 1].sequence, 1]);
    }
    drawSegments(pairs);
  }

  function drawSegments(pairs) {
    const bySeq = new Map(data.steps.map(s => [s.sequence, s.position]));
    for (const [a, b] of pairs) {
      const p = bySeq.get(a), q = bySeq.get(b);
      refs.gSeg.appendChild(el('line', {
        x1: p.x, y1: p.y, x2: q.x, y2: q.y, class: 'seg',
      }));
    }
  }

  function updateProgress() {
    const p = game.progress();
    $('barFill').style.width = `${p.ratio * 100}%`;
    $('count').textContent = `${p.completed} / ${p.total}`;
    const s = game.summary();
    $('stats').textContent = p.completed
      ? `${Math.round(s.accuracy * 100)}% first-try`
      : '';
  }

  function setStatus(text, kind) {
    const n = $('status');
    n.textContent = text;
    n.className = `status${kind ? ' ' + kind : ''}`;
  }

  function showHint(hint) {
    const box = $('hint');
    if (!hint) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = '';
    const b = document.createElement('b');
    b.textContent = hint.reveals === 'answer' ? 'Answer' : 'Hint';
    box.append(b, document.createTextNode(hint.text));
  }

  /* ------------------------------------------------------- live readout -- */

  function resetLive() {
    const row = $('liveMods');
    row.replaceChildren();
    chips = (MODIFIER_CHIPS[data.platformId] ?? MODIFIER_CHIPS.windows).map(([flag, label]) => {
      const n = document.createElement('span');
      n.className = 'chip';
      n.textContent = label;
      row.appendChild(n);
      return [flag, n];
    });
    setLiveChar(null);
    $('liveTech').textContent = 'Press any key.';
  }

  function setLiveChar(text) {
    const n = $('liveChar');
    n.textContent = text ?? 'Waiting\u2026';
    n.className = `live-char${text ? '' : ' empty'}`;
  }

  function releaseModifiers() {
    for (const [, node] of chips) node.classList.remove('on');
  }

  /**
   * Mirrors what the browser reports, before any rule of the game runs.
   * Watching SHIFT light up while nothing appears is the point: that is how a
   * student learns a modifier produces no character by itself.
   */
  function onLiveKey(e) {
    for (const [flag, node] of chips) node.classList.toggle('on', !!e[flag]);
    if (e.type !== 'keydown' || e.repeat) return;

    if (e.key === 'Dead') {                     // accent keys wait for a partner
      setLiveChar('\u25CC');
      $('liveTech').textContent = `dead key \u00b7 code ${e.code} \u00b7 waiting for the next key`;
      return;
    }
    if (MODIFIER_KEYS.has(e.key)) {
      setLiveChar(null);
      $('liveTech').textContent = `${e.key} held \u00b7 code ${e.code} \u00b7 no character yet`;
      return;
    }
    setLiveChar(KEY_GLYPH[e.key] ?? e.key);
    $('liveTech').textContent = `key "${e.key}" \u00b7 code ${e.code}`;
  }

  /* ---------------------------------------------------------- challenge -- */

  const now = () => performance.now();

  function stopClock() {
    if (!run) return;
    clearTimeout(run.timer);
    clearInterval(run.timer);
    run.timer = null;
  }

  function cancelChallenge() {
    stopClock();
    run = null;
    $('clock').hidden = true;
    $('clock').classList.remove('low');
    for (const b of $('chal').querySelectorAll('button')) {
      b.setAttribute('aria-pressed', 'false');
    }
  }

  /**
   * A round always starts on a clean octopus. Two children who began at
   * different dots did different work, so their scores would not be
   * comparable — and comparing them is the whole point of a class challenge.
   */
  function startChallenge(minutes) {
    cancelChallenge();
    run = { minutes, records: [], phase: 'countdown', endsAt: 0, timer: null };
    build();
    for (const b of $('chal').querySelectorAll('button')) {
      b.setAttribute('aria-pressed', String(Number(b.dataset.min) === minutes));
    }
    $('clock').hidden = false;
    $('clock').textContent = formatClock(minutes * 60000);
    countIn(3);
  }

  /* Hands reach the keyboard before the clock runs. Without this the round
     eats the first seconds while a child is still finding the keys. */
  function countIn(n) {
    if (!run || run.phase !== 'countdown') return;
    if (n > 0) {
      setStatus(`Ready… ${n}`, 'good');
      run.timer = setTimeout(() => countIn(n - 1), 1000);
      return;
    }
    setStatus('Go!', 'good');
    run.phase = 'running';
    run.endsAt = now() + run.minutes * 60000;
    dotStartedAt = now();
    run.timer = setInterval(tick, 200);
  }

  function tick() {
    if (!run || run.phase !== 'running') return;
    const left = run.endsAt - now();
    const c = $('clock');
    c.textContent = formatClock(left);
    c.classList.toggle('low', left <= 10000);
    if (left <= 0) endChallenge('time');
  }

  function endChallenge(reason) {
    if (!run || run.phase === 'over') return;
    stopClock();
    run.phase = 'over';
    const spent = run.minutes * 60000 - Math.max(0, run.endsAt - now());
    $('clock').textContent = formatClock(reason === 'time' ? 0 : run.endsAt - now());
    $('clock').classList.toggle('low', reason === 'time');
    renderReport(reason, spent);
    hideActiveMarkers();
  }

  function renderReport(reason, spent) {
    const p = game.progress();
    const s = game.summary();
    const finished = reason === 'finished';

    $('reportTitle').textContent = finished ? 'Octopus complete!' : 'Time is up';
    $('scoreDots').textContent = finished ? formatClock(spent) : p.completed;
    $('scoreDots').nextElementSibling.textContent = finished
      ? `to join all ${p.total} dots`
      : `of ${p.total} dots joined`;
    $('scoreSub').textContent =
      `${Math.round(s.accuracy * 100)}% first try · ${run.minutes} minute round` +
      (s.skips ? ` · ${s.skips} skipped` : '');

    const again = document.createElement('button');
    again.type = 'button';
    again.className = 'again';
    again.textContent = 'Play again';
    again.addEventListener('click', () => { cancelChallenge(); build(); });
    $('report').querySelector('.again')?.remove();
    $('report').appendChild(again);

    fillList($('slowWrap'), 'Slowest combinations',
      slowestCombinations(run?.records ?? [], 3),
      c => `${c.seconds.toFixed(1)}s` + (c.tries ? ` · ${c.tries} wrong` : ''));

    fillList($('skipWrap'), 'Skipped — could not make these keys',
      mostSkipped(s.skipped, 4),
      c => `${c.count}\u00d7` + (c.target ? ` · ${c.target}` : ''));

    $('report').hidden = false;
  }

  function fillList(wrap, title, items, right) {
    wrap.replaceChildren();
    if (!items.length) return;
    const head = document.createElement('div');
    head.className = 'slowHead';
    head.textContent = title;
    wrap.appendChild(head);
    for (const c of items) {
      const row = document.createElement('div');
      row.className = 'slowRow';
      const k = document.createElement('kbd');
      k.textContent = c.label;
      const t = document.createElement('em');
      t.textContent = right(c);
      row.append(k, t);
      wrap.appendChild(row);
    }
  }

  /* -------------------------------------------------------------- input -- */

  function onKey(e) {
    if (run && run.phase === 'countdown') return;      // hands on, clock not yet
    if (run && run.phase === 'over') {
      // Never go silent. A frozen board with no explanation is indistinguishable
      // from a broken keyboard, and that is exactly how it was read.
      setStatus('The round is over — press Play again, or pick a new challenge.', 'bad');
      return;
    }
    if (e.repeat) return;                       // holding a key is one attempt
    if (isIdleModifier(e, game.currentStep()?.challenge.expected.dead === true)) {
      return;                                   // Shift alone is not a wrong answer
    }
    if (shouldPassThrough(e, layouts, data.platformId,
                          game.currentStep()?.challenge.expected.code)) return;
    if (game.state.status === COMPLETE) return;

    // Everything else belongs to the game: stop the browser saving, printing,
    // selecting the page or scrolling on space.
    e.preventDefault();

    const solving = game.currentStep();
    const r = game.submit(e);
    if (!r.handled) return;

    if (r.correct) {
      const viaDeadKey = e.key === 'Dead' && solving?.challenge.expected.dead;
      if (run?.phase === 'running' && solving) {
        run.records.push({
          label: solving.challenge.expected.label,
          ms: now() - dotStartedAt,
          tries: r.attempts,
        });
      }
      dotStartedAt = now();
      drawSegments(r.segments);
      renderStep();
      updateProgress();
      setStatus(
        viaDeadKey ? `Yes! Those are the keys. When you are really writing, ` +
                     `press Space next and the ${solving.challenge.target} appears.`
                   : (r.attempts === 0 ? 'Yes!' : 'Got it.'), 'good');
      showHint(null);
      if (r.completedAll) {
        onComplete();
        if (run?.phase === 'running') endChallenge('finished');
      }
    } else {
      setStatus('Not that one — try again.', 'bad');
      recheckLayout();          // a wrong answer is when a swapped layout shows
      const card = $('challengeCard');
      card.classList.remove('shake');
      void card.offsetWidth;                    // restart the animation
      card.classList.add('shake');
      showHint(r.hint);
    }
  }

  function onComplete() {
    hideActiveMarkers();
    if (!run) renderReport('finished', 0);   // free play earns a report too
    setStatus('🐙 Octopus complete!', 'good');
    $('prompt').textContent = '🐙';
    $('prompt').className = 'prompt';
    $('challengeKind').textContent = 'Finished';
    $('ask').textContent = 'You drew the whole octopus with your keyboard.';
  }
}
