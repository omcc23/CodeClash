function normalize(text: string) {
  return text.replace(/\r\n/g, '\n').trim();
}

function withNewline(text: string) {
  return text.endsWith('\n') ? text : `${text}\n`;
}

/** A line of integers with its largest value moved to the end, or null when that changes nothing. */
function maxAtEnd(line: string): string | null {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 2 || parts.some((part) => !/^-?\d+$/.test(part))) return null;
  const max = Math.max(...parts.map(Number));
  const index = parts.findIndex((part) => Number(part) === max);
  if (index === parts.length - 1) return null;
  const moved = parts.slice();
  const [value] = moved.splice(index, 1);
  moved.push(value!);
  return moved.join(' ');
}

/**
 * Small edits of tests the reference already accepts. Used when a problem has no input spec,
 * so boundary and random generation cannot run. The caller still drops anything the reference
 * cannot answer.
 */
export function shapeInputs(inputs: string[], limit = 12): string[] {
  const seen = new Set(inputs.map(normalize));
  const out: string[] = [];
  const add = (text: string) => {
    const key = normalize(text);
    if (!key || key.length > 8_000 || seen.has(key) || out.length >= limit) return;
    seen.add(key);
    out.push(withNewline(text));
  };

  for (const raw of inputs) {
    if (out.length >= limit) break;
    const lines = normalize(raw).split('\n');
    lines.forEach((line, index) => {
      const moved = maxAtEnd(line);
      if (!moved) return;
      const next = lines.slice();
      next[index] = moved;
      add(next.join('\n'));
    });

    const tokens = normalize(raw).split(/\s+/);
    const ints = tokens.every((token) => /^-?\d+$/.test(token));
    if (ints && tokens.length >= 2) {
      const count = Number(tokens[0]);
      const rest = tokens.slice(1);
      if (count === rest.length && count > 1) {
        add(`1\n${rest[0]}`);
        const zeroed = rest.slice();
        zeroed[zeroed.length - 1] = '0';
        add(`${count}\n${zeroed.join(' ')}`);
        const negative = rest.slice();
        negative[negative.length - 1] = '-1';
        add(`${count}\n${negative.join(' ')}`);
      }
      const bumped = tokens.slice();
      bumped[bumped.length - 1] = String(Number(bumped[bumped.length - 1]) + 1);
      add(bumped.join(' '));
    } else if (lines.length >= 2) {
      add(lines.slice(0, -1).join('\n'));
      const longest = lines.reduce((best, line) => (line.length > best.length ? line : best), '');
      if (longest.length > 1) add(normalize(raw).replace(longest, longest.slice(0, -1)));
    }
  }
  return out;
}
