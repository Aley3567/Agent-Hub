CREATE TABLE IF NOT EXISTS providers (
    id TEXT NOT NULL, app_type TEXT NOT NULL, name TEXT NOT NULL,
    settings_config TEXT NOT NULL, meta TEXT NOT NULL DEFAULT '{}',
    category TEXT, provider_type TEXT, is_current BOOLEAN NOT NULL DEFAULT 0,
    in_failover_queue BOOLEAN NOT NULL DEFAULT 0, sort_index INTEGER,
    PRIMARY KEY (id, app_type)
);
CREATE TABLE IF NOT EXISTS provider_sources (
    id TEXT NOT NULL, app_type TEXT NOT NULL, source TEXT NOT NULL,
    imported_at INTEGER NOT NULL, PRIMARY KEY (id, app_type)
);
