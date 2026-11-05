import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.env.P0_NOTIFY_ROOT;
const db = new DatabaseSync(join(root, 'outbox.sqlite'));
db.exec(`PRAGMA journal_mode=WAL;
  CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, state TEXT);
  CREATE TABLE IF NOT EXISTS outbox (
    dedupeKey TEXT PRIMARY KEY, payload TEXT NOT NULL,
    visibleAfter INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
    persistedAt INTEGER, ackedAt INTEGER, entryId TEXT);
`);
const log = (data) => appendFileSync(join(root, 'daemon.jsonl'), JSON.stringify({ pid: process.pid, ...data }) + '\n');
function records(path) {
  try { return readFileSync(path, 'utf8').split('\n').slice(0, -1).map(line => JSON.parse(line)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
const server = createServer(async (req, res) => {
  try {
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : {};
    let result;
    if (req.url === '/create') {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('INSERT OR REPLACE INTO tasks VALUES (?, ?)').run(body.dedupeKey, 'completed');
        db.prepare('INSERT OR IGNORE INTO outbox (dedupeKey, payload) VALUES (?, ?)').run(body.dedupeKey, JSON.stringify(body));
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      result = { created: true };
    } else if (req.url === '/inbox') {
      const now = Date.now();
      const rows = db.prepare('SELECT * FROM outbox WHERE ackedAt IS NULL AND visibleAfter <= ? ORDER BY rowid').all(now);
      const leaseMs = Number(process.env.P0_NOTIFY_LEASE_MS ?? 250);
      for (const row of rows) db.prepare('UPDATE outbox SET visibleAfter=?, attempts=attempts+1 WHERE dedupeKey=?').run(now + leaseMs, row.dedupeKey);
      result = rows.map(row => JSON.parse(row.payload));
      if (rows.length) log({ kind: 'delivery', keys: rows.map(row => row.dedupeKey) });
    } else if (req.url === '/ack') {
      const onDisk = records(body.sessionFile).some(entry => entry.id === body.entryId && entry.type === 'custom_message' && entry.details?.dedupeKey === body.dedupeKey);
      // Record the oracle independently; an early ack is not hidden by server rejection.
      log({ kind: 'ack', dedupeKey: body.dedupeKey, entryId: body.entryId, onDisk });
      db.prepare('UPDATE outbox SET persistedAt=?, ackedAt=?, entryId=? WHERE dedupeKey=?').run(Date.now(), Date.now(), body.entryId, body.dedupeKey);
      result = { acked: true };
    } else if (req.url === '/state') {
      result = db.prepare('SELECT * FROM outbox ORDER BY rowid').all().map(row => ({ ...row, payload: JSON.parse(row.payload) }));
    } else throw new Error('Unknown endpoint');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (error) {
    res.writeHead(500); res.end(JSON.stringify({ error: String(error) }));
  }
});
server.listen(Number(process.env.P0_NOTIFY_PORT ?? 0), '127.0.0.1', () => {
  process.send({ kind: 'ready', pid: process.pid, port: server.address().port });
});
process.on('SIGTERM', () => server.close(() => { db.close(); process.exit(0); }));
