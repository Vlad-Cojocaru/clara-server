import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { randomBytes, scryptSync } from "crypto";
import * as db from "./db.mjs";
import { mergeShortlistWithRetell } from "./voiceShortlist.mjs";

const app = express();

const ONBOARDING_PASSWORD = process.env.ONBOARDING_PASSWORD ?? "claraOnboardingFlow";
const SUPERUSER_EMAIL = (process.env.SUPERUSER_EMAIL ?? "vlad@curate222.com").trim().toLowerCase();
const ONBOARDING_SECRET = process.env.ONBOARDING_SECRET ?? "clara-onboarding-salt";
const SESSION_COOKIE = "onboarding_session";
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
/** If set (e.g. .claraforclinics.com), cookie is shared with app subdomain — use when API is at api.claraforclinics.com */
const COOKIE_DOMAIN = (process.env.COOKIE_DOMAIN || "").trim() || undefined;
const sessions = new Map(); // token -> { createdAt, type, onboardingId }

function getCookieOptions() {
  const opts = {
    httpOnly: true,
    maxAge: SESSION_TTL_MS,
    path: "/",
    secure: true,
  };
  if (COOKIE_DOMAIN) {
    opts.domain = COOKIE_DOMAIN;
    opts.sameSite = "lax"; // same-site (app + api on claraforclinics.com)
  } else {
    opts.sameSite = "none"; // cross-origin (API on different domain)
  }
  return opts;
}

function createSession(type = "operator", onboardingId = null) {
  const token = randomBytes(32).toString("hex");
  sessions.set(token, { createdAt: Date.now(), type, onboardingId });
  return token;
}

function getSessionToken(req) {
  return req.cookies?.[SESSION_COOKIE] ?? null;
}

function isSessionValid(token) {
  if (!token) return false;
  const s = sessions.get(token);
  if (!s) return false;
  if (Date.now() - s.createdAt > SESSION_TTL_MS) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function getSessionData(token) {
  if (!token || !isSessionValid(token)) return null;
  const s = sessions.get(token);
  return s ? { type: s.type ?? "operator", onboardingId: s.onboardingId ?? null } : null;
}

function hashClientPassword(plain) {
  return scryptSync(plain, ONBOARDING_SECRET, 64).toString("hex");
}

function requireOperator(req, res, next) {
  const token = getSessionToken(req);
  const data = getSessionData(token);
  if (!data) return res.status(401).json({ error: "Unauthorized" });
  if (data.type !== "operator") return res.status(403).json({ error: "Operator access required" });
  next();
}

function requireDraftAccess(req, res, next) {
  const token = getSessionToken(req);
  const data = getSessionData(token);
  if (!data) return res.status(401).json({ error: "Unauthorized" });
  if (data.type === "operator") return next();
  if (data.type === "client" && data.onboardingId === req.params.id) return next();
  return res.status(403).json({ error: "Access denied to this onboarding" });
}

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());

// Log every request (shows in Railway stdout)
const log = (msg, req) => {
  const method = req?.method ?? "";
  const path = req?.path ?? req?.url ?? "";
  console.log(`[Clara server] ${msg} ${method} ${path}`);
};
app.use((req, res, next) => {
  log("→", req);
  next();
});

// Health check so you can confirm the Node app is the one responding
app.get("/", (req, res) => {
  log("GET /", req);
  res.json({ ok: true, service: "clara-server", path: req.path });
});
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "clara-server" });
});

const RETELL_API_BASE = "https://api.retellai.com/v2";

app.post("/api/create-web-call", async (req, res) => {
  log("POST /api/create-web-call", req);
  const apiKey = process.env.RETELL_API_KEY;
  const agentId = process.env.RETELL_AGENT_ID || "+14313404488";

  if (!apiKey) {
    console.log("[Clara server] RETELL_API_KEY not set");
    return res.status(500).json({
      error: "RETELL_API_KEY is not set on the server",
    });
  }

  try {
    const response = await fetch(`${RETELL_API_BASE}/create-web-call`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        agent_id: agentId,
        metadata: {
          source: "lp",
          ...((req.body && req.body.metadata) || {}),
        },
        // Agent speaks first (greeting); works for both Retell LLM and Conversation Flow
        agent_override: {
          retell_llm: { start_speaker: "agent" },
          conversation_flow: { start_speaker: "agent" },
        },
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.log("[Clara server] Retell API error:", response.status, errorBody);
      return res.status(response.status).json({
        error: "Failed to create web call with Retell",
        status: response.status,
        body: errorBody,
      });
    }

    const data = await response.json();
    return res.json({
      accessToken: data.access_token,
      callId: data.call_id,
      raw: data,
    });
  } catch (err) {
    console.error("[Clara server] Retell error:", err);
    return res.status(500).json({
      error: "Unexpected error while creating Retell web call",
    });
  }
});

