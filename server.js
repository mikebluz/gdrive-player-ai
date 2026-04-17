// server.js
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
require("dotenv").config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3001;

// Serve all static files
app.use(express.static(__dirname));

app.get("/config", (req, res) => {
  res.json({
    clientId: process.env.CLIENT_ID,
    apiKey: process.env.API_KEY,
  });
});

// Catch-all: serve index.html for any other route
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => {
  console.log(`🎵 Google Drive Music Player running at http://localhost:${PORT}`);
});
