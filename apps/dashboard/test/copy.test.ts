// Final review I10: the UI names the benchmark codebase only as "a real open-source Python codebase".
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

const app = join(__dirname, '..');
test('no dashboard source or page names the benchmark codebase', () => {
  const files = [join(app, 'index.html'), ...readdirSync(join(app, 'src')).map((f) => join(app, 'src', f))];
  const named = files.filter((f) => /django/i.test(readFileSync(f, 'utf8')));
  expect(named.map((f) => f.slice(app.length + 1))).toEqual([]);
});
