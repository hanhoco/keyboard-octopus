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

function combinationLabel(layouts, platformId, modifiers, baseKey) {
  const primary = layouts.platforms[platformId].primaryLabel;
  const parts = modifiers.map(m =>
    m === 'Primary' ? primary : layouts.modifierLabels[m]);
  return [...parts, baseKey].join(' + ');
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
    label: combinationLabel(layouts, platformId, char.modifiers, char.baseKey),
  };
}

/** Does this keyboard event satisfy the expected input? */
export function matchesExpected(expected, event, layouts, platformId) {
  const primaryProp = layouts.platforms[platformId].primaryModifier; // ctrlKey | metaKey
  const otherPrimary = primaryProp === 'ctrlKey' ? 'metaKey' : 'ctrlKey';

  if (expected.kind === 'shortcut') {
    return event.code === expected.code
      && event[primaryProp] === true
      && event[otherPrimary] !== true
      && event.shiftKey !== true
      && event.altKey !== true;
  }
  // A character is judged by what it produced, not by which keys were held —
  // except that a shortcut attempt must never count as a character.
  return event.key === expected.key
    && event.ctrlKey !== true
    && event.metaKey !== true;
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
    region: `Look at ${layouts.keyRegions[expected.region]}.`,
    answer: expected.label,
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
export function joinGameData({ geometry, curriculum, layouts, layoutId, platformId }) {
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
  const steps = [...geometry.dots]
    .sort((a, b) => a.sequence - b.sequence)
    .map(dot => {
      const c = bySequence.get(dot.sequence);
      if (!c) throw new JoinError(`no challenge for dot sequence ${dot.sequence}`);

      const expected = resolveExpectedInput(layouts, lid, pid, c.target);
      if (!expected) {
        throw new JoinError(
          `sequence ${c.sequence}: target "${c.target}" cannot be named on ` +
          `layout "${lid}" — rebuild the curriculum for this layout`);
      }
      return {
        sequence: dot.sequence,
        // straight from the geometry file, untouched
        position: { x: dot.x, y: dot.y },
        dotId: dot.id,
        referenceLabel: dot.referenceLabel,
        // straight from the curriculum file, plus layout-derived presentation
        challenge: {
          prompt: c.prompt,
          challengeType: c.challengeType,
          difficulty: c.difficulty,
          target: c.target,
          expected,
          hints: buildHints(layouts, pid, expected, policy),
        },
      };
    });

  return {
    canvas: geometry.meta.canvas,
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

export async function loadGameData({ layoutId, platformId, base = '' } = {}) {
  const [geometry, curriculum, layouts] = await Promise.all(
    Object.values(FILES).map(async f => {
      const res = await fetch(base + f);
      if (!res.ok) throw new JoinError(`could not load ${f} (HTTP ${res.status})`);
      return res.json();
    }));
  return joinGameData({
    geometry, curriculum, layouts,
    layoutId,
    platformId: platformId ?? detectPlatform(layouts, globalThis.navigator),
  });
}
