import { randomUUID } from "crypto";

const usePg = Boolean(process.env.DATABASE_URL);
let pool;
let db; // SQLite instance when !usePg

if (usePg) {
  const pg = await import("pg");
  pool = new pg.default.Pool({ connectionString: process.env.DATABASE_URL });
} else {
  const Database = (await import("better-sqlite3")).default;
  const { mkdirSync, existsSync } = await import("fs");
  const { dirname } = await import("path");
  const dbPath = process.env.SQLITE_PATH || "./data/clara.sqlite";
  const dir = dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  db = new Database(dbPath);
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
  for (const col of ["client_password_hash", "client_email", "client_password_plaintext"]) {
    try { db.exec(`ALTER TABLE onboardings ADD COLUMN ${col} TEXT`); } catch (e) { if (!/duplicate column name/i.test(e.message)) throw e; }
  }
  const agreementColumns = [
    "agreement_signed_by_operator_at", "agreement_signed_by_client_at",
    "agreement_operator_name", "agreement_operator_title",
    "agreement_client_name", "agreement_client_title",
    "agreement_client_address", "agreement_pricing_option",
  ];
  for (const col of agreementColumns) {
    try { db.exec(`ALTER TABLE onboardings ADD COLUMN ${col} TEXT`); } catch (e) { if (!/duplicate column name/i.test(e.message)) throw e; }
  }
}

