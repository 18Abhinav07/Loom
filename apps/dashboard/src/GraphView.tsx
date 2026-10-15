// One sigma canvas over a node/edge list. Layout: forceatlas2 (200 iterations) whenever new nodes appear, positions kept.
import { useEffect, useRef } from 'react';
import Graph from 'graphology';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import Sigma, { DEFAULT_STYLES } from 'sigma';

export interface NodeLook { color: string; size: number; label: string; ring?: string | null }
export interface GraphViewProps {
  nodes: { id: string; qname: string }[]; edges: { from: string; to: string }[];
  node: (id: string) => NodeLook; edge?: (from: string, to: string) => { color: string; size: number };
  tick?: number;   // bump to repaint (animations)
}

const ekey = (a: string, b: string) => `${a}->${b}`;

export function GraphView({ nodes, edges, node, edge, tick }: GraphViewProps) {
  const box = useRef<HTMLDivElement>(null);
  const g = useRef(new Graph({ type: 'directed', multi: false }));
  const sigma = useRef<Sigma | null>(null);
  const pos = useRef(new Map<string, { x: number; y: number }>());

  useEffect(() => {
    if (!box.current) return;
    (window as any).__loom = { graph: g.current };   // for poking at the live graph from devtools
    sigma.current = new Sigma(g.current, box.current, {
      settings: { itemSizesReference: 'screen', stagePadding: 80, renderEdgeLabels: false, labelRenderedSizeThreshold: 0, allowInvalidContainer: true },
      styles: {
        nodes: { ...DEFAULT_STYLES.nodes,
          labelColor: '#e5e7eb',
          // the contract ring: a node-only backdrop in the holder's colour
          backdropVisibility: { whenData: { ring: true }, then: 'visible', else: { whenState: 'isHovered', then: 'visible', else: 'hidden' } },
          backdropArea: { whenData: { ring: true }, then: 'node', else: 'both' },
          backdropColor: { attribute: 'ringColor', defaultValue: '#1f2937' },
          backdropPadding: { whenData: { ring: true }, then: 5, else: 6 },
          backdropShadowBlur: { whenData: { ring: true }, then: 14, else: 12 },
          backdropShadowColor: { attribute: 'ringColor', defaultValue: 'rgba(0,0,0,0.5)' },
        },
        edges: DEFAULT_STYLES.edges,
      },
    } as any);
    return () => { sigma.current?.kill(); sigma.current = null; };
  }, []);

  // structure: add/drop nodes and edges, lay out when something new arrived
  useEffect(() => {
    const G = g.current; const want = new Set(nodes.map((n) => n.id));
    G.forEachNode((id) => { if (!want.has(id)) G.dropNode(id); });
    let fresh = 0;
    for (const n of nodes) {
      if (G.hasNode(n.id)) continue;
      const p = pos.current.get(n.id) ?? (fresh++, { x: Math.random() * 10, y: Math.random() * 10 });
      G.addNode(n.id, { ...p, label: n.qname, size: 8, color: '#6b7280' });
    }
    const wantE = new Set(edges.map((e) => ekey(e.from, e.to)));
    G.forEachEdge((k) => { if (!wantE.has(k)) G.dropEdge(k); });
    for (const e of edges) if (G.hasNode(e.from) && G.hasNode(e.to) && !G.hasEdge(ekey(e.from, e.to)))
      G.addDirectedEdgeWithKey(ekey(e.from, e.to), e.from, e.to, { size: 1, color: '#374151' });
    if (fresh && G.order > 1) {
      forceAtlas2.assign(G, { iterations: 200, settings: { ...forceAtlas2.inferSettings(G), gravity: 1, scalingRatio: 10 } });
    }
    G.forEachNode((id, a) => pos.current.set(id, { x: a.x, y: a.y }));
  }, [nodes, edges]);

  // looks: repaint every render (cheap at <= 300 nodes)
  useEffect(() => {
    const G = g.current;
    G.forEachNode((id) => {
      const l = node(id);
      G.mergeNodeAttributes(id, { color: l.color, size: l.size, label: l.label, ring: Boolean(l.ring), ringColor: l.ring ?? undefined });
    });
    if (edge) G.forEachEdge((k, _a, s, t) => G.mergeEdgeAttributes(k, edge(s, t)));
  });
  void tick;

  return <div ref={box} className="graph" />;
}
