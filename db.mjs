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
try {
  db.exec("ALTER TABLE onboardings ADD COLUMN client_email TEXT");
} catch (e) {
  if (!/duplicate column name/i.test(e.message)) throw e;
}
try {
  db.exec("ALTER TABLE onboardings ADD COLUMN client_password_plaintext TEXT");
} catch (e) {
  if (!/duplicate column name/i.test(e.message)) throw e;
}
const agreementColumns = [
  "agreement_signed_by_operator_at", "agreement_signed_by_client_at",
  "agreement_operator_name", "agreement_operator_title",
  "agreement_client_name", "agreement_client_title",
  "agreement_client_address", "agreement_pricing_option",
];
for (const col of agreementColumns) {
  try {
    db.exec(`ALTER TABLE onboardings ADD COLUMN ${col} TEXT`);
  } catch (e) {
    if (!/duplicate column name/i.test(e.message)) throw e;
  }
}

function deriveLabel(payloadJson) {
  if (!payloadJson) return null;
  try {
    const p = JSON.parse(payloadJson);
    const name = p?.business?.company_name?.trim();
    if (name) return name;
    const owner = p?.business?.owner_name?.trim();
    if (owner) return owner;
    const email = p?.business?.primary_email?.trim();
    if (email) return email;
  } catch (_) {}
  return null;
}

export function listOnboardings() {
  const stmt = db.prepare(`
    SELECT onboarding_id AS id, status, created_at, updated_at, payload_json
    FROM onboardings
    ORDER BY updated_at DESC
  `);
  const rows = stmt.all();
  return rows.map((r) => {
    const { payload_json, ...rest } = r;
    const label = deriveLabel(payload_json);
    return { ...rest, label: label || null };
  });
}

export function getOnboarding(id) {
  const row = db.prepare(
    "SELECT * FROM onboardings WHERE onboarding_id = ?"
  ).get(id);
  if (!row) return null;
  const { client_password_hash, client_email, client_password_plaintext, ...rest } = row;
  const agreement = {
    agreement_signed_by_operator_at: row.agreement_signed_by_operator_at ?? null,
    agreement_signed_by_client_at: row.agreement_signed_by_client_at ?? null,
    agreement_operator_name: row.agreement_operator_name ?? null,
    agreement_operator_title: row.agreement_operator_title ?? null,
    agreement_client_name: row.agreement_client_name ?? null,
    agreement_client_title: row.agreement_client_title ?? null,
    agreement_client_address: row.agreement_client_address ?? null,
    agreement_pricing_option: row.agreement_pricing_option ?? null,
  };
  return {
    ...rest,
    payload_json: row.payload_json ? JSON.parse(row.payload_json) : {},
    has_client_password: Boolean(client_password_hash),
    client_email: client_email ?? null,
    client_password_plaintext: client_password_plaintext ?? null,
    ...agreement,
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

export function setClientAccess(onboardingId, { clientEmail, hashedPassword, plainPassword }) {
  const result = db.prepare(`
    UPDATE onboardings
    SET client_email = ?, client_password_hash = ?, client_password_plaintext = ?, updated_at = datetime('now')
    WHERE onboarding_id = ? AND status = 'Draft'
  `).run(clientEmail ?? null, hashedPassword ?? null, plainPassword ?? null, onboardingId);
  return result.changes > 0;
}

export function getClientPasswordHash(onboardingId) {
  const row = db.prepare(
    "SELECT client_password_hash FROM onboardings WHERE onboarding_id = ? AND status = 'Draft'"
  ).get(onboardingId);
  return row?.client_password_hash ?? null;
}

export function getClientEmail(onboardingId) {
  const row = db.prepare(
    "SELECT client_email FROM onboardings WHERE onboarding_id = ?"
  ).get(onboardingId);
  return row?.client_email ?? null;
}

export function signAgreementOperator(onboardingId, { name, title, pricingOption }) {
  const now = new Date().toISOString();
  const result = db.prepare(`
    UPDATE onboardings
    SET agreement_signed_by_operator_at = ?,
        agreement_operator_name = ?,
        agreement_operator_title = ?,
        agreement_pricing_option = ?,
        updated_at = datetime('now')
    WHERE onboarding_id = ? AND status = 'Draft'
  `).run(now, name ?? null, title ?? null, pricingOption ?? null, onboardingId);
  return result.changes > 0 ? { signedAt: now } : null;
}

export function signAgreementClient(onboardingId, { name, title, clientAddress }) {
  const now = new Date().toISOString();
  const result = db.prepare(`
    UPDATE onboardings
    SET agreement_signed_by_client_at = ?,
        agreement_client_name = ?,
        agreement_client_title = ?,
        agreement_client_address = ?,
        updated_at = datetime('now')
    WHERE onboarding_id = ? AND status = 'Draft'
  `).run(now, name ?? null, title ?? null, clientAddress ?? null, onboardingId);
  return result.changes > 0 ? { signedAt: now } : null;
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