async function runMigrationsPg() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS onboardings (
      onboarding_id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft', 'Submitted')),
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      submitted_at TIMESTAMPTZ,
      info_complete_at TIMESTAMPTZ,
      launch_clock_start_at TIMESTAMPTZ
    )
  `);
  const cols = [
    "client_password_hash", "client_email", "client_password_plaintext",
    "agreement_signed_by_operator_at", "agreement_signed_by_client_at",
    "agreement_operator_name", "agreement_operator_title",
    "agreement_client_name", "agreement_client_title",
    "agreement_client_address", "agreement_pricing_option",
  ];
  for (const col of cols) {
    try {
      await pool.query(`ALTER TABLE onboardings ADD COLUMN IF NOT EXISTS ${col} TEXT`);
    } catch (e) {
      if (e.code !== "42701") throw e; // duplicate_column
    }
  }
}

if (usePg) {
  await runMigrationsPg();
}

function deriveLabel(payloadJson) {
  if (!payloadJson) return null;
  try {
    const p = typeof payloadJson === "string" ? JSON.parse(payloadJson) : payloadJson;
    const name = p?.business?.company_name?.trim();
    if (name) return name;
    const owner = p?.business?.owner_name?.trim();
    if (owner) return owner;
    const email = p?.business?.primary_email?.trim();
    if (email) return email;
  } catch (_) {}
  return null;
}

function rowToOnboarding(row) {
  if (!row) return null;
  const {
    client_password_hash,
    client_email,
    client_password_plaintext,
    payload_json,
    ...rest
  } = row;
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
    payload_json: payload_json != null
      ? (typeof payload_json === "string" ? JSON.parse(payload_json) : payload_json)
      : {},
    has_client_password: Boolean(client_password_hash),
    client_email: client_email ?? null,
    client_password_plaintext: client_password_plaintext ?? null,
    ...agreement,
  };
}

export async function listOnboardings() {
  if (usePg) {
    const { rows } = await pool.query(
      "SELECT onboarding_id AS id, status, created_at, updated_at, payload_json FROM onboardings ORDER BY updated_at DESC"
    );
    return rows.map((r) => {
      const { payload_json, ...rest } = r;
      return { ...rest, label: deriveLabel(payload_json) || null };
    });
  }
  const stmt = db.prepare(`
    SELECT onboarding_id AS id, status, created_at, updated_at, payload_json
    FROM onboardings ORDER BY updated_at DESC
  `);
  const rows = stmt.all();
  return rows.map((r) => {
    const { payload_json, ...rest } = r;
    return { ...rest, label: deriveLabel(payload_json) || null };
  });
}

export async function getOnboarding(id) {
  if (usePg) {
    const { rows } = await pool.query("SELECT * FROM onboardings WHERE onboarding_id = $1", [id]);
    return rowToOnboarding(rows[0] ?? null);
  }
  const row = db.prepare("SELECT * FROM onboardings WHERE onboarding_id = ?").get(id);
  return rowToOnboarding(row);
}

export async function setClientPassword(onboardingId, hashedPassword) {
  if (usePg) {
    const r = await pool.query(
      "UPDATE onboardings SET client_password_hash = $1, updated_at = NOW() WHERE onboarding_id = $2 AND status = 'Draft'",
      [hashedPassword ?? null, onboardingId]
    );
    return r.rowCount > 0;
  }
  const result = db.prepare(`
    UPDATE onboardings SET client_password_hash = ?, updated_at = datetime('now')
    WHERE onboarding_id = ? AND status = 'Draft'
  `).run(hashedPassword ?? null, onboardingId);
  return result.changes > 0;
}

export async function setClientAccess(onboardingId, { clientEmail, hashedPassword, plainPassword }) {
  if (usePg) {
    const r = await pool.query(
      `UPDATE onboardings
       SET client_email = $1, client_password_hash = $2, client_password_plaintext = $3, updated_at = NOW()
       WHERE onboarding_id = $4 AND status = 'Draft'`,
      [clientEmail ?? null, hashedPassword ?? null, plainPassword ?? null, onboardingId]
    );
    return r.rowCount > 0;
  }
  const result = db.prepare(`
    UPDATE onboardings
    SET client_email = ?, client_password_hash = ?, client_password_plaintext = ?, updated_at = datetime('now')
    WHERE onboarding_id = ? AND status = 'Draft'
  `).run(clientEmail ?? null, hashedPassword ?? null, plainPassword ?? null, onboardingId);
  return result.changes > 0;
}

export async function getClientPasswordHash(onboardingId) {
  if (usePg) {
    const { rows } = await pool.query(
      "SELECT client_password_hash FROM onboardings WHERE onboarding_id = $1 AND status = 'Draft'",
      [onboardingId]
    );
    return rows[0]?.client_password_hash ?? null;
  }
  const row = db.prepare(
    "SELECT client_password_hash FROM onboardings WHERE onboarding_id = ? AND status = 'Draft'"
  ).get(onboardingId);
  return row?.client_password_hash ?? null;
}

export async function getClientEmail(onboardingId) {
  if (usePg) {
    const { rows } = await pool.query("SELECT client_email FROM onboardings WHERE onboarding_id = $1", [onboardingId]);
    return rows[0]?.client_email ?? null;
  }
  const row = db.prepare("SELECT client_email FROM onboardings WHERE onboarding_id = ?").get(onboardingId);
  return row?.client_email ?? null;
}

export async function signAgreementOperator(onboardingId, { name, title, pricingOption }) {
  const now = new Date().toISOString();
  if (usePg) {
    const r = await pool.query(
      `UPDATE onboardings
       SET agreement_signed_by_operator_at = $1, agreement_operator_name = $2, agreement_operator_title = $3,
           agreement_pricing_option = $4, updated_at = NOW()
       WHERE onboarding_id = $5 AND status = 'Draft'`,
      [now, name ?? null, title ?? null, pricingOption ?? null, onboardingId]
    );
    return r.rowCount > 0 ? { signedAt: now } : null;
  }
  const result = db.prepare(`
    UPDATE onboardings
    SET agreement_signed_by_operator_at = ?, agreement_operator_name = ?, agreement_operator_title = ?,
        agreement_pricing_option = ?, updated_at = datetime('now')
    WHERE onboarding_id = ? AND status = 'Draft'
  `).run(now, name ?? null, title ?? null, pricingOption ?? null, onboardingId);
  return result.changes > 0 ? { signedAt: now } : null;
}

export async function signAgreementClient(onboardingId, { name, title, clientAddress }) {
  const now = new Date().toISOString();
  if (usePg) {
    const r = await pool.query(
      `UPDATE onboardings
       SET agreement_signed_by_client_at = $1, agreement_client_name = $2, agreement_client_title = $3,
           agreement_client_address = $4, updated_at = NOW()
       WHERE onboarding_id = $5 AND status = 'Draft'`,
      [now, name ?? null, title ?? null, clientAddress ?? null, onboardingId]
    );
    return r.rowCount > 0 ? { signedAt: now } : null;
  }
  const result = db.prepare(`
    UPDATE onboardings
    SET agreement_signed_by_client_at = ?, agreement_client_name = ?, agreement_client_title = ?,
        agreement_client_address = ?, updated_at = datetime('now')
    WHERE onboarding_id = ? AND status = 'Draft'
  `).run(now, name ?? null, title ?? null, clientAddress ?? null, onboardingId);
  return result.changes > 0 ? { signedAt: now } : null;
}

export async function createOnboarding() {
  const id = randomUUID();
  if (usePg) {
    await pool.query(
      "INSERT INTO onboardings (onboarding_id, status, payload_json) VALUES ($1, 'Draft', '{}')",
      [id]
    );
    return id;
  }
  db.prepare("INSERT INTO onboardings (onboarding_id, status, payload_json) VALUES (?, 'Draft', '{}')").run(id);
  return id;
}

export async function updateOnboarding(id, payload) {
  const payloadStr = typeof payload === "string" ? payload : JSON.stringify(payload ?? {});
  if (usePg) {
    const r = await pool.query(
      "UPDATE onboardings SET payload_json = $1, updated_at = NOW() WHERE onboarding_id = $2 AND status = 'Draft'",
      [payloadStr, id]
    );
    if (r.rowCount === 0) return null;
    return getOnboarding(id);
  }
  const result = db.prepare(`
    UPDATE onboardings SET payload_json = ?, updated_at = datetime('now')
    WHERE onboarding_id = ? AND status = 'Draft'
  `).run(payloadStr, id);
  if (result.changes === 0) return null;
  return getOnboarding(id);
}

export async function submitOnboarding(id, payload, { infoCompleteAt, launchClockStartAt }) {
  const payloadStr = typeof payload === "string" ? payload : JSON.stringify(payload ?? {});
  if (usePg) {
    await pool.query(
      `UPDATE onboardings
       SET status = 'Submitted', payload_json = $1, updated_at = NOW(), submitted_at = NOW(),
           info_complete_at = $2, launch_clock_start_at = $3
       WHERE onboarding_id = $4 AND status = 'Draft'`,
      [payloadStr, infoCompleteAt ?? null, launchClockStartAt ?? null, id]
    );
    return getOnboarding(id);
  }
  db.prepare(`
    UPDATE onboardings
    SET status = 'Submitted', payload_json = ?, updated_at = datetime('now'), submitted_at = datetime('now'),
        info_complete_at = ?, launch_clock_start_at = ?
    WHERE onboarding_id = ? AND status = 'Draft'
  `).run(payloadStr, infoCompleteAt ?? null, launchClockStartAt ?? null, id);
  return getOnboarding(id);
}

export default { listOnboardings, getOnboarding, setClientPassword, setClientAccess, getClientPasswordHash, getClientEmail, signAgreementOperator, signAgreementClient, createOnboarding, updateOnboarding, submitOnboarding };
