import { BASE_FEE, Networks, TransactionBuilder, rpc, Asset, Horizon, Operation, type xdr } from '@stellar/stellar-sdk';
import { signTransaction } from '@stellar/freighter-api';
import { useCallback } from 'react';
import { useToast } from '@/hooks/useToast';

interface EndpointHealth {
  url: string;
  lastLatency: number | null;
  failureCount: number;
  lastChecked: number;
  isHealthy: boolean;
}

const TESTNET_ENDPOINTS: [string, ...string[]] = [
  'https://horizon-testnet.stellar.org',
  'https://testnet.stellar.lobstr.co',
  'https://stellar-testnet.blockdaemon.com',
];

const MAINNET_ENDPOINTS: [string, ...string[]] = [
  'https://horizon.stellar.org',
  'https://stellar-mainnet.blockdaemon.com',
  'https://mainnet.stellar.lobstr.co',
];

const LATENCY_THRESHOLD_MS = 2500;
const MAX_FAILURES = 3;

const endpointHealth: Map<string, EndpointHealth> = new Map();

/**
 * Global Stellar configuration for the application.
 *
 * This object defines the network, Horizon endpoint, and passphrase used by
 * the Stellar SDK in this frontend.
 *
 * Environment Variables (see README.md):
 * - NEXT_PUBLIC_STELLAR_NETWORK: Defines the network ('testnet' or 'mainnet'). Defaults to 'testnet'.
 * - NEXT_PUBLIC_HORIZON_URL: Defines the Horizon API URL. Defaults to the public testnet URL.
 *
 * Note: The passphrase is hardcoded to `Networks.TESTNET` currently. If you need to support
 * mainnet, ensure you map `NEXT_PUBLIC_STELLAR_NETWORK === 'mainnet'` to `Networks.PUBLIC`.
 */
const isMainnet = process.env.NEXT_PUBLIC_STELLAR_NETWORK === 'mainnet';
const endpoints = isMainnet ? MAINNET_ENDPOINTS : TESTNET_ENDPOINTS;

export const STELLAR_CONFIG = {
  network: process.env.NEXT_PUBLIC_STELLAR_NETWORK || 'testnet',
  horizonUrl: process.env.NEXT_PUBLIC_HORIZON_URL || endpoints[0],
  endpoints,
  passphrase: isMainnet ? Networks.PUBLIC : Networks.TESTNET,
  // SDF hosts a public Soroban RPC for testnet only; mainnet needs a provider URL.
  sorobanRpcUrl:
    process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ||
    (isMainnet ? '' : 'https://soroban-testnet.stellar.org'),
};

function initializeEndpointHealth() {
  if (endpointHealth.size === 0) {
    STELLAR_CONFIG.endpoints.forEach((url) => {
      endpointHealth.set(url, {
        url,
        lastLatency: null,
        failureCount: 0,
        lastChecked: 0,
        isHealthy: true,
      });
    });
  }
}

/**
 * Pings a Horizon endpoint and records its latency and failure count so that
 * `getHealthyEndpoint` can prefer the fastest reachable server.
 */