// --- Onboarding API (password-protected) ---

app.post("/api/onboarding/login", (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password required" });
  }
  const emailNorm = String(email).trim().toLowerCase();
  if (emailNorm !== SUPERUSER_EMAIL || password !== ONBOARDING_PASSWORD) {
    return res.status(401).json({ error: "Invalid email or password" });
  }
  const token = createSession("operator");
  res.cookie(SESSION_COOKIE, token, getCookieOptions());
  res.json({ ok: true });
});

app.post("/api/onboarding/client-login", async (req, res) => {
  const { onboarding_id, email, password } = req.body || {};
  if (!onboarding_id || !email || !password) {
    return res.status(400).json({ error: "onboarding_id, email, and password required" });
  }
  const storedEmail = await db.getClientEmail(onboarding_id);
  const storedHash = await db.getClientPasswordHash(onboarding_id);
  if (!storedHash || !storedEmail) {
    return res.status(401).json({ error: "Invalid access" });
  }
  const emailNorm = String(email).trim().toLowerCase();
  if (emailNorm !== storedEmail.trim().toLowerCase()) {
    return res.status(401).json({ error: "Invalid email or password" });
  }
  const inputHash = hashClientPassword(password);
  if (inputHash !== storedHash) {
    return res.status(401).json({ error: "Invalid email or password" });
  }
  const token = createSession("client", onboarding_id);
  res.cookie(SESSION_COOKIE, token, getCookieOptions());
  res.json({ ok: true });
});

app.post("/api/onboarding/logout", (req, res) => {
  const token = getSessionToken(req);
  if (token) sessions.delete(token);
  res.clearCookie(SESSION_COOKIE, { path: "/", ...getCookieOptions() });
  res.json({ ok: true });
});

app.get("/api/onboarding/session", (req, res) => {
  const token = getSessionToken(req);
  const data = getSessionData(token);
  if (!data) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  res.json({
    type: data.type,
    onboarding_id: data.onboardingId || undefined,
  });
});

app.get("/api/onboarding", requireOperator, async (req, res) => {
  const list = await db.listOnboardings();
  res.json(list);
});

app.post("/api/onboarding/create", requireOperator, async (req, res) => {
  const onboarding_id = await db.createOnboarding();
  res.status(201).json({ onboarding_id });
});

app.delete("/api/onboarding/:id", requireOperator, async (req, res) => {
  const deleted = await db.deleteOnboarding(req.params.id);
  if (!deleted) return res.status(404).json({ error: "Not found" });
  res.status(204).end();
});

/** Curated voice previews for onboarding (Retell list-voices + shortlist); no API key in client */
app.get("/api/onboarding/:id/voice-options", requireDraftAccess, async (req, res) => {
  const apiKey = process.env.RETELL_API_KEY;
  if (!apiKey) {
    return res.status(200).json({ voices: [], unavailable: true });
  }
  try {
    const response = await fetch("https://api.retellai.com/list-voices", {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    });
    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      console.log("[Clara server] list-voices error:", response.status, errText);
      return res.status(200).json({ voices: [], unavailable: true });
    }
    const data = await response.json();
    const list = Array.isArray(data) ? data : data.voices || [];
    const voices = mergeShortlistWithRetell(list);
    return res.json({ voices });
  } catch (err) {
    console.error("[Clara server] voice-options:", err);
    return res.status(200).json({ voices: [], unavailable: true });
  }
});

