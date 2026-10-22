'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { StrKey, TransactionBuilder } from '@stellar/stellar-sdk';
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  ExternalLink,
  Loader2,
  ShieldCheck,
  Wallet,
} from 'lucide-react';
import {
  BASE_RESERVE_XLM,
  STELLAR_CONFIG,
  buildAccountMergeTransaction,
  buildRecordPointerTransaction,
  confirmAccountClosed,
  freighterSigner,
  lookupMergeAccount,
  planAccountMerge,
  submitTransaction,
  waitForTransactionConfirmation,
  type AccountLookupResult,
  type AccountMergePlan,
  type MergeAccountSnapshot,
} from '@/lib/stellar';
import { useWalletStore } from '@/store/useWalletStore';

type MergeStep = 'destination' | 'assets' | 'records' | 'review' | 'complete';

type PointerStatus = 'idle' | 'signing' | 'submitted' | 'confirmed' | 'error';

const STEP_ORDER: MergeStep[] = ['destination', 'assets', 'records', 'review'];

const STEP_LABELS: Record<MergeStep, string> = {
  destination: 'New wallet',
  assets: 'Asset check',
  records: 'Record pointers',
  review: 'Review & merge',
  complete: 'Complete',
};

function shorten(key: string): string {
  return key.length <= 12 ? key : `${key.slice(0, 6)}…${key.slice(-4)}`;
}

