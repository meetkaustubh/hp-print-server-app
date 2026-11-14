'use strict';
// SQLite via Node's built-in node:sqlite (no native compile step on the Pi).
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, 'printnimbus.db');
  const db = new DatabaseSync(file);
  try { fs.chmodSync(file, 0o600); } catch {}
  // Upgrade from the 2.0 schema (one payment per job, UNIQUE payment_id): rebuild the jobs table.
  const old = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='jobs'").get();
  const needsRebuild = old && !db.prepare('PRAGMA table_info(jobs)').all().some(c => c.name === 'batch_id');
  if (needsRebuild) { db.exec('DROP INDEX IF EXISTS jobs_status; DROP INDEX IF EXISTS jobs_order; ALTER TABLE jobs RENAME TO jobs_old;'); }
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,              -- uploaded | awaiting_payment | queued | printing | done | failed | refunded | refund_failed | expired
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      original_name TEXT,
      file_path TEXT,                    -- normalised PDF on disk (null once purged)
      pages_total INTEGER NOT NULL,
      pages_selected INTEGER,
      page_range TEXT,
      copies INTEGER,
      color INTEGER,                     -- 0/1
      duplex INTEGER,                    -- 0/1
      paper TEXT,
      amount INTEGER NOT NULL DEFAULT 0, -- smallest currency unit (paise)
      currency TEXT NOT NULL DEFAULT 'INR',
      order_id TEXT,
      payment_id TEXT,
      refund_id TEXT,
      cups_job TEXT,
      error TEXT,
      batch_id TEXT,
      queued_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);
    CREATE INDEX IF NOT EXISTS jobs_order ON jobs(order_id);
    CREATE INDEX IF NOT EXISTS jobs_batch ON jobs(batch_id);
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,               -- Razorpay order id
      batch_id TEXT NOT NULL,
      amount INTEGER NOT NULL,
      currency TEXT NOT NULL,
      payment_id TEXT,
      status TEXT NOT NULL DEFAULT 'created',  -- created | paid | stale_refunded | stale_refund_failed
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      job_id TEXT,
      kind TEXT NOT NULL,
      detail TEXT
    );
  `);
  if (needsRebuild) {
    db.exec(`INSERT INTO jobs(id,status,created_at,updated_at,original_name,file_path,pages_total,pages_selected,page_range,copies,color,duplex,paper,amount,currency,order_id,payment_id,refund_id,cups_job,error,queued_at)
             SELECT id,status,created_at,updated_at,original_name,file_path,pages_total,pages_selected,page_range,copies,color,duplex,paper,amount,currency,order_id,payment_id,refund_id,cups_job,error,updated_at FROM jobs_old;
             INSERT OR IGNORE INTO orders(id,batch_id,amount,currency,payment_id,status,created_at)
             SELECT order_id,id,amount,currency,payment_id,CASE WHEN payment_id IS NULL THEN 'created' ELSE 'paid' END,created_at FROM jobs_old WHERE order_id IS NOT NULL;
             DROP TABLE jobs_old;`);
  }
  if (!db.prepare("SELECT 1 FROM pragma_table_info('jobs') WHERE name='source'").get()) db.exec('ALTER TABLE jobs ADD COLUMN source TEXT');
  return db;
}

module.exports = { openDb };
