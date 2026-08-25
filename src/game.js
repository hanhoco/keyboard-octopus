/**
 * Stage 6 — game state.
 *
 * Deliberately free of DOM, timers and rendering so the rules can be tested
 * directly. The UI observes this; it never owns the rules.
 *
 * The sequential lock is structural, not a check: submit() only ever compares
 * input against the CURRENT step. There is no code path that looks at any
 * other step, so a student cannot skip ahead even by typing a future answer.
 */
import { matchesExpected } from './data.js';

export const PLAYING = 'playing';
export const COMPLETE = 'complete';

export function createGame(data, layouts, { hintsEnabled = true, resume = null } = {}) {
  if (!data?.steps?.length) throw new Error('createGame: no steps');

  // `resume` carries a run across a rebuild. Windows can switch keyboard
  // layout under our feet with Win+Space, and re-labelling the challenges
  // must not cost a child the dots they already earned.
  const state = resume ? { ...resume } : {
    currentSequence: 1,
    completedDots: [],          // sequences, in the order they were solved
    attempts: {},               // sequence -> wrong attempts on that dot
    hintsUsed: {},              // sequence -> how many hint tiers were shown
    totalCorrect: 0,
    totalWrong: 0,
    status: PLAYING,
  };

  const stepBySeq = new Map(data.steps.map(s => [s.sequence, s]));
  const total = data.steps.length;
  const last = data.steps[data.steps.length - 1].sequence;

  const currentStep = () => stepBySeq.get(state.currentSequence) ?? null;

  /** Highest hint tier earned by the wrong attempts made on the current dot. */
  function hintFor(sequence = state.currentSequence) {
    if (!hintsEnabled) return null;
    const step = stepBySeq.get(sequence);
    if (!step) return null;
    const tries = state.attempts[sequence] ?? 0;
    const earned = step.challenge.hints.filter(h => tries >= h.afterAttempts);
    return earned.length ? earned[earned.length - 1] : null;
  }

  function progress() {
    return {
      completed: state.completedDots.length,
      total,
      ratio: state.completedDots.length / total,
      currentSequence: state.status === COMPLETE ? null : state.currentSequence,
    };
  }

  /**
   * Feed a keyboard event in. Returns what happened; the UI renders from this.
   * Never throws on bad input — a wrong key is a normal part of the game.
   */
  function submit(event) {
    if (state.status === COMPLETE) {
      return { handled: false, reason: 'complete' };
    }
    const step = currentStep();
    const seq = step.sequence;

    if (!matchesExpected(step.challenge.expected, event, layouts, data.platformId)) {
      state.attempts[seq] = (state.attempts[seq] ?? 0) + 1;
      state.totalWrong += 1;
      const hint = hintFor(seq);
      if (hint) state.hintsUsed[seq] = step.challenge.hints.indexOf(hint) + 1;
      return {
        handled: true,
        correct: false,
        sequence: seq,
        attempts: state.attempts[seq],
        hint,
        segments: [],
        status: state.status,
      };
    }

    // correct
    state.completedDots.push(seq);
    state.totalCorrect += 1;

    // A line may only ever join consecutive dots. The previous dot is
    // guaranteed solved, because that is the only way we reached this one.
    const segments = [];
    if (seq > 1) segments.push([seq - 1, seq]);
    const isLast = seq === last;
    if (isLast && data.closed) segments.push([last, 1]);   // close the silhouette

    if (isLast) {
      state.status = COMPLETE;
      state.currentSequence = null;
    } else {
      state.currentSequence = seq + 1;
    }

    return {
      handled: true,
      correct: true,
      sequence: seq,
      attempts: state.attempts[seq] ?? 0,
      segments,
      next: state.currentSequence,
      status: state.status,
      completedAll: isLast,
    };
  }

  /** Everything the student practised — for the completion screen. */
  function summary() {
    const solved = state.completedDots.map(s => stepBySeq.get(s));
    const byType = {}, targets = new Set(), families = new Set();
    for (const s of solved) {
      byType[s.challenge.challengeType] = (byType[s.challenge.challengeType] ?? 0) + 1;
      targets.add(s.challenge.target);
      families.add(s.challenge.expected.modifiers.join('+'));
    }
    const attempts = Object.values(state.attempts).reduce((a, b) => a + b, 0);
    return {
      solved: solved.length,
      total,
      byType,
      distinctTargets: [...targets],
      modifierFamilies: [...families],
      wrongAttempts: attempts,
      hintsUsed: Object.values(state.hintsUsed).reduce((a, b) => a + b, 0),
      accuracy: state.totalCorrect / Math.max(1, state.totalCorrect + state.totalWrong),
    };
  }

  return { state, submit, currentStep, hintFor, progress, summary, total };
}
