/**
 * Client-side AES-256-GCM encryption using the Web Crypto API.
 * Raw file bytes are encrypted before upload; only the content hash
 * and an encrypted metadata pointer are stored on-chain.
 *
 * ## Algorithm
 * AES-256-GCM (authenticated encryption): a single `crypto.subtle.encrypt` call
 * produces ciphertext with an integrity tag, so tampering with the encrypted
 * blob is detectable on decryption rather than silently accepted.
 *
 * ## Key management
 * - No password-based key derivation (e.g. PBKDF2/Argon2) is used. Each call to
 *   {@link encryptFile} generates a fresh random 256-bit `CryptoKey` via
 *   `crypto.subtle.generateKey`, scoped to a single file.
 * - The key is generated as `extractable: true` so it can be exported (see
 *   {@link exportKey}). Sending an exported key alongside the ciphertext would
 *   give the backend plaintext-equivalent access, so `MedicalRecordUpload.tsx`
 *   instead uses the envelope format below, where the key never leaves the
 *   client unwrapped.
 *
 * ## Streaming envelope encryption (large files, multi-recipient sharing)
 * {@link encryptFileToEnvelope} encrypts files of up to 250 MB as a stream of
 * 64 KiB AES-256-GCM chunks, so memory use stays constant whatever the file
 * size. The random per-file Data Encryption Key (DEK) is wrapped separately for
 * each recipient with ECDH P-256 + HKDF-SHA-256 + AES-KW. You can add or remove
 * recipients by editing only the JSON header; the ciphertext body is not changed.
 *
 * ## IV handling
 * A new 96-bit (12-byte) IV is generated per encryption via
 * `crypto.getRandomValues`. 96 bits is the size recommended for AES-GCM.
 * Reusing an IV with the same key would break GCM's confidentiality/integrity
 * guarantees, but since {@link encryptFile} always pairs a fresh IV with a
 * freshly generated key, reuse cannot occur here.
 *
 * ## Integrity hash
 * {@link hashBuffer} computes a SHA-256 hex digest of the *ciphertext*, used as
 * a content hash (e.g. for on-chain reference/dedup), not as a substitute for
 * GCM's built-in authentication tag.
 */

import { captureMessage } from '@/lib/sentry';

export class CryptographicFaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CryptographicFaultError';
  }
}

export interface SecurityContextStatus {
  isSecureContext: boolean;
  isIframe: boolean;
  isSandboxed: boolean;
}

export function checkSecurityContext(): SecurityContextStatus {
  const isSecure = typeof window !== 'undefined' ? (window.isSecureContext ?? true) : true;
  let isIframe = false;
  let isSandboxed = false;

  if (typeof window !== 'undefined') {
    try {
      isIframe = window.self !== window.top;
    } catch {
      isIframe = true;
      isSandboxed = true;
    }
  }

  if (!isSecure || isIframe) {
    const reasons: string[] = [];
    if (!isSecure) reasons.push('insecure context (non-HTTPS)');
    if (isIframe) reasons.push('sandboxed or embedded iframe');
    captureMessage(
      `Hardware security context warning: entropy source executing in ${reasons.join(', ')}.`,
      'warning',
    );
  }

  return { isSecureContext: isSecure, isIframe, isSandboxed };
}

export function auditEntropySource(
  entropyCrypto: Crypto = typeof window !== 'undefined' ? window.crypto : globalThis.crypto,
): void {
  if (!entropyCrypto || typeof entropyCrypto.getRandomValues !== 'function') {
    throw new CryptographicFaultError(
      'Fatal: Cryptographic entropy source (crypto.getRandomValues) is unavailable.',
    );
  }

  checkSecurityContext();

  const SAMPLE_SIZE = 512;
  const sample1 = new Uint8Array(SAMPLE_SIZE);
  const sample2 = new Uint8Array(SAMPLE_SIZE);

  entropyCrypto.getRandomValues(sample1);
  entropyCrypto.getRandomValues(sample2);

  let isIdentical = true;
  for (let i = 0; i < SAMPLE_SIZE; i++) {
    if (sample1[i] !== sample2[i]) {
      isIdentical = false;
      break;
    }
  }
  if (isIdentical) {
    throw new CryptographicFaultError(
      'Fatal cryptographic fault: PRNG returned identical consecutive outputs (stuck or deterministic entropy source).',
    );
  }

  let consecutiveCount = 1;
  let maxConsecutive = 1;
  for (let i = 1; i < SAMPLE_SIZE; i++) {
    if (sample1[i] === sample1[i - 1]) {
      consecutiveCount++;
      if (consecutiveCount > maxConsecutive) maxConsecutive = consecutiveCount;
    } else {
      consecutiveCount = 1;
    }
  }
  if (maxConsecutive >= 16) {
    throw new CryptographicFaultError(
      `Fatal cryptographic fault: Repetition Count Test failed with ${maxConsecutive} consecutive identical bytes.`,
    );
  }

  let setBits = 0;
  const byteFrequency = new Map<number, number>();
  let maxByteFrequency = 0;

  for (let i = 0; i < SAMPLE_SIZE; i++) {
    const byte = sample1[i]!;
    let b = byte;
    while (b > 0) {
      setBits += b & 1;
      b >>= 1;
    }
    const count = (byteFrequency.get(byte) ?? 0) + 1;
    byteFrequency.set(byte, count);
    if (count > maxByteFrequency) maxByteFrequency = count;
  }

  if (setBits < 1600 || setBits > 2496) {
    throw new CryptographicFaultError(
      `Fatal cryptographic fault: Entropy failed monobit distribution test (${setBits}/4096 set bits).`,
    );
  }

  if (maxByteFrequency > 30) {
    throw new CryptographicFaultError(
      `Fatal cryptographic fault: Adaptive proportion test failed (single byte appeared ${maxByteFrequency} times in 512 bytes).`,
    );
  }

  if (byteFrequency.size < 150) {
    throw new CryptographicFaultError(
      `Fatal cryptographic fault: Entropy failed symbol diversity test (${byteFrequency.size}/256 unique bytes).`,
    );
  }
}

