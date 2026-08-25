/**
 * Stage 5 — join the locked geometry to the keyboard curriculum.
 *
 *   DOT  →  POSITION  →  KEYBOARD CHALLENGE  →  EXPECTED INPUT
 *
 * The join key is `sequence` and nothing else. Position is read exclusively
 * from the geometry file; the challenge is read exclusively from the
 * curriculum file. Neither can reach into the other, which is what makes
 * "changing a prompt must not move a dot" a structural guarantee rather than
 * a promise. See test/separation.test.js — it proves it.
 */

/* ------------------------------------------------------------------ layout */

/** Which physical modifier acts as the shortcut key on this platform. */
export function detectPlatform(layouts, nav) {
  const ua = nav?.userAgentData?.platform ?? nav?.platform ?? '';
  return /mac|iphone|ipad/i.test(ua) ? 'mac' : layouts.defaultPlatform;
}

/**
 * Which keyboard the student is actually sitting at.
 *
 * getLayoutMap() reports what each physical key produces on this machine, so
 * the layout is MEASURED, not guessed from the interface language. A Chilean
 * school running Windows in English still has Latin American keyboards on the
 * desks, and navigator.language would get that exactly wrong.
 *
 * Chromium only. Anywhere else this returns null and the caller keeps the
 * configured default, because naming the wrong combination is worse than
 * naming none: the whole point of the layout tables is to not lie.
 */
export async function detectLayout(layouts, nav) {
  let map = null;
  try { map = await nav?.keyboard?.getLayoutMap?.(); } catch { map = null; }
  if (!map) return null;
  // Windows spells the key Ñ, the browser hands back ñ. Comparing them
  // literally would fail to recognise both Spanish keyboards.
  const same = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
  for (const [id, layout] of Object.entries(layouts.layouts)) {
    const fp = layout.fingerprint;
    if (fp && Object.entries(fp).every(([code, ch]) => same(map.get(code), ch))) return id;
  }
  return null;
}

function combinationLabel(layouts, platformId, modifiers, baseKey) {
  const platform = layouts.platforms[platformId];
  const parts = modifiers.map(m => {
    if (m === 'Primary') return platform.primaryLabel;
    if (m === 'Meta') return platform.metaLabel ?? 'Meta';
    return layouts.modifierLabels[m];
  });
  return [...parts, baseKey].join(' + ');
}

/**
 * Which physical modifiers a shortcut asks for, as browser event flags.
 *
 * Written out rather than assumed, because not every shortcut is
 * "the primary key plus a letter": a screenshot is Win+Shift+S, or a lone
 * PrtScn with no modifier at all.
 */
function modifierState(modifiers, layouts, platformId) {
  const primaryProp = layouts.platforms[platformId].primaryModifier;
  const want = { shiftKey: false, ctrlKey: false, altKey: false, metaKey: false };
  for (const m of modifiers) {
    if (m === 'Primary') want[primaryProp] = true;
    else if (m === 'Shift') want.shiftKey = true;
    else if (m === 'Alt') want.altKey = true;
    else if (m === 'Meta') want.metaKey = true;
    else if (m === 'AltGr') { want.altKey = true; want.ctrlKey = true; }
  }
  return want;
}

/**
 * Resolve a curriculum target into something we can match a keyboard event
 * against, plus a human label for hints and the answer reveal.
 *
 * Characters match on `event.key`. This matters: by the time a keydown fires,
 * the OS has already applied the student's layout, so '@' is '@' on every
 * keyboard in the world. The layout config is not used to *detect* the
 * character — only to *name* the combination correctly when we talk about it.
 *
 * Shortcuts match on `event.code` plus the platform's primary modifier,
 * because Ctrl+C has to stay Ctrl+C no matter where the letters sit.
 */
export function resolveExpectedInput(layouts, layoutId, platformId, target) {
  const shortcut = layouts.shortcuts[target];
  if (shortcut) {
    return {
      kind: 'shortcut',
      code: shortcut.code,
      modifiers: shortcut.modifiers,
      region: shortcut.region,
      label: combinationLabel(layouts, platformId, shortcut.modifiers, shortcut.baseKey),
    };
  }
  const char = layouts.layouts[layoutId].characters[target];
  if (!char) return null;              // unnameable on this layout
  return {
    kind: 'character',
    key: target,
    modifiers: char.modifiers,
    region: char.region,
    dead: char.dead === true,
    code: char.code,
    where: KEY_POSITION[char.code] ?? null,
    label: combinationLabel(layouts, platformId, char.modifiers, char.baseKey),
  };
}

