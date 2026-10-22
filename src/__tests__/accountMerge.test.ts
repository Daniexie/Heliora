import { TransactionBuilder } from '@stellar/stellar-sdk';
import {
  BASE_RESERVE_XLM,
  buildAccountMergeTransaction,
  buildRecordPointerPlan,
  buildRecordPointerTransaction,
  compareAmounts,
  planAccountMerge,
  stroopsToXlm,
  subtractAmounts,
  xlmToStroops,
  type MergeAccountSnapshot,
} from '@/lib/stellar';

jest.mock('@/hooks/useToast', () => ({ useToast: jest.fn() }));

const SOURCE_KEY = 'GB2UKWUW54RZ3JCVQ6C4J4QMKU52RELWCFW6JHS3QWHOGVTH3W5BBZ43';
const DESTINATION_KEY = 'GBZZ2SNYBJ7MQYKDWOLHLN6K2GR6DGITDBRDUNWU6DUPD6EMOG6PRO6B';
const ISSUER = 'GB7LI6QMTB6YBTZR6L7GD7DDOAGEUVI2RCKQOU2UGQNKTQU7YMKICUNG';
const PASSPHRASE = 'Test SDF Network ; September 2015';

/** The SDK exposes the parsed operations as a union, so narrow it for assertions. */
type ParsedOperation = {
  type: string;
  destination?: string;
  name?: string;
  value?: Buffer | null;
};

function snapshot(overrides: Partial<MergeAccountSnapshot> = {}): MergeAccountSnapshot {
  return {
    publicKey: SOURCE_KEY,
    sequence: '100',
    nativeBalance: '10.0000000',
    subentryCount: 2,
    trustlines: [],
    dataEntries: [],
    ...overrides,
  };
}

describe('amount helpers', () => {
  it('converts XLM to stroops and back without losing precision', () => {
    expect(xlmToStroops('1.0000000')).toBe(10_000_000n);
    expect(xlmToStroops('0.0000001')).toBe(1n);
    expect(stroopsToXlm(10_000_000n)).toBe('1.0000000');
    expect(stroopsToXlm(1n)).toBe('0.0000001');
  });

  it('compares and subtracts decimal amounts', () => {
    expect(compareAmounts('10.5', '10.5')).toBe(0);
    expect(compareAmounts('10.4', '10.5')).toBe(-1);
    expect(compareAmounts('11', '10.5')).toBe(1);
    expect(subtractAmounts('100', '25.5')).toBe('74.5000000');
  });
});

describe('buildRecordPointerPlan', () => {
  it('rewrites pointers that reference the account being merged', () => {
    const plan = buildRecordPointerPlan(
      snapshot({
        dataEntries: [
          { key: 'medical_record:HS-001', value: SOURCE_KEY },
          { key: 'config.locale', value: 'en-US' },
        ],
      }),
      SOURCE_KEY,
      DESTINATION_KEY,
    );

    expect(plan.count).toBe(1);
    expect(plan.blocked).toHaveLength(0);
    expect(plan.updates[0]).toMatchObject({
      key: 'medical_record:HS-001',
      value: DESTINATION_KEY,
      previousValue: SOURCE_KEY,
      referencesSource: true,
    });
  });

  it('also carries over Heliora record pointers that do not embed the account key', () => {
    const plan = buildRecordPointerPlan(
      snapshot({
        dataEntries: [
          { key: 'medical_record:HS-002', value: 'cid:QmRecordHash' },
          { key: 'unrelated', value: 'value' },
        ],
      }),
      SOURCE_KEY,
      DESTINATION_KEY,
    );

    expect(plan.count).toBe(1);
    expect(plan.updates[0]).toMatchObject({
      key: 'medical_record:HS-002',
      value: 'cid:QmRecordHash',
      referencesSource: false,
    });
  });

  it('blocks pointers that cannot be rewritten within the 64 byte data limit', () => {
    const plan = buildRecordPointerPlan(
      snapshot({
        dataEntries: [{ key: 'medical_record:HS-003', value: `${SOURCE_KEY}${'x'.repeat(20)}` }],
      }),
      SOURCE_KEY,
      DESTINATION_KEY,
    );

    expect(plan.updates).toHaveLength(0);
    expect(plan.blocked).toHaveLength(1);
    expect(plan.blocked[0]?.reason).toMatch(/64 bytes/);
  });
});