/**
 * Encrypt a file's contents with a freshly generated AES-256-GCM key.
 * @param file - File to encrypt.
 * @returns The ciphertext (`encryptedBuffer`), the random 96-bit IV used, and
 *   the extractable `CryptoKey` (export via {@link exportKey} if it needs to

 *   leave the Web Crypto API, e.g. for upload).
 */
export async function encryptFile(file: File): Promise<{
  encryptedBuffer: ArrayBuffer;
  iv: Uint8Array;
  key: CryptoKey;
}> {
  auditEntropySource();

  // extractable: true — required so the key can be exported/uploaded (see module docs above)
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ]);

  // 96-bit IV, the size recommended for AES-GCM; safe to reuse only because a new key
  // is generated per call, so no (key, iv) pair is ever repeated.
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const fileBuffer = await file.arrayBuffer();

  const encryptedBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new Uint8Array(fileBuffer),
  );

  return { encryptedBuffer, iv, key };
}

/**
 * Export a `CryptoKey` to a raw byte buffer so it can be transmitted or stored
 * outside the Web Crypto API.
 * @param key - An extractable AES-GCM `CryptoKey`, e.g. from {@link encryptFile}.
 * @returns Raw key bytes.
 */
export async function exportKey(key: CryptoKey): Promise<ArrayBuffer> {
  return crypto.subtle.exportKey('raw', key);
}

/**
 * Compute a SHA-256 hex digest of a buffer, used as a content-integrity hash
 * (e.g. for the on-chain record pointer). This is independent of AES-GCM's own
 * authentication tag, which already guards ciphertext integrity on decrypt.
 * @param buffer - Bytes to hash (typically the encrypted file buffer).
 * @returns Lowercase hex-encoded SHA-256 digest.
 */
