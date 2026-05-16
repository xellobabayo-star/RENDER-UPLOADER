const express = require("express");
const multer = require("multer");
const axios = require("axios");
const cors = require("cors");
const FormData = require("form-data");
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");
const os = require("os");
require("dotenv").config();

// ── FFmpeg ──────────────────────────────────────────────────
let FFMPEG_PATH = "ffmpeg";
try {
  const ffmpegInstaller = require("@ffmpeg-installer/ffmpeg");
  FFMPEG_PATH = ffmpegInstaller.path;
  console.log("FFmpeg bundled:", FFMPEG_PATH);
} catch {
  console.log("Using system ffmpeg");
}

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ──────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: "500mb" }));
app.use(express.urlencoded({ extended: true, limit: "500mb" }));
// Disable cache untuk HTML supaya browser selalu ambil versi terbaru
app.use((req, res, next) => {
  if (req.path === "/" || req.path.endsWith(".html")) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
  }
  next();
});
app.use(express.static(path.join(__dirname, "public")));

// ── Simple Auth Middleware ──────────────────────────────────
// Password diset via env ACCESS_PASSWORD, kalau kosong = no auth
function requireAuth(req, res, next) {
  const pass = process.env.ACCESS_PASSWORD;
  if (!pass) return next(); // no password set = open access
  const token = req.headers["x-access-token"] || req.query.token;
  if (token === pass) return next();
  res.status(401).json({ error: "Unauthorized" });
}

// ── Multer — memory storage, max 150MB ─────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 150 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("audio/") || file.originalname.match(/\.(mp3|wav|ogg|flac|aac|m4a)$/i)) {
      cb(null, true);
    } else {
      cb(new Error("Hanya file audio yang diizinkan"));
    }
  }
});

// ── Upload history (in-memory, cukup untuk personal) ───────
const history = [];

// ── Redis (Upstash) — persistent log ────────────────────────
let redis = null;
const REDIS_KEY = "xello:logs";
const MAX_LOG_ENTRIES = 200;

if (process.env.UPSTASH_REDIS_URL && process.env.UPSTASH_REDIS_TOKEN) {
  try {
    const { Redis } = require("@upstash/redis");
    redis = new Redis({
      url: process.env.UPSTASH_REDIS_URL,
      token: process.env.UPSTASH_REDIS_TOKEN,
    });
    console.log("[STARTUP] Upstash Redis connected — logs will persist");
  } catch (e) {
    console.warn("[STARTUP] Redis init failed, falling back to memory:", e.message);
  }
} else {
  console.log("[STARTUP] No Redis config — using in-memory logs");
}

// In-memory fallback
const serverLogs = [];

async function log(msg, type = "info") {
  const icons = { error: "❌", success: "✅", warn: "⚠️", info: "ℹ️" };
  const entry = { time: new Date().toISOString(), type, msg };

  // Always keep in-memory for fast reads
  serverLogs.unshift(entry);
  if (serverLogs.length > MAX_LOG_ENTRIES) serverLogs.pop();

  // Persist to Redis if available
  if (redis) {
    try {
      await redis.lpush(REDIS_KEY, JSON.stringify(entry));
      await redis.ltrim(REDIS_KEY, 0, MAX_LOG_ENTRIES - 1);
    } catch (e) {
      console.warn("Redis log write error:", e.message);
    }
  }

  console.log(`[${entry.time}] ${icons[type] || "ℹ️"} ${msg}`);
}

// Load logs from Redis into memory on startup
async function loadLogsFromRedis() {
  if (!redis) return;
  try {
    const items = await redis.lrange(REDIS_KEY, 0, MAX_LOG_ENTRIES - 1);
    serverLogs.length = 0;
    items.forEach(item => {
      try {
        const parsed = typeof item === "string" ? JSON.parse(item) : item;
        serverLogs.push(parsed);
      } catch {}
    });
    console.log(`[STARTUP] Loaded ${serverLogs.length} log entries from Redis`);
  } catch (e) {
    console.warn("[STARTUP] Could not load logs from Redis:", e.message);
  }
}