app.get("/api/onboarding/:id", requireDraftAccess, async (req, res) => {
  const record = await db.getOnboarding(req.params.id);
  if (!record) return res.status(404).json({ error: "Not found" });
  const session = getSessionData(getSessionToken(req));
  const payload = {
    onboarding_id: record.onboarding_id,
    status: record.status,
    payload: record.payload_json,
    created_at: record.created_at,
    updated_at: record.updated_at,
    submitted_at: record.submitted_at,
    info_complete_at: record.info_complete_at,
    launch_clock_start_at: record.launch_clock_start_at,
    has_client_password: record.has_client_password ?? false,
    client_email: record.client_email ?? null,
  };
  if (session?.type === "operator" && record.client_password_plaintext != null) {
    payload.client_password_plaintext = record.client_password_plaintext;
  }
  res.json(payload);
});

app.patch("/api/onboarding/:id", requireDraftAccess, async (req, res) => {
  const record = await db.getOnboarding(req.params.id);
  if (!record) return res.status(404).json({ error: "Not found" });
  if (record.status !== "Draft") {
    return res.status(400).json({ error: "Cannot update submitted onboarding" });
  }
  const existing = record.payload_json || {};
  const merged = { ...existing, ...(req.body || {}) };
  const updated = await db.updateOnboarding(req.params.id, merged);
  if (!updated) return res.status(400).json({ error: "Update failed" });
  res.json({
    onboarding_id: updated.onboarding_id,
    status: updated.status,
    payload: updated.payload_json,
    updated_at: updated.updated_at,
    has_client_password: updated.has_client_password ?? false,
  });
});

app.patch("/api/onboarding/:id/client-password", requireOperator, async (req, res) => {
  const record = await db.getOnboarding(req.params.id);
  if (!record) return res.status(404).json({ error: "Not found" });
  if (record.status !== "Draft") {
    return res.status(400).json({ error: "Cannot set client password on submitted onboarding" });
  }
  const { client_password } = req.body || {};
  const hash = client_password != null && String(client_password).trim() !== ""
    ? hashClientPassword(String(client_password).trim())
    : null;
  await db.setClientPassword(req.params.id, hash);
  res.json({ ok: true });
});

app.patch("/api/onboarding/:id/client-access", requireOperator, async (req, res) => {
  const record = await db.getOnboarding(req.params.id);
  if (!record) return res.status(404).json({ error: "Not found" });
  if (record.status !== "Draft") {
    return res.status(400).json({ error: "Cannot set client access on submitted onboarding" });
  }
  const { client_email, client_password } = req.body || {};
  if (!client_email || typeof client_email !== "string" || !client_email.trim()) {
    return res.status(400).json({ error: "client_email required" });
  }
  if (!client_password || typeof client_password !== "string" || !client_password.trim()) {
    return res.status(400).json({ error: "client_password required" });
  }
  const emailTrimmed = client_email.trim();
  const pwdTrimmed = client_password.trim();
  const hash = hashClientPassword(pwdTrimmed);
  await db.setClientAccess(req.params.id, {
    clientEmail: emailTrimmed,
    hashedPassword: hash,
    plainPassword: pwdTrimmed,
  });
  res.json({ ok: true });
});

app.get("/api/onboarding/:id/agreement", requireDraftAccess, async (req, res) => {
  const record = await db.getOnboarding(req.params.id);
  if (!record) return res.status(404).json({ error: "Not found" });
  res.json({
    agreement_signed_by_operator_at: record.agreement_signed_by_operator_at ?? null,
    agreement_signed_by_client_at: record.agreement_signed_by_client_at ?? null,
    agreement_operator_name: record.agreement_operator_name ?? null,
    agreement_operator_title: record.agreement_operator_title ?? null,
    agreement_client_name: record.agreement_client_name ?? null,
    agreement_client_title: record.agreement_client_title ?? null,
    agreement_client_address: record.agreement_client_address ?? null,
    agreement_pricing_option: record.agreement_pricing_option ?? null,
    payload: record.payload_json,
  });
});

app.post("/api/onboarding/:id/agreement/sign-operator", requireOperator, async (req, res) => {
  const record = await db.getOnboarding(req.params.id);
  if (!record) return res.status(404).json({ error: "Not found" });
  if (record.status !== "Draft") {
    return res.status(400).json({ error: "Cannot sign agreement on submitted onboarding" });
  }
  const { name, title, pricing_option } = req.body || {};
  const result = await db.signAgreementOperator(req.params.id, {
    name: name?.trim() || null,
    title: title?.trim() || null,
    pricingOption: pricing_option === "100_per_appointment" ? "100_per_appointment" : "497_month",
  });
  if (!result) return res.status(400).json({ error: "Update failed" });
  res.json({ ok: true, signed_at: result.signedAt });
});