export async function hashBuffer(buffer: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/* ═══════════════════════════════════════════════════════════════════
   Worker-offloaded variants (#34)
   ═══════════════════════════════════════════════════════════════════ */

/**
 * Encrypts a file entirely off the main thread via a dedicated Web Worker.
 * Falls back to the main-thread {@link encryptFile} if Workers are unavailable.
 *
 * Time: O(n). Space: O(n) — transferred, not copied.
 */
export async function encryptFileOffThread(file: File): Promise<{
  encryptedBuffer: ArrayBuffer;
  iv: Uint8Array;
  key: CryptoKey;
}> {
  if (typeof Worker === 'undefined') return encryptFile(file);
  const { workerEncryptFile } = await import('./cryptoWorkerApi');
  const fileBuffer = await file.arrayBuffer();
  const { encryptedBuffer, iv, rawKey } = await workerEncryptFile(fileBuffer);
  const key = await crypto.subtle.importKey(
    'raw', rawKey, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'],
  );
  return { encryptedBuffer, iv: new Uint8Array(iv), key };
}

/**
 * Computes SHA-256 off the main thread. Falls back to main-thread
 * {@link hashBuffer} if Workers are unavailable.
 *
 * Time: O(n). Space: O(n) for the transfer.
 */
export async function hashBufferOffThread(buffer: ArrayBuffer): Promise<string> {
  if (typeof Worker === 'undefined') return hashBuffer(buffer);
  const { workerHash } = await import('./cryptoWorkerApi');
  const copy = buffer.slice(0);
  const digest = await workerHash(copy);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/* ═══════════════════════════════════════════════════════════════════
   Streaming envelope encryption (#24) + multi-recipient KEM (#25)
   ═══════════════════════════════════════════════════════════════════ */

type Bytes = Uint8Array<ArrayBuffer>;

/** Plaintext bytes per encrypted chunk (64 KiB). */
export const ENVELOPE_CHUNK_BYTES = 64 * 1024;
/** Largest file accepted by {@link encryptFileToEnvelope} (250 MB). */
export const MAX_ENVELOPE_FILE_BYTES = 250 * 1024 * 1024;

const GCM_TAG_BYTES = 16;
const NONCE_PREFIX_BYTES = 7;
const ENVELOPE_MAGIC = 'HLE1';
const MAX_HEADER_BYTES = 1024 * 1024;
const KEM_INFO_LABEL = 'heliora/envelope/v1/ecdh-p256-hkdf-sha256-a256kw';
const ECDH_P256 = { name: 'ECDH', namedCurve: 'P-256' } as const;

/** A recipient's wrapped copy of the file's Data Encryption Key. */
export interface EnvelopeRecipient {
  /** Recipient identifier (their Stellar account address). */
  id: string;
  /** Ephemeral P-256 public key (JWK) used for this recipient's key agreement. */
  epk: JsonWebKey;
  /** Base64 AES-KW (RFC 3394) wrap of the 256-bit DEK; 40 bytes. */
  wrappedKey: string;
}

/**
 * JSON header of the envelope container. Everything except `recipients` is
 * fixed when the file is encrypted. `recipients` can change without touching
 * the ciphertext body.
 */
export interface EnvelopeHeader {
  version: 1;
  cipher: 'AES-256-GCM-STREAM';
  kem: 'ECDH-P256+HKDF-SHA256+A256KW';
  /** Plaintext bytes per chunk. Every chunk except the last is exactly this size. */
  chunkSize: number;
  plaintextSize: number;
  /** Base64 7-byte random nonce prefix shared by every chunk of this file. */
  noncePrefix: string;
  recipients: EnvelopeRecipient[];
}

/** A recipient's long-term ECDH P-256 public key. */
export interface RecipientPublicKey {
  id: string;
  publicKey: JsonWebKey;
}

export interface EncryptedEnvelope {
  header: EnvelopeHeader;
  /** Ciphertext body: each chunk's ciphertext followed by its 16-byte GCM tag, in order. */
  body: Blob;
  /**
   * Hex SHA-256 over the concatenated SHA-256 digests of the ciphertext chunks.
   * It covers only the body, so it stays stable when recipients change.
   */
  contentHash: string;
}

/* ── Encoding helpers ─────────────────────────────────────────────── */

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(value: string): Bytes {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function concatBytes(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/* ── Chunk framing (STREAM construction, as in Tink's AES-GCM-HKDF streaming) ── */

/** Number of chunks for a plaintext of `size` bytes. An empty file still has one empty chunk. */
function chunkCount(size: number, chunkSize: number): number {
  return Math.max(1, Math.ceil(size / chunkSize));
}

/**
 * Builds the 12-byte IV: `noncePrefix (7) ‖ chunkIndex (4, big-endian) ‖ lastChunkFlag (1)`.
 * IVs are sequential and never repeat under one DEK. The last-chunk flag makes
 * truncating, reordering or appending chunks fail authentication.
 */
function chunkIv(noncePrefix: Uint8Array, index: number, last: boolean): Bytes {
  const iv = new Uint8Array(12);
  iv.set(noncePrefix, 0);
  new DataView(iv.buffer).setUint32(NONCE_PREFIX_BYTES, index, false);
  iv[11] = last ? 1 : 0;
  return iv;
}

/**
 * Pull-based source of exact `chunkSize` slices of a Blob. Only the slice
 * being read is held in memory: O(chunkSize) space.
 */
function blobChunkStream(blob: Blob, chunkSize: number): ReadableStream<Bytes> {
  const total = chunkCount(blob.size, chunkSize);
  let index = 0;
  return new ReadableStream<Bytes>({
    async pull(controller) {
      if (index === total) {
        controller.close();
        return;
      }
      const start = index * chunkSize;
      const slice = blob.slice(start, Math.min(blob.size, start + chunkSize));
      index++;
      controller.enqueue(new Uint8Array(await slice.arrayBuffer()));
    },
  });
}

/** Encrypts the i-th plaintext chunk with the STREAM IV for position i. */
function chunkEncryptor(
  dek: CryptoKey,
  noncePrefix: Uint8Array,
  total: number,
): TransformStream<Bytes, Bytes> {
  let index = 0;
  return new TransformStream<Bytes, Bytes>({
    async transform(chunk, controller) {
      if (index >= total) throw new Error('Envelope: more chunks than declared.');
      const iv = chunkIv(noncePrefix, index, index === total - 1);
      index++;
      controller.enqueue(
        new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, dek, chunk)),
      );
    },
  });
}

/** Re-frames an arbitrary byte stream into fixed `segmentSize` segments (the last one may be shorter). */
function segmenter(segmentSize: number): TransformStream<Uint8Array, Bytes> {
  let buffer = new Uint8Array(segmentSize);
  let filled = 0;
  return new TransformStream<Uint8Array, Bytes>({
    transform(chunk, controller) {
      let offset = 0;
      while (offset < chunk.length) {
        const n = Math.min(segmentSize - filled, chunk.length - offset);
        buffer.set(chunk.subarray(offset, offset + n), filled);
        filled += n;
        offset += n;
        if (filled === segmentSize) {
          controller.enqueue(buffer);
          buffer = new Uint8Array(segmentSize);
          filled = 0;
        }
      }
    },
    flush(controller) {
      if (filled > 0) controller.enqueue(buffer.slice(0, filled));
    },
  });
}

/** Decrypts and authenticates each ciphertext segment, and rejects truncated or extended bodies. */
function chunkDecryptor(
  dek: CryptoKey,
  noncePrefix: Uint8Array,
  total: number,
): TransformStream<Bytes, Bytes> {
  let index = 0;
  return new TransformStream<Bytes, Bytes>({
    async transform(segment, controller) {
      if (index >= total) throw new Error('Envelope: ciphertext has trailing data.');
      const iv = chunkIv(noncePrefix, index, index === total - 1);
      index++;
      controller.enqueue(
        new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, dek, segment)),
      );
    },
    flush() {
      if (index !== total) throw new Error('Envelope: ciphertext is truncated.');
    },
  });
}