/* AltGr is Ctrl+Alt on Windows: the browser reports ctrlKey true for a key
   that is producing a character, not running a shortcut. Without this, every
   AltGr character on a Latin American keyboard — @ and ~ — is rejected. */
const isAltGr = e => e.altKey === true && e.ctrlKey === true;

/** Does this keyboard event satisfy the expected input? */
export function matchesExpected(expected, event, layouts, platformId) {
  const primaryProp = layouts.platforms[platformId].primaryModifier; // ctrlKey | metaKey

  if (expected.kind === 'shortcut') {
    if (event.code !== expected.code) return false;
    const want = modifierState(expected.modifiers, layouts, platformId);
    // AltGr reports Ctrl and Alt together; a shortcut asking for neither must
    // not be satisfied by one of them arriving on its own.
    return ['shiftKey', 'ctrlKey', 'altKey', 'metaKey']
      .every(flag => (event[flag] === true) === want[flag]);
  }
  // A dead key delivers no character on keydown: it waits for the next
  // keystroke before deciding what to compose. The question asked which keys
  // make the symbol, and those are the keys, so it counts.
  if (expected.dead && event.key === 'Dead') {
    return event.code === expected.code
      && event.altKey === expected.modifiers.includes('AltGr')
      && event.shiftKey === expected.modifiers.includes('Shift');
  }

  // A character is judged by what it produced, not by which keys were held —
  // except that a shortcut attempt must never count as a character.
  return event.key === expected.key
    && event.metaKey !== true
    && (event.ctrlKey !== true || isAltGr(event));
}

/**
 * Where a key SITS, for the keys whose printing cannot be trusted.
 *
 * A Spanish-printed keyboard running a US layout has no key marked ";" — that
 * one is painted Ñ — so "Shift + ;" is true and unfollowable at the same time.
 * Letters and digits are painted the same the world over and need no help.
 * Everything else is described by where it is, which no paint can contradict.
 */
const KEY_POSITION = {
  Backquote:     'the key to the left of the 1',
  Minus:         'the key to the right of the 0',
  Equal:         'two keys to the right of the 0',
  BracketLeft:   'the key to the right of the P',
  BracketRight:  'two keys to the right of the P',
  Backslash:     'the key just above Enter',
  Semicolon:     'the key to the right of the L',
  Quote:         'two keys to the right of the L',
  IntlBackslash: 'the key to the left of the Z',
  Comma:         'the key to the right of the M',
  Period:        'two keys to the right of the M',
  Slash:         'three keys to the right of the M',
};

/** What the card shows when the curriculum's own wording no longer applies. */
function promptFor(challengeType, target, expected) {
  if (challengeType === 'combination-recall') return expected.label;
  return target;                       // the symbol, or the name of the action
}

/* -------------------------------------------------------------------- hints */

const MODIFIER_HINT = {
  Shift: 'This one uses the SHIFT key.',
  AltGr: 'This one uses the ALT GR key.',
};

function buildHints(layouts, platformId, expected, policy) {
  if (!policy?.enabled) return [];
  const primary = layouts.platforms[platformId].primaryLabel;
  const text = {
    modifier: expected.modifiers.includes('Primary')
      ? `This one uses the ${primary.toUpperCase()} key.`
      : MODIFIER_HINT[expected.modifiers[0]] ?? 'This one uses a modifier key.',
    // Position beats naming: it survives a keyboard painted in another
    // language, which is exactly the case that stalls a class.
    region: expected.where
      ? `Look at ${expected.where}.`
      : `Look at ${layouts.keyRegions[expected.region]}.`,
    answer: expected.where
      ? `${expected.label}  —  ${expected.where}`
      : expected.label,
  };
  return policy.tiers.map(t => ({
    afterAttempts: t.afterAttempts,
    reveals: t.reveals,
    text: text[t.reveals],
  }));
}

/* --------------------------------------------------------------------- join */

export class JoinError extends Error {}

/**
 * Pure join. Takes already-parsed JSON so it is trivially testable and can
 * never depend on how the files were fetched.
 */
