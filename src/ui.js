/**
 * Stage 6 — the interactive shell.
 *
 * Renders the board and feeds keyboard events into the game state machine.
 * It owns no rules: every decision about right/wrong, advancing and which
 * line to draw comes back from game.submit().
 */
import { createGame, PLAYING, COMPLETE } from './game.js';
import { joinGameData } from './data.js';

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

export function startUI(initialData) {
  let data = initialData;
  let game, layouts;
  let refs = {};
  let chips = [];                 // [modifier flag, chip node]

  // the raw config is needed again if the student switches platform
  const layoutsPromise = fetch('keyboard-layouts.json').then(r => r.json());

  layoutsPromise.then(cfg => {
    layouts = cfg;
    $('platform').value = data.platformId;
    build();
    $('platform').addEventListener('change', e => {
      switchPlatform(e.target.value);
    });
    $('restart').addEventListener('click', () => { build(); $('restart').blur(); });
    window.addEventListener('keydown', onKey, { capture: true });
    // Separate from onKey on purpose: the readout must also see the keys the
    // game ignores — modifiers on their own, and browser pass-throughs.
    window.addEventListener('keydown', onLiveKey, { capture: true });
    window.addEventListener('keyup', onLiveKey, { capture: true });
    window.addEventListener('blur', releaseModifiers);
  });

  function switchPlatform(platformId) {
    Promise.all([
      fetch('octopus-path-LOCKED.json').then(r => r.json()),
      fetch('keyboard-curriculum.json').then(r => r.json()),
    ]).then(([geometry, curriculum]) => {
      data = joinGameData({ geometry, curriculum, layouts, platformId });
      build();
    });
  }

  /* ------------------------------------------------------------- render -- */

  function build() {
    game = createGame(data, layouts);
    refs = drawBoard(data);
    $('layoutName').textContent = `${data.layoutName} · ${data.platformName}`;
    renderStep();
    setStatus('', '');
    $('hint').hidden = true;
    resetLive();
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
    $('ask').textContent = ({
      'character-recall': 'Press the combination on your keyboard.',
      'combination-recall': 'Press it, and see what appears.',
      'shortcut-recall': 'Press the shortcut.',
    })[step.challenge.challengeType];
  }

  function hideActiveMarkers() {
    refs.gHalo.setAttribute('cx', -100);
    refs.badgeRect.setAttribute('x', -300);
    refs.badgeText.textContent = '';
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

  /* -------------------------------------------------------------- input -- */

  function shouldPassThrough(e) {
    if (PASSTHROUGH_KEYS.has(e.key)) return true;
    const primary = e[layouts.platforms[data.platformId].primaryModifier];
    if (primary && PASSTHROUGH_WITH_PRIMARY.has(e.code)) return true;
    if (primary && e.shiftKey && e.altKey) return true;   // devtools-ish combos
    return false;
  }

  function onKey(e) {
    if (e.repeat) return;                       // holding a key is one attempt
    if (MODIFIER_KEYS.has(e.key)) return;       // Shift alone is not a wrong answer
    if (shouldPassThrough(e)) return;
    if (game.state.status === COMPLETE) return;

    // Everything else belongs to the game: stop the browser saving, printing,
    // selecting the page or scrolling on space.
    e.preventDefault();

    const r = game.submit(e);
    if (!r.handled) return;

    if (r.correct) {
      drawSegments(r.segments);
      renderStep();
      updateProgress();
      setStatus(r.attempts === 0 ? 'Yes!' : 'Got it.', 'good');
      showHint(null);
      if (r.completedAll) onComplete();
    } else {
      setStatus('Not that one — try again.', 'bad');
      const card = $('challengeCard');
      card.classList.remove('shake');
      void card.offsetWidth;                    // restart the animation
      card.classList.add('shake');
      showHint(r.hint);
    }
  }

  function onComplete() {
    hideActiveMarkers();
    setStatus('🐙 Octopus complete!', 'good');
    $('prompt').textContent = '🐙';
    $('prompt').className = 'prompt';
    $('challengeKind').textContent = 'Finished';
    $('ask').textContent = 'You drew the whole octopus with your keyboard.';
  }
}
