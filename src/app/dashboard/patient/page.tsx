'use client';

export const dynamic = 'force-dynamic';

import { useMemo } from 'react';
import Link from 'next/link';
import { useInfiniteQuery } from '@tanstack/react-query';
import { fetchRecordsPaginated } from '@/services/api.service';
import { useWalletStore } from '@/store/useWalletStore';
import {
  FileText,
  Shield,
  Clock,
  CheckCircle2,
  AlertCircle,
  Eye,
  Download,
  Stethoscope,
  Calendar,
  ChevronRight,
  TrendingUp,
  TrendingDown,
  Lock,
  Unlock,
  Plus,
  ArrowUpRight,
  Activity,
  Loader2,
  Wallet,
} from 'lucide-react';
import { KpiSkeleton } from '@/components/ui/KpiSkeleton';
import { DashboardSkeleton } from '@/components/ui/DashboardSkeleton';
import { AppointmentSkeleton } from '@/components/ui/AppointmentSkeleton';
import RecordSearch from '@/components/records/RecordSearch';
import { useRecordSearch } from '@/hooks/useRecordSearch';
import type { MedicalRecord } from '@/types';
import { EmptyRecordState } from '@/components/records/EmptyRecordState';
import RecoveryBackupWizard from '@/components/recovery/RecoveryBackupWizard';
import ClinicalTrialEnrollment from '@/components/trials/ClinicalTrialEnrollment';

/* ─── Sparkline ─────────────────────────────────────────────────── */
function Sparkline({ values, color }: { values: number[]; color: string }) {
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  const h = 28;
  const w = 56;
  const step = w / (values.length - 1);
  const points = values.map((v, i) => `${i * step},${h - ((v - min) / range) * h}`).join(' ');
  return (
    <svg width={w} height={h} className="overflow-visible" aria-hidden="true">
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.8"
      />
    </svg>
  );
}

/* ─── Ring chart ─────────────────────────────────────────────────── */
function RingChart({ pct, size = 44 }: { pct: number; size?: number }) {
  const r = (size - 6) / 2;
  const circ = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} className="-rotate-90" aria-hidden="true">
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="rgba(255,255,255,0.06)"
        strokeWidth="3"
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="#00C896"
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray={`${(circ * pct) / 100} ${circ}`}
      />
    </svg>
  );
}

/* ─── Data ──────────────────────────────────────────────────────── */
const kpis = [
  {
    icon: FileText,
    label: 'Total Records',
    value: '24',
    change: '+2',
    trend: 'up',
    sub: 'this month',
    spark: [8, 12, 10, 15, 14, 18, 22, 24],
  },
  {
    icon: Stethoscope,
    label: 'Active Doctors',
    value: '3',
    change: null,
    trend: null,
    sub: '2 pending requests',
    spark: [1, 2, 2, 3, 3, 2, 3, 3],
  },
  {
    icon: Shield,
    label: 'Access Grants',
    value: '7',
    change: '−1',
    trend: 'down',
    sub: '1 expiring soon',
    spark: [5, 6, 7, 8, 7, 8, 7, 7],
  },
  {
    icon: Clock,
    label: 'Last Activity',
    value: '2h',
    change: null,
    trend: null,
    sub: 'Record viewed',
    spark: [3, 5, 2, 6, 4, 7, 5, 8],
  },
];

const fallbackRecords = [
  {
    id: 'HS-001337',
    type: 'Blood Test Results',
    doctor: 'Dr. Sarah Smith',
    date: 'Jun 3, 2025',
    status: 'verified',
  },
  {
    id: 'HS-001290',
    type: 'MRI Scan Report',
    doctor: 'Dr. James Wilson',
    date: 'May 28, 2025',
    status: 'verified',
  },
  {
    id: 'HS-001201',
    type: 'Prescription',
    doctor: 'Dr. Sarah Smith',
    date: 'May 15, 2025',
    status: 'pending',
  },
  {
    id: 'HS-001188',
    type: 'Annual Physical',
    doctor: 'Dr. Emily Chen',
    date: 'May 1, 2025',
    status: 'verified',
  },
  {
    id: 'HS-001102',
    type: 'Cardiology Report',
    doctor: 'Dr. James Wilson',
    date: 'Apr 20, 2025',
    status: 'verified',
  },
];

const grants = [
  {
    name: 'Dr. Sarah Smith',
    role: 'General Practitioner',
    expiry: 'Aug 20, 2025',
    pct: 70,
    active: true,
  },
  { name: 'Dr. James Wilson', role: 'Radiologist', expiry: 'Jun 28, 2025', pct: 20, active: true },
  { name: 'City Medical Lab', role: 'Laboratory', expiry: 'Jun 15, 2025', pct: 8, active: false },
];

