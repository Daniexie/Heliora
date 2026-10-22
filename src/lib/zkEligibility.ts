/*
 * Zero-knowledge eligibility proofs (Groth16 on BN254, via snarkjs).
 *
 * The patient proves age ≥ 18, or active insurance cover, against a Poseidon
 * commitment their issuer attested. The birth date, policy number, expiry date
 * and salt stay in the browser; only the proof and its public signals
 * (`[date, commitment]`) are shared. Circuits are in `circuits/`.
 *
 * Vaccination eligibility (`vaccination`) extends the same pattern to prove
 * that a completed series of an approved vaccine schema exists, without revealing
 * dates, lot numbers or issuer hospital Ids. The public signals are
 * `[registryRoot, commitment]`: the registry root binds the approved schema Ids,
 * the commitment binds the patient's dose records.
 */

import type { EligibilityKind, EligibilityProofToken } from '@/types';

export const MIN_CONSULTATION_AGE = 18;

const CIRCUITS: Record<EligibilityKind, string> = {
  age18: 'age_eligibility',
  insurance: 'insurance_coverage',
  vaccination: 'vaccination_eligibility',
};

/** Base URL serving `<circuit>.wasm`,  `<circuit>.zkey` and `<circuit>.vkey.json` from the trusted setup. */
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

/**
 * A single administered dose in a patient's vaccination record. The circuit
 * proves that every dose belongs to an approved schema in the registry and that
 * the series is complete, without revealing the date, lot number or hospital ID.
 */
export interface VaccinationDose {
  /** Registry schema ID of the vaccine (e.g. EUa/ WHO / CDC code), as a field element. */
  schemaId: string;
  /** Date the dose was administered (YYYYMMDD). */
  administeredDate: string;
  /** Lot number as a field element. */
  lotId: string;
  /** Hospital / issuer ID as a field element. */
  hospitalId: string;
  /** Patient-specific salt binding the dose to the commitment. */
  salt: string;
}

/** Patient-provided vaccination credential. `commitment` binds the dose list. */
export interface VaccinationCredential {
  type: 'vaccination';
  /** Number of doses required by the schema for a completed series. */
  requiredDoses: number;
  /** Administered doses, at least `requiredDoses`. */
  doses: VaccinationDose[];
  /** Poseidon commitment over the dose list and salt. */
  commitment: string;
  /** Root of the approved-vaccine-schema registry the proof is bound to. */
  registryRoot: string;
}

export type EligibilityCredential = AgeCredential | InsuranceCredential | VaccinationCredential;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FIELD_ELEMENT = /^\d{1,78}$/;
const MAX_DOSES = 8;

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

/**
 * Encodes an arbitrary string (e.g. a vaccine schema ID, lot number or
 * hospital ID) as a BN254 field element: the first 31 bytes of SHA-256,
 * big-endian. Registries and issuers must use the same encoding.
 */
export async function fieldElementFromString(value: string): Promise<bigint> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
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
  if (c.type === 'vaccination') {
    const registryRoot = text('registryRoot', FIELD_ELEMENT);
    const requiredDoses = c.requiredDoses;
    const rawDoses = c.doses;
    if (
      salt &&
      commitment &&
      registryRoot &&
      typeof requiredDoses === 'number' &&
      Number.isInteger(requiredDoses) &&
      requiredDoses >= 1 &&
      requiredDoses <= MAX_DOGES &&
      Array.isArray(rawDoses) &&
      rawDoses.length >= requiredDoses
    ) {
      const doses: VaccinationDose[] = [];
      for (const entry of rawDoses) {
        if (!entry || typeof entry !== 'object') throw new Error('Unrecognised eligibility credential.');
        const d = entry as Record<string, unknown>;
        const str = (key: string, pattern: RegExp) => {
          const v = d[key];
          return typeof v === 'string' && pattern.test(v) ? v : null;
        };
        const schemaId = str('schemaId', FIELD_ELEMENT);
        const administeredDate = str('administeredDate', ISO_DATE);
        const lotId = str('lotId', FIELD_ELEMENT);
        const hospitalId = str('hospitalId', FIELD_ELEMENT);
        const doseSalt = str('salt', FIELD_ELEMENT);
        if (!schemaId || !administeredDate || !lotId || !hospitalId || !doseSalt)
          throw new Error('Unrecognised eligibility credential.');
        doses.push({ schemaId, administeredDate, lotId, hospitalId, salt: doseSalt });
      }
      return { type: 'vaccination', requiredDoses, doses, commitment, registryRoot };
    }
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
 * false (too young, policy expired, incomplete vaccine series, unknown scheme)
 * or the credential doesn't match its commitment.
 * Cost: one Groth16 proof over ~1,200 constraints, about a second on a laptop
 * and well under the 3s mobile budget.
 */
export async function generateEligibilityProof(
  credential: EligibilityCredential,
  now = new Date(),
  artifactsUrl = ARTIFACTS_URL,
): Promise<EligibilityProofToken> {
  const kind: EligibilityKind =
    credential.type === 'age'
      ? 'age18'
      : credential.type === 'insurance'
        ? 'insurance'
        : 'vaccination';
  const input =
    credential.type === 'age'
      ? {
          birthDate: parseDate(credential.birthDate),
          salt: credential.salt,
          cutoffDate: ageCutoff(now),
          commitment: credential.commitment,
        }
      : credential.type === 'insurance'
        ? {
            policyId: await policyIdFromNumber(credential.policyNumber),
            expiryDate: parseDate(credential.expiryDate),
            salt: credential.salt,
            currentDate: utcDateInt(now),
            commitment: credential.commitment,
          }
        : await vaccinationInput(credential);
  const { groth16 } = await import('snarkjs');
  try {
    const { proof, publicSignals } = await groth16.fullProve(
      input,
      artifact(kind, 'wasm', artifactsUrl),
      artifact(kind, 'zkey', artifactsUrl),
    );
    return { kind, proof, publicSignals };
  } catch (err) {
    // The witness generation fails when the claim is false; surface a clearer
    // message than snarkjs' opaque assertion failure.
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not prove eligibility: ${message}`);
  }
}

/**
 * Builds the circuit input for a vaccination credential. The dose list is
 * padded to `MAX_DOSES` so the circuit has a fixed shape; padding entries are
 * zero field elements and are ignored by the circuit's completeness check.
 */
async function vaccinationInput(credential: VaccinationCredential): Promise<Record<string, unknown>> {
  const doses = await Promise.all(
    credential.doses.map(async (d) => ({
      schemaId: await fieldElementFromString(d.schemaId),
      administeredDate: parseDate(d.administeredDate),
      lotId: await fieldElementFromString(d.lotId),
      hospitalId: await fieldElementFromString(d.hospitalId),
      salt: d.salt,
    })),
  );
  while (doses.length < MAX_DOSES) {
    doses.push({
      schemaId: BigInt(0),
      administeredDate: 0,
      lotId: BigInt(0),
      hospitalId: BigInt(0),
      salt: '0',
    });
  }
  return {
    requiredDoses: credential.requiredDoses,
    doses,
    commitment: credential.commitment,
    registryRoot: credential.registryRoot,
  };
}
