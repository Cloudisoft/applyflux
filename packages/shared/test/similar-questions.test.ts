import { describe, expect, it } from 'vitest';
import { pickOption, questionKey, questionSimilarity } from '../src';

const sim = (a: string, b: string) => questionSimilarity(questionKey(a), questionKey(b));

describe('the same question in different words', () => {
  it('recognises reworded questions', () => {
    expect(sim('What size of support team have you led?', 'How big a support team have you led?')).toBeGreaterThanOrEqual(0.7);
    expect(sim('How did you hear about this role?', 'How did you first hear about this role?')).toBeGreaterThanOrEqual(0.8);
    expect(sim('How many years of experience do you have with React?', 'Years of React experience?')).toBeGreaterThanOrEqual(0.7);
  });
  it('reuses a general answer, but not one written for another company', () => {
    expect(sim('Why do you want to join our team?', 'Why do you want to join our team at Acme?')).toBeGreaterThanOrEqual(0.75);
    expect(sim('Why do you want to work at Northwind?', 'Why do you want to work at Acme?')).toBeLessThan(0.75);
  });
  it('keeps different questions apart', () => {
    expect(sim('How many years of experience do you have with React?', 'How many years of experience do you have with Python?')).toBeLessThan(0.7);
    expect(sim('What size of support team have you led?', 'Which ticketing tools have you used?')).toBeLessThan(0.7);
    expect(sim('Will you require visa sponsorship?', 'Are you legally authorized to work in the US?')).toBeLessThan(0.7);
  });
});

describe('options worded differently', () => {
  it('maps an answer onto the option that means it', () => {
    const opts = ['A job board', 'The company careers site', 'Someone referred me', 'Something else'];
    expect(pickOption(opts, 'Referral')?.option).toBe('Someone referred me');
    expect(pickOption(opts, 'Company website')?.option).toBe('The company careers site');
    expect(pickOption(opts, 'Job board')?.option).toBe('A job board');
  });
  it('never guesses between two options that both fit', () => {
    expect(pickOption(['Employee referral', 'Friend referral'], 'Referral')).toBeNull();
    expect(pickOption(['I am authorized to work', 'I am not authorized to work'], 'Authorized')).toBeNull();
  });
});