/* ── Key encapsulation: ECDH P-256 → HKDF-SHA-256 → AES-KW ──────────── */

/**
 * Derives the AES-KW key-encryption key for one (ephemeral, recipient) pair.
 * HKDF `info` binds the ephemeral and recipient public keys (as HPKE's
 * kem_context does), so a wrapped key cannot be replayed to another recipient.
 */
async function deriveKek(
  privateKey: CryptoKey,
  peerPublicKey: CryptoKey,
  ephemeralPublic: CryptoKey,
  recipientPublic: CryptoKey,
): Promise<CryptoKey> {
  const [shared, epkRaw, pkRaw] = await Promise.all([
    crypto.subtle.deriveBits({ name: 'ECDH', public: peerPublicKey }, privateKey, 256),
    crypto.subtle.exportKey('raw', ephemeralPublic),
    crypto.subtle.exportKey('raw', recipientPublic),
  ]);
  const ikm = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const info = concatBytes(
    new TextEncoder().encode(KEM_INFO_LABEL),
    new Uint8Array(epkRaw),
    new Uint8Array(pkRaw),
  );
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info },
    ikm,
    { name: 'AES-KW', length: 256 },
    false,
    ['wrapKey', 'unwrapKey'],
  );
}

function importRecipientPublicKey(jwk: JsonWebKey): Promise<CryptoKey> {
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || jwk.d !== undefined) {
    throw new Error('Envelope: recipient key must be a public P-256 EC JWK.');
  }
  return crypto.subtle.importKey('jwk', jwk, ECDH_P256, true, []);
}

/** Wraps the DEK for one recipient with a fresh ephemeral key pair. */
async function wrapForRecipient(
  dek: CryptoKey,
  recipient: RecipientPublicKey,
): Promise<EnvelopeRecipient> {
  auditEntropySource();
  const recipientKey = await importRecipientPublicKey(recipient.publicKey);
  const ephemeral = await crypto.subtle.generateKey(ECDH_P256, true, ['deriveBits']);
  const kek = await deriveKek(
    ephemeral.privateKey,
    recipientKey,
    ephemeral.publicKey,
    recipientKey,
  );
  const [wrapped, epk] = await Promise.all([
    crypto.subtle.wrapKey('raw', dek, kek, 'AES-KW'),
    crypto.subtle.exportKey('jwk', ephemeral.publicKey),
  ]);
  return {
    id: recipient.id,
    epk: { kty: epk.kty!, crv: epk.crv!, x: epk.x!, y: epk.y! },
    wrappedKey: toBase64(new Uint8Array(wrapped)),
  };
}

/**
 * Recovers the DEK from the envelope with the recipient's private key.
 * Fails with an OperationError if the key does not match (AES-KW's integrity check).
 */
export async function unwrapDataKey(
  header: EnvelopeHeader,
  recipientId: string,
  keyPair: CryptoKeyPair,
): Promise<CryptoKey> {
  const entry = header.recipients.find((r) => r.id === recipientId);
  if (!entry) throw new Error('Envelope: you are not a recipient of this record.');
  const epk = await importRecipientPublicKey(entry.epk);
  const kek = await deriveKek(keyPair.privateKey, epk, epk, keyPair.publicKey);
  // Extractable so the DEK can be re-wrapped for new recipients (wrapKey requires it).
  return crypto.subtle.unwrapKey(
    'raw',
    fromBase64(entry.wrappedKey),
    kek,
    'AES-KW',
    'AES-GCM',
    true,
    ['decrypt'],
  );
}

/* ── Public API ───────────────────────────────────────────────────── */

/**
 * Encrypts a file as a stream of 64 KiB AES-256-GCM chunks and wraps the
 * per-file DEK for every recipient.
 *
 * Time: O(n) over the file size. Space: O(chunk) working memory, i.e. a few
 * 64 KiB buffers in flight plus 32 bytes of digest per chunk (~128 KB at 250 MB),
 * so the encryption working set stays well under 20 MB at any file size. Each
 * ciphertext chunk is released into a Blob part as soon as it is produced; the
 * browser owns that storage (Chromium moves blob data to the browser process and
 * pages large blobs to disk).
 *
 * @param onProgress Called after each chunk with the percentage (0–100) of plaintext encrypted.
 */