/**
 * Every target the curriculum uses, grouped by kind of challenge.
 * Used both to replace an ignored target and to reroll one on Skip.
 */
function targetsByType(curriculum, allowed) {
  const byType = new Map();
  for (const c of curriculum.challenges) {
    if (!allowed(c.target)) continue;
    const list = byType.get(c.challengeType) ?? [];
    if (!list.includes(c.target)) list.push(c.target);
    byType.set(c.challengeType, list);
  }
  for (const list of byType.values()) list.sort();
  return byType;
}

export function joinGameData({ geometry, curriculum, layouts, layoutId, platformId,
                               config }) {
  const lid = layoutId ?? layouts.defaultLayout;
  const pid = platformId ?? layouts.defaultPlatform;
  if (!layouts.layouts[lid]) throw new JoinError(`unknown layout "${lid}"`);
  if (!layouts.platforms[pid]) throw new JoinError(`unknown platform "${pid}"`);

  if (geometry.dots.length !== curriculum.challenges.length) {
    throw new JoinError(
      `geometry has ${geometry.dots.length} dots but the curriculum has ` +
      `${curriculum.challenges.length} challenges`);
  }

  const bySequence = new Map();
  for (const c of curriculum.challenges) {
    if (bySequence.has(c.sequence)) {
      throw new JoinError(`duplicate challenge for sequence ${c.sequence}`);
    }
    bySequence.set(c.sequence, c);
  }

  const policy = curriculum.meta.hintPolicy;

  /* A target the classroom asked us not to use. The dot stays exactly where it
     is — the geometry is locked — and is handed a different question of the
     same kind, so the octopus is drawn identically either way. */
  const ignored = new Set(config?.ignore ?? []);
  const allowed = t => !ignored.has(t);
  const pool = targetsByType(curriculum, allowed);
  if (![...pool.values()].some(list => list.length)) {
    throw new JoinError('every challenge is on the ignore list; nothing left to ask');
  }

  /* The target standing on each dot, decided before anything is resolved for a
     particular keyboard. Ignoring and adding both edit this plan; neither ever
     touches a position. */
  const plan = new Map(curriculum.challenges.map(c => [c.sequence, c.target]));

  let swapped = 0;
  for (const c of curriculum.challenges) {
    if (!ignored.has(c.target)) continue;
    const choices = pool.get(c.challengeType)?.length
      ? pool.get(c.challengeType)
      : [...pool.values()].find(l => l.length);
    plan.set(c.sequence, choices[swapped++ % choices.length]);   // deterministic
  }

  /* An extra takes its turn from whatever is repeated most, so bringing one in
     costs the curriculum nothing: no target is ever reduced to zero. */
  for (const extra of config?.add ?? []) {
    if (ignored.has(extra)) continue;
    if ([...plan.values()].includes(extra)) continue;            // already asked
    const type = layouts.shortcuts[extra] ? 'shortcut-recall' : 'character-recall';
    const of = curriculum.challenges.filter(c => c.challengeType === type);
    const counts = new Map();
    for (const c of of) counts.set(plan.get(c.sequence),
      (counts.get(plan.get(c.sequence)) ?? 0) + 1);
    let best = null;
    for (const c of of) {
      if ((counts.get(plan.get(c.sequence)) ?? 0) < 2) continue;
      if (best === null ||
          counts.get(plan.get(c.sequence)) > counts.get(plan.get(best))) best = c.sequence;
    }
    if (best !== null) plan.set(best, extra);
  }

  /* A target pinned to a dot by hand. The last dots are a natural place for
     something a class wants to end on. */
  for (const [seq, target] of Object.entries(config?.at ?? {})) {
    const n = Number(seq);
    if (!plan.has(n)) throw new JoinError(`config.at: there is no dot ${seq}`);
    if (ignored.has(target)) continue;
    plan.set(n, target);
  }

  const steps = [...geometry.dots]
    .sort((a, b) => a.sequence - b.sequence)
    .map(dot => {
      const c = bySequence.get(dot.sequence);
      if (!c) throw new JoinError(`no challenge for dot sequence ${dot.sequence}`);

      const target = plan.get(c.sequence);
      // The kind of question follows the target: pin a shortcut onto a dot and
      // it becomes a shortcut, whatever the curriculum wrote there.
      const challengeType = layouts.shortcuts[target]
        ? 'shortcut-recall'
        : (c.challengeType === 'shortcut-recall' ? 'character-recall' : c.challengeType);
      const expected = resolveExpectedInput(layouts, lid, pid, target);
      if (!expected) {
        throw new JoinError(
          `sequence ${c.sequence}: target "${target}" cannot be named on ` +
          `layout "${lid}" — rebuild the curriculum for this layout`);
      }
      /* A "what does this type?" challenge PRINTS a combination on screen, and
         the curriculum stores that text — written once, in US QWERTY. Shown
         unchanged to a Latin American keyboard it reads "Shift + 2" for @,
         which there produces a quote mark. The child does exactly as told and
         is marked wrong. The combination must come from the layout, like
         every other combination this game names. */
      const prompt = challengeType === 'combination-recall'
        ? expected.label
        : (target === c.target ? c.prompt : promptFor(challengeType, target, expected));

      return {
        sequence: dot.sequence,
        // straight from the geometry file, untouched
        position: { x: dot.x, y: dot.y },
        dotId: dot.id,
        referenceLabel: dot.referenceLabel,
        // straight from the curriculum file, plus layout-derived presentation
        challenge: {
          prompt,
          challengeType,
          difficulty: c.difficulty,
          target,
          expected,
          hints: buildHints(layouts, pid, expected, policy),
        },
      };
    });

  /* Everything Skip is allowed to offer instead, resolved once for this
     keyboard. Kept off the steps themselves: one entry per target, not per dot. */
  const alternatives = {};
  const played = new Map();
  for (const c of curriculum.challenges) {
    const list = played.get(c.challengeType) ?? [];
    const t = plan.get(c.sequence);
    if (!list.includes(t)) list.push(t);
    played.set(c.challengeType, list);
  }
  for (const list of played.values()) list.sort();
  for (const [type, targets] of played) {
    alternatives[type] = targets.map(t => {
      const e = resolveExpectedInput(layouts, lid, pid, t);
      return e && {
        target: t,
        prompt: type === 'combination-recall' ? e.label : promptFor(type, t, e),
        challengeType: type,
        expected: e,
        hints: buildHints(layouts, pid, e, policy),
      };
    }).filter(Boolean);
  }

  return {
    canvas: geometry.meta.canvas,
    alternatives,
    ignored: [...ignored],
    face: geometry.meta.face,
    closed: geometry.meta.closed === true,
    layoutId: lid,
    platformId: pid,
    layoutName: layouts.layouts[lid].name,
    platformName: layouts.platforms[pid].name,
    total: steps.length,
    steps,
  };
}

