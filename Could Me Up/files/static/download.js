document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("downloadForm");
  const shareFile = document.getElementById("shareFile");
  const passwordInput = document.getElementById("password");
  const statusEl = document.getElementById("status");
  const fileLink = document.getElementById("fileLink");

  const customUrlInput = document.getElementById("custom_url");
  const customKeyInput = document.getElementById("custom_key");

  function log(msg) {
    statusEl.textContent += msg + "\n";
  }

  async function downloadFromCustom(objectId, baseUrl, apiKey) {
    const urlBase = (baseUrl || "").trim();
    const getUrl =
      (urlBase ? urlBase.replace(/\/$/, "") : "") +
      `/api/objects/${encodeURIComponent(objectId)}/get`;

    const res = await fetch(getUrl, {
      method: "GET",
      headers: {
        ...(apiKey ? { "X-API-Key": apiKey } : {}),
      },
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`Custom download failed (${res.status}) ${txt}`);
    }

    const buf = await res.arrayBuffer();
    return new Uint8Array(buf);
  }

  async function downloadFromGDrive(fileId) {
    const res = await fetch(
      `/api/gdrive/files/${encodeURIComponent(fileId)}/get`,
      { method: "GET" }
    );

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`GDrive download failed (${res.status}) ${txt}`);
    }

    const buf = await res.arrayBuffer();
    return new Uint8Array(buf);
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    statusEl.textContent = "";
    fileLink.style.display = "none";

    const f = shareFile.files?.[0];
    if (!f) {
      log("Please import share_package.json first.");
      return;
    }

    let pkg;
    try {
      pkg = JSON.parse(await f.text());
    } catch {
      log("Invalid JSON file.");
      return;
    }

    const manifest = pkg?.manifest;
    if (!manifest?.chunks?.length) {
      log("Invalid share package: missing manifest/chunks.");
      return;
    }

    const password = (passwordInput.value || "").trim();

    // Recover raw AES key (base64) from share package
    let rawKeyB64;
    if (pkg.key?.rawKeyB64) {
      rawKeyB64 = pkg.key.rawKeyB64; // demo mode (plaintext key)
      log("Share package contains plaintext key (demo mode).");
    } else {
      if (!password) {
        log("Password is required to unwrap the file key.");
        return;
      }
      try {
        rawKeyB64 = await ScottyCrypto.unwrapKeyWithPassword(pkg.key, password);
      } catch (err) {
        log("Wrong password (unable to unlock the file key).");
        log("Tip: use the same password you entered during upload.");
        return;
      }
    }

    const aesKey = await ScottyCrypto.importRawKeyFromB64(rawKeyB64);

    const fileId = manifest.fileId;
    const customUrl = (
      customUrlInput.value ||
      manifest.providers?.custom?.url ||
      ""
    ).trim();
    const customKey = (customKeyInput.value || "").trim();

    log(`Reconstructing: ${manifest.fileName}`);
    log(`Chunks: ${manifest.chunks.length}`);

    const outChunks = [];

    for (const ch of manifest.chunks) {
      const aadStr = `${fileId}:${ch.index}`;
      const iv = ScottyCrypto.b64ToU8(ch.ivB64);

      let cipherU8 = null;

      // 1) Try Google Drive first (if present)
      const gId = ch.objects?.gdrive?.id;
      if (gId) {
        try {
          log(`Downloading chunk ${ch.index + 1} from Google Drive...`);
          cipherU8 = await downloadFromGDrive(gId);
        } catch (e) {
          log(
            `Google Drive failed for chunk ${ch.index + 1}, falling back to Custom...`
          );
        }
      }

      // 2) Fallback to Custom provider
      if (!cipherU8) {
        const objId = ch.objects?.custom?.id;
        if (!objId) {
          throw new Error(
            "No provider IDs available for this chunk (missing gdrive + custom)."
          );
        }
        log(`Downloading chunk ${ch.index + 1} from Custom provider...`);
        cipherU8 = await downloadFromCustom(objId, customUrl, customKey);
      }

      const plainU8 = await ScottyCrypto.decryptChunk(aesKey, iv, cipherU8, aadStr);

      outChunks.push(plainU8);
      log(`Decrypted chunk ${ch.index + 1}/${manifest.chunks.length}`);
    }

    // Concatenate all decrypted chunks
    const totalLen = outChunks.reduce((sum, c) => sum + c.length, 0);
    const full = new Uint8Array(totalLen);
    let off = 0;
    for (const c of outChunks) {
      full.set(c, off);
      off += c.length;
    }

    const blob = new Blob([full], {
      type: manifest.mime || "application/octet-stream",
    });
    const url = URL.createObjectURL(blob);

    fileLink.href = url;
    fileLink.download = manifest.fileName || "file.bin";
    fileLink.textContent = `Download ${fileLink.download}`;
    fileLink.style.display = "inline-block";

    log("Done.");
  });
});
