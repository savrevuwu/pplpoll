// Spec §9: proposal text, exact-duplicate key, routing hints, refund reasons.
import { describe, expect, it } from 'vitest';
import {
  cleanQuestionText,
  isRefundable,
  isValidQuestionText,
  mentionsSensitiveTerm,
  questionExactKey,
} from '../src/index.js';

describe('question text', () => {
  it('cleans whitespace and control characters', () => {
    expect(cleanQuestionText('  Name\tsomething \n in your   purse ')).toBe(
      'Name something in your purse',
    );
  });
  it('validates length and needs letters', () => {
    expect(isValidQuestionText('Too short')).toBe(false);
    expect(isValidQuestionText('Name something in your purse')).toBe(true);
    expect(isValidQuestionText('1234567890123')).toBe(false);
    expect(isValidQuestionText('x'.repeat(201))).toBe(false);
  });
  it('exact-duplicate key ignores case, punctuation and spacing only', () => {
    expect(questionExactKey('Name something in your PURSE!')).toBe(
      questionExactKey('name something   in your purse'),
    );
    expect(questionExactKey("What's a fruit?")).toBe(questionExactKey('Whats a fruit'));
    expect(questionExactKey('Name a red fruit')).not.toBe(questionExactKey('Name a green fruit'));
  });
});

describe('routing and refunds', () => {
  it('flags whole-word sensitive terms only', () => {
    expect(mentionsSensitiveTerm('Name a famous political figure')).toBe(true);
    expect(mentionsSensitiveTerm('Name something you find in a diet soda')).toBe(false); // "die" inside "diet"
  });
  it('refunds good-faith rejections only', () => {
    expect(isRefundable('duplicate_similar')).toBe(true);
    expect(isRefundable('quality')).toBe(true);
    expect(isRefundable('spam')).toBe(false);
    expect(isRefundable('malicious')).toBe(false);
  });
});