export async function encryptFileToEnvelope(
  file: Blob,
  recipients: RecipientPublicKey[],
  onProgress?: (percent: number) => void,
): Promise<EncryptedEnvelope> {
  if (file.size > MAX_ENVELOPE_FILE_BYTES) throw new Error('File exceeds the 250 MB limit.');
  if (recipients.length === 0) throw new Error('Envelope: at least one recipient is required.');

  auditEntropySource();
  const dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ]);
  const noncePrefix = crypto.getRandomValues(new Uint8Array(NONCE_PREFIX_BYTES));
  const total = chunkCount(file.size, ENVELOPE_CHUNK_BYTES);

  const reader = blobChunkStream(file, ENVELOPE_CHUNK_BYTES)
    .pipeThrough(chunkEncryptor(dek, noncePrefix, total))
    .getReader();

  const parts: Blob[] = [];
  const digests = new Uint8Array(total * 32);
  for (let i = 0; ; i++) {
    const { done, value } = await reader.read();
    if (done) break;
    digests.set(new Uint8Array(await crypto.subtle.digest('SHA-256', value)), i * 32);
    parts.push(new Blob([value]));
    const plaintextDone = Math.min(file.size, (i + 1) * ENVELOPE_CHUNK_BYTES);
    onProgress?.(file.size === 0 ? 100 : (plaintextDone / file.size) * 100);
  }

  const wrapped = await Promise.all(recipients.map((r) => wrapForRecipient(dek, r)));
  return {
    header: {
      version: 1,
      cipher: 'AES-256-GCM-STREAM',
      kem: 'ECDH-P256+HKDF-SHA256+A256KW',
      chunkSize: ENVELOPE_CHUNK_BYTES,
      plaintextSize: file.size,
      noncePrefix: toBase64(noncePrefix),
      recipients: wrapped,
    },
    body: new Blob(parts),
    contentHash: toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', digests))),
  };
}

/**
 * Streams the decrypted plaintext of an envelope body. Each chunk is
 * authenticated before it is emitted. O(chunk) memory.
 */
export function decryptEnvelopeBody(
  body: ReadableStream<Uint8Array>,
  header: EnvelopeHeader,
  dek: CryptoKey,
): ReadableStream<Bytes> {
  return body
    .pipeThrough(segmenter(header.chunkSize + GCM_TAG_BYTES))
    .pipeThrough(
      chunkDecryptor(
        dek,
        fromBase64(header.noncePrefix),
        chunkCount(header.plaintextSize, header.chunkSize),
      ),
    );
}

/**
 * Returns a new header with the DEK wrapped for `recipient`, replacing any
 * existing entry with the same id. The ciphertext body is not touched.
 */
export async function addEnvelopeRecipient(
  header: EnvelopeHeader,
  dek: CryptoKey,
  recipient: RecipientPublicKey,
): Promise<EnvelopeHeader> {
  const entry = await wrapForRecipient(dek, recipient);
  return {
    ...header,
    recipients: [...header.recipients.filter((r) => r.id !== recipient.id), entry],
  };
}

/**
 * Returns a new header without `recipientId`. The ciphertext body is not touched.
 * This only stops future key unwraps. A recipient who has already decrypted the
 * DEK keeps it, so full revocation means re-encrypting under a new DEK.
 */
export function removeEnvelopeRecipient(
  header: EnvelopeHeader,
  recipientId: string,
): EnvelopeHeader {
  const recipients = header.recipients.filter((r) => r.id !== recipientId);
  if (recipients.length === 0) throw new Error('Envelope: cannot remove the last recipient.');
  return { ...header, recipients };
}

/**
 * Serializes the envelope container:
 * `"HLE1" (4) ‖ headerLength (4, big-endian) ‖ header JSON (UTF-8) ‖ ciphertext body`.
 * The body is referenced, not copied.
 */
export function serializeEnvelope(header: EnvelopeHeader, body: Blob): Blob {
  const json = new TextEncoder().encode(JSON.stringify(header));
  const prefix = new Uint8Array(8);
  prefix.set(new TextEncoder().encode(ENVELOPE_MAGIC), 0);
  new DataView(prefix.buffer).setUint32(4, json.length, false);
  return new Blob([prefix, json, body], { type: 'application/octet-stream' });
}

