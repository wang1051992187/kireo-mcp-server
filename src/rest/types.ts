export type MemoryType =
  | 'fact'
  | 'decision'
  | 'preference'
  | 'event'
  | 'goal'
  | 'insight'
  | 'relationship'
  | 'other';

export interface MemoryRecord {
  id: string;
  user_id?: string;
  namespace: string;
  content: string;
  type: MemoryType;
  entities: string[];
  tags: string[];
  importance: number;
  occurred_at: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  metadata?: Record<string, unknown>;
  schema_version: string;
  embedding_status?: 'ready' | 'queued' | 'failed';
}

export interface MemoryHit {
  id: string;
  content: string;
  type: MemoryType;
  namespace: string;
  tags: string[];
  importance: number;
  occurred_at: string;
  created_at: string;
  score: number;
  ann_rank?: number;
  bm25_rank?: number;
}

export interface SearchResult {
  hits: MemoryHit[];
}

export interface MemoryListResponse {
  items: MemoryRecord[];
  next_cursor: string | null;
}

export interface NamespaceRow {
  name: string;
  created_at: string;
}

export interface NamespaceListResponse {
  items: NamespaceRow[];
}

export interface HealthResponse {
  status: 'ok' | 'degraded' | 'down';
  version?: string;
  region?: string;
}

export interface BatchCreateResponse {
  succeeded: { index: number; id: string; embedding_status?: 'ready' | 'queued' | 'failed' }[];
  failures: { index: number; code: string; message: string }[];
}