app.post("/api/onboarding/:id/agreement/sign-client", requireDraftAccess, async (req, res) => {
  const data = getSessionData(getSessionToken(req));
  if (!data || data.type !== "client" || data.onboardingId !== req.params.id) {
    return res.status(403).json({ error: "Client access required" });
  }
  const record = await db.getOnboarding(req.params.id);
  if (!record) return res.status(404).json({ error: "Not found" });
  if (record.status !== "Draft") {
    return res.status(400).json({ error: "Cannot sign agreement on submitted onboarding" });
  }
  const { name, title, client_address } = req.body || {};
  const result = await db.signAgreementClient(req.params.id, {
    name: name?.trim() || null,
    title: title?.trim() || null,
    clientAddress: client_address?.trim() || null,
  });
  if (!result) return res.status(400).json({ error: "Update failed" });
  res.json({ ok: true, signed_at: result.signedAt });
});

function validateSubmitPayload(payload) {
  const fields = {};
  const p = payload || {};

  // Booking
  const booking = p.booking || {};
  const system = booking.booking_system;
  if (system === "GHL") {
    if (!booking.ghl_subaccount?.trim()) fields.booking_ghl_subaccount = "Required";
    if (!booking.ghl_admin_name?.trim() || !booking.ghl_admin_email?.trim()) {
      if (!booking.ghl_admin_name?.trim()) fields.booking_ghl_admin_name = "Required";
      if (!booking.ghl_admin_email?.trim()) fields.booking_ghl_admin_email = "Required";
    }
  } else if (system === "Cal.com" || system === "Other") {
    if (!booking.booking_link?.trim()) fields.booking_link = "Required";
    if (!booking.booking_mode?.trim()) fields.booking_mode = "Required";
  }

  // Transcripts
  const delivery = p.transcripts_delivery || {};
  const method = delivery.method;
  if (method === "Email" && (!delivery.email_recipients || delivery.email_recipients.length === 0)) {
    fields.transcripts_email_recipients = "At least one email required";
  }
  if (method === "SMS" && (!delivery.sms_recipients || delivery.sms_recipients.length === 0)) {
    fields.transcripts_sms_recipients = "At least one SMS required";
  }
  if (method === "Both") {
    if (!delivery.email_recipients?.length) fields.transcripts_email_recipients = "At least one email required";
    if (!delivery.sms_recipients?.length) fields.transcripts_sms_recipients = "At least one SMS required";
  }

  // Routing
  if (p.routing_enabled) {
    const r = p.routing || {};
    if (!r.primary_contact_name?.trim() || !r.primary_contact_phone?.trim()) {
      if (!r.primary_contact_name?.trim()) fields.routing_primary_name = "Required";
      if (!r.primary_contact_phone?.trim()) fields.routing_primary_phone = "Required";
    }
  }

  return Object.keys(fields).length ? { error: "Validation failed", fields } : null;
}

function computeInfoComplete(payload) {
  const p = payload || {};
  const business = p.business || {};
  if (!business.company_name?.trim() || !business.primary_email?.trim() || !business.primary_phone?.trim()) return false;
  const booking = p.booking || {};
  const system = booking.booking_system;
  if (system === "GHL") {
    if (!booking.ghl_subaccount?.trim() || !booking.ghl_admin_email?.trim()) return false;
  } else if (system === "Cal.com" || system === "Other") {
    if (!booking.booking_link?.trim() || !booking.booking_mode?.trim()) return false;
  } else return false;
  const schedule = p.run_schedule || {};
  if (!schedule.type) return false;
  const capture = p.capture || {};
  if (!capture || typeof capture !== "object") return false;
  const services = p.services || {};
  if (!services.services_handled?.length && !services.top_3_priority_services?.trim()) return false;
  if (p.routing_enabled) {
    const r = p.routing || {};
    if (!r.primary_contact_name?.trim() || !r.primary_contact_phone?.trim()) return false;
  }
  const delivery = p.transcripts_delivery || {};
  if (delivery.method === "Email" && !delivery.email_recipients?.length) return false;
  if (delivery.method === "SMS" && !delivery.sms_recipients?.length) return false;
  if (delivery.method === "Both" && (!delivery.email_recipients?.length || !delivery.sms_recipients?.length)) return false;

  const kb = p.knowledge_base || {};
  const kbMethod = kb.delivery_method;
  if (kbMethod === "website_interim") return true;
  if (kbMethod === "email_after" && kb.kb_received_status === "Received") return true;
  if (kbMethod === "email_after") return false;
  return true;
}

