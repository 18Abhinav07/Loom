import { spawnSync } from 'node:child_process';

export const dockerUp = () => spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;
export const dockerInstalled = () => spawnSync('docker', ['--version'], { stdio: 'ignore' }).status === 0;

/** Starts Docker if it is installed but not running, and waits (up to 2 minutes) until it answers. */
export function startDocker(): boolean {
  if (dockerUp()) return true;
  if (!dockerInstalled()) return false;
  console.log('starting Docker…');
  if (process.platform === 'darwin') spawnSync('open', ['-a', 'Docker'], { stdio: 'ignore' });
  else spawnSync('sudo', ['-n', 'systemctl', 'start', 'docker'], { stdio: 'ignore' });
  for (let i = 0; i < 60 && !dockerUp(); i++) spawnSync('sleep', ['2']);
  return dockerUp();
}
