/**
 * crypto.js
 * Client-side cryptographic helpers for:
 * - AES-GCM chunk encryption/decryption (WebCrypto)
 * - Password-based key wrapping (PBKDF2 -> AES-GCM) for share packages
 */

// Base64 helpers (Uint8Array <-> base64) 
function u8ToB64(u8) {
  let bin = "";
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return btoa(bin);
}

function b64ToU8(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

// Adaptive chunk sizing (simple MVP) 
function pickChunkSize(bytes) {
  const MB = 1024 * 1024;
  if (bytes < 100 * MB) return 4 * MB;
  if (bytes < 1024 * MB) return 8 * MB;
  return 16 * MB;
}

// AES-GCM file key 
async function generateFileKey() {
  return crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true, // extractable for demo/share package
    ["encrypt", "decrypt"]
  );
}

async function exportRawKeyB64(key) {
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key));
  return u8ToB64(raw);
}

async function importRawKeyFromB64(keyB64) {
  const raw = b64ToU8(keyB64);
  return crypto.subtle.importKey(
    "raw",
    raw,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
}

// AES-GCM chunk encryption/decryption 
// IMPORTANT: Never reuse the same IV with the same key. We generate a new 12-byte IV per chunk.
async function encryptChunk(aesKey, plainU8, aadStr) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = new TextEncoder().encode(aadStr);

  const ctBuf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad },
    aesKey,
    plainU8
  );

  // WebCrypto returns ciphertext with authentication tag appended internally.
  return { iv, cipherU8: new Uint8Array(ctBuf) };
}

async function decryptChunk(aesKey, ivU8, cipherU8, aadStr) {
  const aad = new TextEncoder().encode(aadStr);

  const ptBuf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: ivU8, additionalData: aad },
    aesKey,
    cipherU8
  );

  // If ciphertext/tag is modified, decrypt() throws.
  return new Uint8Array(ptBuf);
}

//Password-based key wrap (PBKDF2 -> AES-GCM)
async function deriveKek(password, saltU8, iterations = 200000) {
  const passKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: saltU8, iterations, hash: "SHA-256" },
    passKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function wrapKeyWithPassword(rawKeyB64, password) {
  const rawKeyU8 = b64ToU8(rawKeyB64);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const kek = await deriveKek(password, salt);

  const wrappedBuf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    kek,
    rawKeyU8
  );

  return {
    kdf: "PBKDF2-SHA256",
    iterations: 200000,
    saltB64: u8ToB64(salt),
    ivB64: u8ToB64(iv),
    wrappedKeyB64: u8ToB64(new Uint8Array(wrappedBuf)),
  };
}

async function unwrapKeyWithPassword(wrapObj, password) {
  const salt = b64ToU8(wrapObj.saltB64);
  const iv = b64ToU8(wrapObj.ivB64);
  const wrapped = b64ToU8(wrapObj.wrappedKeyB64);

  const kek = await deriveKek(password, salt, wrapObj.iterations || 200000);

  const rawBuf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    kek,
    wrapped
  );

  return u8ToB64(new Uint8Array(rawBuf));
}

// Expose a minimal API to window for Django static usage
window.ScottyCrypto = {
  u8ToB64,
  b64ToU8,
  pickChunkSize,
  generateFileKey,
  exportRawKeyB64,
  importRawKeyFromB64,
  encryptChunk,
  decryptChunk,
  wrapKeyWithPassword,
  unwrapKeyWithPassword,
};