// ── Build atempo chain (FFmpeg max per node: 0.5–2.0) ──────
function buildAtempoChain(tempo) {
  const filters = [];
  let t = tempo;
  while (t < 0.5) { filters.push("atempo=0.5"); t /= 0.5; }
  while (t > 2.0) { filters.push("atempo=2.0"); t /= 2.0; }
  if (Math.abs(t - 1.0) > 0.0001) filters.push(`atempo=${t.toFixed(6)}`);
  return filters;
}

// ── processAudio ────────────────────────────────────────────
// Bersih: hanya speed, pitch, dan optional volume normalization
// Tidak ada lowpass/EQ/compressor/loudnorm yang bikin mendam
function processAudio(inputBuffer, filename, tempo = 1.0, pitch = 0, normalize = false) {
  return new Promise((resolve, reject) => {
    const tmpDir = os.tmpdir();
    const ts = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const ext = path.extname(filename).toLowerCase() || ".mp3";
    const inputPath = path.join(tmpDir, `xp_in_${ts}${ext}`);
    const outputPath = path.join(tmpDir, `xp_out_${ts}.mp3`);

    fs.writeFileSync(inputPath, inputBuffer);

    const filterParts = [];

    // 1. Pitch shift (asetrate trick) — kualitas tinggi
    if (pitch !== 0) {
      const sampleRate = 44100;
      const pitchFactor = Math.pow(2, pitch / 12);
      const newRate = Math.round(sampleRate * pitchFactor);
      filterParts.push(`asetrate=${newRate}`);
      filterParts.push(`aresample=44100:resampler=swr:precision=28:cheby=1`);
      // Kompensasi durasi akibat pitch shift
      filterParts.push(...buildAtempoChain(1 / pitchFactor));
    }

    // 2. Speed / tempo
    if (tempo !== 1.0) {
      filterParts.push(...buildAtempoChain(tempo));
    }

    // 3. Volume normalization (dynaudnorm)
    // Angkat volume yang drop akibat pitch+speed tanpa mengubah karakter suara
    // dynaudnorm jauh lebih halus dari loudnorm — tidak bikin mendam
    if (normalize) {
      filterParts.push("dynaudnorm=f=150:g=15:r=0.9:p=0.95");
    }

    // Kalau tidak ada filter sama sekali, skip FFmpeg langsung return
    if (filterParts.length === 0) {
      fs.unlinkSync(inputPath);
      return resolve(inputBuffer);
    }

    const args = [
      "-i", inputPath,
      "-af", filterParts.join(","),
      // Output: stereo 44100Hz, bitrate 320k (kualitas terbaik)
      "-ar", "44100",
      "-ac", "2",
      "-b:a", "320k",
      "-y", outputPath
    ];

    log(`FFmpeg: tempo=${tempo}x pitch=${pitch}st normalize=${normalize}`);

    execFile(FFMPEG_PATH, args, { timeout: 900000 }, (err, stdout, stderr) => {
      try { fs.unlinkSync(inputPath); } catch {}
      if (err) {
        log(`FFmpeg error: ${stderr}`, "error");
        try { fs.unlinkSync(outputPath); } catch {}
        return reject(new Error("FFmpeg processing failed: " + stderr.slice(-300)));
      }
      try {
        const buf = fs.readFileSync(outputPath);
        fs.unlinkSync(outputPath);
        log(`Processed: ${(inputBuffer.length / 1024).toFixed(0)}KB → ${(buf.length / 1024).toFixed(0)}KB`, "success");
        resolve(buf);
      } catch (e) { reject(e); }
    });
  });
}

// ── Poll Roblox operation ───────────────────────────────────
async function pollOperation(operationId, apiKey, maxWait = 120000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    await new Promise(r => setTimeout(r, 3000));
    try {
      const res = await axios.get(
        `https://apis.roblox.com/assets/v1/operations/${operationId}`,
        { headers: { "x-api-key": apiKey } }
      );
      const { done, response, error } = res.data;
      if (done) {
        if (error) return { success: false, error };
        return { success: true, assetId: response?.assetId || response?.Id };
      }
    } catch (e) {
      log(`Poll error: ${e.message}`, "warn");
    }
  }
  return { success: false, error: "Timeout polling operation" };
}

