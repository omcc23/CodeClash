import { describe, expect, it } from 'vitest';
import { shapeInputs } from './shape.js';

describe('shapeInputs', () => {
  it('moves the largest value to the end and tries a one-element case', () => {
    const inputs = shapeInputs(['3\n1 5 2\n', '1\n7\n']);
    expect(inputs).toContain('3\n1 2 5\n');
    expect(inputs).toContain('1\n1\n');
    expect(inputs).toContain('3\n1 5 0\n');
    expect(inputs).not.toContain('3\n1 5 2\n');
    expect(inputs).not.toContain('1\n7\n');
  });

  it('edits a string line when the input is not a list of integers', () => {
    const inputs = shapeInputs(['2\nab\ncd\n']);
    expect(inputs).toContain('2\nab\n');
    expect(inputs).toContain('2\na\ncd\n');
  });

  it('stops at the limit and skips duplicates', () => {
    const inputs = shapeInputs(['4\n1 2 3 4\n', '4\n1 2 3 4\n'], 2);
    expect(inputs).toHaveLength(2);
    expect(new Set(inputs).size).toBe(2);
  });
});
