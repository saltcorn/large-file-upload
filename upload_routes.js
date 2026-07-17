const path = require("path");
const fs = require("fs");
const fsp = fs.promises;
const crypto = require("crypto");
const File = require("@saltcorn/data/models/file");
const Field = require("@saltcorn/data/models/field");
const Table = require("@saltcorn/data/models/table");
const View = require("@saltcorn/data/models/view");
const db = require("@saltcorn/data/db");
const { getState } = require("@saltcorn/data/db/state");

const ABSOLUTE_MAX_FILE_MB = 20480; // hard ceiling regardless of field config
const MIN_CHUNK_MB = 1;
const MAX_CHUNK_MB = 64;
const TMP_DIRNAME = ".large-file-upload-tmp";
const SESSION_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const MAX_SESSIONS_PER_USER = 25;

// sessionId -> { userId, tenantSchema, folder, filename, declaredSize,
//                chunkSizeBytes, expectedChunkCount, receivedChunks: Set<number>,
//                tmpPath, minRoleRead, createdAt }
const sessions = new Map();

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

const tmpDirFor = () =>
  path.join(db.connectObj.file_store, db.getTenantSchema(), TMP_DIRNAME);

const removeSession = async (sessionId) => {
  const session = sessions.get(sessionId);
  if (!session) return;
  sessions.delete(sessionId);
  try {
    await fsp.unlink(session.tmpPath);
  } catch (e) {
    // already gone
  }
};

const getOwnedSession = (req) => {
  const session = sessions.get(req.params.sessionId);
  if (
    !session ||
    !req.user ||
    session.userId !== req.user.id ||
    session.tenantSchema !== db.getTenantSchema()
  )
    return null;
  return session;
};

const receivedBytesOf = (session) =>
  session.receivedChunks.size === session.expectedChunkCount
    ? session.declaredSize
    : session.receivedChunks.size * session.chunkSizeBytes;

const readRawBody = (req, maxBytes) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;
    let settled = false;
    const settle = (fn, arg) => {
      if (settled) return;
      settled = true;
      fn(arg);
    };
    req.on("data", (buf) => {
      received += buf.length;
      if (received > maxBytes) {
        settle(reject, new Error("Chunk too large"));
        req.destroy();
        return;
      }
      chunks.push(buf);
    });
    req.on("end", () => settle(resolve, Buffer.concat(chunks)));
    req.on("error", (err) => settle(reject, err));
    req.on("close", () =>
      settle(reject, new Error("Connection closed before chunk finished"))
    );
  });

