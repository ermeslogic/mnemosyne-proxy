PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 2000;

CREATE TABLE IF NOT EXISTS memory_nodes (
    id INTEGER PRIMARY KEY,
    namespace TEXT NOT NULL,
    fact_key TEXT NOT NULL,
    content TEXT NOT NULL,
    normalized_content TEXT NOT NULL,
    embedding BLOB NOT NULL CHECK (length(embedding) = 2048),
    importance_score REAL NOT NULL CHECK (importance_score BETWEEN 1 AND 10),
    created_at REAL NOT NULL,
    last_accessed_at REAL NOT NULL,
    observed_at REAL NOT NULL,
    decay_rate REAL NOT NULL CHECK (decay_rate > 0),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'archived')),
    superseded_by_id INTEGER,
    UNIQUE (id, namespace),
    FOREIGN KEY (superseded_by_id, namespace) REFERENCES memory_nodes (id, namespace),
    CHECK ((status = 'superseded') = (superseded_by_id IS NOT NULL)),
    CHECK (superseded_by_id IS NULL OR superseded_by_id <> id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_active_fact_key
ON memory_nodes (namespace, fact_key) WHERE status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS idx_active_content
ON memory_nodes (namespace, normalized_content) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_memory_retrieval
ON memory_nodes (namespace, status);

CREATE INDEX IF NOT EXISTS idx_memory_archive
ON memory_nodes (status, last_accessed_at);

CREATE INDEX IF NOT EXISTS idx_memory_history
ON memory_nodes (namespace, fact_key, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_successor
ON memory_nodes (superseded_by_id) WHERE superseded_by_id IS NOT NULL;