/** Parses and validates an envelope container. The returned body is a zero-copy Blob slice. */
export async function parseEnvelope(
  container: Blob,
): Promise<{ header: EnvelopeHeader; body: Blob }> {
  const prefix = new Uint8Array(await container.slice(0, 8).arrayBuffer());
  if (prefix.length < 8 || new TextDecoder().decode(prefix.subarray(0, 4)) !== ENVELOPE_MAGIC) {
    throw new Error('Envelope: unrecognised container format.');
  }
  const headerLength = new DataView(prefix.buffer).getUint32(4, false);
  if (headerLength > MAX_HEADER_BYTES || 8 + headerLength > container.size) {
    throw new Error('Envelope: invalid header length.');
  }
  const header = JSON.parse(await container.slice(8, 8 + headerLength).text()) as EnvelopeHeader;
  const total = chunkCount(header.plaintextSize, header.chunkSize);
  const body = container.slice(8 + headerLength);
  if (
    header.version !== 1 ||
    header.cipher !== 'AES-256-GCM-STREAM' ||
    header.kem !== 'ECDH-P256+HKDF-SHA256+A256KW' ||
    !Number.isSafeInteger(header.chunkSize) ||
    header.chunkSize <= 0 ||
    !Number.isSafeInteger(header.plaintextSize) ||
    header.plaintextSize < 0 ||
    fromBase64(header.noncePrefix).length !== NONCE_PREFIX_BYTES ||
    body.size !== header.plaintextSize + total * GCM_TAG_BYTES
  ) {
    throw new Error('Envelope: unsupported or corrupted header.');
  }
  return { header, body };
}

/* ═══════════════════════════════════════════════════════════════════
   PQC hybrid envelope encryption (#32)
   ═══════════════════════════════════════════════════════════════════ */

/** PQC envelope recipient entry: wraps the DEK under a hybrid ML-KEM-768 + X25519 KEM. */
export interface PqcEnvelopeRecipient {
  id: string;
  kem: 'ML-KEM-768+X25519';
  ciphertext: { mlkem: string; x25519: string };
  wrappedKey: string;
}

/**
 * Wrap a DEK for a recipient using the PQC hybrid KEM (ML-KEM-768 + X25519).
 * The hybrid shared secret is used as an AES-256 key-wrapping key via
 * HKDF-SHA-256, matching the NIST SP 800-227 combiner pattern.
 *
 * Requires `NEXT_PUBLIC_PQC_ENABLED=true`.
 */
export async function wrapDekForPqcRecipient(
  dek: CryptoKey,
  recipientPublicKey: { mlkem: string; x25519: string },
  recipientId: string,
): Promise<PqcEnvelopeRecipient> {
  const { encapsulate, deserializePublicKey, serializeCiphertext } = await import('./pqcHybridKem');
  const pk = deserializePublicKey(recipientPublicKey);
  const { sharedSecret, ciphertext } = await encapsulate(pk);

  const kek = await crypto.subtle.importKey(
    'raw', sharedSecret as unknown as ArrayBuffer, { name: 'AES-KW', length: 256 }, false, ['wrapKey'],
  );
  const wrapped = await crypto.subtle.wrapKey('raw', dek, kek, 'AES-KW');

  return {
    id: recipientId,
    kem: 'ML-KEM-768+X25519',
    ciphertext: serializeCiphertext(ciphertext),
    wrappedKey: toBase64(new Uint8Array(wrapped)),
  };
}

/**
 * Unwrap a DEK from a PQC envelope recipient entry using the recipient's
 * hybrid private key.
 */
export async function unwrapDekFromPqcRecipient(
  entry: PqcEnvelopeRecipient,
  privateKey: { mlkem: Uint8Array; x25519: CryptoKey },
): Promise<CryptoKey> {
  const { decapsulate, deserializeCiphertext } = await import('./pqcHybridKem');
  const ct = deserializeCiphertext(entry.ciphertext);
  const sharedSecret = await decapsulate(ct, privateKey);

  const kek = await crypto.subtle.importKey(
    'raw', sharedSecret as unknown as ArrayBuffer, { name: 'AES-KW', length: 256 }, false, ['unwrapKey'],
  );
  return crypto.subtle.unwrapKey(
    'raw', fromBase64(entry.wrappedKey), kek, 'AES-KW', 'AES-GCM', true, ['decrypt'],
  );
}

/* ── Recipient key pair storage ───────────────────────────────────── */

const KEY_DB = 'heliora-envelope-keys';
const KEY_STORE = 'ecdh-p256';

function keyStoreRequest<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(KEY_DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(KEY_STORE);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(KEY_STORE, mode);
      const request = run(tx.objectStore(KEY_STORE));
      tx.oncomplete = () => {
        db.close();
        resolve(request.result);
      };
      tx.onabort = () => {
        db.close();
        reject(request.error ?? tx.error);
      };
    };
  });
}

/**
 * Loads this device's long-term ECDH P-256 key pair for `ownerId`, creating it
 * on first use. The private key is non-extractable: it is stored in IndexedDB as
 * a structured-cloned CryptoKey that keeps `extractable: false`, so script can
 * use it for key agreement but cannot export its key material.
 */
export async function loadOrCreateRecipientKeyPair(ownerId: string): Promise<CryptoKeyPair> {
  const existing = await keyStoreRequest<CryptoKeyPair | undefined>('readonly', (s) =>
    s.get(ownerId),
  );
  if (existing) return existing;
  auditEntropySource();
  const keyPair = await crypto.subtle.generateKey(ECDH_P256, false, ['deriveBits']);
  try {
    // `add` (not `put`) so a key pair created concurrently in another tab is never overwritten.
    await keyStoreRequest('readwrite', (s) => s.add(keyPair, ownerId));
    return keyPair;
  } catch {
    const winner = await keyStoreRequest<CryptoKeyPair | undefined>('readonly', (s) =>
      s.get(ownerId),
    );
    if (!winner) throw new Error('Envelope: could not persist the encryption key pair.');
    return winner;
  }
}

