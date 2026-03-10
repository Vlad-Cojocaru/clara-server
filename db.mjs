import pg from "pg";
import { randomUUID } from "crypto";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required. Add a PostgreSQL database (e.g. Railway Postgres) and set DATABASE_URL.");
}

const pool = new pg.Pool({ connectionString });

async function runMigrations() {
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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS landing_video_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id TEXT,
      event_type TEXT NOT NULL CHECK (event_type IN ('play', 'pause', 'unmute', 'mute', 'timeupdate', 'ended')),
      video_time_seconds NUMERIC,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_landing_video_events_created_at ON landing_video_events (created_at)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_landing_video_events_session_id ON landing_video_events (session_id)
  `);
}

await runMigrations();

const ALLOWED_VIDEO_EVENT_TYPES = ["play", "pause", "unmute", "mute", "timeupdate", "ended"];

export async function insertLandingVideoEvent({ sessionId, eventType, videoTimeSeconds }) {
  if (!ALLOWED_VIDEO_EVENT_TYPES.includes(eventType)) return;
  const time = videoTimeSeconds != null ? Math.min(600, Math.max(0, Number(videoTimeSeconds))) : null;
  await pool.query(
    `INSERT INTO landing_video_events (session_id, event_type, video_time_seconds) VALUES ($1, $2, $3)`,
    [sessionId ?? null, eventType, time]
  );
}

export async function getLandingVideoAnalytics(fromDate, toDate) {
  const from = fromDate ? new Date(fromDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const to = toDate ? new Date(toDate) : new Date();
  const fromStr = from.toISOString();
  const toStr = to.toISOString();

  const [totalsResult, dailyResult, pauseHistogramResult, watchTimeResult, unmuteSessionsResult] = await Promise.all([
    pool.query(
      `SELECT
        COUNT(*) FILTER (WHERE event_type = 'play') AS total_plays,
        COUNT(*) FILTER (WHERE event_type = 'pause') AS total_pauses,
        COUNT(*) FILTER (WHERE event_type = 'unmute') AS total_unmutes,
        COUNT(*) FILTER (WHERE event_type = 'mute') AS total_mutes
       FROM landing_video_events WHERE created_at >= $1 AND created_at <= $2`,
      [fromStr, toStr]
    ),
    pool.query(
      `SELECT date_trunc('day', created_at AT TIME ZONE 'UTC')::date AS day,
        COUNT(*) FILTER (WHERE event_type = 'play') AS plays,
        COUNT(*) FILTER (WHERE event_type = 'pause') AS pauses,
        COUNT(*) FILTER (WHERE event_type = 'unmute') AS unmutes
       FROM landing_video_events WHERE created_at >= $1 AND created_at <= $2
       GROUP BY date_trunc('day', created_at AT TIME ZONE 'UTC') ORDER BY day`,
      [fromStr, toStr]
    ),
    pool.query(
      `SELECT
        CASE
          WHEN video_time_seconds IS NULL OR video_time_seconds < 15 THEN '0-15s'
          WHEN video_time_seconds < 30 THEN '15-30s'
          WHEN video_time_seconds < 60 THEN '30-60s'
          WHEN video_time_seconds < 120 THEN '1-2m'
          ELSE '2m+'
        END AS bucket,
        COUNT(*) AS count
       FROM landing_video_events WHERE event_type = 'pause' AND created_at >= $1 AND created_at <= $2
       GROUP BY 1 ORDER BY MIN(video_time_seconds) NULLS FIRST`,
      [fromStr, toStr]
    ),
    pool.query(
      `WITH session_max AS (
         SELECT session_id, MAX(video_time_seconds) AS max_seconds
         FROM landing_video_events
         WHERE created_at >= $1 AND created_at <= $2 AND session_id IS NOT NULL
           AND event_type IN ('timeupdate', 'pause', 'ended') AND video_time_seconds IS NOT NULL
         GROUP BY session_id
       )
       SELECT COALESCE(SUM(max_seconds), 0) AS total_seconds, COUNT(*) AS session_count
       FROM session_max`,
      [fromStr, toStr]
    ),
    pool.query(
      `SELECT COUNT(DISTINCT session_id) AS sessions_with_unmute
       FROM landing_video_events WHERE event_type = 'unmute' AND created_at >= $1 AND created_at <= $2 AND session_id IS NOT NULL`,
      [fromStr, toStr]
    ),
  ]);

  const totals = totalsResult.rows[0];
  const totalPlays = parseInt(totals?.total_plays ?? "0", 10);
  const totalSessions = watchTimeResult.rows[0]?.session_count ?? 0;
  const totalWatchSeconds = parseFloat(watchTimeResult.rows[0]?.total_seconds ?? "0") || 0;
  const sessionsWithUnmute = parseInt(unmuteSessionsResult.rows[0]?.sessions_with_unmute ?? "0", 10);
  const unmuteRate =
    totalSessions > 0 ? Math.round((sessionsWithUnmute / totalSessions) * 100) : 0;

  return {
    from: fromStr,
    to: toStr,
    totalPlays: totalPlays,
    totalPauses: parseInt(totals?.total_pauses ?? "0", 10),
    totalUnmutes: parseInt(totals?.total_unmutes ?? "0", 10),
    totalMutes: parseInt(totals?.total_mutes ?? "0", 10),
    dailyEvents: (dailyResult.rows || []).map((r) => ({
      date: r.day,
      plays: parseInt(r.plays ?? "0", 10),
      pauses: parseInt(r.pauses ?? "0", 10),
      unmutes: parseInt(r.unmutes ?? "0", 10),
    })),
    avgWatchTimeSeconds: totalSessions > 0 ? Math.round(totalWatchSeconds / totalSessions) : 0,
    totalWatchTimeSeconds: Math.round(totalWatchSeconds),
    sessionCount: totalSessions,
    pauseAtHistogram: (pauseHistogramResult.rows || []).map((r) => ({
      bucket: r.bucket,
      count: parseInt(r.count ?? "0", 10),
    })),
    unmuteRate,
    sessionsWithUnmute,
  };
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
  const { rows } = await pool.query(
    "SELECT onboarding_id AS id, status, created_at, updated_at, payload_json FROM onboardings ORDER BY updated_at DESC"
  );
  return rows.map((r) => {
    const { payload_json, ...rest } = r;
    return { ...rest, label: deriveLabel(payload_json) || null };
  });
}

export async function getOnboarding(id) {
  const { rows } = await pool.query("SELECT * FROM onboardings WHERE onboarding_id = $1", [id]);
  return rowToOnboarding(rows[0] ?? null);
}

export async function setClientPassword(onboardingId, hashedPassword) {
  const r = await pool.query(
    "UPDATE onboardings SET client_password_hash = $1, updated_at = NOW() WHERE onboarding_id = $2 AND status = 'Draft'",
    [hashedPassword ?? null, onboardingId]
  );
  return r.rowCount > 0;
}

export async function setClientAccess(onboardingId, { clientEmail, hashedPassword, plainPassword }) {
  const r = await pool.query(
    `UPDATE onboardings
     SET client_email = $1, client_password_hash = $2, client_password_plaintext = $3, updated_at = NOW()
     WHERE onboarding_id = $4 AND status = 'Draft'`,
    [clientEmail ?? null, hashedPassword ?? null, plainPassword ?? null, onboardingId]
  );
  return r.rowCount > 0;
}

export async function getClientPasswordHash(onboardingId) {
  const { rows } = await pool.query(
    "SELECT client_password_hash FROM onboardings WHERE onboarding_id = $1 AND status = 'Draft'",
    [onboardingId]
  );
  return rows[0]?.client_password_hash ?? null;
}

export async function getClientEmail(onboardingId) {
  const { rows } = await pool.query("SELECT client_email FROM onboardings WHERE onboarding_id = $1", [onboardingId]);
  return rows[0]?.client_email ?? null;
}

export async function signAgreementOperator(onboardingId, { name, title, pricingOption }) {
  const now = new Date().toISOString();
  const r = await pool.query(
    `UPDATE onboardings
     SET agreement_signed_by_operator_at = $1, agreement_operator_name = $2, agreement_operator_title = $3,
         agreement_pricing_option = $4, updated_at = NOW()
     WHERE onboarding_id = $5 AND status = 'Draft'`,
    [now, name ?? null, title ?? null, pricingOption ?? null, onboardingId]
  );
  return r.rowCount > 0 ? { signedAt: now } : null;
}

export async function signAgreementClient(onboardingId, { name, title, clientAddress }) {
  const now = new Date().toISOString();
  const r = await pool.query(
    `UPDATE onboardings
     SET agreement_signed_by_client_at = $1, agreement_client_name = $2, agreement_client_title = $3,
         agreement_client_address = $4, updated_at = NOW()
     WHERE onboarding_id = $5 AND status = 'Draft'`,
    [now, name ?? null, title ?? null, clientAddress ?? null, onboardingId]
  );
  return r.rowCount > 0 ? { signedAt: now } : null;
}

export async function createOnboarding() {
  const id = randomUUID();
  await pool.query(
    "INSERT INTO onboardings (onboarding_id, status, payload_json) VALUES ($1, 'Draft', '{}')",
    [id]
  );
  return id;
}

export async function updateOnboarding(id, payload) {
  const payloadStr = typeof payload === "string" ? payload : JSON.stringify(payload ?? {});
  const r = await pool.query(
    "UPDATE onboardings SET payload_json = $1, updated_at = NOW() WHERE onboarding_id = $2 AND status = 'Draft'",
    [payloadStr, id]
  );
  if (r.rowCount === 0) return null;
  return getOnboarding(id);
}

export async function submitOnboarding(id, payload, { infoCompleteAt, launchClockStartAt }) {
  const payloadStr = typeof payload === "string" ? payload : JSON.stringify(payload ?? {});
  await pool.query(
    `UPDATE onboardings
     SET status = 'Submitted', payload_json = $1, updated_at = NOW(), submitted_at = NOW(),
         info_complete_at = $2, launch_clock_start_at = $3
     WHERE onboarding_id = $4 AND status = 'Draft'`,
    [payloadStr, infoCompleteAt ?? null, launchClockStartAt ?? null, id]
  );
  return getOnboarding(id);
}

export async function deleteOnboarding(id) {
  const r = await pool.query("DELETE FROM onboardings WHERE onboarding_id = $1", [id]);
  return r.rowCount > 0;
}

export default { listOnboardings, getOnboarding, setClientPassword, setClientAccess, getClientPasswordHash, getClientEmail, signAgreementOperator, signAgreementClient, createOnboarding, updateOnboarding, submitOnboarding, deleteOnboarding };