// ── Upload ke Roblox ────────────────────────────────────────
async function uploadToRoblox(fileBuffer, filename, apiKey, creatorType, userId, groupId, displayName, description) {
  let creatorField;
  if (creatorType === "group") {
    creatorField = { groupId: String(groupId) };
  } else {
    creatorField = { userId: String(userId) };
  }

  const metadata = {
    assetType: "Audio",
    displayName: displayName || path.basename(filename, path.extname(filename)),
    description: description || "",
    creationContext: { creator: creatorField }
  };

  const form = new FormData();
  form.append("request", JSON.stringify(metadata));
  form.append("fileContent", fileBuffer, { filename, contentType: "audio/mpeg" });

  const response = await axios.post(
    "https://apis.roblox.com/assets/v1/assets",
    form,
    {
      headers: { "x-api-key": apiKey, ...form.getHeaders() },
      maxBodyLength: Infinity,
      maxContentLength: Infinity
    }
  );

  let { assetId, operationId } = response.data;
  if (operationId && !assetId) {
    const poll = await pollOperation(operationId, apiKey);
    if (poll.success) assetId = poll.assetId;
    else throw new Error(JSON.stringify(poll.error));
  }

  return assetId;
}

// ═══════════════════════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════════════════════

// ── Health check (no auth) ─────────────────────────────────
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", version: "1.0.0" });
});

// ── Auth check — tells client if password is needed ─────────
// Returns 200 jika tidak perlu password atau token valid
// Returns 401 jika perlu password tapi token salah/tidak ada
app.get("/api/auth-check", requireAuth, (req, res) => {
  res.json({ ok: true, passwordRequired: !!process.env.ACCESS_PASSWORD });
});

// ── Validate Roblox API Key + User/Group ───────────────────
app.post("/api/validate-key", requireAuth, async (req, res) => {
  const { apiKey, creatorType = "user", userId, groupId } = req.body;

  if (!apiKey || !apiKey.trim())
    return res.status(400).json({ valid: false, error: "API Key wajib diisi" });

  if (creatorType === "group") {
    if (!groupId || !groupId.trim())
      return res.status(400).json({ valid: false, error: "Group ID wajib diisi untuk mode Group" });
  } else {
    if (!userId || !userId.trim())
      return res.status(400).json({ valid: false, error: "User ID wajib diisi untuk mode User" });
  }

  try {
    let name = "(tidak diketahui)";

    if (creatorType === "group") {
      // Validasi group via Open Cloud v2
      const r = await axios.get(
        `https://apis.roblox.com/cloud/v2/groups/${groupId.trim()}`,
        { headers: { "x-api-key": apiKey.trim() } }
      );
      name = r.data.displayName || r.data.name || `Group ${groupId}`;
    } else {
      // Validasi user: coba v2 dulu
      try {
        const r = await axios.get(
          `https://apis.roblox.com/cloud/v2/users/${userId.trim()}`,
          { headers: { "x-api-key": apiKey.trim() } }
        );
        name = r.data.displayName || r.data.name || r.data.username || `User ${userId}`;
      } catch (e2) {
        const status2 = e2.response?.status;
        // 403 = API key valid tapi tidak punya izin user:read → tetap anggap valid
        if (status2 === 403) {
          try {
            const pub = await axios.get(`https://users.roblox.com/v1/users/${userId.trim()}`);
            name = pub.data.displayName || pub.data.name || `User ${userId}`;
          } catch {
            name = `User ${userId}`;
          }
        } else {
          throw e2; // 401 atau error lain = API key benar-benar invalid
        }
      }
    }

    log(`API Key valid — ${creatorType}: ${name}`, "success");
    res.json({ valid: true, creatorType, name });
  } catch (e) {
    const errData = e.response?.data;
    const status = e.response?.status;
    log(`API Key invalid — status ${status}: ${JSON.stringify(errData)}`, "warn");
    res.json({ valid: false, status, error: errData || e.message });
  }
});

