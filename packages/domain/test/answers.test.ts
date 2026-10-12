// Spec §4: one free-text answer; garbage/nonanswers/links rejected; matching key for counting.
import { describe, expect, it } from 'vitest';
import { answerKey, checkAnswer } from '../src/index.js';

describe('answer quality gate', () => {
  it.each(['Keys', 'my keys', 'Lip balm', 'Phone charger', '7 Up', 'Crème brûlée', 'A pen'])(
    'accepts %j',
    (a) => {
      expect(checkAnswer(a).ok).toBe(true);
    },
  );
  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['???', 'empty'],
    ['idk', 'not_an_answer'],
    ["I don't know", 'not_an_answer'],
    ['N/A', 'not_an_answer'],
    ['aaaaaa', 'not_an_answer'],
    ['sdfghjkl', 'not_an_answer'],
    ['visit www.spam.com', 'link'],
    ['http://x.y', 'link'],
    ['x'.repeat(81), 'too_long'],
  ])('rejects %j as %s', (a, reason) => {
    expect(checkAnswer(a)).toEqual({ ok: false, reason });
  });
  it('blocks configured abusive terms as whole words', () => {
    expect(checkAnswer('a badword here', ['badword'])).toEqual({ ok: false, reason: 'blocked' });
    expect(checkAnswer('notabadwordhere', ['badword']).ok).toBe(true);
  });
});

describe('answerKey', () => {
  it('ignores case, punctuation, spacing and leading articles', () => {
    expect(answerKey('The Keys!')).toBe('keys');
    expect(answerKey('  my   KEYS ')).toBe('keys');
    expect(answerKey('a pen')).toBe('pen');
  });
  it('keeps meaningfully different answers apart', () => {
    expect(answerKey('car keys')).not.toBe(answerKey('keys'));
    expect(answerKey('The Who')).toBe('who'); // known limit: article stripping; refined by M4 groups
  });
});