/* ------------------------------------------------------------------ loading */

const FILES = {
  geometry:   'octopus-path-LOCKED.json',
  curriculum: 'keyboard-curriculum.json',
  layouts:    'keyboard-layouts.json',
};

/**
 * The classroom's own settings. Optional on purpose: a missing or malformed
 * file must never stop a lesson, so it degrades to "ignore nothing".
 */
export async function loadConfig(base = '') {
  try {
    const res = await fetch(`${base}game-config.json`);
    if (!res.ok) return { ignore: [] };
    const cfg = await res.json();
    return { ignore: Array.isArray(cfg?.ignore) ? cfg.ignore : [] };
  } catch {
    return { ignore: [] };
  }
}

export async function loadGameData({ layoutId, platformId, base = '' } = {}) {
  const [geometry, curriculum, layouts] = await Promise.all(
    Object.values(FILES).map(async f => {
      const res = await fetch(base + f);
      if (!res.ok) throw new JoinError(`could not load ${f} (HTTP ${res.status})`);
      return res.json();
    }));
  const nav = globalThis.navigator;
  const config = await loadConfig(base);
  const measured = layoutId ? null : await detectLayout(layouts, nav);
  const data = joinGameData({
    geometry, curriculum, layouts, config,
    layoutId: layoutId ?? measured ?? undefined,
    platformId: platformId ?? detectPlatform(layouts, nav),
  });
  // Whether we KNOW the keyboard or merely fell back to the default. The UI
  // says so out loud rather than naming keys it cannot vouch for.
  data.layoutConfirmed = Boolean(layoutId || measured);
  return data;
}
