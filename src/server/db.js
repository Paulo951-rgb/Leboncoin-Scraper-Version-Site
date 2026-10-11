'use strict';

/**
 * Persistance SQLite (better-sqlite3).
 *
 * Schéma :
 *   users        — comptes (email, hash de mot de passe scrypt, sel)
 *   sessions     — jetons de session (hash du jeton, expiration)
 *   jobs         — tâches de scraping (état, progression, compteurs, chemins)
 *   job_logs     — lignes de log par tâche (buffer borné)
 *   settings     — préférences par utilisateur (JSON)
 *
 * Toutes les requêtes sont paramétrées (aucune concaténation SQL). L'accès aux
 * ressources est TOUJOURS filtré par user_id au niveau requête : un identifiant
 * de job ne suffit jamais à autoriser l'accès.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS jobs (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  status        TEXT NOT NULL,
  search_url    TEXT,
  pages         INTEGER,
  limit_ads     INTEGER,
  no_desc       INTEGER DEFAULT 0,
  proxy_url     TEXT,
  profile_id    TEXT,
  export_fields TEXT,
  include_seller_data INTEGER DEFAULT 1,
  speed         TEXT,
  progress      INTEGER DEFAULT 0,
  message       TEXT,
  ads_count     INTEGER DEFAULT 0,
  duplicate_count INTEGER DEFAULT 0,
  error_code    TEXT,
  job_dir       TEXT,
  results_dir   TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  started_at    TEXT,
  finished_at   TEXT,
  cancel_requested INTEGER DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_jobs_user ON jobs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);

CREATE TABLE IF NOT EXISTS job_logs (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id  TEXT NOT NULL,
  ts      TEXT NOT NULL,
  level   TEXT NOT NULL,
  message TEXT NOT NULL,
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_job_logs_job ON job_logs(job_id, id);

CREATE TABLE IF NOT EXISTS settings (
  user_id TEXT PRIMARY KEY,
  data    TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

function openDatabase(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

// ─── Mots de passe (scrypt, sans dépendance native supplémentaire) ───────────

function hashPassword(password, salt) {
  const useSalt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), useSalt, 64).toString('hex');
  return { hash, salt: useSalt };
}

function verifyPassword(password, salt, expectedHash) {
  try {
    const { hash } = hashPassword(password, salt);
    const a = Buffer.from(hash, 'hex');
    const b = Buffer.from(expectedHash, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function newId(prefix = 'job') {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const rand = crypto.randomBytes(4).toString('hex');
  return `${prefix}-${ts}-${rand}`;
}

// ─── Dépôt utilisateurs / sessions ───────────────────────────────────────────

class Repository {
  constructor(db) {
    this.db = db;
    this._prepare();
  }

  _prepare() {
    const db = this.db;
    this.stmt = {
      insertUser: db.prepare('INSERT INTO users (id, email, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)'),
      userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
      userById: db.prepare('SELECT * FROM users WHERE id = ?'),
      insertSession: db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'),
      sessionByHash: db.prepare('SELECT * FROM sessions WHERE token_hash = ?'),
      deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
      deleteExpiredSessions: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),

      insertJob: db.prepare(`INSERT INTO jobs
        (id, user_id, status, search_url, pages, limit_ads, no_desc, proxy_url, profile_id, export_fields,
         include_seller_data, speed, progress, message, created_at, updated_at)
        VALUES (@id, @user_id, @status, @search_url, @pages, @limit_ads, @no_desc, @proxy_url, @profile_id, @export_fields,
         @include_seller_data, @speed, @progress, @message, @created_at, @updated_at)`),
      jobById: db.prepare('SELECT * FROM jobs WHERE id = ?'),
      jobByIdForUser: db.prepare('SELECT * FROM jobs WHERE id = ? AND user_id = ?'),
      jobsByUser: db.prepare('SELECT * FROM jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'),
      countJobsByUser: db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE user_id = ?'),
      countActiveJobs: db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued','running','action_required')"),
      countActiveJobsForUser: db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE user_id = ? AND status IN ('queued','running','action_required')"),
      updateJob: db.prepare('UPDATE jobs SET status=@status, progress=@progress, message=@message, ads_count=@ads_count, duplicate_count=@duplicate_count, error_code=@error_code, job_dir=COALESCE(@job_dir, job_dir), results_dir=COALESCE(@results_dir, results_dir), updated_at=@updated_at, started_at=COALESCE(@started_at, started_at), finished_at=COALESCE(@finished_at, finished_at) WHERE id=@id'),
      requestCancel: db.prepare('UPDATE jobs SET cancel_requested=1, updated_at=? WHERE id=?'),
      deleteJob: db.prepare('DELETE FROM jobs WHERE id = ? AND user_id = ?'),
      oldestJobs: db.prepare('SELECT id, job_dir FROM jobs WHERE created_at < ? ORDER BY created_at ASC'),

      insertLog: db.prepare('INSERT INTO job_logs (job_id, ts, level, message) VALUES (?, ?, ?, ?)'),
      logsByJob: db.prepare('SELECT id, ts, level, message FROM job_logs WHERE job_id = ? AND id > ? ORDER BY id ASC LIMIT ?'),
      countLogs: db.prepare('SELECT COUNT(*) AS n FROM job_logs WHERE job_id = ?'),
      trimLogs: db.prepare('DELETE FROM job_logs WHERE job_id = ? AND id NOT IN (SELECT id FROM job_logs WHERE job_id = ? ORDER BY id DESC LIMIT ?)'),

      getSettings: db.prepare('SELECT data FROM settings WHERE user_id = ?'),
      upsertSettings: db.prepare('INSERT INTO settings (user_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at'),
    };
  }

  // Utilisateurs
  createUser(email, password) {
    const id = crypto.randomUUID();
    const { hash, salt } = hashPassword(password);
    const now = new Date().toISOString();
    this.stmt.insertUser.run(id, String(email).toLowerCase(), hash, salt, now);
    return { id, email: String(email).toLowerCase(), created_at: now };
  }

  getUserByEmail(email) {
    return this.stmt.userByEmail.get(String(email).toLowerCase()) || null;
  }

  getUserById(id) {
    return this.stmt.userById.get(id) || null;
  }

  verifyUser(email, password) {
    const user = this.getUserByEmail(email);
    if (!user) return null;
    if (!verifyPassword(password, user.password_salt, user.password_hash)) return null;
    return { id: user.id, email: user.email, created_at: user.created_at };
  }

  // Sessions
  createSession(userId, ttlMs) {
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = sha256(token);
    const now = new Date().toISOString();
    this.stmt.insertSession.run(tokenHash, userId, now, Date.now() + ttlMs);
    return token;
  }

  getSession(token) {
    if (!token) return null;
    const row = this.stmt.sessionByHash.get(sha256(token));
    if (!row) return null;
    if (row.expires_at < Date.now()) {
      this.stmt.deleteSession.run(row.token_hash);
      return null;
    }
    return row;
  }

  deleteSession(token) {
    if (!token) return;
    this.stmt.deleteSession.run(sha256(token));
  }

  purgeExpiredSessions() {
    this.stmt.deleteExpiredSessions.run(Date.now());
  }

  // Jobs
  createJob(job) {
    const now = new Date().toISOString();
    const row = {
      id: job.id,
      user_id: job.user_id,
      status: job.status || 'queued',
      search_url: job.search_url || null,
      pages: job.pages || 1,
      limit_ads: job.limit_ads || null,
      no_desc: job.no_desc ? 1 : 0,
      proxy_url: job.proxy_url || null,
      profile_id: job.profile_id || 'default',
      export_fields: Array.isArray(job.export_fields) ? JSON.stringify(job.export_fields) : null,
      include_seller_data: job.include_seller_data === false ? 0 : 1,
      speed: job.speed || 'moyen',
      progress: 0,
      message: job.message || 'En file d\'attente',
      created_at: now,
      updated_at: now,
    };
    this.stmt.insertJob.run(row);
    return this.getJobForUser(job.id, job.user_id);
  }

  getJob(id) {
    return this.stmt.jobById.get(id) || null;
  }

  getJobForUser(id, userId) {
    return this.stmt.jobByIdForUser.get(id, userId) || null;
  }

  listJobsForUser(userId, limit, offset) {
    return this.stmt.jobsByUser.all(userId, limit, offset);
  }

  countJobsForUser(userId) {
    return this.stmt.countJobsByUser.get(userId).n;
  }

  countActiveJobs() {
    return this.stmt.countActiveJobs.get().n;
  }

  countActiveJobsForUser(userId) {
    return this.stmt.countActiveJobsForUser.get(userId).n;
  }

  updateJob(id, patch) {
    const current = this.getJob(id);
    if (!current) return null;
    const merged = {
      id,
      status: patch.status != null ? patch.status : current.status,
      progress: patch.progress != null ? patch.progress : current.progress,
      message: patch.message != null ? patch.message : current.message,
      ads_count: patch.ads_count != null ? patch.ads_count : current.ads_count,
      duplicate_count: patch.duplicate_count != null ? patch.duplicate_count : current.duplicate_count,
      error_code: patch.error_code !== undefined ? patch.error_code : current.error_code,
      job_dir: patch.job_dir || null,
      results_dir: patch.results_dir || null,
      updated_at: new Date().toISOString(),
      started_at: patch.started_at || null,
      finished_at: patch.finished_at || null,
    };
    this.stmt.updateJob.run(merged);
    return this.getJob(id);
  }

  requestCancel(id) {
    this.stmt.requestCancel.run(new Date().toISOString(), id);
  }

  deleteJob(id, userId) {
    return this.stmt.deleteJob.run(id, userId).changes > 0;
  }

  // Logs
  addLog(jobId, level, message, bufferMax) {
    this.stmt.insertLog.run(jobId, new Date().toISOString(), level || 'info', String(message));
    if (bufferMax && this.stmt.countLogs.get(jobId).n > bufferMax) {
      this.stmt.trimLogs.run(jobId, jobId, bufferMax);
    }
  }

  getLogs(jobId, afterId = 0, limit = 2000) {
    return this.stmt.logsByJob.all(jobId, afterId, limit);
  }

  // Settings
  getSettings(userId) {
    const row = this.stmt.getSettings.get(userId);
    if (!row) return null;
    try { return JSON.parse(row.data); } catch { return null; }
  }

  saveSettings(userId, data) {
    this.stmt.upsertSettings.run(userId, JSON.stringify(data), new Date().toISOString());
    return data;
  }
}

module.exports = { openDatabase, Repository, hashPassword, verifyPassword, sha256, newId, SCHEMA };
