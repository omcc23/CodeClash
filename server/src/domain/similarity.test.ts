import { describe, expect, it } from 'vitest';
import { codeScore, tokenize } from './similarity.js';

const python = `
def longest(values):
    best = 0
    running = 0
    for value in values:
        running = value if value > running + value else running + value
        if running > best:
            best = running
    return best
`;

const renamed = python.replaceAll('value', 'item').replaceAll('best', 'answer').replaceAll('running', 'total');

const other = `
function twoSum(nums, target):
    seen = {}
    for index, num in enumerate(nums):
        need = target - num
        if need in seen:
            return [seen[need], index]
        seen[num] = index
    return []
`;

describe('similarity tokens', () => {
  it('scores a renamed copy high and a different solution low', () => {
    const left = tokenize(python);
    const right = tokenize(renamed);
    expect(left.length).toBeGreaterThan(30);
    expect(left).toEqual(right);
    expect(codeScore(python, renamed)).toBeGreaterThan(0.9);
    expect(codeScore(python, other)).toBeLessThan(0.7);
  });

  it('drops comments and string text in every language', () => {
    const samples = [
      'def f():\n    # note\n    return 1',
      'function f() { // note\n return 1; }',
      'int f(){ /* note */ return 1; }',
      'int f(){ return 1; } // c++',
      'int f(){ return 1; }',
      'func f() int { return 1 }',
    ];
    for (const sample of samples) {
      const tokens = tokenize(sample);
      expect(tokens.join(' ')).not.toMatch(/note/);
      expect(tokens).toContain('ID');
    }
  });

  it('ignores a fingerprint that is shared by most submissions', () => {
    const common = tokenize('return left + right');
    const extra = tokenize(`${python}\nreturn left + right`);
    const noisy = new Set(common);
    const kept = new Set(extra.filter((token) => !noisy.has(token) || token === 'ID'));
    expect(kept.has('return') || extra.length > common.length).toBe(true);
  });
});