const startUpload = async (req, res) => {
  if (!req.user || !req.user.id)
    return res.status(401).json({ error: "Not authorized" });
  const minRoleUpload = getState().getConfig("min_role_upload", 1);
  if (req.user.role_id > +minRoleUpload)
    return res.status(403).json({ error: "Not authorized to upload files" });

  // Cap how many uploads one user can have open at once, so a runaway
  // client can't pile up unlimited sessions and temp files.
  let openForUser = 0;
  for (const session of sessions.values())
    if (session.userId === req.user.id) openForUser++;
  if (openForUser >= MAX_SESSIONS_PER_USER)
    return res
      .status(429)
      .json({
        error: "Too many uploads in progress, finish or cancel one first",
      });

  if (getState().getConfig("storage_s3_enabled", false))
    return res
      .status(400)
      .json({ error: "Large file upload is not supported with S3 storage" });

  const body = req.body || {};

  // Look up the real field, so we can check the user actually has write
  // access to the table it belongs to.
  const fieldId = Number(body.field_id);
  if (!Number.isInteger(fieldId))
    return res.status(400).json({ error: "Missing field" });
  const field = await Field.findOne({ id: fieldId });
  const fieldTypeName =
    field && (typeof field.type === "string" ? field.type : field.type?.name);
  if (!field || fieldTypeName !== "File")
    return res.status(400).json({ error: "Invalid field" });
  const table = Table.findOne({ id: field.table_id });
  if (!table || req.user.role_id > table.min_role_write)
    return res.status(403).json({ error: "Not authorized for this field" });

  // Also look up the view that's actually using this field, so the real
  // configured limits apply instead of whatever the browser sends.
  const view = View.findOne({ name: String(body.view_name || "") });
  const column =
    view?.table_id === field.table_id &&
    (view.configuration?.columns || []).find(
      (c) =>
        c.type === "Field" &&
        c.field_name === field.name &&
        c.fieldview === "Large file upload"
    );
  const fieldPolicy = column?.configuration || {};

  const declaredSize = Number(body.filesize);
  if (!Number.isFinite(declaredSize) || declaredSize <= 0)
    return res.status(400).json({ error: "Invalid file size" });

  const maxFileMb = clamp(
    Number(fieldPolicy.max_file_size_mb) || ABSOLUTE_MAX_FILE_MB,
    1,
    ABSOLUTE_MAX_FILE_MB
  );
  if (declaredSize > maxFileMb * 1024 * 1024)
    return res
      .status(400)
      .json({ error: `File exceeds maximum size of ${maxFileMb} MB` });

  const chunkMb = clamp(
    Number(body.chunk_size_mb) || 8,
    MIN_CHUNK_MB,
    MAX_CHUNK_MB
  );
  const chunkSizeBytes = chunkMb * 1024 * 1024;

  const minRoleRead = clamp(
    Number(field.attributes?.min_role_read) || 1,
    1,
    100
  );

  const dirs = await File.allDirectories();
  const folder = dirs.some((d) => d.path_to_serve === fieldPolicy.folder)
    ? fieldPolicy.folder
    : "/";

  let filename = path
    .basename(String(body.filename || "").trim())
    .replace(/[^\w.\- ]+/g, "_");
  // A name made only of dots (".", "..") isn't a real filename, just a
  // path trick, so treat it the same as an empty one.
  if (!filename || /^\.+$/.test(filename)) filename = `upload-${Date.now()}`;

  const allowedExts = String(fieldPolicy.allowed_extensions || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (allowedExts.length) {
    const ext = filename.includes(".")
      ? filename.split(".").pop().toLowerCase()
      : "";
    if (!allowedExts.includes(ext))
      return res.status(400).json({ error: "File type not allowed" });
  }

  const sessionId = crypto.randomUUID();
  const tmpDir = tmpDirFor();
  await fsp.mkdir(tmpDir, { recursive: true });
  const tmpPath = path.join(tmpDir, sessionId);
  const fh = await fsp.open(tmpPath, "w");
  await fh.truncate(declaredSize);
  await fh.close();

  const expectedChunkCount = Math.max(
    1,
    Math.ceil(declaredSize / chunkSizeBytes)
  );

  sessions.set(sessionId, {
    userId: req.user.id,
    tenantSchema: db.getTenantSchema(),
    folder,
    filename,
    declaredSize,
    chunkSizeBytes,
    expectedChunkCount,
    receivedChunks: new Set(),
    tmpPath,
    minRoleRead,
    createdAt: Date.now(),
  });

  res.json({ sessionId, chunkSizeMb: chunkMb });
};

const uploadChunk = async (req, res) => {
  const session = getOwnedSession(req);
  if (!session)
    return res.status(404).json({ error: "Upload session not found" });

  const index = Number(req.params.index);
  if (
    !Number.isInteger(index) ||
    index < 0 ||
    index >= session.expectedChunkCount
  )
    return res.status(400).json({ error: "Invalid chunk index" });

  const offset = index * session.chunkSizeBytes;
  const expectedLen = Math.min(
    session.chunkSizeBytes,
    session.declaredSize - offset
  );

  let buf;
  try {
    buf = await readRawBody(req, expectedLen);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  if (buf.length !== expectedLen)
    return res.status(400).json({ error: "Incomplete chunk" });

  const fh = await fsp.open(session.tmpPath, "r+");
  try {
    await fh.write(buf, 0, buf.length, offset);
  } finally {
    await fh.close();
  }
  session.receivedChunks.add(index);
  res.json({ receivedBytes: receivedBytesOf(session) });
};

const finishUpload = async (req, res) => {
  const session = getOwnedSession(req);
  if (!session)
    return res.status(404).json({ error: "Upload session not found" });
  if (session.receivedChunks.size !== session.expectedChunkCount)
    return res.status(400).json({ error: "Upload incomplete" });

  const mimetype =
    File.nameToMimeType(session.filename) || "application/octet-stream";
  const [mime_super, mime_sub] = mimetype.split("/");

  const finalPath = File.get_new_path(
    path.join(session.folder, session.filename),
    true
  );

  // Keep the session until the file is safely stored, so a failure
  // doesn't leave an untracked, orphaned file behind.
  let moved = false;
  try {
    await fsp.mkdir(path.dirname(finalPath), { recursive: true });
    await fsp.rename(session.tmpPath, finalPath);
    moved = true;

    const file = await File.create({
      filename: session.filename,
      location: finalPath,
      uploaded_at: new Date(),
      size_kb: Math.round(session.declaredSize / 1024),
      user_id: req.user.id,
      mime_super,
      mime_sub,
      min_role_read: session.minRoleRead,
      s3_store: false,
    });

    sessions.delete(req.params.sessionId);

    res.json({
      location: file.field_value,
      filename: file.filename,
      url: File.pathToServeUrl(file.field_value, { filename: file.filename }),
    });
  } catch (e) {
    if (moved) {
      try {
        await fsp.unlink(finalPath);
      } catch (unlinkErr) {
        // already gone
      }
    }
    res.status(500).json({ error: "Could not finish upload" });
  }
};

const uploadStatus = async (req, res) => {
  const session = getOwnedSession(req);
  if (!session)
    return res.status(404).json({ error: "Upload session not found" });
  res.json({
    receivedBytes: receivedBytesOf(session),
    receivedChunks: Array.from(session.receivedChunks),
  });
};

const cancelUpload = async (req, res) => {
  const session = getOwnedSession(req);
  if (!session)
    return res.status(404).json({ error: "Upload session not found" });
  await removeSession(req.params.sessionId);
  res.json({ success: true });
};

let cleanupTimer = null;
const startCleanupSweep = () => {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [sessionId, session] of sessions)
      if (now - session.createdAt > SESSION_TTL_MS) removeSession(sessionId);
  }, 30 * 60 * 1000);
  if (cleanupTimer.unref) cleanupTimer.unref();
};

module.exports = {
  routes: [
    { url: "/large-file-upload/start", method: "post", callback: startUpload },
    {
      url: "/large-file-upload/chunk/:sessionId/:index",
      method: "post",
      callback: uploadChunk,
    },
    {
      url: "/large-file-upload/finish/:sessionId",
      method: "post",
      callback: finishUpload,
    },
    {
      url: "/large-file-upload/status/:sessionId",
      method: "get",
      callback: uploadStatus,
    },
    {
      url: "/large-file-upload/cancel/:sessionId",
      method: "post",
      callback: cancelUpload,
    },
  ],
  startCleanupSweep,
};