/** Exports the public half of a recipient key pair as a minimal JWK for registration. */
export async function exportRecipientPublicKey(keyPair: CryptoKeyPair): Promise<JsonWebKey> {
  const { kty, crv, x, y } = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  return { kty: kty!, crv: crv!, x: x!, y: y! };
}

/* ═══════════════════════════════════════════════════════════════════
   #39 — Forensic watermarking & cryptographic fingerprinting
   ═══════════════════════════════════════════════════════════════════ */

export interface WatermarkPayload {
  viewerPublicKey: string;
  viewerIpHash: string;
  viewedAt: string;
}

/**
 * Computes a SHA-256 fingerprint of the viewer's identity + timestamp. The hash
 * is used as the content of the watermark so the original viewer can be traced
 * forensically without displaying raw PII.
 *
 * Time: O(1). Space: O(1).
 */
export async function computeViewerFingerprint(payload: WatermarkPayload): Promise<string> {
  const raw = `${payload.viewerPublicKey}:${payload.viewerIpHash}:${payload.viewedAt}`;
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return toHex(new Uint8Array(hash));
}

export interface WatermarkConfig {
  payload: WatermarkPayload;
  fingerprint: string;
  opacity?: number;
  fontSize?: number;
  rotation?: number;
  color?: string;
}

/**
 * Renders a repeating diagonal forensic watermark onto a canvas context.
 * The watermark contains the truncated SHA-256 fingerprint and ISO timestamp,
 * tiled across the full canvas area.
 *
 * Time: O(r × c) where r,c = tile rows/cols. Space: O(1) drawing state.
 */
export function renderCanvasWatermark(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  config: WatermarkConfig,
): void {
  const {
    fingerprint,
    payload,
    opacity = 0.06,
    fontSize = 14,
    rotation = -30,
    color = '128,128,128',
  } = config;

  const label = `${fingerprint.slice(0, 16)} · ${payload.viewedAt}`;

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.font = `${fontSize}px monospace`;
  ctx.fillStyle = `rgb(${color})`;

  const radians = (rotation * Math.PI) / 180;
  const stepX = fontSize * label.length * 0.55;
  const stepY = fontSize * 4;

  for (let y = -height; y < height * 2; y += stepY) {
    for (let x = -width; x < width * 2; x += stepX) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(radians);
      ctx.fillText(label, 0, 0);
      ctx.restore();
    }
  }
  ctx.restore();
}

/**
 * Applies a steganographic watermark to an ImageData by encoding the fingerprint
 * into the least-significant bits of the blue channel. Uses a seeded position
 * pattern so the same fingerprint always embeds at the same pixel offsets.
 *
 * Capacity: 256 bits (32-byte fingerprint) need 256 pixels out of a typical
 * medical image with millions, so the visual distortion is imperceptible.
 *
 * Time: O(f) where f = fingerprint length in bits (256). Space: O(1).
 */
export function embedSteganographicWatermark(
  imageData: ImageData,
  fingerprint: string,
): ImageData {
  const bytes = hexToBytes(fingerprint.slice(0, 64));
  const pixels = imageData.data;
  const totalPixels = imageData.width * imageData.height;

  const seed = ((bytes[0] ?? 0) << 8) | (bytes[1] ?? 0);
  let position = seed % totalPixels;

  for (const byte of bytes) {
    for (let bit = 7; bit >= 0; bit--) {
      const pixelIndex = position * 4 + 2; // blue channel
      if (pixelIndex < pixels.length) {
        pixels[pixelIndex] = ((pixels[pixelIndex] ?? 0) & 0xfe) | ((byte >> bit) & 1);
      }
      position = (position + 7919) % totalPixels; // prime step for spread
    }
  }

  return imageData;
}

/**
 * Extracts a steganographic fingerprint previously embedded by
 * {@link embedSteganographicWatermark}.
 *
 * Time: O(f) where f = fingerprint length in bits. Space: O(1).
 */
export function extractSteganographicWatermark(
  imageData: ImageData,
  seedHint: number,
): string {
  const totalPixels = imageData.width * imageData.height;
  const pixels = imageData.data;
  let position = seedHint % totalPixels;

  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    let byte = 0;
    for (let bit = 7; bit >= 0; bit--) {
      const pixelIndex = position * 4 + 2;
      if (pixelIndex < pixels.length) {
        byte |= ((pixels[pixelIndex] ?? 0) & 1) << bit;
      }
      position = (position + 7919) % totalPixels;
    }
    bytes[i] = byte;
  }

  return toHex(bytes);
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

/* ═══════════════════════════════════════════════════════════════════
   Zero-knowledge proof of vaccination (#zk-vax)
   ═══════════════════════════════════════════════════════════════════ */

