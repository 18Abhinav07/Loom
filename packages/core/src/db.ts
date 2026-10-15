import { FalkorDB } from 'falkordb';

export type Params = Record<string, unknown>;
type Graph = ReturnType<FalkorDB['selectGraph']>;

export class LoomDb {
  private constructor(private readonly client: FalkorDB) {}

  static async connect(url = process.env.FALKORDB_URL ?? 'redis://127.0.0.1:6379'): Promise<LoomDb> {
    const u = new URL(url);
    const client = await FalkorDB.connect({
      socket: { host: u.hostname, port: Number(u.port || 6379) },
      username: u.username || undefined,
      password: u.password || undefined,
    });
    return new LoomDb(client);
  }

  graph(name: string): LoomGraph { return new LoomGraph(this.client.selectGraph(name), name); }
  list(): Promise<string[]> { return this.client.list(); }
  async close(): Promise<void> { await this.client.close(); }
}

export class LoomGraph {
  constructor(private readonly g: Graph, readonly name = '') {}

  async query<T = Record<string, unknown>>(cypher: string, params: Params = {}): Promise<T[]> {
    const r = await this.g.query<T>(cypher, { params: params as never });
    return (r.data ?? []) as T[];
  }

  async drop(): Promise<void> { await this.g.delete(); }
  /** GRAPH.COPY: a full server-side fork of this graph under `dest`. */
  async copy(dest: string): Promise<void> { await this.g.copy(dest); }
}
