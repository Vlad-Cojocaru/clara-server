import express from "express";
import cors from "cors";

const app = express();

app.use(cors());
app.use(express.json());

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
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
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

// Log 404s so we know if something else is handling the request
app.use((req, res) => {
  log("404", req);
  res.status(404).json({ error: "Not found", path: req.path });
});

const port = process.env.PORT || process.env.SERVER_PORT || 8787;

app.listen(port, () => {
  console.log(`[Clara server] listening on port ${port}`);
});
