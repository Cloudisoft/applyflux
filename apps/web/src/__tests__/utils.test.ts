import { describe, expect, it } from 'vitest';
import { cn, initials, salaryRange, timeAgo } from '../lib/utils';

describe('web utils', () => {
  it('merges tailwind classes', () => expect(cn('px-2', 'px-4')).toBe('px-4'));
  it('formats salary ranges', () => {
    expect(salaryRange(null, null)).toBeNull();
    expect(salaryRange(100000, 120000, 'USD')).toMatch(/100,000.*120,000/);
  });
  it('initials', () => expect(initials('Maya Chen')).toBe('MC'));
  it('relative time', () => expect(timeAgo(new Date().toISOString())).toBe('just now'));
});