export async function checkEndpointHealth(url: string): Promise<number> {
  const startTime = performance.now();
  try {
    const response = await fetch(`${url}/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    });
    const latency = performance.now() - startTime;

    if (response.ok) {
      const health = endpointHealth.get(url);
      if (health) {
        health.lastLatency = latency;
        health.failureCount = 0;
        health.isHealthy = latency < LATENCY_THRESHOLD_MS;
        health.lastChecked = Date.now();
      }
      return latency;
    }
    throw new Error(`Health check failed: ${response.status}`);
  } catch (err) {
    const health = endpointHealth.get(url);
    if (health) {
      health.failureCount++;
      health.isHealthy = health.failureCount < MAX_FAILURES;
      health.lastChecked = Date.now();
    }
    throw err;
  }
}

export function getHealthyEndpoint(): string {
  initializeEndpointHealth();

  const healthyEndpoints = Array.from(endpointHealth.values())
    .filter((h) => h.isHealthy)
    .sort((a, b) => {
      const aLatency = a.lastLatency ?? LATENCY_THRESHOLD_MS;
      const bLatency = b.lastLatency ?? LATENCY_THRESHOLD_MS;
      return aLatency - bLatency;
    });

  const healthiest = healthyEndpoints[0];
  return healthiest ? healthiest.url : STELLAR_CONFIG.endpoints[0];
}

export function resetEndpointFailure(url: string) {
  const health = endpointHealth.get(url);
  if (health) {
    health.failureCount = 0;
    health.isHealthy = true;
  }
}

export class HorizonRequestError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'HorizonRequestError';
  }
}

/**
 * Attempts a call with automatic fallback to healthy endpoints on failure.
 * Tracks endpoint health and latency for future requests.
 */
export async function callHorizonWithFallback<T>(fn: (url: string) => Promise<T>): Promise<T> {
  initializeEndpointHealth();

  const endpointsToTry = Array.from(endpointHealth.values())
    .sort((a, b) => {
      const aLatency = a.lastLatency ?? LATENCY_THRESHOLD_MS;
      const bLatency = b.lastLatency ?? LATENCY_THRESHOLD_MS;
      return aLatency - bLatency;
    })
    .map((h) => h.url);

  let lastError: unknown;

  for (const url of endpointsToTry) {
    try {
      const result = await fn(url);
      resetEndpointFailure(url);
      return result;
    } catch (err: unknown) {
      lastError = err;
      const health = endpointHealth.get(url);
      if (health) {
        health.failureCount++;
        health.isHealthy = health.failureCount < MAX_FAILURES;
      }
    }
  }

  throw lastError;
}

/**
 * Normalizes Horizon network errors, rate limits, and invalid responses into a
 * single HorizonRequestError instead of letting them throw unhandled/crash the UI.
 */
export async function callHorizon<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await callHorizonWithFallback(() => fn());
  } catch (err: unknown) {
    if (err instanceof TypeError) {
      throw new HorizonRequestError(
        'Unable to reach the Stellar network. Check your connection and try again.',
        err,
      );
    }
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status === 429) {
      throw new HorizonRequestError(
        'Stellar network rate limit reached. Please try again shortly.',
        err,
      );
    }
    if (status && status >= 500) {
      throw new HorizonRequestError('Stellar Horizon service is temporarily unavailable.', err);
    }
    if (status && status >= 400) {
      throw new HorizonRequestError('Invalid request sent to the Stellar network.', err);
    }
    throw new HorizonRequestError('Unexpected error communicating with the Stellar network.', err);
  }
}

/** Runs a Horizon call and surfaces any failure via the toast system instead of failing silently. */
export function useHorizonCall() {
  const { toast } = useToast();

  return useCallback(
    async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await callHorizon(fn);
      } catch (err) {
        const message =
          err instanceof HorizonRequestError
            ? err.message
            : 'Failed to communicate with the Stellar network.';
        toast(message, 'error');
        return undefined;
      }
    },
    [toast],
  );
}

/** Signs a base64 transaction envelope with `address` for `networkPassphrase` and returns the signed envelope. */
export type TransactionSigner = (
  envelopeXdr: string,
  networkPassphrase: string,
  address: string,
) => Promise<string>;

/**
 * {@link TransactionSigner} backed by the Freighter extension through the official
 * `@stellar/freighter-api` (v6: resolves to `{ signedTxXdr, signerAddress, error? }`).
 */
export const freighterSigner: TransactionSigner = async (
  envelopeXdr,
  networkPassphrase,
  address,
) => {
  const { signedTxXdr, signerAddress, error } = await signTransaction(envelopeXdr, {
    networkPassphrase,
    address,
  });
  if (error) throw new Error(error.message || 'Freighter could not sign the transaction.');
  if (signerAddress !== address) throw new Error('Freighter signed with a different account.');
  return signedTxXdr;
};

const SOROBAN_TX_TIMEOUT_SECONDS = 300;
const SOROBAN_POLL_ATTEMPTS = 30; // ~1 s apart, i.e. about 5 ledgers

/**
 * Simulates, signs, submits and confirms a single Soroban contract invocation.
 * `prepareTransaction` runs `simulateTransaction` and attaches the footprint,
 * authorization entries and resource fee before the wallet signs.
 * @returns The confirmed transaction hash.
 */
export async function invokeSorobanContract(
  source: string,
  operation: xdr.Operation,
  sign: TransactionSigner,
): Promise<string> {
  if (!STELLAR_CONFIG.sorobanRpcUrl)
    throw new Error('NEXT_PUBLIC_SOROBAN_RPC_URL is not configured.');
  const server = new rpc.Server(STELLAR_CONFIG.sorobanRpcUrl);
  const tx = new TransactionBuilder(await server.getAccount(source), {
    fee: BASE_FEE,
    networkPassphrase: STELLAR_CONFIG.passphrase,
  })
    .addOperation(operation)
    .setTimeout(SOROBAN_TX_TIMEOUT_SECONDS)
    .build();

  const prepared = await server.prepareTransaction(tx);
  const signedXdr = await sign(prepared.toXDR(), STELLAR_CONFIG.passphrase, source);
  const sent = await server.sendTransaction(
    TransactionBuilder.fromXDR(signedXdr, STELLAR_CONFIG.passphrase),
  );
  if (sent.status !== 'PENDING' && sent.status !== 'DUPLICATE') {
    throw new Error(`Soroban transaction was not accepted (${sent.status}).`);
  }

  const result = await server.pollTransaction(sent.hash, { attempts: SOROBAN_POLL_ATTEMPTS });
  if (result.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(
      result.status === rpc.Api.GetTransactionStatus.FAILED
        ? `Soroban transaction ${sent.hash} failed.`
        : `Soroban transaction ${sent.hash} was not confirmed in time.`,
    );
  }
  return sent.hash;
}

export interface StrictReceivePathQuote {
  sourceAsset: Asset;
  sourceAssetCode: string;
  sourceAssetIssuer?: string;
  sourceAmount: string;
  destAsset: Asset;
  destAssetCode: string;
  destAssetIssuer?: string;
  destAmount: string;
  path: Asset[];
  conversionRate: number;
  sendMax: string;
  slippageTolerancePercent: number;
}

export interface SupportedPaymentAsset {
  code: string;
  name: string;
  asset: Asset;
}

export const CLINICAL_PAYMENT_ASSETS: Record<'testnet' | 'mainnet', SupportedPaymentAsset[]> = {
  testnet: [
    { code: 'XLM', name: 'Stellar Lumens', asset: Asset.native() },
    { code: 'USDC', name: 'USD Coin', asset: new Asset('USDC', 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5') },
    { code: 'EURC', name: 'Euro Coin', asset: new Asset('EURC', 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5') },
  ],
  mainnet: [
    { code: 'XLM', name: 'Stellar Lumens', asset: Asset.native() },
    { code: 'USDC', name: 'USD Coin', asset: new Asset('USDC', 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN') },
    { code: 'EURC', name: 'Euro Coin', asset: new Asset('EURC', 'GDZCEWJ5TVXUTFH6V5CVDZDDE4P74IIVRCMMDQS75WKMWHRCKIAZHA') },
  ],
};

export function parseStellarAsset(assetStr: string): Asset {
  if (!assetStr || assetStr === 'native' || assetStr === 'XLM' || assetStr === 'stellar:native') {
    return Asset.native();
  }
  const parts = assetStr.split(':');
  if (parts.length === 3 && parts[0] === 'stellar') {
    return new Asset(parts[1], parts[2]);
  }
  if (parts.length === 2) {
    return new Asset(parts[0], parts[1]);
  }
  return Asset.native();
}

/**
 * Queries Horizon /paths/strict-receive for source assets and maximum send limits.
 * Computes exact conversion rates and slippage bounds.
 */
export async function findStrictReceivePaymentPaths(options: {
  sourceAccountOrAssets: string | Asset[];
  destAsset: Asset;
  destAmount: string;
  slippageTolerancePercent?: number;
}): Promise<StrictReceivePathQuote[]> {
  const slippagePercent = options.slippageTolerancePercent ?? 1.0;
  const endpoint = getHealthyEndpoint();
  const server = new Horizon.Server(endpoint);

  const response = await callHorizon(async () => {
    return await server
      .strictReceivePaths(options.sourceAccountOrAssets, options.destAsset, options.destAmount)
      .call();
  });

  if (!response || !response.records || response.records.length === 0) {
    return [];
  }

  const destAmountNum = Number(options.destAmount);

  return (response.records as Array<{
    source_asset_type: string;
    source_asset_code: string;
    source_asset_issuer: string;
    source_amount: string;
    path: Array<{ asset_type: string; asset_code: string; asset_issuer: string }>;
  }>).map((record) => {
    const sourceAsset =
      record.source_asset_type === 'native'
        ? Asset.native()
        : new Asset(record.source_asset_code, record.source_asset_issuer);

    const sourceAmountNum = Number(record.source_amount);
    const multiplier = 1 + slippagePercent / 100;
    const sendMaxCalculated = (sourceAmountNum * multiplier).toFixed(7);

    const pathAssets: Asset[] = (record.path || []).map((hop: { asset_type: string; asset_code: string; asset_issuer: string }) =>
      hop.asset_type === 'native' ? Asset.native() : new Asset(hop.asset_code, hop.asset_issuer),
    );

    const conversionRate = destAmountNum > 0 ? sourceAmountNum / destAmountNum : 0;

    return {
      sourceAsset,
      sourceAssetCode: sourceAsset.isNative() ? 'XLM' : sourceAsset.getCode(),
      sourceAssetIssuer: sourceAsset.isNative() ? undefined : sourceAsset.getIssuer(),
      sourceAmount: record.source_amount,
      destAsset: options.destAsset,
      destAssetCode: options.destAsset.isNative() ? 'XLM' : options.destAsset.getCode(),
      destAssetIssuer: options.destAsset.isNative() ? undefined : options.destAsset.getIssuer(),
      destAmount: options.destAmount,
      path: pathAssets,
      conversionRate,
      sendMax: sendMaxCalculated,
      slippageTolerancePercent: slippagePercent,
    };
  });
}

/**
 * Assembles and builds a PathPaymentStrictReceive transaction with strict slippage bounds.
 */
export async function buildPathPaymentStrictReceiveTransaction(options: {
  sourceAddress: string;
  destinationAddress: string;
  sendAsset: Asset;
  sendMax: string;
  destAsset: Asset;
  destAmount: string;
  path?: Asset[];
  fee?: string;
  timeoutSeconds?: number;
}) {
  const endpoint = getHealthyEndpoint();
  const server = new Horizon.Server(endpoint);
  const account = await callHorizon(() => server.loadAccount(options.sourceAddress));

  const tx = new TransactionBuilder(account, {
    fee: options.fee || BASE_FEE,
    networkPassphrase: STELLAR_CONFIG.passphrase,
  })
    .addOperation(
      Operation.pathPaymentStrictReceive({
        sendAsset: options.sendAsset,
        sendMax: options.sendMax,
        destination: options.destinationAddress,
        destAsset: options.destAsset,
        destAmount: options.destAmount,
        path: options.path || [],
      }),
    )
    .setTimeout(options.timeoutSeconds ?? 30)
    .build();

  return tx;
}