const appointments = [
  {
    doctor: 'Dr. Sarah Smith',
    type: 'Follow-up',
    date: 'Jun 10',
    time: '10:00 AM',
    confirmed: true,
  },
  {
    doctor: 'Dr. Emily Chen',
    type: 'Annual Physical',
    date: 'Jun 18',
    time: '2:30 PM',
    confirmed: false,
  },
];

const activity = [
  {
    action: 'Record Accessed',
    by: 'Dr. Sarah Smith',
    hash: 'GAKP...X7QM',
    time: '2h ago',
    type: 'read',
  },
  {
    action: 'Access Granted',
    by: 'You → Dr. J. Wilson',
    hash: 'GCMR...4BNP',
    time: '1d ago',
    type: 'grant',
  },
  {
    action: 'Record Added',
    by: 'Dr. Sarah Smith',
    hash: 'GPX2...9KLF',
    time: '3d ago',
    type: 'write',
  },
  {
    action: 'Record Verified',
    by: 'Stellar Network',
    hash: 'GAPH...2MQT',
    time: '5d ago',
    type: 'verify',
  },
];

const typeColor: Record<string, string> = {
  read: '#8E9E99',
  grant: '#EAB308',
  write: '#00C896',
  verify: '#00C896',
};

export default function PatientDashboard() {
  const { publicKey } = useWalletStore();

  const {
    data: recordsData,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isLoading: recordsLoading,
  } = useInfiniteQuery({
    queryKey: ['patient-records-paginated', publicKey],
    queryFn: ({ pageParam }) => fetchRecordsPaginated(publicKey!, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: !!publicKey,
  });

  const allRecords = useMemo<MedicalRecord[]>(
    () => recordsData?.pages.flatMap((p) => p.data) ?? [],
    [recordsData],
  );
  const search = useRecordSearch(allRecords);

  const records = recordsData
    ? search.results.map((r) => ({
        id: r.id,
        type: r.diagnosis,
        doctor: r.doctorName,
        date: new Date(r.date).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        }),
        status: 'verified' as const,
      }))
    : fallbackRecords;

  const totalRecords = recordsData?.pages[0]?.total ?? records.length;

  return (
    <div>
      {/* ── Page header ─────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 mb-8">
        <div>
          <p className="text-xs text-text-3 mb-1">Welcome back</p>
          <h1 className="text-2xl font-bold tracking-tight text-text-1">John Doe</h1>
          <div className="flex items-center gap-2 mt-2">
            <span className="badge-green">Patient</span>
            <span className="text-2xs text-text-3 font-mono">GAKP...X7QM</span>
          </div>
        </div>
        <div className="flex items-center gap-2.5">
          <button className="btn-secondary rounded-[9px] text-xs py-2 px-3.5">
            <Plus className="w-3.5 h-3.5" />
            Add Record
          </button>
          <button className="btn-primary rounded-[9px] text-xs py-2 px-3.5">
            <Shield className="w-3.5 h-3.5" />
            Manage Access
          </button>
        </div>
      </div>

      {/* ── KPI cards ────────────────────────────────────────────── */}
      {recordsLoading ? (
        <KpiSkeleton count={4} />
      ) : (
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-4 mb-7">
          {kpis.map((k, i) => (
            <div
              key={i}
              className="card rounded-[14px] p-5"
              style={{ background: 'var(--bg-card)', border: '1px solid rgba(255,255,255,0.07)' }}
            >
              <div className="flex items-start justify-between mb-4">
                <div
                  className="w-8 h-8 rounded-[9px] flex items-center justify-center"
                  style={{
                    background: 'rgba(0,200,150,0.1)',
                    border: '1px solid rgba(0,200,150,0.12)',
                  }}
                >
                  <k.icon className="w-4 h-4" style={{ color: '#00C896' }} />
                </div>
                <Sparkline values={k.spark} color={k.trend === 'down' ? '#F87171' : '#00C896'} />
              </div>
              <p className="text-2xl font-bold tracking-tight text-text-1">{k.value}</p>
              <p className="text-xs text-text-3 mt-0.5">{k.label}</p>
              <div className="flex items-center gap-1 mt-2">
                {k.trend === 'up' && (
                  <TrendingUp className="w-3 h-3" style={{ color: '#00C896' }} />
                )}
                {k.trend === 'down' && (
                  <TrendingDown className="w-3 h-3" style={{ color: '#F87171' }} />
                )}
                {k.change && (
                  <span
                    className="text-2xs font-semibold"
                    style={{ color: k.trend === 'up' ? '#00C896' : '#F87171' }}
                  >
                    {k.change}
                  </span>
                )}
                <span className="text-2xs text-text-3">{k.sub}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Main grid ────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-5 mb-5">
        {/* Records table */}
        <div
          className="xl:col-span-2 rounded-[14px] overflow-hidden"
          style={{ background: 'var(--bg-card)', border: '1px solid rgba(255,255,255,0.07)' }}
        >
          <div
            className="px-5 py-4 flex items-center justify-between"
            style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}
          >
            <div>
              <h2 className="text-sm font-semibold text-text-1">Medical Records</h2>
              <p className="text-xs text-text-3 mt-0.5">
                {totalRecords} records total · {records.length} loaded
              </p>
            </div>
            <Link
              href="/dashboard/patient/records"
              className="flex items-center gap-1 text-xs font-medium transition-colors hover:text-text-1"
              style={{ color: '#00C896' }}
            >
              View all <ChevronRight className="w-3.5 h-3.5" />
            </Link>
          </div>

          {recordsData && <RecordSearch search={search} />}

          {recordsLoading ? (
            <DashboardSkeleton rows={4} />
          ) : records.length === 0 ? (
            <EmptyRecordState />
          ) : (
            <table className="data-table w-full">
              <thead>
                <tr>
                  <th>Type</th>
                  <th className="hidden sm:table-cell">Doctor</th>
                  <th className="hidden md:table-cell">ID</th>
                  <th>Date</th>
                  <th>Status</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {records.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <div className="flex items-center gap-2.5">
                        <div
                          className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
                          style={{
                            background: 'var(--bg-inset)',
                            border: '1px solid rgba(255,255,255,0.06)',
                          }}
                        >
                          <FileText className="w-3.5 h-3.5 text-text-3" />
                        </div>
                        <span className="text-xs font-medium text-text-1 truncate max-w-[120px]">
                          {r.type}
                        </span>
                      </div>
                    </td>
                    <td className="hidden sm:table-cell text-xs text-text-2">{r.doctor}</td>
                    <td className="hidden md:table-cell text-2xs font-mono text-text-3">{r.id}</td>
                    <td className="text-xs text-text-2 whitespace-nowrap">{r.date}</td>
                    <td>
                      {r.status === 'verified' ? (
                        <span className="badge-green">
                          <CheckCircle2 className="w-2.5 h-2.5" />
                          verified
                        </span>
                      ) : (
                        <span className="badge-yellow">
                          <AlertCircle className="w-2.5 h-2.5" />
                          pending
                        </span>
                      )}
                    </td>
                    <td>
                      <div className="flex items-center gap-1 justify-end">
                        <button className="btn-icon rounded-md w-7 h-7" aria-label="View record">
                          <Eye className="w-3.5 h-3.5" />
                        </button>
                        <button
                          className="btn-icon rounded-md w-7 h-7"
                          aria-label="Download record"
                        >
                          <Download className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {hasNextPage && (
            <div
              className="px-5 py-3 flex justify-center"
              style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}
            >
              <button
                onClick={() => fetchNextPage()}
                disabled={isFetchingNextPage}
                className="flex items-center gap-2 text-xs font-medium transition-colors hover:text-text-1 disabled:opacity-50"
                style={{ color: '#00C896' }}
              >
                {isFetchingNextPage ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…
                  </>
                ) : (
                  'Load more records'
                )}
              </button>
            </div>
          )}
        </div>

        {/* Right column */}
        <div className="space-y-4">
          {/* Access grants */}
          <div
            className="rounded-[14px] p-5"
            style={{ background: 'var(--bg-card)', border: '1px solid rgba(255,255,255,0.07)' }}
          >
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-sm font-semibold text-text-1">Access Grants</h2>
                <p className="text-xs text-text-3 mt-0.5">3 active providers</p>
              </div>
              <button
                className="text-xs font-medium transition-colors"
                style={{ color: '#00C896' }}
              >
                Manage
              </button>
            </div>
            <div className="space-y-3">
              {grants.map((g, i) => (
                <div key={i} className="flex items-center gap-3">
                  <RingChart pct={g.pct} size={36} />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-text-1 truncate">{g.name}</p>
                    <p className="text-2xs text-text-3 truncate">Expires {g.expiry}</p>
                  </div>
                  <button
                    className="btn-icon w-7 h-7 rounded-lg"
                    aria-label={g.active ? 'Revoke access' : 'Grant access'}
                    style={g.active ? { color: '#00C896' } : {}}
                  >
                    {g.active ? (
                      <Unlock className="w-3.5 h-3.5" />
                    ) : (
                      <Lock className="w-3.5 h-3.5" />
                    )}
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Appointments */}
          <div
            className="rounded-[14px] p-5"
            style={{ background: 'var(--bg-card)', border: '1px solid rgba(255,255,255,0.07)' }}
          >
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-text-1">Upcoming</h2>
              <button className="btn-icon w-6 h-6 rounded-md" aria-label="Add appointment">
                <Plus className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="space-y-2.5">
              {recordsLoading ? (
                <AppointmentSkeleton rows={2} />
              ) : (
                appointments.map((a, i) => (
                  <div
                    key={i}
                    className="flex items-start gap-3 p-3 rounded-[10px]"
                    style={{
                      background: 'var(--bg-inset)',
                      border: '1px solid rgba(255,255,255,0.05)',
                    }}
                  >
                    <div
                      className="w-8 h-8 rounded-lg flex flex-col items-center justify-center shrink-0"
                      style={{
                        background: 'rgba(0,200,150,0.1)',
                        border: '1px solid rgba(0,200,150,0.12)',
                      }}
                    >
                      <Calendar className="w-3.5 h-3.5" style={{ color: '#00C896' }} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-text-1 truncate">{a.type}</p>
                      <p className="text-2xs text-text-3">{a.doctor}</p>
                      <p className="text-2xs text-text-3 mt-0.5">
                        {a.date} · {a.time}
                      </p>
                    </div>
                    {a.confirmed ? (
                      <span className="badge-green shrink-0">confirmed</span>
                    ) : (
                      <span className="badge-yellow shrink-0">pending</span>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ── Emergency recovery backup ─────────────────────────────── */}
      {publicKey && (
        <div
          className="rounded-[14px] p-5 mb-6"
          style={{ background: 'var(--bg-card)', border: '1px solid rgba(255,255,255,0.07)' }}
        >
          <h2 className="text-sm font-semibold text-text-1">Emergency Recovery Backup</h2>
          <p className="text-xs text-text-3 mt-0.5 mb-4">Optional · stays on your device</p>
          <RecoveryBackupWizard account={publicKey} />
        </div>
      )}

      {/* ── Change wallet (account merge) ──────────────────────────── */}
      {publicKey && (
        <div
          className="rounded-[14px] p-5 mb-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4"
          style={{ background: 'var(--bg-card)', border: '1px solid rgba(255,255,255,0.07)' }}
        >
          <div>
            <h2 className="text-sm font-semibold text-text-1">Changing wallet?</h2>
            <p className="text-xs text-text-3 mt-0.5">
              Move your remaining XLM and assets to a new wallet, reassign your on-chain record
              pointers and close the old account safely.
            </p>
          </div>
          <Link
            href="/dashboard/patient/merge"
            className="btn-primary rounded-[9px] text-xs py-2 px-3.5 shrink-0"
          >
            <Wallet className="w-3.5 h-3.5" />
            Start account merge
          </Link>
        </div>
      )}

      {/* ── Anonymous clinical trial enrollment (#31) ────────────── */}
      {publicKey && (
        <div className="mb-6">
          <ClinicalTrialEnrollment patientAddress={publicKey} />
        </div>
      )}

      {/* ── On-chain activity ─────────────────────────────────────── */}
      <div
        className="rounded-[14px] overflow-hidden"
        style={{ background: 'var(--bg-card)', border: '1px solid rgba(255,255,255,0.07)' }}
      >
        <div
          className="px-5 py-4 flex items-center justify-between"
          style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}
        >
          <div>
            <h2 className="text-sm font-semibold text-text-1">On-Chain Activity</h2>
            <p className="text-xs text-text-3 mt-0.5">All actions recorded on Stellar</p>
          </div>
          <div
            className="flex items-center gap-1.5 text-xs font-medium"
            style={{ color: '#00C896' }}
          >
            <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse-dot" />
            Live
          </div>
        </div>

        <div
          className="divide-y"
          style={
            {
              '--tw-divide-opacity': '1',
              borderColor: 'rgba(255,255,255,0.05)',
            } as React.CSSProperties
          }
        >
          {activity.map((ev, i) => (
            <div
              key={i}
              className="px-5 py-3.5 flex items-center justify-between hover:bg-surface-hover transition-colors"
            >
              <div className="flex items-center gap-3">
                <div
                  className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
                  style={{
                    background: 'var(--bg-inset)',
                    border: '1px solid rgba(255,255,255,0.06)',
                  }}
                >
                  <Activity className="w-3 h-3" style={{ color: typeColor[ev.type] }} />
                </div>
                <div>
                  <span className="text-sm font-medium text-text-1">{ev.action}</span>
                  <span className="text-sm text-text-2"> · {ev.by}</span>
                </div>
              </div>
              <div className="flex items-center gap-4 shrink-0 ml-4">
                <span className="text-xs font-mono text-text-3 hidden sm:block">{ev.hash}</span>
                <span className="text-xs text-text-3">{ev.time}</span>
                <button
                  className="btn-icon w-6 h-6 rounded-md"
                  aria-label="View on-chain transaction"
                >
                  <ArrowUpRight className="w-3 h-3" />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
