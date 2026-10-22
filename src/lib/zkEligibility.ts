/**
 * Zero-knowledge eligibility proofs (Groth16 on BN254, via snarkjs).
 *
 * The patient proves age ≥ 18, or active insurance cover, against a Poseidon
 * commitment their issuer attested. The birth date, policy number, expiry date
 * and salt stay in the browser; only the proof and its public signals
 * (`[date, commitment]`) are shared. Circuits are in `circuits/`.
 */

import type { EligibilityKind, EligibilityProofToken } from '@/types';

export const MIN_CONSULTATION_AGE = 18;

const CIRCUITS: Record<EligibilityKind, string> = {
  age18: 'age_eligibility',
  insurance: 'insurance_coverage',
};

/** Base URL serving `<circuit>.wasm`, `<circuit>.zkey` and `<circuit>.vkey.json` from the trusted setup. */
const ARTIFACTS_URL = (process.env.NEXT_PUBLIC_ZK_ARTIFACTS_URL || '/zk').replace(/\/+$/, '');

/** Issuer-provided credential for the age circuit. `commitment` = Poseidon(birthDate, salt). */
export interface AgeCredential {
  type: 'age';
  birthDate: string; // YYYY-MM-DD
  salt: string;
  commitment: string;
}

/** Insurer-provided credential. `commitment` = Poseidon(policyId(policyNumber), expiryDate, salt). */
export interface InsuranceCredential {
  type: 'insurance';
  policyNumber: string;
  expiryDate: string; // YYYY-MM-DD
  salt: string;
  commitment: string;
}

export type EligibilityCredential = AgeCredential | InsuranceCredential;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FIELD_ELEMENT = /^\d{1,78}$/;

/** `YYYY-MM-DD` → YYYYMMDD integer (compares like the calendar date). */
function parseDate(value: string): number {
  const m = ISO_DATE.exec(value);
  if (!m) throw new Error(`Invalid date "${value}"; expected YYYY-MM-DD.`);
  return Number(m[1]) * 10_000 + Number(m[2]) * 100 + Number(m[3]);
}

/** Today's UTC date as YYYYMMDD. */
export const utcDateInt = (now: Date) =>
  now.getUTCFullYear() * 10_000 + (now.getUTCMonth() + 1) * 100 + now.getUTCDate();

/** Latest birth date (YYYYMMDD) that is at least {@link MIN_CONSULTATION_AGE} years before `now` (UTC). */
export const ageCutoff = (now: Date) => utcDateInt(now) - MIN_CONSULTATION_AGE * 10_000;

/**
 * Encodes a policy number as a BN254 field element: the first 31 bytes of
 * SHA-256(UTF-8), big-endian. 248 bits is always below the field modulus.
 * Issuers must use the same encoding when computing the commitment.
 */
export async function policyIdFromNumber(policyNumber: string): Promise<bigint> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(policyNumber)),
  );
  return digest.subarray(0, 31).reduce((acc, b) => (acc << BigInt(8)) | BigInt(b), BigInt(0));
}

/** Validates an untrusted credential file before it is used as circuit input. */
export function parseCredential(json: string): EligibilityCredential {
  const c = JSON.parse(json) as Record<string, unknown>;
  const text = (key: string, pattern?: RegExp) => {
    const v = c[key];
    return typeof v === 'string' && v.length > 0 && (!pattern || pattern.test(v)) ? v : null;
  };
  const salt = text('salt', FIELD_ELEMENT);
  const commitment = text('commitment', FIELD_ELEMENT);
  const birthDate = text('birthDate', ISO_DATE);
  const policyNumber = text('policyNumber');
  const expiryDate = text('expiryDate', ISO_DATE);
  if (salt && commitment && c.type === 'age' && birthDate)
    return { type: 'age', birthDate, salt, commitment };
  if (salt && commitment && c.type === 'insurance' && policyNumber && expiryDate) {
    return { type: 'insurance', policyNumber, expiryDate, salt, commitment };
  }
  throw new Error('Unrecognised eligibility credential.');
}

const artifact = (
  kind: EligibilityKind,
  ext: 'wasm' | 'zkey' | 'vkey.json',
  base = ARTIFACTS_URL,
) => `${base}/${CIRCUITS[kind]}.${ext}`;

/**
 * Generates a proof in the browser. Witness generation fails when the claim is
 * false (too young, policy expired) or the credential doesn't match its commitment.
 * Cost: one Groth16 prove over ~700 constraints, about a second on a laptop.
 */
export async function generateEligibilityProof(
  credential: EligibilityCredential,
  now = new Date(),
  artifactsUrl = ARTIFACTS_URL,
): Promise<EligibilityProofToken> {
  const kind: EligibilityKind = credential.type === 'age' ? 'age18' : 'insurance';
  const input =
    credential.type === 'age'
      ? {
          birthDate: parseDate(credential.birthDate),
          salt: credential.salt,
          cutoffDate: ageCutoff(now),
          commitment: credential.commitment,
        }
      : {
          policyId: await policyIdFromNumber(credential.policyNumber),
          expiryDate: parseDate(credential.expiryDate),
          salt: credential.salt,
          currentDate: utcDateInt(now),
          commitment: credential.commitment,
        };
  const { groth16 } = await import('snarkjs');
  try {
    const { proof, publicSignals } = await groth16.fullProve(
      input,
      artifact(kind, 'wasm', artifactsUrl),
      artifact(kind, 'zkey', artifactsUrl),
    );
    return { kind, proof, publicSignals };
  } catch (err) {
    // The witness calculator reports a false claim as "Assert Failed"; anything else (e.g. artifacts not reachable) is rethrown.
    if (!String((err as Error)?.message ?? err).includes('Assert Failed')) throw err;
    throw new Error(
      kind === 'age18'
        ? `This credential does not prove you are ${MIN_CONSULTATION_AGE} or older.`
        : 'This credential does not prove active insurance coverage.',
    );
  }
}

const vkeyCache = new Map<string, Promise<object>>();

function loadVerificationKey(url: string): Promise<object> {
  let cached = vkeyCache.get(url);
  if (!cached) {
    cached = fetch(url).then((res) => {
      if (!res.ok) throw new Error('Could not load the verification key.');
      return res.json() as Promise<object>;
    });
    cached.catch(() => vkeyCache.delete(url));
    vkeyCache.set(url, cached);
  }
  return cached;
}

/**
 * Verifies a proof token against the public verification key. It also checks
 * that its public signals state the required claim: the date is the age cutoff
 * (or earlier) or today (or later), and the commitment is the one the issuer
 * registered for this patient.
 */
export async function verifyEligibilityProof(
  token: EligibilityProofToken,
  expectedCommitment: string,
  now = new Date(),
  verificationKey?: object,
): Promise<boolean> {
  const [date, commitment] = token.publicSignals;
  if (token.publicSignals.length !== 2 || date === undefined || commitment !== expectedCommitment)
    return false;
  const claimHolds =
    token.kind === 'age18'
      ? BigInt(date) <= BigInt(ageCutoff(now))
      : BigInt(date) >= BigInt(utcDateInt(now));
  if (!claimHolds) return false;
  const vkey = verificationKey ?? (await loadVerificationKey(artifact(token.kind, 'vkey.json')));
  const { groth16 } = await import('snarkjs');
  return groth16.verify(vkey, token.publicSignals, token.proof);
}
