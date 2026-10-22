import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import AccountMergeWizard from '@/app/dashboard/patient/merge/AccountMergeWizard';
import {
  confirmAccountClosed,
  freighterSigner,
  lookupMergeAccount,
  submitTransaction,
  waitForTransactionConfirmation,
  type MergeAccountSnapshot,
} from '@/lib/stellar';

jest.mock('@/hooks/useToast', () => ({ useToast: jest.fn() }));

jest.mock('@/store/useWalletStore', () => ({
  useWalletStore: () => ({ publicKey: 'GB2UKWUW54RZ3JCVQ6C4J4QMKU52RELWCFW6JHS3QWHOGVTH3W5BBZ43' }),
}));

jest.mock('@/lib/stellar', () => {
  const actual = jest.requireActual('@/lib/stellar');
  return {
    ...actual,
    lookupMergeAccount: jest.fn(),
    submitTransaction: jest.fn(),
    waitForTransactionConfirmation: jest.fn(),
    confirmAccountClosed: jest.fn(),
    freighterSigner: jest.fn(),
  };
});

const SOURCE_KEY = 'GB2UKWUW54RZ3JCVQ6C4J4QMKU52RELWCFW6JHS3QWHOGVTH3W5BBZ43';
const DESTINATION_KEY = 'GBZZ2SNYBJ7MQYKDWOLHLN6K2GR6DGITDBRDUNWU6DUPD6EMOG6PRO6B';
const ISSUER = 'GB7LI6QMTB6YBTZR6L7GD7DDOAGEUVI2RCKQOU2UGQNKTQU7YMKICUNG';

const mockedLookup = lookupMergeAccount as jest.MockedFunction<typeof lookupMergeAccount>;
const mockedSubmit = submitTransaction as jest.MockedFunction<typeof submitTransaction>;
const mockedWait = waitForTransactionConfirmation as jest.MockedFunction<
  typeof waitForTransactionConfirmation
>;
const mockedClosed = confirmAccountClosed as jest.MockedFunction<typeof confirmAccountClosed>;
const mockedSigner = freighterSigner as jest.MockedFunction<typeof freighterSigner>;

function sourceSnapshot(): MergeAccountSnapshot {
  return {
    publicKey: SOURCE_KEY,
    sequence: '100',
    nativeBalance: '10.0000000',
    subentryCount: 2,
    trustlines: [
      {
        assetCode: 'USDC',
        assetIssuer: ISSUER,
        assetType: 'credit_alphanum4',
        balance: '25.0000000',
        limit: '1000.0000000',
        sponsored: false,
      },
    ],
    dataEntries: [{ key: 'medical_record:HS-001', value: SOURCE_KEY }],
  };
}

function destinationSnapshot(withTrustline: boolean): MergeAccountSnapshot {
  return {
    publicKey: DESTINATION_KEY,
    sequence: '200',
    nativeBalance: '4.0000000',
    subentryCount: 1,
    trustlines: withTrustline
      ? [
          {
            assetCode: 'USDC',
            assetIssuer: ISSUER,
            assetType: 'credit_alphanum4',
            balance: '10.0000000',
            limit: '1000.0000000',
            sponsored: false,
          },
        ]
      : [],
    dataEntries: [],
  };
}

function mockLookup(destinationHasTrustline: boolean, destinationExists = true) {
  mockedLookup.mockImplementation(async (publicKey: string) => {
    if (publicKey === SOURCE_KEY) {
      return { status: 'found' as const, account: sourceSnapshot() };
    }
    if (publicKey === DESTINATION_KEY) {
      return destinationExists
        ? { status: 'found' as const, account: destinationSnapshot(destinationHasTrustline) }
        : { status: 'not-found' as const };
    }
    return { status: 'not-found' as const };
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedSigner.mockImplementation(async (envelopeXdr: string) => envelopeXdr);
  mockedSubmit.mockResolvedValue('TX_HASH');
  mockedWait.mockResolvedValue(true);
  mockedClosed.mockResolvedValue(true);
});

describe('AccountMergeWizard', () => {
  it('rejects a destination that is not a valid Stellar public key', async () => {
    mockLookup(true);
    render(<AccountMergeWizard />);

    fireEvent.change(screen.getByLabelText('New wallet public key'), {
      target: { value: 'not-a-key' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Check new wallet' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('not a valid Stellar public key');
    expect(mockedLookup).not.toHaveBeenCalledWith('not-a-key');
  });

  it('reports a destination that does not exist on the network', async () => {
    mockLookup(true, false);
    render(<AccountMergeWizard />);

    fireEvent.change(screen.getByLabelText('New wallet public key'), {
      target: { value: DESTINATION_KEY },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Check new wallet' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('No account exists');
  });

  it('blocks the merge when the destination has no trustline for a held asset', async () => {
    mockLookup(false);
    render(<AccountMergeWizard />);

    await screen.findByText('10.0000000 XLM');

    fireEvent.change(screen.getByLabelText('New wallet public key'), {
      target: { value: DESTINATION_KEY },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Check new wallet' }));

    expect(await screen.findByText('no trustline')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
  });

  it('reassigns the record pointers, merges the accounts and confirms the closure', async () => {
    mockLookup(true);
    render(<AccountMergeWizard />);

    await screen.findByText('10.0000000 XLM');

    fireEvent.change(screen.getByLabelText('New wallet public key'), {
      target: { value: DESTINATION_KEY },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Check new wallet' }));

    expect(await screen.findByText('ready')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText('medical_record:HS-001')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reassign pointers to new wallet' }));

    await waitFor(() => {
      expect(mockedSigner).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        DESTINATION_KEY,
      );
    });
    expect(mockedSubmit).toHaveBeenCalledTimes(1);

    const continueButton = screen.getByRole('button', { name: 'Continue' });
    await waitFor(() => expect(continueButton).not.toBeDisabled());
    fireEvent.click(continueButton);

    expect(await screen.findByText('Final transaction breakdown')).toBeInTheDocument();
    expect(screen.getByText('9.9999900 XLM')).toBeInTheDocument();
    expect(screen.getByText('1.0000000 XLM')).toBeInTheDocument();

    const mergeButton = screen.getByRole('button', { name: 'Merge accounts' });
    expect(mergeButton).toBeDisabled();

    fireEvent.click(screen.getByRole('checkbox'));
    expect(mergeButton).not.toBeDisabled();

    fireEvent.click(mergeButton);

    expect(await screen.findByText('Account closed')).toBeInTheDocument();
    expect(mockedClosed).toHaveBeenCalledWith(SOURCE_KEY);
    expect(mockedSigner).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.any(String),
      SOURCE_KEY,
    );
  });
});