describe('planAccountMerge', () => {
  it('accepts a destination that trusts every asset of the source', () => {
    const plan = planAccountMerge(
      snapshot({
        trustlines: [
          {
            assetCode: 'USDC',
            assetIssuer: ISSUER,
            assetType: 'credit_alphanum4',
            balance: '25.000000',
            limit: '1000.000000',
            sponsored: false,
          },
        ],
      }),
      snapshot({
        publicKey: DESTINATION_KEY,
        nativeBalance: '4.0000000',
        subentryCount: 1,
        trustlines: [
          {
            assetCode: 'USDC',
            assetIssuer: ISSUER,
            assetType: 'credit_alphanum4',
            balance: '10.000000',
            limit: '1000.000000',
            sponsored: false,
          },
        ],
      }),
      SOURCE_KEY,
      DESTINATION_KEY,
    );

    expect(plan.blockers).toHaveLength(0);
    expect(plan.assets[0]).toMatchObject({ status: 'ready', required: true });
    expect(plan.xlmTransferredXlm).toBe('9.9999900');
    expect(plan.reclaimableReserveXlm).toBe(
      stroopsToXlm(BigInt(2 * BASE_RESERVE_XLM * 10_000_000)),
    );
    expect(plan.destinationBalanceAfterXlm).toBe('14.9999900');
  });

  it('blocks the merge when the destination has no trustline for a held asset', () => {
    const plan = planAccountMerge(
      snapshot({
        trustlines: [
          {
            assetCode: 'USDC',
            assetIssuer: ISSUER,
            assetType: 'credit_alphanum4',
            balance: '25.000000',
            limit: '1000.000000',
            sponsored: false,
          },
        ],
      }),
      snapshot({ publicKey: DESTINATION_KEY }),
      SOURCE_KEY,
      DESTINATION_KEY,
    );

    expect(plan.assets[0]).toMatchObject({ status: 'missing-trustline', required: true });
    expect(plan.blockers).toContain(
      'The new account has no trustline for USDC:GB7LI6QMTB6YBTZR6L7GD7DDOAGEUVI2RCKQOU2UGQNKTQU7YMKICUNG.',
    );
  });

  it('blocks the merge when the trustline limit cannot absorb the transferred balance', () => {
    const plan = planAccountMerge(
      snapshot({
        trustlines: [
          {
            assetCode: 'USDC',
            assetIssuer: ISSUER,
            assetType: 'credit_alphanum4',
            balance: '25.000000',
            limit: '1000.000000',
            sponsored: false,
          },
        ],
      }),
      snapshot({
        publicKey: DESTINATION_KEY,
        trustlines: [
          {
            assetCode: 'USDC',
            assetIssuer: ISSUER,
            assetType: 'credit_alphanum4',
            balance: '990.000000',
            limit: '1000.000000',
            sponsored: false,
          },
        ],
      }),
      SOURCE_KEY,
      DESTINATION_KEY,
    );

    expect(plan.assets[0]).toMatchObject({ status: 'insufficient-limit' });
    expect(plan.blockers).toHaveLength(1);
  });

  it('only warns when an unused asset is missing on the destination', () => {
    const plan = planAccountMerge(
      snapshot({
        trustlines: [
          {
            assetCode: 'USDC',
            assetIssuer: ISSUER,
            assetType: 'credit_alphanum4',
            balance: '0.000000',
            limit: '1000.000000',
            sponsored: false,
          },
        ],
      }),
      snapshot({ publicKey: DESTINATION_KEY }),
      SOURCE_KEY,
      DESTINATION_KEY,
    );

    expect(plan.blockers).toHaveLength(0);
    expect(plan.assets[0]).toMatchObject({ status: 'zero-balance', required: false });
    expect(plan.warnings).toHaveLength(1);
  });
});

describe('transaction builders', () => {
  it('builds a single AccountMerge operation towards the destination', () => {
    const transaction = buildAccountMergeTransaction({
      sourcePublicKey: SOURCE_KEY,
      sourceSequence: '100',
      destinationPublicKey: DESTINATION_KEY,
    });

    const operations = transaction.operations;
    expect(operations).toHaveLength(1);
    expect(transaction.source).toBe(SOURCE_KEY);

    const parsed = TransactionBuilder.fromXDR(transaction.toXDR(), PASSPHRASE);
    const op = parsed.operations[0] as ParsedOperation | undefined;
    expect(op?.type).toBe('accountMerge');
    expect(op?.destination).toBe(DESTINATION_KEY);
  });

  it('builds one ManageData operation per reassigned record pointer', () => {
    const transaction = buildRecordPointerTransaction({
      destinationPublicKey: DESTINATION_KEY,
      destinationSequence: '200',
      updates: [
        {
          key: 'medical_record:HS-001',
          previousKey: 'medical_record:HS-001',
          value: DESTINATION_KEY,
          previousValue: SOURCE_KEY,
          referencesSource: true,
        },
      ],
    });

    expect(transaction.operations).toHaveLength(1);
    expect(transaction.source).toBe(DESTINATION_KEY);

    const parsed = TransactionBuilder.fromXDR(transaction.toXDR(), PASSPHRASE);
    const op = parsed.operations[0] as ParsedOperation | undefined;
    expect(op?.type).toBe('manageData');
    expect(op?.name).toBe('medical_record:HS-001');
    expect(op?.value?.toString('utf8')).toBe(DESTINATION_KEY);
  });
});
