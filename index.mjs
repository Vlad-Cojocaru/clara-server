import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { randomBytes, scryptSync } from "crypto";
import * as db from "./db.mjs";

const app = express();

const ONBOARDING_PASSWORD = process.env.ONBOARDING_PASSWORD ?? "claraOnboardingFlow";
const ONBOARDING_SECRET = process.env.ONBOARDING_SECRET ?? "clara-onboarding-salt";
const SESSION_COOKIE = "onboarding_session";
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const sessions = new Map(); // token -> { createdAt, type, onboardingId }

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
  const { password } = req.body || {};
  if (password !== ONBOARDING_PASSWORD) {
    return res.status(401).json({ error: "Invalid password" });
  }
  const token = createSession("operator");
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    maxAge: SESSION_TTL_MS,
    sameSite: "lax",
    path: "/",
  });
  res.json({ ok: true });
});

app.post("/api/onboarding/client-login", (req, res) => {
  const { onboarding_id, password } = req.body || {};
  if (!onboarding_id || !password) {
    return res.status(400).json({ error: "onboarding_id and password required" });
  }
  const storedHash = db.getClientPasswordHash(onboarding_id);
  if (!storedHash) {
    return res.status(401).json({ error: "Invalid access" });
  }
  const inputHash = hashClientPassword(password);
  if (inputHash !== storedHash) {
    return res.status(401).json({ error: "Invalid password" });
  }
  const token = createSession("client", onboarding_id);
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    maxAge: SESSION_TTL_MS,
    sameSite: "lax",
    path: "/",
  });
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

app.get("/api/onboarding", requireOperator, (req, res) => {
  const list = db.listOnboardings();
  res.json(list);
});

app.post("/api/onboarding/create", requireOperator, (req, res) => {
  const onboarding_id = db.createOnboarding();
  res.status(201).json({ onboarding_id });
});

app.get("/api/onboarding/:id", requireDraftAccess, (req, res) => {
  const record = db.getOnboarding(req.params.id);
  if (!record) return res.status(404).json({ error: "Not found" });
  res.json({
    onboarding_id: record.onboarding_id,
    status: record.status,
    payload: record.payload_json,
    created_at: record.created_at,
    updated_at: record.updated_at,
    submitted_at: record.submitted_at,
    info_complete_at: record.info_complete_at,
    launch_clock_start_at: record.launch_clock_start_at,
    has_client_password: record.has_client_password ?? false,
  });
});

app.patch("/api/onboarding/:id", requireDraftAccess, (req, res) => {
  const record = db.getOnboarding(req.params.id);
  if (!record) return res.status(404).json({ error: "Not found" });
  if (record.status !== "Draft") {
    return res.status(400).json({ error: "Cannot update submitted onboarding" });
  }
  const existing = record.payload_json || {};
  const merged = { ...existing, ...(req.body || {}) };
  const updated = db.updateOnboarding(req.params.id, merged);
  if (!updated) return res.status(400).json({ error: "Update failed" });
  res.json({
    onboarding_id: updated.onboarding_id,
    status: updated.status,
    payload: updated.payload_json,
    updated_at: updated.updated_at,
    has_client_password: updated.has_client_password ?? false,
  });
});

app.patch("/api/onboarding/:id/client-password", requireOperator, (req, res) => {
  const record = db.getOnboarding(req.params.id);
  if (!record) return res.status(404).json({ error: "Not found" });
  if (record.status !== "Draft") {
    return res.status(400).json({ error: "Cannot set client password on submitted onboarding" });
  }
  const { client_password } = req.body || {};
  const hash = client_password != null && String(client_password).trim() !== ""
    ? hashClientPassword(String(client_password).trim())
    : null;
  db.setClientPassword(req.params.id, hash);
  res.json({ ok: true });
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
  const record = db.getOnboarding(req.params.id);
  if (!record) return res.status(404).json({ error: "Not found" });
  if (record.status !== "Draft") {
    return res.status(400).json({ error: "Already submitted" });
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

  db.submitOnboarding(req.params.id, merged, {
    infoCompleteAt,
    launchClockStartAt,
  });

  const webhookUrl = process.env.GHL_ONBOARDING_WEBHOOK_URL;
  if (webhookUrl) {
    try {
      const webhookPayload = {
        ...merged,
        meta: {
          onboarding_id: req.params.id,
          submitted_at: now,
          info_complete_at: infoCompleteAt,
          launch_clock_start_at: launchClockStartAt,
        },
      };
      await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(webhookPayload),
      });
    } catch (err) {
      console.error("[Clara server] GHL webhook error:", err);
    }
  }

  res.json({ ok: true });
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