function assetLabel(assetCode: string, assetIssuer: string | null): string {
  return assetIssuer ? `${assetCode}:${assetIssuer}` : assetCode;
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export default function AccountMergeWizard() {
  const { publicKey } = useWalletStore();

  const [step, setStep] = useState<MergeStep>('destination');
  const [destinationInput, setDestinationInput] = useState('');
  const [destination, setDestination] = useState<MergeAccountSnapshot | null>(null);
  const [source, setSource] = useState<MergeAccountSnapshot | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [loadingSource, setLoadingSource] = useState(false);
  const [checkingDestination, setCheckingDestination] = useState(false);
  const [destinationError, setDestinationError] = useState<string | null>(null);
  const [pointerStatus, setPointerStatus] = useState<PointerStatus>('idle');
  const [pointerTxHash, setPointerTxHash] = useState<string | null>(null);
  const [mergeTxHash, setMergeTxHash] = useState<string | null>(null);
  const [accountClosed, setAccountClosed] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!publicKey) return;

    let cancelled = false;
    setLoadingSource(true);

    void lookupMergeAccount(publicKey).then((result: AccountLookupResult) => {
      if (cancelled) return;
      setLoadingSource(false);

      if (result.status === 'found') {
        setSource(result.account);
        setSourceError(null);
      } else if (result.status === 'not-found') {
        setSource(null);
        setSourceError('The connected account does not exist on the selected network.');
      } else {
        setSource(null);
        setSourceError(result.message);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [publicKey]);

  const plan: AccountMergePlan | null = useMemo(() => {
    if (!source || !destination || !publicKey) return null;
    return planAccountMerge(source, destination, publicKey, destination.publicKey);
  }, [source, destination, publicKey]);

  const checkDestination = useCallback(async () => {
    setDestinationError(null);
    setError(null);

    const key = destinationInput.trim();
    if (!key) {
      setDestinationError('Enter the public key of the wallet you are switching to.');
      return;
    }
    if (!StrKey.isValidEd25519PublicKey(key)) {
      setDestinationError('That is not a valid Stellar public key. It has to start with "G".');
      return;
    }
    if (key === publicKey) {
      setDestinationError('The new wallet has to be different from the connected account.');
      return;
    }

    setCheckingDestination(true);
    const result = await lookupMergeAccount(key);
    setCheckingDestination(false);

    if (result.status === 'not-found') {
      setDestination(null);
      setDestinationError(
        'No account exists for that public key on this network. Fund the new wallet first, then check again.',
      );
      return;
    }

    if (result.status === 'error') {
      setDestination(null);
      setDestinationError(result.message);
      return;
    }

    setDestination(result.account);
    setStep('assets');
  }, [destinationInput, publicKey]);

  const goToStep = useCallback((next: MergeStep) => {
    setError(null);
    setStep(next);
  }, []);

  const reassignPointers = useCallback(async () => {
    if (!plan || !destination || !publicKey) return;

    if (plan.pointers.updates.length === 0) {
      setPointerStatus('confirmed');
      return;
    }

    setError(null);
    setBusy(true);
    setPointerStatus('signing');

    try {
      // Re-read the destination so the transaction uses its current sequence number.
      const fresh = await lookupMergeAccount(destination.publicKey);
      const destinationAccount = fresh.status === 'found' ? fresh.account : destination;

      const transaction = buildRecordPointerTransaction({
        destinationPublicKey: destinationAccount.publicKey,
        destinationSequence: destinationAccount.sequence,
        updates: plan.pointers.updates,
      });
      const signedXdr = await freighterSigner(
        transaction.toXDR(),
        STELLAR_CONFIG.passphrase,
        destination.publicKey,
      );
      const signedTransaction = TransactionBuilder.fromXDR(signedXdr, STELLAR_CONFIG.passphrase);

      setPointerStatus('submitted');
      const hash = await submitTransaction(signedTransaction);
      setPointerTxHash(hash);

      const confirmed = await waitForTransactionConfirmation(hash);
      if (!confirmed) {
        throw new Error(
          'The pointer transaction was not confirmed in time. Check the network and try again.',
        );
      }

      setPointerStatus('confirmed');
    } catch (err: unknown) {
      setPointerStatus('error');
      setError(
        errorMessage(
          err,
          'Could not reassign the record pointers. Make sure the new wallet is available in your wallet extension.',
        ),
      );
    } finally {
      setBusy(false);
    }
  }, [plan, destination, publicKey]);

  const mergeAccounts = useCallback(async () => {
    if (!plan || !source || !destination || !publicKey) return;

    setError(null);
    setBusy(true);

    try {
      // Re-read the account that is being closed so the transaction uses its
      // current sequence number.
      const fresh = await lookupMergeAccount(publicKey);
      const sourceAccount = fresh.status === 'found' ? fresh.account : source;

      const transaction = buildAccountMergeTransaction({
        sourcePublicKey: publicKey,
        sourceSequence: sourceAccount.sequence,
        destinationPublicKey: destination.publicKey,
      });
      const signedXdr = await freighterSigner(
        transaction.toXDR(),
        STELLAR_CONFIG.passphrase,
        publicKey,
      );
      const signedTransaction = TransactionBuilder.fromXDR(signedXdr, STELLAR_CONFIG.passphrase);

      const hash = await submitTransaction(signedTransaction);
      setMergeTxHash(hash);

      const confirmed = await waitForTransactionConfirmation(hash);
      if (!confirmed) {
        throw new Error('The merge transaction was not confirmed in time.');
      }

      const closed = await confirmAccountClosed(publicKey);
      setAccountClosed(closed);
      setStep('complete');
    } catch (err: unknown) {
      setError(errorMessage(err, 'The merge could not be completed.'));
    } finally {
      setBusy(false);
    }
  }, [plan, source, destination, publicKey]);

  if (!publicKey) {
    return (
      <div
        className="rounded-[14px] p-5"
        style={{ background: 'var(--bg-card)', border: '1px solid rgba(255,255,255,0.07)' }}
      >
        <p className="text-sm text-text-2">Connect your wallet to start the account merge.</p>
      </div>
    );
  }

  const blockers = plan?.blockers ?? [];
  const warnings = plan?.warnings ?? [];
  const hasPointers = (plan?.pointers.updates.length ?? 0) > 0;
  const pointersReassigned = !hasPointers || pointerStatus === 'confirmed';

  return (
    <div className="space-y-4">
      {/* ── Stepper ─────────────────────────────────────────────── */}
      <ol className="flex flex-wrap items-center gap-2" aria-label="Merge progress">
        {STEP_ORDER.map((id, index) => {
          const currentIndex = STEP_ORDER.indexOf(step === 'complete' ? 'review' : step);
          const state = index < currentIndex ? 'done' : index === currentIndex ? 'current' : 'todo';

          return (
            <li key={id} className="flex items-center gap-2">
              <span
                className="inline-flex items-center gap-1.5 text-2xs font-semibold px-2.5 py-1 rounded-full"
                style={{
                  background: state === 'todo' ? 'rgba(255,255,255,0.05)' : 'rgba(0,200,150,0.12)',
                  color: state === 'todo' ? '#4E5E5A' : '#00C896',
                  border: `1px solid ${state === 'todo' ? 'rgba(255,255,255,0.07)' : 'rgba(0,200,150,0.2)'}`,
                }}
                aria-current={state === 'current' ? 'step' : undefined}
              >
                {state === 'done' ? (
                  <CheckCircle2 className="w-3 h-3" />
                ) : (
                  <span className="font-mono">{index + 1}</span>
                )}
                {STEP_LABELS[id]}
              </span>
              {index < STEP_ORDER.length - 1 && <ArrowRight className="w-3 h-3 text-text-3" />}
            </li>
          );
        })}
      </ol>

      {/* ── Source account summary ──────────────────────────────── */}
      <div
        className="rounded-[14px] p-5"
        style={{ background: 'var(--bg-card)', border: '1px solid rgba(255,255,255,0.07)' }}
      >
        <div className="flex items-center gap-2 mb-3">
          <Wallet className="w-4 h-4" style={{ color: '#00C896' }} />
          <h2 className="text-sm font-semibold text-text-1">Account being closed</h2>
        </div>

        {loadingSource ? (
          <div className="flex items-center gap-2 text-xs text-text-3">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Loading the connected account…
          </div>
        ) : sourceError ? (
          <p role="alert" className="text-xs text-red-600">
            {sourceError}
          </p>
        ) : source ? (
          <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
            <div>
              <dt className="text-text-3">Public key</dt>
              <dd className="font-mono text-text-1 mt-0.5" title={source.publicKey}>
                {shorten(source.publicKey)}
              </dd>
            </div>
            <div>
              <dt className="text-text-3">XLM balance</dt>
              <dd className="font-mono text-text-1 mt-0.5">{source.nativeBalance} XLM</dd>
            </div>
            <div>
              <dt className="text-text-3">Subentries</dt>
              <dd className="font-mono text-text-1 mt-0.5">{source.subentryCount}</dd>
            </div>
            <div>
              <dt className="text-text-3">Reserve to reclaim</dt>
              <dd className="font-mono text-text-1 mt-0.5">
                {(source.subentryCount * BASE_RESERVE_XLM).toFixed(1)} XLM
              </dd>
            </div>
          </dl>
        ) : null}
      </div>

      {/* ── Step: destination ───────────────────────────────────── */}
      {step === 'destination' && (
        <div
          className="rounded-[14px] p-5"
          style={{ background: 'var(--bg-card)', border: '1px solid rgba(255,255,255,0.07)' }}
        >
          <h2 className="text-sm font-semibold text-text-1">Which wallet are you switching to?</h2>
          <p className="text-xs text-text-3 mt-1 mb-4">
            The new account has to exist on this network and already hold a trustline for every
            asset you are moving.
          </p>

          <label htmlFor="destination-key" className="block text-xs text-text-2 mb-1.5">
            New wallet public key
          </label>
          <input
            id="destination-key"
            value={destinationInput}
            onChange={(event) => setDestinationInput(event.target.value)}
            placeholder="G…"
            autoComplete="off"
            spellCheck={false}
            className="w-full rounded-md border border-border bg-surface-inset px-3 py-2 font-mono text-xs text-text-1 placeholder:text-text-3"
          />

          {destinationError && (
            <p role="alert" className="text-xs text-red-600 mt-2">
              {destinationError}
            </p>
          )}

          <button
            type="button"
            onClick={checkDestination}
            disabled={checkingDestination}
            className="btn-primary rounded-[9px] text-xs py-2 px-3.5 mt-4 disabled:opacity-50"
          >
            {checkingDestination ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Checking…
              </>
            ) : (
              'Check new wallet'
            )}
          </button>
        </div>
      )}

      {/* ── Step: assets ────────────────────────────────────────── */}
      {step === 'assets' && destination && plan && (
        <div
          className="rounded-[14px] p-5"
          style={{ background: 'var(--bg-card)', border: '1px solid rgba(255,255,255,0.07)' }}
        >
          <h2 className="text-sm font-semibold text-text-1">
            Can the new wallet receive everything?
          </h2>
          <p className="text-xs text-text-3 mt-1 mb-4">
            A merge only succeeds when the destination already trusts every asset the old account
            holds.
          </p>

          {plan.assets.length === 0 ? (
            <p className="text-xs text-text-2">
              The old account only holds XLM, so there is nothing else to transfer.
            </p>
          ) : (
            <div className="space-y-2">
              {plan.assets.map((asset) => (
                <div
                  key={`${asset.assetCode}:${asset.assetIssuer ?? 'native'}`}
                  className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 p-3 rounded-[10px]"
                  style={{
                    background: 'var(--bg-inset)',
                    border: '1px solid rgba(255,255,255,0.05)',
                  }}
                >
                  <div className="min-w-0">
                    <p className="text-xs font-medium font-mono text-text-1 truncate">
                      {assetLabel(asset.assetCode, asset.assetIssuer)}
                    </p>
                    <p className="text-2xs text-text-3 mt-0.5">
                      Old balance {asset.sourceBalance} · new account balance{' '}
                      {asset.destinationBalance ?? '—'} / limit {asset.destinationLimit ?? '—'}
                    </p>
                  </div>
                  <span
                    className={
                      asset.status === 'ready'
                        ? 'badge-green shrink-0'
                        : asset.status === 'zero-balance'
                          ? 'badge-muted shrink-0'
                          : 'badge-red shrink-0'
                    }
                  >
                    {asset.status === 'ready'
                      ? 'ready'
                      : asset.status === 'zero-balance'
                        ? 'nothing to send'
                        : asset.status === 'missing-trustline'
                          ? 'no trustline'
                          : 'limit too low'}
                  </span>
                </div>
              ))}
            </div>
          )}

          {blockers.length > 0 && (
            <div
              className="mt-4 p-3 rounded-[10px] flex gap-2"
              style={{
                background: 'rgba(239,68,68,0.08)',
                border: '1px solid rgba(239,68,68,0.2)',
              }}
            >
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" style={{ color: '#F87171' }} />
              <div>
                <p className="text-xs font-semibold" style={{ color: '#F87171' }}>
                  Fix these before merging
                </p>
                <ul className="list-disc pl-4 mt-1 space-y-0.5">
                  {blockers.map((blocker) => (
                    <li key={blocker} className="text-2xs text-text-2">
                      {blocker}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          {warnings.length > 0 && (
            <div
              className="mt-3 p-3 rounded-[10px] flex gap-2"
              style={{
                background: 'rgba(234,179,8,0.08)',
                border: '1px solid rgba(234,179,8,0.2)',
              }}
            >
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" style={{ color: '#EAB308' }} />
              <ul className="space-y-0.5">
                {warnings.map((warning) => (
                  <li key={warning} className="text-2xs text-text-2">
                    {warning}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex gap-2 mt-4">
            <button
              type="button"
              onClick={() => goToStep('destination')}
              className="btn-secondary rounded-[9px] text-xs py-2 px-3.5"
            >
              Back
            </button>
            <button
              type="button"
              onClick={() => goToStep('records')}
              disabled={blockers.length > 0}
              className="btn-primary rounded-[9px] text-xs py-2 px-3.5 disabled:opacity-50"
            >
              Continue
            </button>
          </div>
        </div>
      )}

      {/* ── Step: record pointers ───────────────────────────────── */}
      {step === 'records' && plan && (
        <div
          className="rounded-[14px] p-5"
          style={{ background: 'var(--bg-card)', border: '1px solid rgba(255,255,255,0.07)' }}
        >
          <h2 className="text-sm font-semibold text-text-1">Reassign on-chain record pointers</h2>
          <p className="text-xs text-text-3 mt-1 mb-4">
            Merging deletes every data entry of the old account, so the pointers to your medical
            records are moved to the new wallet first — pointing at the new public key.
          </p>

          {plan.pointers.blocked.length > 0 && (
            <div
              className="mb-4 p-3 rounded-[10px] flex gap-2"
              style={{
                background: 'rgba(239,68,68,0.08)',
                border: '1px solid rgba(239,68,68,0.2)',
              }}
            >
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" style={{ color: '#F87171' }} />
              <ul className="space-y-0.5">
                {plan.pointers.blocked.map((entry) => (
                  <li key={entry.key} className="text-2xs text-text-2">
                    <span className="font-mono text-text-1">{entry.key}</span> — {entry.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {!hasPointers ? (
            <p className="text-xs text-text-2">
              No on-chain medical record pointers were found on the old account, so there is nothing
              to reassign.
            </p>
          ) : (
            <div className="space-y-2">
              {plan.pointers.updates.map((update) => (
                <div
                  key={update.key}
                  className="p-3 rounded-[10px]"
                  style={{
                    background: 'var(--bg-inset)',
                    border: '1px solid rgba(255,255,255,0.05)',
                  }}
                >
                  <p className="text-xs font-mono text-text-1 truncate">{update.key}</p>
                  <p className="text-2xs text-text-3 mt-1 font-mono break-all">
                    {update.previousValue === update.value ? (
                      update.value
                    ) : (
                      <>
                        {update.previousValue} → {update.value}
                      </>
                    )}
                  </p>
                </div>
              ))}
            </div>
          )}

          {pointerTxHash && (
            <p className="text-2xs text-text-3 mt-3 font-mono break-all">
              Pointer tx: {pointerTxHash}
            </p>
          )}

          {error && (
            <p role="alert" className="text-xs text-red-600 mt-3">
              {error}
            </p>
          )}

          <div className="flex flex-wrap gap-2 mt-4">
            <button
              type="button"
              onClick={() => goToStep('assets')}
              className="btn-secondary rounded-[9px] text-xs py-2 px-3.5"
            >
              Back
            </button>

            {hasPointers && pointerStatus !== 'confirmed' ? (
              <button
                type="button"
                onClick={reassignPointers}
                disabled={busy}
                className="btn-primary rounded-[9px] text-xs py-2 px-3.5 disabled:opacity-50"
              >
                {busy ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" /> Reassigning…
                  </>
                ) : (
                  'Reassign pointers to new wallet'
                )}
              </button>
            ) : null}

            <button
              type="button"
              onClick={() => goToStep('review')}
              disabled={!pointersReassigned}
              className="btn-primary rounded-[9px] text-xs py-2 px-3.5 disabled:opacity-50"
            >
              Continue
            </button>
          </div>

          {hasPointers && !pointersReassigned && (
            <p className="text-2xs text-text-3 mt-2">
              The pointer transaction has to be signed by the new wallet. Make sure it is available
              in your wallet extension.
            </p>
          )}
        </div>
      )}

      {/* ── Step: review ────────────────────────────────────────── */}
      {step === 'review' && plan && destination && (
        <div
          className="rounded-[14px] p-5"
          style={{ background: 'var(--bg-card)', border: '1px solid rgba(255,255,255,0.07)' }}
        >
          <h2 className="text-sm font-semibold text-text-1">Final transaction breakdown</h2>
          <p className="text-xs text-text-3 mt-1 mb-4">
            One <span className="font-mono">AccountMerge</span> operation closes the old account and
            moves everything it holds.
          </p>

          <dl className="space-y-2 text-xs">
            <div className="flex items-center justify-between gap-4">
              <dt className="text-text-2">Operation</dt>
              <dd className="font-mono text-text-1">
                AccountMerge → {shorten(destination.publicKey)}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-4">
              <dt className="text-text-2">XLM balance of the old account</dt>
              <dd className="font-mono text-text-1">{plan.source.nativeBalance} XLM</dd>
            </div>
            <div className="flex items-center justify-between gap-4">
              <dt className="text-text-2">Network fee</dt>
              <dd className="font-mono text-text-1">{plan.mergeFeeXlm} XLM</dd>
            </div>
            <div className="flex items-center justify-between gap-4">
              <dt className="text-text-2">XLM transferred to the new wallet</dt>
              <dd className="font-mono text-text-1">{plan.xlmTransferredXlm} XLM</dd>
            </div>
            <div className="flex items-center justify-between gap-4">
              <dt className="text-text-2">
                Base reserve reclaimed ({plan.source.subentryCount} subentries × {BASE_RESERVE_XLM}{' '}
                XLM)
              </dt>
              <dd className="font-mono text-text-1">{plan.reclaimableReserveXlm} XLM</dd>
            </div>
            <div className="flex items-center justify-between gap-4">
              <dt className="text-text-2">Estimated new wallet balance</dt>
              <dd className="font-mono text-text-1">{plan.destinationBalanceAfterXlm} XLM</dd>
            </div>
            <div className="flex items-center justify-between gap-4">
              <dt className="text-text-2">Assets transferred</dt>
              <dd className="font-mono text-text-1">
                {plan.assets.filter((asset) => asset.required).length} trustline(s)
              </dd>
            </div>
            <div className="flex items-center justify-between gap-4">
              <dt className="text-text-2">Record pointers reassigned</dt>
              <dd className="font-mono text-text-1">
                {plan.pointers.updates.length} (fee {plan.pointerFeeXlm} XLM)
              </dd>
            </div>
          </dl>

          {plan.assets
            .filter((asset) => asset.required)
            .map((asset) => (
              <div
                key={`${asset.assetCode}:${asset.assetIssuer ?? 'native'}`}
                className="flex items-center justify-between gap-4 text-2xs text-text-3 mt-2 font-mono"
              >
                <span className="truncate">{assetLabel(asset.assetCode, asset.assetIssuer)}</span>
                <span>{asset.sourceBalance}</span>
              </div>
            ))}

          <label className="flex items-start gap-2 mt-5 text-xs text-text-2">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
              className="mt-0.5"
            />
            <span>
              I understand that the old account is closed permanently and cannot be reopened. Only
              the new wallet will be able to spend these funds.
            </span>
          </label>

          {error && (
            <p role="alert" className="text-xs text-red-600 mt-3">
              {error}
            </p>
          )}

          <div className="flex gap-2 mt-4">
            <button
              type="button"
              onClick={() => goToStep('records')}
              className="btn-secondary rounded-[9px] text-xs py-2 px-3.5"
            >
              Back
            </button>
            <button
              type="button"
              onClick={mergeAccounts}
              disabled={!acknowledged || busy}
              className="btn-primary rounded-[9px] text-xs py-2 px-3.5 disabled:opacity-50"
            >
              {busy ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> Merging…
                </>
              ) : (
                'Merge accounts'
              )}
            </button>
          </div>
        </div>
      )}

      {/* ── Step: complete ──────────────────────────────────────── */}
      {step === 'complete' && (
        <div
          className="rounded-[14px] p-5"
          style={{ background: 'var(--bg-card)', border: '1px solid rgba(255,255,255,0.07)' }}
        >
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4" style={{ color: '#00C896' }} />
            <h2 className="text-sm font-semibold text-text-1">Account closed</h2>
            <span className="badge-green">complete</span>
          </div>

          <p className="text-xs text-text-2 mt-2">
            {accountClosed
              ? 'The old account no longer exists on the ledger. Every remaining XLM, every asset and the base reserve of its subentries now belong to the new wallet.'
              : 'The merge was confirmed, but the old account could not be verified as closed yet. Refresh the page to check again.'}
          </p>

          {mergeTxHash && (
            <p className="text-2xs text-text-3 mt-3 font-mono break-all">
              Merge transaction:{' '}
              <a
                href={`${STELLAR_CONFIG.horizonUrl}/transactions/${mergeTxHash}`}
                target="_blank"
                rel="noreferrer"
                className="underline inline-flex items-center gap-1"
              >
                {mergeTxHash}
                <ExternalLink className="w-2.5 h-2.5" />
              </a>
            </p>
          )}

          {pointerTxHash && (
            <p className="text-2xs text-text-3 mt-1 font-mono break-all">
              Pointer transaction: {pointerTxHash}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
