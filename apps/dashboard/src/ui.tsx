import type { ReactNode } from 'react';

export const NO_REPO = /not a Loom repo/i;

/** The v5 robot avatar: one colour per agent, eyes that scan, an antenna that pulses while it works. */
export function Bot({ color, size = 44, mode = '' }: { color: string; size?: number; mode?: string }) {
  return (
    <svg className={`bot ${mode}`} width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
      <line className="ant" x1="24" y1="4" x2="24" y2="10" stroke={color} strokeWidth="2.5" strokeLinecap="round" />
      <circle cx="24" cy="4" r="2.4" fill={color} />
      <rect x="8" y="10" width="32" height="26" rx="10" fill={color} />
      <rect x="13" y="16" width="22" height="13" rx="6" fill="#fff" />
      <g className="eyes"><circle cx="19.5" cy="22.5" r="2.4" fill="#141413" /><circle cx="28.5" cy="22.5" r="2.4" fill="#141413" /></g>
      <rect x="14" y="38" width="20" height="6" rx="3" fill={color} opacity=".55" />
    </svg>
  );
}

/** Shown in place of a screen when the folder was never set up: an instruction, not an error. */
export function NoRepo({ what }: { what?: string }) {
  return (
    <div className="card onboard reveal">
      <Bot color="#D97757" size={56} mode="m-back" />
      <h3>This folder is not a Loom repo yet</h3>
      <p>{what ?? 'Loom maps your code into a graph the first time. Run this once in the repo, then reload.'}</p>
      <code className="cmd">loom init</code>
    </div>
  );
}

/** A refused or unreachable route: the repo hint when that is the cause, otherwise the daemon's own message. */
export function Problem({ msg }: { msg: string }) {
  return NO_REPO.test(msg) ? <NoRepo /> : <p className="card sp bad">{msg}</p>;
}

export const Empty = ({ children }: { children: ReactNode }) => <div className="card sp dim reveal">{children}</div>;

export function Page({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <section className="screen on page">
      <div className="reveal"><div className="pgtitle">{title}</div>{sub && <div className="pgsub">{sub}</div>}</div>
      {children}
    </section>
  );
}