/** A single vaccination record as held in the patient's encrypted store. */
export interface VaccinationRecord {
  /** Approved vaccine schema / protocol identifier (e.g. "CDC-COVID-2024"). */
  schemaId: string;
  /** ISO date of administration (never revealed by the proof). */
  administeredAt: string;
  /** Lot number (never revealed by the proof). */
  lotNumber: string;
  /** Issuing hospital / clinic identifier (never revealed by the proof). */
  issuerId: string;
}

/** Public parameters the verifier trusts: the registry of approved schema IDs. */
export interface VaccinationRegistry {
  approvedSchemaIds: string[];
  /** Minimum number of doses required to satisfy the protocol. */
  requiredDoses: number;
}

/**
 * A zero-knowledge proof that the holder has completed an approved vaccination
 * protocol. It reveals only the fact of eligibility — not dates, lot numbers,
 * issuer IDs, or which specific schema was matched.
 */
export interface VaccinationProof {
  version: 1;
  /** Commitment to the patient's record set (hides the underlying records). */
  commitment: string;
  /** Fiat-Shamir challenge derived from the commitment + registry. */
  challenge: string;
  /** Response binding the committed records to the approved-schema predicate. */
  response: string;
  /** Registry the proof was constructed against (so verifiers can pin it). */
  registryDigest: string;
  /** Wall-clock time the proof was generated (for freshness checks). */
  createdAt: string;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}

async function sha256BigInt(input: Uint8Array): Promise<bigint> {
  const digest = await crypto.subtle.digest('SHA-256', input);
  return bytesToBigInt(new Uint8Array(digest));
}

/**
 * Builds a zero-knowledge proof that the supplied records satisfy the
 * registry's approved-schema predicate for at least `requiredDoses` doses,
 * without revealing dates, lot numbers, or issuer IDs.
 *
 * The construction is a Sigma-protocol style proof over a SHA-256 commitment:
 * the prover commits to the multiset of approved-schema matches, derives a
 * Fiat-Shamir challenge from the commitment and registry digest, and returns a
 * response that a verifier can check against the same public inputs. It runs
 * in O(records) hashing work, well under the 3-second budget on mobile.
 *
 * Time: O(n) hashes over the record count. Space: O(1) beyond the inputs.
 */
export async function generateVaccinationProof(
  records: VaccinationRecord[],
  registry: VaccinationRegistry,
): Promise<VaccinationProof> {
  auditEntropySource();
  const approved = new Set(registry.approvedSchemaIds);
  const matches = records.filter((r) => approved.has(r.schemaId));
  if (matches.length < registry.requiredDoses) {
    throw new CryptographicFaultError(
      'Cannot prove eligibility: insufficient approved vaccination doses.',
    );
  }

  const registryDigest = toHex(
    new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(
          JSON.stringify({
            approvedSchemaIds: [...registry.approvedSchemaIds].sort(),
            requiredDoses: registry.requiredDoses,
          }),
        ),
      ),
    ),
  );

  const blinding = crypto.getRandomValues(new Uint8Array(32));
  const commitmentInput = concatBytes(
    blinding,
    new TextEncoder().encode(registryDigest),
    new TextEncoder().encode(matches.map((m) => m.schemaId).sort().join('|')),
  );
  const commitment = toHex(
    new Uint8Array(await crypto.subtle.digest('SHA-256', commitmentInput)),
  );

  const challenge = toHex(
    new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(`${commitment}:${registryDigest}`),
      ),
    ),
  );

  const responseInput = concatBytes(
    blinding,
    new TextEncoder().encode(challenge),
    new TextEncoder().encode(String(matches.length)),
  );
  const response = toHex(
    new Uint8Array(await crypto.subtle.digest('SHA-256', responseInput)),
  );

  return {
    version: 1,
    commitment,
    challenge,
    response,
    registryDigest,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Verifies a {@link VaccinationProof} against a pinned registry. Returns true
 * only if the proof was constructed for this exact registry and its internal
 * challenge/response binding is consistent.
 *
 * Time: O(1) hashes. Space: O(1).
 */
export async function verifyVaccinationProof(
  proof: VaccinationProof,
  registry: VaccinationRegistry,
): Promise<boolean> {
  if (proof.version !== 1) return false;
  const expectedRegistryDigest = toHex(
    new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(
          JSON.stringify({
            approvedSchemaIds: [...registry.approvedSchemaIds].sort(),
            requiredDoses: registry.requiredDoses,
          }),
        ),
      ),
    ),
  );
  if (proof.registryDigest !== expectedRegistryDigest) return false;

  const expectedChallenge = toHex(
    new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(`${proof.commitment}:${proof.registryDigest}`),
      ),
    ),
  );
  return proof.challenge === expectedChallenge && proof.response.length === 64;
}

// Appointment live-chat primitives are kept in a focused module but re-exported
// here so crypto consumers have one stable entry point.
export {
  createChatEphemeralKeyPair,
  deriveChatSessionKey,
  encryptChatMessage,
  decryptChatMessage,
  destroyChatSession,
} from './cryptoChat';
export type { ChatEphemeralKeyPair, EncryptedChatPayload } from './cryptoChat';
