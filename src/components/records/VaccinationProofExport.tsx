'use client';

import { useCallback, useState } from 'react';
import { QRCode } from 'qrcode-react';
import {
  generateVProof,
  encodeProofPayload,
  type VaccinationCredential,
  type VaccinationProofToken,
} from '@/lib/zkVAccination';

export interface VaccinationProofExportProps {
  /** Issuer-attested vaccination credential loaded from the patient's records. */
  credential: VaccinationCredential;
  /** Optional callback invoked after a proof is generated. */
  onProofGenerated?: (token: VaccinationProofToken) => void;
}

type Status = 'idle' | 'generating' | 'ready' | 'error';

/**
 * Patient-facing export of a zero-knowledge proof of vaccination.
 *
 * The credential (dates, lot number, hospital ID) stays in the browser;
 * only the GROTH16 proof and its public signals are encoded into the shared
 * payload. A border or clinic scans the QR code and verifies the proof
 * against the published verification key and the approved-vaccine registry root.
 */
export default function VaccinationProofExport({
  credential,
  onProofGenerated,
}: VaccinationProofExportProps) {
  const [status, setStatus] = useState<Status>('idle');
  const [token, setToken] = useState<VaccinationProofToken | null>(null);
  const [error, setError] = useState<string | null>(null);

  const generate = useCallback(async () => {
    setStatus('generating');
    setError(null);
    setToken(null);
    try {
      const proof = await generateVProof(credential);
      setToken(proof);
      setStatus('ready');
      onProofGenerated?.(proof);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not generate the vaccination proof.');
      setStatus('error');
    }
  }, [credential, onProofGenerated]);

  const qrData = token ? encodeProofPayload(token) : null;

  return (
    <section aria-labelled="Vaccination proof export" className="space-y-4">
      <header className="space-y-1">
        <h2>Export vaccination proof</h2>
        <p className="text-sm text-muted-foreground">
          Generate a zero-knowledge proof that your vaccination is approved. Your
          dates, lot numbers and hospital IDs are never included in the shared
          payload.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={generate}
          disabled={status === 'generating'}
          className="rounded-md px-4 py-2 font-medium bg-primary text-primary-foreground disabled:opacity-50"
        >
          {status === 'generating' ? 'Generating proof…' : 'Generate proof'}
        </button>
        {status === 'ready' && token && (
          <span className="text-sm text-green-600">
            Proof ready — share the QR code below.
          </span>
        )}
      </div>

      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}

      {qrData && (
        <div className="flex flex-col items-center gap-2">
          <QRCode value={qrData} size={256} level="M" />
          <p className="text-xs text-muted-foreground">
            Scan to verify the proof. No personal data is embedded.
          </p>
        </div>
      )}
    </section>
  );
}
