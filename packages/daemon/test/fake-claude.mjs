// Stand-in for `claude -p --input-format stream-json`: echoes each user line, then reports a result.
import { createInterface } from 'node:readline';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
let n = 0;
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
out({ type: 'system', subtype: 'init', session_id: `fake-${process.pid}` });
createInterface({ input: process.stdin }).on('line', (l) => {
  let text = '';
  try { text = JSON.parse(l).message.content.map((c) => c.text).join(''); } catch { return; }
  if (text.includes('CRASH')) process.exit(3);
  if (process.env.FAKE_COMMIT === '1') {
    writeFileSync(`fake-${process.pid}-${++n}.txt`, text);
    const g = (...a) => execFileSync('git', ['-c', 'user.email=f@f', '-c', 'user.name=f', ...a], { stdio: 'ignore' });
    g('add', '-A'); g('commit', '-qm', 'fake');
  }
  out({ type: 'assistant', message: { content: [{ type: 'text', text: `ack:${text.slice(0, 40)}` }] } });
  out({ type: 'result', session_id: `fake-${process.pid}`, is_error: false });
});
