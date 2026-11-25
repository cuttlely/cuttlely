export const VECTOR_SCHEMA = `CREATE TABLE IF NOT EXISTS vectors (
    id TEXT PRIMARY KEY,
    source TEXT,
    content TEXT NOT NULL,
    metadata TEXT,
    norm REAL NOT NULL,
    embedding BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);`
