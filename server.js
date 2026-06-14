// server.js — local dev only
import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3001;

// Local dev: never let the browser cache assets, so edits to the JS/CSS
// modules always load fresh on refresh (no stale per-file caching that masks
// just-saved changes).
app.use(express.static(__dirname, {
  etag: false,
  lastModified: false,
  setHeaders: (res) => { res.setHeader("Cache-Control", "no-store, max-age=0"); },
}));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => {
  console.log(`🎵 Google Drive Music Player running at http://localhost:${PORT}`);
});
