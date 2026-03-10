document.addEventListener("DOMContentLoaded", () => {
  const fileInput = document.getElementById("file");
  const passwordInput = document.getElementById("password");
  const statusEl = document.getElementById("status");
  const shareLink = document.getElementById("shareLink");
  const form = document.getElementById("uploadForm");

  const customCb = document.getElementById("custom");
  const customUrlInput = document.getElementById("custom_url");
  const customKeyInput = document.getElementById("custom_key");

  const gdriveCb = document.getElementById("gdrive");
  const onedriveCb = document.getElementById("onedrive");

  function log(msg) {
    statusEl.textContent += msg + "\n";
  }

  async function uploadToCustom(objectId, bytesU8, baseUrl, apiKey) {
    const urlBase = (baseUrl || "").trim();
    const putUrl =
      (urlBase ? urlBase.replace(/\/$/, "") : "") +
      `/api/objects/${encodeURIComponent(objectId)}`;

    const res = await fetch(putUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
        ...(apiKey ? { "X-API-Key": apiKey } : {}),
      },
      body: bytesU8,
    });

    if (!res.ok) throw new Error(`Custom upload failed (${res.status})`);
    return objectId;
  }

  async function uploadToGDrive(objectId, bytesU8) {
    const res = await fetch(`/api/gdrive/objects/${encodeURIComponent(objectId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: bytesU8,
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`GDrive upload failed (${res.status}) ${txt}`);
    }
    return await res.json(); // { ok:true, driveFileId:"..." }
  }
  
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    statusEl.textContent = "";
    shareLink.style.display = "none";
    log("SUBMIT fired ");
    const file = fileInput.files?.[0];
    if (!file) {
      log("Please select a file first.");
      return;
    }

    const useCustom = customCb.checked;
    const useGdrive = gdriveCb.checked;
    const useOnedrive = onedriveCb.checked;

    log(`useCustom=${useCustom} useGdrive=${useGdrive} useOnedrive=${useOnedrive}`);

    if (!useCustom && !useGdrive && !useOnedrive) {
      log("Please select at least one provider.");
      return;
    }

    const password = (passwordInput.value || "").trim();
    if (!password) {
      log("No password provided: share package will store the key in plaintext (demo mode).");
    }

    const fileId = crypto.randomUUID();
    const chunkSize = ScottyCrypto.pickChunkSize(file.size);

    log(`File: ${file.name} (${file.size} bytes)`);
    log(`Chunk size: ${chunkSize} bytes`);
    log(`fileId: ${fileId}`);

    // Generate a per-file AES key (DEK)
    const aesKey = await ScottyCrypto.generateFileKey();
    const rawKeyB64 = await ScottyCrypto.exportRawKeyB64(aesKey);

    // Wrap the key using a password (PBKDF2 -> AES-GCM) for sharing
    const keyObj = password
      ? await ScottyCrypto.wrapKeyWithPassword(rawKeyB64, password)
      : { rawKeyB64 }; // demo fallback

    const manifest = {
      type: "scotty-manifest",
      version: 1,
      fileId,
      fileName: file.name,
      fileSize: file.size,
      mime: file.type || "application/octet-stream",
      chunkSize,
      crypto: { alg: "AES-GCM", keyLen: 256 },
      providers: {
        custom: useCustom ? { url: (customUrlInput.value || "").trim() } : null,
        gdrive: useGdrive ? {} : null,
        onedrive: useOnedrive ? {} : null,
      },
      chunks: [],
    };

    const totalChunks = Math.ceil(file.size / chunkSize);
    log(`Total chunks: ${totalChunks}`);

    const customUrl = (customUrlInput.value || "").trim();
    const customKey = (customKeyInput.value || "").trim();

     if ((useCustom ? 1 : 0) + (useGdrive ? 1 : 0) + (useOnedrive ? 1 : 0) < 2) {
     log("For resilience, select at least 2 providers (e.g., Custom + Google Drive).");
    }
    
    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize;
      const end = Math.min(file.size, start + chunkSize);

      const blob = file.slice(start, end);
      const plainBuf = await blob.arrayBuffer();
      const plainU8 = new Uint8Array(plainBuf);

      // AAD binds chunk to fileId + index (prevents swapping chunks silently)
      const aadStr = `${fileId}:${i}`;

      // Encrypt locally BEFORE upload
      const { iv, cipherU8 } = await ScottyCrypto.encryptChunk(aesKey, plainU8, aadStr);

      const objectId = `${fileId}/chunk_${String(i).padStart(6, "0")}.bin`;

      const chunkRec = {
        index: i,
        ivB64: ScottyCrypto.u8ToB64(iv),
        size: cipherU8.length,
        objects: {},
      };

      if (useCustom) {
        await uploadToCustom(objectId, cipherU8, customUrl, customKey);
        chunkRec.objects.custom = { id: objectId };
      }

      if (useGdrive) {
        log("Calling Google Drive upload (PUT /api/gdrive/objects/...)");
        try {
          const g = await uploadToGDrive(objectId, cipherU8);
          chunkRec.objects.gdrive = { id: g.driveFileId };
        } catch (err) {
            log(`Google Drive upload failed on chunk ${i + 1}.`);
            log(`Tip: click "Connect Google Drive" first and try again.`);
          throw err; // simplest MVP: stop the upload
        }
}

      if (useOnedrive) {
        // will connect OneDrive upload here
        chunkRec.objects.onedrive = { id: null };
      }

      manifest.chunks.push(chunkRec);
      log(`Uploaded chunk ${i + 1}/${totalChunks}`);
    }

    // Share package = manifest + wrapped key
    const sharePackage = {
      type: "cloudmeup-share",
      version: 1,
      manifest,
      key: keyObj,
    };

    const blobOut = new Blob([JSON.stringify(sharePackage, null, 2)], {
      type: "application/json",
    });

    const url = URL.createObjectURL(blobOut);
    shareLink.href = url;
    shareLink.style.display = "inline-block";

    log("Done. Download share_package.json and import it on /download/.");
  });

  
});

