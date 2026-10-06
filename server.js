import express from "express";
import cors from "cors";
import multer from "multer";
import { google } from "googleapis";
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const PORT = Number(process.env.PORT || 10000);
const DOWNLOAD_DIR = path.resolve(process.env.ARIA2_DOWNLOAD_DIR || "/tmp/downloads");
const RPC_URL = process.env.ARIA2_RPC_URL || "http://127.0.0.1:6800/jsonrpc";
const RPC_SECRET = process.env.ARIA2_RPC_SECRET || crypto.randomBytes(24).toString("hex");
const APP_API_KEY = process.env.APP_API_KEY || "";
const GOOGLE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID || "";
const DELETE_AFTER_UPLOAD = String(process.env.DELETE_AFTER_UPLOAD || "true").toLowerCase() !== "false";
const CORS_ORIGINS = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);

await fsp.mkdir(DOWNLOAD_DIR, { recursive: true });

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));

if (CORS_ORIGINS.length) {
  app.use(cors({
    origin(origin, cb) {
      if (!origin || CORS_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error("Origin not allowed"));
    },
  }));
}

function requireApiKey(req, res, next) {
  if (!APP_API_KEY) {
    return res.status(503).json({
      error: "APP_API_KEY is not configured on Render",
    });
  }
  const auth = req.headers.authorization || "";
  if (auth !== `Bearer ${APP_API_KEY}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

function aria2Params(params = []) {
  return RPC_SECRET ? [`token:${RPC_SECRET}`, ...params] : params;
}

async function rpc(method, params = []) {
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method,
      params: aria2Params(params),
    }),
  });
  const json = await response.json();
  if (!response.ok || json.error) {
    throw new Error(json?.error?.message || `aria2 RPC failed: ${response.status}`);
  }
  return json.result;
}

function startAria2() {
  const args = [
    "--enable-rpc=true",
    "--rpc-listen-all=false",
    "--rpc-listen-port=6800",
    `--rpc-secret=${RPC_SECRET}`,
    `--dir=${DOWNLOAD_DIR}`,
    "--continue=true",
    "--max-concurrent-downloads=3",
    "--seed-time=0",
    "--bt-enable-lpd=false",
    "--enable-dht=true",
    "--enable-dht6=true",
    "--follow-torrent=true",
    "--file-allocation=none",
    "--summary-interval=0",
  ];

  const child = spawn("aria2c", args, { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => process.stdout.write(`[aria2] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[aria2] ${d}`));
  child.on("exit", (code, signal) => {
    console.error(`aria2 exited (code=${code}, signal=${signal})`);
    process.exit(code || 1);
  });
  return child;
}

const aria2Process = startAria2();

async function waitForAria2() {
  let lastError;
  for (let i = 0; i < 40; i += 1) {
    try {
      await rpc("aria2.getVersion");
      return;
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw lastError || new Error("aria2 did not start");
}

function googleAuth() {
  if (
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET &&
    process.env.GOOGLE_REFRESH_TOKEN
  ) {
    const oauth2 = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET
    );
    oauth2.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
    return oauth2;
  }

  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    return new google.auth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/drive.file"],
    });
  }

  return null;
}

const auth = googleAuth();
const drive = auth ? google.drive({ version: "v3", auth }) : null;

function escapeDriveQuery(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function ensureDriveFolder(name, parentId) {
  const safeName = String(name).trim() || "downloads";
  const q = [
    `name = '${escapeDriveQuery(safeName)}'`,
    "mimeType = 'application/vnd.google-apps.folder'",
    "trashed = false",
    `'${escapeDriveQuery(parentId)}' in parents`,
  ].join(" and ");

  const found = await drive.files.list({
    q,
    fields: "files(id,name)",
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  if (found.data.files?.length) return found.data.files[0].id;

  const created = await drive.files.create({
    requestBody: {
      name: safeName,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    },
    fields: "id",
    supportsAllDrives: true,
  });
  return created.data.id;
}

async function uploadFileToDrive(localFile, relativePath) {
  if (!drive || !GOOGLE_FOLDER_ID) {
    throw new Error("Google Drive credentials or GOOGLE_DRIVE_FOLDER_ID are missing");
  }

  const parts = relativePath.split(/[\\/]+/).filter(Boolean);
  const fileName = parts.pop() || path.basename(localFile);
  let parentId = GOOGLE_FOLDER_ID;

  for (const folder of parts) {
    parentId = await ensureDriveFolder(folder, parentId);
  }

  const result = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [parentId],
    },
    media: {
      body: fs.createReadStream(localFile),
    },
    fields: "id,name,webViewLink,size",
    supportsAllDrives: true,
  });

  return result.data;
}

function assertInsideDownloadDir(filePath) {
  const resolved = path.resolve(filePath);
  if (resolved !== DOWNLOAD_DIR && !resolved.startsWith(DOWNLOAD_DIR + path.sep)) {
    throw new Error("Refusing to access path outside ARIA2_DOWNLOAD_DIR");
  }
  return resolved;
}

async function removeEmptyParents(filePath) {
  let current = path.dirname(filePath);
  while (current !== DOWNLOAD_DIR && current.startsWith(DOWNLOAD_DIR + path.sep)) {
    try {
      await fsp.rmdir(current);
    } catch {
      break;
    }
    current = path.dirname(current);
  }
}

const jobs = new Map();

async function statusFor(gid) {
  return rpc("aria2.tellStatus", [
    gid,
    [
      "gid",
      "status",
      "totalLength",
      "completedLength",
      "downloadSpeed",
      "uploadSpeed",
      "errorCode",
      "errorMessage",
      "dir",
      "files",
      "bittorrent",
    ],
  ]);
}

async function uploadCompletedJob(gid) {
  const existing = jobs.get(gid) || {};
  if (existing.uploadStatus === "uploading" || existing.uploadStatus === "uploaded") return;

  const status = await statusFor(gid);
  if (status.status !== "complete") return;

  if (!drive || !GOOGLE_FOLDER_ID) {
    jobs.set(gid, {
      ...existing,
      uploadStatus: "waiting_for_google_drive",
      completedAt: existing.completedAt || new Date().toISOString(),
    });
    return;
  }

  jobs.set(gid, { ...existing, uploadStatus: "uploading", uploadError: null });

  try {
    const uploaded = [];
    const baseDir = assertInsideDownloadDir(status.dir || DOWNLOAD_DIR);

    for (const item of status.files || []) {
      if (!item.path) continue;
      const localFile = assertInsideDownloadDir(item.path);

      let stat;
      try {
        stat = await fsp.stat(localFile);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;

      let relative = path.relative(baseDir, localFile);
      if (!relative || relative.startsWith("..")) relative = path.basename(localFile);

      const result = await uploadFileToDrive(localFile, relative);
      uploaded.push({
        localPath: relative,
        driveFileId: result.id,
        name: result.name,
        webViewLink: result.webViewLink || null,
      });

      if (DELETE_AFTER_UPLOAD) {
        await fsp.unlink(localFile).catch(() => {});
        await removeEmptyParents(localFile);
      }
    }

    jobs.set(gid, {
      ...jobs.get(gid),
      uploadStatus: "uploaded",
      uploadedAt: new Date().toISOString(),
      uploaded,
    });

    await rpc("aria2.removeDownloadResult", [gid]).catch(() => {});
  } catch (err) {
    console.error(`Upload failed for ${gid}:`, err);
    jobs.set(gid, {
      ...jobs.get(gid),
      uploadStatus: "error",
      uploadError: err.message,
    });
  }
}

setInterval(async () => {
  for (const [gid] of jobs) {
    try {
      await uploadCompletedJob(gid);
    } catch (err) {
      console.error(`Job monitor error for ${gid}:`, err.message);
    }
  }
}, 5000).unref();

app.get("/health", async (_req, res) => {
  try {
    const version = await rpc("aria2.getVersion");
    res.json({
      ok: true,
      aria2: version.version,
      googleDriveConfigured: Boolean(drive && GOOGLE_FOLDER_ID),
      downloadDir: DOWNLOAD_DIR,
    });
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message });
  }
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(process.cwd(), "libraTorrrentdrive.html"));
});

app.get("/notebook", (_req, res) => {
  res.sendFile(path.join(process.cwd(), "libraTorrrentdrive.html"));
});

app.use("/api", requireApiKey);

app.get("/api/health", async (_req, res) => {
  const version = await rpc("aria2.getVersion");
  res.json({
    ok: true,
    aria2: version.version,
    googleDriveConfigured: Boolean(drive && GOOGLE_FOLDER_ID),
  });
});

app.post("/api/download", async (req, res) => {
  const url = String(req.body?.url || "").trim();
  if (!/^(https?:\/\/|magnet:\?)/i.test(url)) {
    return res.status(400).json({ error: "url must be an http(s) URL or magnet link" });
  }

  const options = {
    dir: DOWNLOAD_DIR,
    "seed-time": "0",
  };

  if (req.body?.fileName && /^https?:\/\//i.test(url)) {
    options.out = path.basename(String(req.body.fileName));
  }

  const gid = await rpc("aria2.addUri", [[url], options]);
  jobs.set(gid, {
    gid,
    source: url.startsWith("magnet:") ? "magnet" : "http",
    createdAt: new Date().toISOString(),
    uploadStatus: "pending",
  });

  res.status(202).json({ gid });
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

app.post("/api/torrent", upload.single("torrent"), async (req, res) => {
  if (!req.file?.buffer) {
    return res.status(400).json({ error: "Upload a .torrent file in multipart field 'torrent'" });
  }

  const torrentBase64 = req.file.buffer.toString("base64");
  const gid = await rpc("aria2.addTorrent", [
    torrentBase64,
    [],
    { dir: DOWNLOAD_DIR, "seed-time": "0" },
  ]);

  jobs.set(gid, {
    gid,
    source: "torrent",
    fileName: req.file.originalname,
    createdAt: new Date().toISOString(),
    uploadStatus: "pending",
  });

  res.status(202).json({ gid });
});

app.get("/api/downloads", async (_req, res) => {
  const keys = [
    "gid",
    "status",
    "totalLength",
    "completedLength",
    "downloadSpeed",
    "uploadSpeed",
    "errorCode",
    "errorMessage",
    "bittorrent",
    "files",
  ];

  const [active, waiting, stopped] = await Promise.all([
    rpc("aria2.tellActive", [keys]),
    rpc("aria2.tellWaiting", [0, 100, keys]),
    rpc("aria2.tellStopped", [0, 100, keys]),
  ]);

  const all = [...active, ...waiting, ...stopped].map((item) => ({
    ...item,
    app: jobs.get(item.gid) || null,
  }));

  res.json({ downloads: all });
});

app.get("/api/download/:gid", async (req, res) => {
  const status = await statusFor(req.params.gid);
  res.json({ ...status, app: jobs.get(req.params.gid) || null });
});

app.post("/api/download/:gid/pause", async (req, res) => {
  const gid = await rpc("aria2.pause", [req.params.gid]);
  res.json({ gid, status: "paused" });
});

app.post("/api/download/:gid/resume", async (req, res) => {
  const gid = await rpc("aria2.unpause", [req.params.gid]);
  res.json({ gid, status: "resumed" });
});

app.delete("/api/download/:gid", async (req, res) => {
  const gid = req.params.gid;
  let result;
  try {
    result = await rpc("aria2.remove", [gid]);
  } catch {
    result = await rpc("aria2.removeDownloadResult", [gid]);
  }
  jobs.delete(gid);
  res.json({ gid: result, removed: true });
});

app.post("/api/download/:gid/upload", async (req, res) => {
  const gid = req.params.gid;
  if (!jobs.has(gid)) {
    jobs.set(gid, {
      gid,
      createdAt: new Date().toISOString(),
      uploadStatus: "pending",
    });
  }
  await uploadCompletedJob(gid);
  res.json({ gid, app: jobs.get(gid) || null });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message || "Internal server error" });
});

await waitForAria2();

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`LibTor2Drive listening on 0.0.0.0:${PORT}`);
  console.log(`aria2 download directory: ${DOWNLOAD_DIR}`);
  console.log(`Google Drive configured: ${Boolean(drive && GOOGLE_FOLDER_ID)}`);
  if (!process.env.ARIA2_RPC_SECRET) {
    console.warn("ARIA2_RPC_SECRET was not set; generated an ephemeral secret for this process.");
  }
  if (!APP_API_KEY) {
    console.warn("APP_API_KEY is not set; /api is disabled until you configure it.");
  }
});

function shutdown() {
  server.close(() => {
    aria2Process.kill("SIGTERM");
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
