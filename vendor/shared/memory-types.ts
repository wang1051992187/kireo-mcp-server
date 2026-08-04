export type MemoryType =
  | 'fact'
  | 'decision'
  | 'preference'
  | 'event'
  | 'goal'
  | 'insight'
  | 'relationship'
  | 'other'
  | 'code';

export const MEMORY_TYPES: readonly MemoryType[] = [
  'fact',
  'decision',
  'preference',
  'event',
  'goal',
  'insight',
  'relationship',
  'other',
  'code',
] as const;

export type EmbeddingStatus = 'ready' | 'queued' | 'failed';

export type SearchMode = 'semantic' | 'keyword' | 'hybrid';

export interface CreateMemoryDTO {
  content: string;
  type: MemoryType;
  entities?: string[];
  tags?: string[];
  importance?: number;
  occurred_at?: string;
  namespace?: string;
  metadata?: Record<string, unknown>;
}

export interface MemoryRecord {
  id: string;
  user_id: string;
  namespace: string;
  schema_version: '1.0';
  content: string;
  type: MemoryType;
  entities: string[];
  tags: string[];
  importance: number;
  occurred_at: string;
  metadata: Record<string, unknown>;
  embedding_status: EmbeddingStatus;
  embedding_model: string;
  embedding_version: number;
  source: {
    api_key_id: string | null;
    client: string | null;
    ip: string | null;
  };
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  expires_at: string | null;
}

export interface CreateMemoryResponse {
  id: string;
  created_at: string;
  schema_version: '1.0';
  embedding_status: EmbeddingStatus;
}

export interface BatchCreateRequest {
  items: CreateMemoryDTO[];
  strict?: boolean;
}

export interface BatchCreateResponse {
  // `deduped: true` marks an item that matched an existing active row
  // (same user + namespace + content_hash) and was reported instead of
  // re-created — idempotent retry, so it never consumes write quota.
  succeeded: {
    index: number;
    id: string;
    embedding_status: EmbeddingStatus;
    deduped?: true;
  }[];
  failures: { index: number; code: string; message: string }[];
}

export interface MemoryFilters {
  type?: MemoryType[];
  entities?: string[];
  tags?: string[];
  importance_gte?: number;
  occurred_after?: string;
  occurred_before?: string;
  namespace?: string;
  include_deleted?: boolean;
}

export interface SearchRequest {
  query: string;
  filters?: MemoryFilters;
  mode?: SearchMode;
  limit?: number;
  include_metadata?: boolean;
}

export interface ScoreBreakdown {
  semantic?: number;
  keyword?: number;
  rrf?: number;
}

export interface SearchResultItem extends MemoryRecord {
  score: number;
  score_breakdown: ScoreBreakdown;
}

export interface SearchResponse {
  results: SearchResultItem[];
  total: number;
  elapsed_ms: number;
  query_id: string;
  cached: boolean;
}

export interface RecallRequest {
  query: string;
  namespace?: string;
  limit?: number;
}

export interface ListRequest {
  cursor?: string;
  limit?: number;
  filters?: MemoryFilters;
}

export interface ListResponse {
  items: MemoryRecord[];
  next_cursor: string | null;
  total_estimate: number;
}

export interface NamespaceRecord {
  name: string;
  count: number;
  bytes: number;
  last_active: string | null;
  created_at: string;
}

export interface NamespaceStats extends NamespaceRecord {
  by_type: Record<MemoryType, number>;
  oldest_at: string | null;
  newest_at: string | null;
}

export type TaskKind =
  | 'reembed'
  | 'import'
  | 'export'
  | 'rename_namespace'
  | 'namespace_delete'
  | 'ttl_sweep'
  | 'storage_sweep';

export type TaskStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export interface TaskRecord {
  id: string;
  kind: TaskKind;
  status: TaskStatus;
  progress: number;
  total: number | null;
  result: Record<string, unknown> | null;
  error: { code: string; message: string } | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  download_url?: string;
}

export const MEMORY_LIMITS = {
  CONTENT_MAX: 8000,
  ENTITY_MAX: 20,
  ENTITY_LEN_MAX: 64,
  TAG_MAX: 10,
  TAG_LEN_MAX: 32,
  TAG_REGEX: /^[a-z0-9_-]+$/,
  NAMESPACE_REGEX: /^[a-z0-9_-]{1,32}$/,
  METADATA_BYTES_MAX: 2 * 1024,
  BATCH_MAX: 100,
  LIST_LIMIT_DEFAULT: 50,
  LIST_LIMIT_MAX: 200,
  SEARCH_LIMIT_DEFAULT: 10,
  SEARCH_LIMIT_MAX: 50,
} as const;
