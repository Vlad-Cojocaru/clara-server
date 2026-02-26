import express from "express";
import cors from "cors";

const app = express();

app.use(cors());
app.use(express.json());

const RETELL_API_BASE = "https://api.retellai.com/v2";

app.post("/api/create-web-call", async (req, res) => {
  const apiKey = process.env.RETELL_API_KEY;
  const agentId = process.env.RETELL_AGENT_ID || "+14313404488";

  if (!apiKey) {
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
    console.error("Error creating Retell web call:", err);
    return res.status(500).json({
      error: "Unexpected error while creating Retell web call",
    });
  }
});

const port = process.env.PORT || process.env.SERVER_PORT || 8787;

app.listen(port, () => {
  console.log(`Retell web-call backend listening on http://localhost:${port}`);
});