// ── Upload + Process (SSE streaming) ───────────────────────
app.post("/api/upload", requireAuth, upload.array("files", 500), async (req, res) => {
  if (!req.files || req.files.length === 0)
    return res.status(400).json({ error: "Tidak ada file" });

  const {
    apiKey, creatorType = "user", userId, groupId,
    displayName, description,
    tempoMultiplier = "1", pitchShift = "0", normalize = "false"
  } = req.body;

  if (!apiKey || !apiKey.trim())
    return res.status(400).json({ error: "API Key Roblox wajib diisi" });

  const tempo = Math.max(0.5, Math.min(16, parseFloat(tempoMultiplier) || 1));
  const pitch = Math.max(-24, Math.min(24, parseFloat(pitchShift) || 0));
  const doNormalize = normalize === "true";
  const needsProcess = tempo !== 1.0 || pitch !== 0 || doNormalize;

  // SSE setup
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const send = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  send({ type: "start", total: req.files.length });

  for (let i = 0; i < req.files.length; i++) {
    const file = req.files[i];
    const entry = {
      id: `${Date.now()}_${i}`,
      filename: file.originalname,
      status: "PENDING",
      assetId: null,
      error: null,
      tempo, pitch,
      size: file.size,
      createdAt: new Date().toISOString()
    };

    send({ type: "progress", index: i + 1, total: req.files.length, file: file.originalname, status: "processing" });

    try {
      // 1. Process audio (FFmpeg)
      let buf = file.buffer;
      if (needsProcess) {
        send({ type: "progress", index: i + 1, total: req.files.length, file: file.originalname, status: "ffmpeg" });
        buf = await processAudio(file.buffer, file.originalname, tempo, pitch, doNormalize);
      }

      // 2. Upload ke Roblox
      send({ type: "progress", index: i + 1, total: req.files.length, file: file.originalname, status: "uploading" });
      const assetId = await uploadToRoblox(buf, file.originalname, apiKey.trim(), creatorType, userId, groupId, displayName, description);

      entry.status = "SUCCESS";
      entry.assetId = assetId;
      log(`Upload success: ${file.originalname} → ${assetId}`, "success");
      send({ type: "result", index: i + 1, file: file.originalname, status: "SUCCESS", assetId });
    } catch (e) {
      entry.status = "FAILED";
      entry.error = e.response?.data ? JSON.stringify(e.response.data) : e.message;
      log(`Upload failed: ${file.originalname} — ${entry.error}`, "error");
      send({ type: "result", index: i + 1, file: file.originalname, status: "FAILED", error: entry.error });
    }

    history.unshift(entry);
    if (history.length > 200) history.pop(); // keep last 200

    // Rate limit antar file
    if (i < req.files.length - 1) await new Promise(r => setTimeout(r, 800));
  }

  const success = history.slice(0, req.files.length).filter(h => h.status === "SUCCESS").length;
  send({ type: "done", total: req.files.length, success });
  res.end();
});

// ── Get history ─────────────────────────────────────────────
app.get("/api/history", requireAuth, (req, res) => {
  res.json(history.slice(0, 100));
});

// ── Clear history ───────────────────────────────────────────
app.delete("/api/history", requireAuth, (req, res) => {
  history.length = 0;
  res.json({ ok: true });
});

// ── Get server logs ────────────────────────────────────────
app.get("/api/logs", requireAuth, (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  res.json(serverLogs.slice(0, limit));
});

// ── Clear server logs ───────────────────────────────────────
app.delete("/api/logs", requireAuth, async (req, res) => {
  serverLogs.length = 0;
  if (redis) {
    try { await redis.del(REDIS_KEY); } catch {}
  }
  res.json({ ok: true });
});

// ── Serve index.html for all non-API routes ─────────────────
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ── Start ───────────────────────────────────────────────────
(async () => {
  await loadLogsFromRedis();
  app.listen(PORT, () => {
    log(`🚀 Xello Personal running on port ${PORT}`, "success");
    log(`🔑 Auth: ${process.env.ACCESS_PASSWORD ? "ON (password set)" : "OFF (open access)"}`, "info");
    log(`💾 Log storage: ${redis ? "Upstash Redis (persistent)" : "In-memory (sementara)"}`, "info");
  });
})();
