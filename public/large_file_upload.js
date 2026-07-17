const _largeFileUploadState = {};

function largeFileUploadEls(id) {
  return {
    fileInput: document.getElementById(id),
    valueInput: document.getElementById(id + "__value"),
    progressWrap: document.getElementById(id + "__progress"),
    progressBar: document
      .getElementById(id + "__progress")
      ?.querySelector(".progress-bar"),
    status: document.getElementById(id + "__status"),
    customText: document.getElementById(id + "-custom-text"),
  };
}

function resetLargeFileUpload(fileInputEl) {
  const id = fileInputEl.id;
  const els = largeFileUploadEls(id);
  fileInputEl.value = "";
  if (els.valueInput) els.valueInput.value = "";
  if (els.status) els.status.textContent = "";
  if (els.progressWrap) els.progressWrap.classList.add("d-none");
  if (els.progressBar) els.progressBar.style.width = "0%";
  if (els.customText) els.customText.textContent = "No file chosen";
  delete _largeFileUploadState[id];
}

function initLargeFileUpload(id, cfg) {
  const fileInput = document.getElementById(id);
  if (!fileInput) return;
  fileInput.addEventListener("change", function () {
    const file = fileInput.files && fileInput.files[0];
    if (file) startLargeFileUpload(id, cfg, file);
  });
}

function setLargeFileUploadStatus(id, msg) {
  const els = largeFileUploadEls(id);
  if (els.status) els.status.textContent = msg;
}

function setLargeFileUploadProgress(id, fraction) {
  const els = largeFileUploadEls(id);
  if (!els.progressWrap || !els.progressBar) return;
  els.progressWrap.classList.remove("d-none");
  const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
  els.progressBar.style.width = pct + "%";
}

function largeFileUploadXhr(method, url, body, onProgress) {
  return new Promise(function (resolve, reject) {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    xhr.setRequestHeader("CSRF-Token", window._sc_globalCsrf);
    if (body instanceof Blob) {
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
    } else if (body !== null && body !== undefined) {
      xhr.setRequestHeader("Content-Type", "application/json");
    }
    if (onProgress) xhr.upload.onprogress = onProgress;
    xhr.onload = function () {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(xhr.responseText ? JSON.parse(xhr.responseText) : {});
        } catch (e) {
          reject(new Error("Invalid server response"));
        }
      } else {
        let msg = "Upload failed (" + xhr.status + ")";
        try {
          const parsed = JSON.parse(xhr.responseText);
          if (parsed && parsed.error) msg = parsed.error;
        } catch (e) {
          // ignore, keep default msg
        }
        reject(new Error(msg));
      }
    };
    xhr.onerror = function () {
      reject(new Error("Network error"));
    };
    xhr.send(
      body instanceof Blob || body === null || body === undefined
        ? body
        : JSON.stringify(body)
    );
  });
}

async function startLargeFileUpload(id, cfg, file) {
  const els = largeFileUploadEls(id);
  const maxBytes = cfg.max_file_size_mb * 1024 * 1024;
  if (file.size > maxBytes) {
    notifyAlert({
      type: "danger",
      text:
        "File is too large. Maximum size is " + cfg.max_file_size_mb + " MB.",
    });
    resetLargeFileUpload(els.fileInput);
    return;
  }
  if (cfg.allowed_extensions) {
    const exts = cfg.allowed_extensions
      .split(",")
      .map(function (s) {
        return s.trim().toLowerCase();
      })
      .filter(Boolean);
    const fileExt = (file.name.split(".").pop() || "").toLowerCase();
    if (exts.length && exts.indexOf(fileExt) === -1) {
      notifyAlert({
        type: "danger",
        text: "File type not allowed. Allowed: " + exts.join(", "),
      });
      resetLargeFileUpload(els.fileInput);
      return;
    }
  }
  if (els.customText) els.customText.textContent = file.name;
  setLargeFileUploadStatus(id, "Starting upload…");
  try {
    const startResp = await largeFileUploadXhr("POST", cfg.startUrl, {
      filename: file.name,
      filesize: file.size,
      mimetype: file.type || "application/octet-stream",
      folder: cfg.folder,
      max_file_size_mb: cfg.max_file_size_mb,
      chunk_size_mb: cfg.chunk_size_mb,
      allowed_extensions: cfg.allowed_extensions,
      min_role_read: cfg.min_role_read,
    });
    const sessionId = startResp.sessionId;
    _largeFileUploadState[id] = { sessionId, file, cfg };
    await uploadLargeFileChunks(id, sessionId, file, cfg);
    setLargeFileUploadStatus(id, "Finishing…");
    const finishResp = await largeFileUploadXhr(
      "POST",
      cfg.finishUrlBase + "/" + sessionId,
      null
    );
    if (els.valueInput) els.valueInput.value = finishResp.location;
    setLargeFileUploadStatus(id, finishResp.filename || file.name);
    setLargeFileUploadProgress(id, 1);
    if (els.customText)
      els.customText.textContent = finishResp.filename || file.name;
    notifyAlert({ type: "success", text: "File uploaded", remove_delay: 3 });
  } catch (e) {
    notifyAlert({ type: "danger", text: "Upload failed: " + e.message });
    setLargeFileUploadStatus(id, "Upload failed");
  }
}

async function uploadLargeFileChunks(id, sessionId, file, cfg) {
  const chunkBytes = cfg.chunk_size_mb * 1024 * 1024;
  const totalChunks = Math.max(1, Math.ceil(file.size / chunkBytes));
  for (let index = 0; index < totalChunks; index++) {
    const start = index * chunkBytes;
    const end = Math.min(file.size, start + chunkBytes);
    const blob = file.slice(start, end);
    const sentBeforeThisChunk = start;
    let attempt = 0;
    for (;;) {
      try {
        await largeFileUploadXhr(
          "POST",
          cfg.chunkUrlBase + "/" + sessionId + "/" + index,
          blob,
          function (evt) {
            if (!evt.lengthComputable) return;
            setLargeFileUploadProgress(
              id,
              (sentBeforeThisChunk + evt.loaded) / file.size
            );
          }
        );
        setLargeFileUploadProgress(id, end / file.size);
        break;
      } catch (e) {
        attempt++;
        if (attempt > 5) throw e;
        setLargeFileUploadStatus(
          id,
          "Retrying chunk " + (index + 1) + "/" + totalChunks + "…"
        );
        await new Promise(function (r) {
          setTimeout(r, Math.min(1000 * attempt, 5000));
        });
      }
    }
  }
}
