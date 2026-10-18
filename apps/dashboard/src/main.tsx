import { Component, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './theme.css';

class Guard extends Component<{ children: ReactNode }, { err: string }> {
  state = { err: '' };
  static getDerivedStateFromError(e: Error) { return { err: e.message }; }
  render() { return this.state.err ? <div className="card" style={{ margin: 40, padding: 24 }}><b>Something on this screen broke.</b><p className="dim">{this.state.err}</p><button className="btn or" onClick={() => location.reload()}>Reload</button></div> : this.props.children; }
}

createRoot(document.getElementById('root')!).render(<Guard><App /></Guard>);