function shouldStartLaunchClock(payload) {
  if (!computeInfoComplete(payload)) return false;
  const kb = (payload || {}).knowledge_base || {};
  if (kb.delivery_method === "website_interim") return true;
  if (kb.delivery_method === "email_after" && kb.kb_received_status === "Received") return true;
  return false;
}

app.post("/api/onboarding/:id/submit", requireOperator, async (req, res) => {
  const record = await db.getOnboarding(req.params.id);
  if (!record) return res.status(404).json({ error: "Not found" });
  if (record.status !== "Draft") {
    return res.status(400).json({ error: "Already submitted" });
  }
  if (!record.agreement_signed_by_operator_at || !record.agreement_signed_by_client_at) {
    return res.status(400).json({
      error: "Both parties must sign the agreement before submitting",
    });
  }
  const existing = record.payload_json || {};
  const merged = { ...existing, ...(req.body || {}) };
  const validation = validateSubmitPayload(merged);
  if (validation) return res.status(400).json(validation);

  const infoComplete = computeInfoComplete(merged);
  const startLaunchClock = shouldStartLaunchClock(merged);
  const now = new Date().toISOString();
  const infoCompleteAt = infoComplete ? now : null;
  const launchClockStartAt = startLaunchClock ? now : null;

  await db.submitOnboarding(req.params.id, merged, {
    infoCompleteAt,
    launchClockStartAt,
  });

  res.json({ ok: true });
});

// --- Landing page video analytics (public ingest, operator-only read) ---

const ALLOWED_VIDEO_EVENTS = ["play", "pause", "unmute", "mute", "timeupdate", "ended"];
const VIDEO_EVENT_RATE_LIMIT = 60; // max events per sessionId per minute
const videoEventCounts = new Map(); // sessionId -> { count, resetAt }

function checkVideoEventRateLimit(sessionId) {
  if (!sessionId) return true;
  const now = Date.now();
  const key = sessionId;
  let entry = videoEventCounts.get(key);
  if (!entry) {
    videoEventCounts.set(key, { count: 1, resetAt: now + 60 * 1000 });
    return true;
  }
  if (now > entry.resetAt) {
    entry.count = 1;
    entry.resetAt = now + 60 * 1000;
    return true;
  }
  if (entry.count >= VIDEO_EVENT_RATE_LIMIT) return false;
  entry.count += 1;
  return true;
}

app.post("/api/landing/video-event", async (req, res) => {
  const { sessionId, event, videoTimeSeconds } = req.body || {};
  if (!event || !ALLOWED_VIDEO_EVENTS.includes(event)) {
    return res.status(400).json({ error: "Invalid or missing event" });
  }
  if (!checkVideoEventRateLimit(sessionId ?? req.ip)) {
    return res.status(429).json({ error: "Too many events" });
  }
  try {
    await db.insertLandingVideoEvent({
      sessionId: typeof sessionId === "string" ? sessionId.slice(0, 128) : null,
      eventType: event,
      videoTimeSeconds: videoTimeSeconds != null ? Number(videoTimeSeconds) : undefined,
    });
    res.status(204).end();
  } catch (err) {
    console.error("[Clara server] landing video event error:", err);
    res.status(500).json({ error: "Failed to record event" });
  }
});

app.get("/api/landing/analytics", requireOperator, async (req, res) => {
  const { from, to } = req.query || {};
  try {
    const data = await db.getLandingVideoAnalytics(from || undefined, to || undefined);
    res.json(data);
  } catch (err) {
    console.error("[Clara server] landing analytics error:", err);
    res.status(500).json({ error: "Failed to load analytics" });
  }
});

// Log 404s so we know if something else is handling the request
app.use((req, res) => {
  log("404", req);
  res.status(404).json({ error: "Not found", path: req.path });
});

const port = process.env.PORT || process.env.SERVER_PORT || 8787;

app.listen(port, () => {
  console.log(`[Clara server] listening on port ${port}`);
});
