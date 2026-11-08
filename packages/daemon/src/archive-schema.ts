/** v6 仅在安全模块的 v5 迁移之后执行，不占用其他切片预留的版本。 */
export const archiveSchemaV6 = String.raw`
ALTER TABLE agora_sessions ADD COLUMN archive_hash TEXT;
ALTER TABLE agora_sessions ADD COLUMN archive_bytes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agora_sessions ADD COLUMN archive_verified_at TEXT;
ALTER TABLE agora_sessions ADD COLUMN archive_error TEXT;
CREATE TABLE archive_observed_messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  agora_session_id TEXT NOT NULL REFERENCES agora_sessions(id),
  run_id TEXT NOT NULL REFERENCES process_runs(id),
  signature TEXT NOT NULL, role TEXT NOT NULL, timestamp TEXT,
  observed_at TEXT NOT NULL,
  UNIQUE(agora_session_id,signature)
);
CREATE INDEX archive_messages_session ON archive_observed_messages(agora_session_id,seq);
`;
