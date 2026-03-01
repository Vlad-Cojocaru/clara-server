import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import { mkdirSync, existsSync } from "fs";
import { dirname } from "path";

const dbPath = process.env.SQLITE_PATH || "./data/clara.sqlite";
const dir = dirname(dbPath);
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
const db = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS onboardings (
    onboarding_id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft', 'Submitted')),
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    submitted_at TEXT,
    info_complete_at TEXT,
    launch_clock_start_at TEXT
  )
`);

try {
  db.exec("ALTER TABLE onboardings ADD COLUMN client_password_hash TEXT");
} catch (e) {
  if (!/duplicate column name/i.test(e.message)) throw e;
}

export function listOnboardings() {
  const stmt = db.prepare(`
    SELECT onboarding_id AS id, status, created_at, updated_at
    FROM onboardings
    ORDER BY updated_at DESC
  `);
  return stmt.all();
}

export function getOnboarding(id) {
  const row = db.prepare(
    "SELECT * FROM onboardings WHERE onboarding_id = ?"
  ).get(id);
  if (!row) return null;
  const { client_password_hash, ...rest } = row;
  return {
    ...rest,
    payload_json: row.payload_json ? JSON.parse(row.payload_json) : {},
    has_client_password: Boolean(client_password_hash),
  };
}

export function setClientPassword(onboardingId, hashedPassword) {
  const result = db.prepare(`
    UPDATE onboardings
    SET client_password_hash = ?, updated_at = datetime('now')
    WHERE onboarding_id = ? AND status = 'Draft'
  `).run(hashedPassword ?? null, onboardingId);
  return result.changes > 0;
}

export function getClientPasswordHash(onboardingId) {
  const row = db.prepare(
    "SELECT client_password_hash FROM onboardings WHERE onboarding_id = ? AND status = 'Draft'"
  ).get(onboardingId);
  return row?.client_password_hash ?? null;
}

export function createOnboarding() {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO onboardings (onboarding_id, status, payload_json)
    VALUES (?, 'Draft', '{}')
  `).run(id);
  return id;
}

export function updateOnboarding(id, payload) {
  const payloadStr = typeof payload === "string" ? payload : JSON.stringify(payload ?? {});
  const result = db.prepare(`
    UPDATE onboardings
    SET payload_json = ?, updated_at = datetime('now')
    WHERE onboarding_id = ? AND status = 'Draft'
  `).run(payloadStr, id);
  if (result.changes === 0) return null;
  return getOnboarding(id);
}

export function submitOnboarding(id, payload, { infoCompleteAt, launchClockStartAt }) {
  const payloadStr = typeof payload === "string" ? payload : JSON.stringify(payload ?? {});
  db.prepare(`
    UPDATE onboardings
    SET status = 'Submitted', payload_json = ?, updated_at = datetime('now'),
        submitted_at = datetime('now'),
        info_complete_at = ?, launch_clock_start_at = ?
    WHERE onboarding_id = ? AND status = 'Draft'
  `).run(payloadStr, infoCompleteAt ?? null, launchClockStartAt ?? null, id);
  return getOnboarding(id);
}

export default db;
