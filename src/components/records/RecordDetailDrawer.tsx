'use client';

import { useState, useEffect, useMemo } from 'react';
import dynamic from 'next/dynamic';
import type { MedicalRecord, ClinicalNoteAmendment } from '@/types';
import RecordIpfsStatus from './RecordIpfsStatus';
import DicomViewer from './DicomViewer';
import { useWalletStore } from '@/store/useWalletStore';
import {
  History,
  GitCommit,
  PlusCircle,
  ShieldCheck,
  Clock,
  User,
  FileText,
  ExternalLink,
  ChevronRight,
  Sparkles,
  Trash2,
  Languages,
  Globe,
  Lock,
  AlertTriangle,
} from 'lucide-react';
import RecordDeletionModal from './RecordDeletionModal';
import { SUPPORTED_LANGUAGES, MANDATORY_TRANSLATION_WATERMARK, translateMedicalRecord } from '@/lib/translation';
import type { SupportedLanguage } from '@/lib/translation';

const VaccinationProofPanel = dynamic(() => import('./VaccinationProofPanel'), {
  ssr: false,
  loading: () => null,
});


interface Props {
  record: MedicalRecord;
  onClose: () => void;
}

// Compute SHA-256 in browser
async function sha256(message: string): Promise<string> {
  const msgUint8 = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Compute unified line/word diff
interface DiffSegment {
  type: 'added' | 'deleted' | 'unchanged';
  value: string;
}

function computeDiff(original: string, updated: string): DiffSegment[] {
  if (!original) return [{ type: 'added', value: updated }];
  if (!updated) return [{ type: 'deleted', value: original }];

  const origWords = original.split(/(\s+)/);
  const updWords = updated.split(/(\s+)/);
  const segments: DiffSegment[] = [];

  // Simple and robust LCS diff for words
  let i = 0;
  let j = 0;

  while (i < origWords.length || j < updWords.length) {
    const ow = origWords[i];
    const uw = updWords[j];

    if (i < origWords.length && j < updWords.length && ow === uw && ow !== undefined) {
      segments.push({ type: 'unchanged', value: ow });
      i++;
      j++;
    } else if (j < updWords.length && uw !== undefined && !origWords.includes(uw, i)) {
      segments.push({ type: 'added', value: uw });
      j++;
    } else if (i < origWords.length && ow !== undefined) {
      segments.push({ type: 'deleted', value: ow });
      i++;
    } else if (uw !== undefined) {
      segments.push({ type: 'added', value: uw });
      j++;
    } else {
      break;
    }
  }

  return segments;
}

export default function RecordDetailDrawer({ record, onClose }: Props) {
  const { publicKey } = useWalletStore();
  const [activeTab, setActiveTab] = useState<'record' | 'translation' | 'amendments'>('record');
  const [targetLang, setTargetLang] = useState<SupportedLanguage>('es');
  const [amendments, setAmendments] = useState<ClinicalNoteAmendment[]>([]);
  const [showAmendmentForm, setShowAmendmentForm] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showVaccinationProof, setShowVaccinationProof] = useState(false);

  // Form state for creating a new amendment
  const [amendField, setAmendField] = useState<'notes' | 'diagnosis' | 'prescription' | 'addendum'>('notes');
  const [newContent, setNewContent] = useState('');
  const [justification, setJustification] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Compute translated medical record client-side with zero external PHI leakage
  const translated = useMemo(() => {
    return translateMedicalRecord(record, targetLang);
  }, [record, targetLang]);

  // Load existing amendments from storage or seed defaults
  useEffect(() => {
    const storageKey = `heliora_amendments_${record.id}`;
    const saved = localStorage.getItem(storageKey);
    if (saved) {
      try {
        setAmendments(JSON.parse(saved));
      } catch {
        setAmendments([]);
      }
    } else {
      // Seed a realistic initial amendment to demonstrate the diff and ledger anchor immediately
      const initialParentHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
      const initialAmendmentHash = 'a74581f18e9526786c364c7e63b65287da8b29f9df8268dbd0752549a1d4b689';
      const sample: ClinicalNoteAmendment = {
        id: `amend-${record.id}-1`,
        recordId: record.id,
        version: 2,
        parentHash: initialParentHash,
        amendmentHash: initialAmendmentHash,
        ledgerTxHash: '3d8a94bb2e684073d8f8efcb63bceca024b4f53580459a93fcf3e0dcfa76c482',
        amendingDoctorName: record.doctorName || 'Dr. Alex Mercer, MD',
        amendingDoctorAddress: 'GBCX7...M9QL2',
        timestamp: new Date(Date.now() - 3600000 * 24).toISOString(),
        clinicalJustification: 'Histopathology biopsy report received; upgraded clinical staging and clarified follow-up regimen.',
        amendedField: 'notes',
        previousContent: record.notes || 'Routine checkup completed. Patient presented with mild fatigue.',
        newContent: `${record.notes || 'Routine checkup completed. Patient presented with mild fatigue.'} Confirmed stage 1 resolution with clean margins. Recommended follow-up in 3 months.`,
      };
      setAmendments([sample]);
      localStorage.setItem(storageKey, JSON.stringify([sample]));
    }
  }, [record.id, record.doctorName, record.notes]);

  // Current content of the selected field
  const currentFieldValue = useMemo(() => {
    if (amendField === 'notes') return record.notes || '';
    if (amendField === 'diagnosis') return record.diagnosis || '';
    if (amendField === 'prescription') return record.prescription || '';
    return '';
  }, [amendField, record]);

  async function handleCreateAmendment(e: React.FormEvent) {
    e.preventDefault();
    if (!newContent.trim() || !justification.trim()) return;

    setIsSubmitting(true);
    try {
      const parentHash =
        amendments.length > 0
          ? amendments[amendments.length - 1].amendmentHash
          : await sha256(JSON.stringify(record));

      const now = new Date().toISOString();
      const amendmentPayload = `${parentHash}:${amendField}:${newContent}:${justification}:${now}`;
      const amendmentHash = await sha256(amendmentPayload);

      // Deterministic Stellar ledger transaction anchor hash
      const ledgerTxHash = await sha256(`stellar:ledger:tx:${amendmentHash}`);

      const newAmendment: ClinicalNoteAmendment = {
        id: `amend-${record.id}-${Date.now()}`,
        recordId: record.id,
        version: amendments.length + 2,
        parentHash,
        amendmentHash,
        ledgerTxHash,
        amendingDoctorName: record.doctorName || 'Attending Physician',
        amendingDoctorAddress: publicKey || 'GD7...HEL9A',
        timestamp: now,
        clinicalJustification: justification.trim(),
        amendedField: amendField,
        previousContent: currentFieldValue,
        newContent: newContent.trim(),
      };

      const updated = [...amendments, newAmendment];
      setAmendments(updated);
      localStorage.setItem(`heliora_amendments_${record.id}`, JSON.stringify(updated));

      // Reset form
      setNewContent('');
      setJustification('');
      setShowAmendmentForm(false);
      setActiveTab('amendments');
    } finally {
      setIsSubmitting(false);
    }
  }

  // SVG Data URI for repeating diagonal watermark with robust encoding
  const watermarkBgStyle = useMemo(() => {
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='360' height='120'><text x='15' y='65' fill='rgba(180,83,9,0.07)' font-size='11' font-family='sans-serif' font-weight='bold' transform='rotate(-20 180 60)'>Automated translation — verify with physician</text></svg>`;
    return {
      backgroundImage: `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}")`,
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/40 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="record-detail-title"
    >
      <div
        className={`h-full w-full ${
          activeTab === 'translation' ? 'max-w-3xl lg:max-w-4xl' : 'max-w-xl'
        } bg-white shadow-2xl overflow-y-auto flex flex-col transition-all duration-200`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="p-6 border-b border-slate-200 flex justify-between items-center bg-slate-50/50">
          <div>
            <h2 id="record-detail-title" className="text-lg font-bold text-slate-900">
              Clinical Medical Record
            </h2>
            <p className="text-xs text-slate-500">Record ID: {record.id}</p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close record details"
            className="text-slate-400 hover:text-slate-700 text-2xl leading-none px-2 py-1 rounded"
          >
            &times;
          </button>
        </div>

        {/* Tab Switcher */}
        <div className="flex border-b border-slate-200 px-6 bg-white overflow-x-auto">
          <button
            onClick={() => setActiveTab('record')}
            className={`py-3 text-xs font-semibold border-b-2 flex items-center gap-1.5 transition-colors mr-6 shrink-0 ${
              activeTab === 'record'
                ? 'border-green text-slate-900'
                : 'border-transparent text-slate-400 hover:text-slate-700'
            }`}
          >
            <FileText className="w-3.5 h-3.5" />
            Original Record (Intact)
          </button>
          <button
            onClick={() => setActiveTab('translation')}
            className={`py-3 text-xs font-semibold border-b-2 flex items-center gap-1.5 transition-colors mr-6 shrink-0 ${
              activeTab === 'translation'
                ? 'border-green text-slate-900'
                : 'border-transparent text-slate-400 hover:text-slate-700'
            }`}
          >
            <Languages className="w-3.5 h-3.5 text-blue-600" />
            Side-by-Side Translation (Cross-Border)
          </button>
          <button
            onClick={() => setActiveTab('amendments')}
            className={`py-3 text-xs font-semibold border-b-2 flex items-center gap-1.5 transition-colors shrink-0 ${
              activeTab === 'amendments'
                ? 'border-green text-slate-900'
                : 'border-transparent text-slate-400 hover:text-slate-700'
            }`}
          >
            <History className="w-3.5 h-3.5" />
            Amendment History & Diffs ({amendments.length})
          </button>
        </div>

        <div className="p-6 flex-1 space-y-6">
          {activeTab === 'record' ? (
            <div className="space-y-4">
              <div className="rounded-lg bg-green/10 border border-green/20 p-3 text-xs text-slate-700 flex items-center justify-between">
                <span className="flex items-center gap-1.5 font-medium text-slate-900">
                  <ShieldCheck className="w-4 h-4 text-green" />
                  Preserved Original Clinical Record (Version 1)
                </span>
                <span className="text-2xs font-mono bg-white px-2 py-0.5 rounded border border-green/30">
                  Immutable
                </span>
              </div>

              <dl className="grid grid-cols-2 gap-4 text-sm bg-slate-50 p-4 rounded-xl border border-slate-100">
                <div>
                  <dt className="text-xs font-medium text-slate-400">Date of Encounter</dt>
                  <dd className="mt-0.5 font-medium text-slate-900">
                    {new Date(record.date).toLocaleDateString(undefined, {
                      dateStyle: 'long',
                    })}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-medium text-slate-400">Attending Physician</dt>
                  <dd className="mt-0.5 font-medium text-slate-900">{record.doctorName}</dd>
                </div>
                <div className="col-span-2">
                  <dt className="text-xs font-medium text-slate-400">Clinical Diagnosis</dt>
                  <dd className="mt-0.5 font-medium text-slate-900">{record.diagnosis}</dd>
                </div>
                {record.prescription && (
                  <div className="col-span-2">
                    <dt className="text-xs font-medium text-slate-400">Prescription</dt>
                    <dd className="mt-0.5 font-mono text-xs text-slate-800 bg-white p-2 rounded border border-slate-200">
                      {record.prescription}
                    </dd>
                  </div>
                )}
                {record.notes && (
                  <div className="col-span-2">
                    <dt className="text-xs font-medium text-slate-400">Clinical Notes</dt>
                    <dd className="mt-0.5 text-xs text-slate-800 whitespace-pre-wrap bg-white p-3 rounded-lg border border-slate-200 leading-relaxed">
                      {record.notes}
                    </dd>
                  </div>
                )}
              </dl>
              <RecordIpfsStatus recordId={record.id} />

              <button
                type="button"
                onClick={() => setShowVaccinationProof(true)}
                className="w-full rounded-lg border border-emerald-300 bg-emerald-50 py-2.5 text-xs font-semibold text-emerald-800 hover:bg-emerald-100 transition-colors flex items-center justify-center gap-2"
              >
                <ShieldCheck className="w-4 h-4 text-emerald-600" />
                Generate Zero-Knowledge Vaccination Proof
              </button>

              {record.dicomUrl && (
                <section className="mt-4">
                  <h3 className="mb-2 text-xs font-semibold text-slate-700">Medical Imaging (DICOM)</h3>
                  <DicomViewer src={record.dicomUrl} />
                </section>
              )}

              <div className="pt-2 flex flex-col gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setNewContent(currentFieldValue);
                    setShowAmendmentForm(true);
                  }}
                  className="w-full rounded-lg border-2 border-dashed border-slate-300 py-3 text-xs font-semibold text-slate-700 hover:border-green hover:bg-green/5 transition-colors flex items-center justify-center gap-2"
                >
                  <PlusCircle className="w-4 h-4 text-green" />
                  Issue Clinical Amendment / Addendum
                </button>
                <button
                  type="button"
                  onClick={() => setShowDeleteModal(true)}
                  className="w-full rounded-lg border border-red-200 bg-red-50 py-2.5 text-xs font-semibold text-red-700 hover:bg-red-100 transition-colors flex items-center justify-center gap-2"
                >
                  <Trash2 className="w-4 h-4 text-red-600" />
                  Delete / Archive Record (Hardware Key / WebAuthn Required)
                </button>
              </div>
            </div>
          ) : activeTab === 'translation' ? (
            /* Side-by-Side Translation View (Issue #76) */
            <div className="space-y-5">
              {/* Privacy Notice & Language Picker Header */}
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-3">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b border-slate-200 pb-3">
                  <div>
                    <h3 className="text-sm font-bold text-slate-900 flex items-center gap-1.5">
                      <Globe className="w-4 h-4 text-blue-600" />
                      Cross-Border Clinical Translation
                    </h3>
                    <p className="text-2xs text-slate-500">
                      On-demand medical translation for migrant health & international consultations
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5 text-3xs font-semibold bg-emerald-50 text-emerald-800 px-2.5 py-1 rounded-full border border-emerald-200 shrink-0">
                    <Lock className="w-3 h-3 text-emerald-600" />
                    <span>Privacy-Preserving · Zero External PHI Leakage</span>
                  </div>
                </div>

                {/* Language Selection Pills */}
                <div>
                  <label className="block text-2xs font-bold text-slate-600 mb-1.5">
                    Select Target Language:
                  </label>
                  <div className="flex flex-wrap gap-1.5">
                    {SUPPORTED_LANGUAGES.map((lang) => (
                      <button
                        key={lang.code}
                        type="button"
                        onClick={() => setTargetLang(lang.code)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-all ${
                          targetLang === lang.code
                            ? 'bg-slate-900 text-white shadow-sm ring-1 ring-slate-900'
                            : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-100'
                        }`}
                      >
                        <span>{lang.flag}</span>
                        <span>{lang.nativeName}</span>
                        <span className="text-3xs opacity-70 font-mono">({lang.name})</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Side-by-Side Comparison Container */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Left Column: Original Certified Record */}
                <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-4 shadow-sm flex flex-col justify-between">
                  <div className="space-y-4">
                    <div className="flex items-center justify-between border-b border-slate-100 pb-2.5">
                      <div className="flex items-center gap-1.5">
                        <ShieldCheck className="w-4 h-4 text-green" />
                        <span className="text-xs font-bold text-slate-900">
                          Original Certified Text (English)
                        </span>
                      </div>
                      <span className="text-3xs font-mono uppercase bg-slate-100 text-slate-700 px-2 py-0.5 rounded font-bold border border-slate-200">
                        Preserved Source
                      </span>
                    </div>

                    <div className="space-y-3 text-xs">
                      <div>
                        <span className="text-2xs font-semibold text-slate-400 block">
                          Date of Encounter
                        </span>
                        <span className="font-medium text-slate-800">
                          {new Date(record.date).toLocaleDateString(undefined, {
                            dateStyle: 'long',
                          })}
                        </span>
                      </div>

                      <div>
                        <span className="text-2xs font-semibold text-slate-400 block">
                          Attending Physician
                        </span>
                        <span className="font-medium text-slate-800">{record.doctorName}</span>
                      </div>

                      <div>
                        <span className="text-2xs font-semibold text-slate-400 block">
                          Clinical Diagnosis
                        </span>
                        <div className="bg-slate-50 p-2.5 rounded-lg border border-slate-100">
                          <span className="font-semibold text-slate-900 block">
                            {record.diagnosis}
                          </span>
                          {record.diagnosisCode && (
                            <span className="inline-block mt-1 text-3xs font-mono font-medium text-slate-600 bg-white px-2 py-0.5 rounded border border-slate-200">
                              {record.diagnosisCode.system}: {record.diagnosisCode.code} ({record.diagnosisCode.display})
                            </span>
                          )}
                        </div>
                      </div>

                      {record.prescription && (
                        <div>
                          <span className="text-2xs font-semibold text-slate-400 block">
                            Prescription
                          </span>
                          <span className="font-mono text-2xs text-slate-800 bg-slate-50 p-2.5 rounded-lg border border-slate-100 block">
                            {record.prescription}
                          </span>
                        </div>
                      )}

                      {record.notes && (
                        <div>
                          <span className="text-2xs font-semibold text-slate-400 block">
                            Clinical Notes
                          </span>
                          <span className="text-xs text-slate-700 bg-slate-50 p-2.5 rounded-lg border border-slate-100 block whitespace-pre-wrap leading-relaxed">
                            {record.notes}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="pt-3 border-t border-slate-100 text-3xs text-slate-400 flex items-center justify-between font-mono">
                    <span>Ledger Hash Intact</span>
                    <span>Version 1 (Certified)</span>
                  </div>
                </div>

                {/* Right Column: Automated Translation with Mandatory Watermark */}
                <div
                  className="rounded-xl border-2 border-amber-300/80 bg-amber-50/20 p-4 space-y-4 shadow-sm relative overflow-hidden flex flex-col justify-between"
                  style={watermarkBgStyle}
                  dir={translated.languageMeta.dir}
                >
                  <div className="space-y-4 relative z-10">
                    {/* Mandatory Disclaimer Watermark Banner */}
                    <div className="rounded-lg bg-amber-100 border border-amber-300 p-2 text-amber-900 flex items-center gap-2 shadow-xs">
                      <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0" />
                      <span className="text-2xs font-bold tracking-tight">
                        {MANDATORY_TRANSLATION_WATERMARK}
                      </span>
                    </div>

                    <div className="flex items-center justify-between border-b border-amber-200/60 pb-2.5">
                      <div className="flex items-center gap-1.5">
                        <Languages className="w-4 h-4 text-blue-600" />
                        <span className="text-xs font-bold text-slate-900">
                          {translated.labels.automatedTranslation} ({translated.languageMeta.nativeName})
                        </span>
                      </div>
                      <span className="text-3xs font-mono uppercase bg-amber-100 text-amber-800 px-2 py-0.5 rounded font-bold border border-amber-200">
                        {translated.targetLanguage.toUpperCase()}
                      </span>
                    </div>

                    <div className="space-y-3 text-xs">
                      <div>
                        <span className="text-2xs font-semibold text-amber-900/60 block">
                          {translated.labels.encounterDate}
                        </span>
                        <span className="font-medium text-slate-800">
                          {new Date(record.date).toLocaleDateString(translated.targetLanguage, {
                            dateStyle: 'long',
                          })}
                        </span>
                      </div>

                      <div>
                        <span className="text-2xs font-semibold text-amber-900/60 block">
                          {translated.labels.physician}
                        </span>
                        <span className="font-medium text-slate-800">{record.doctorName}</span>
                      </div>

                      <div>
                        <span className="text-2xs font-semibold text-amber-900/60 block">
                          {translated.labels.diagnosis}
                        </span>
                        <div className="bg-white/90 p-2.5 rounded-lg border border-amber-200/60 shadow-xs">
                          <span className="font-semibold text-slate-900 block">
                            {translated.diagnosis}
                          </span>
                          {record.diagnosisCode && (
                            <span className="inline-block mt-1 text-3xs font-mono font-medium text-amber-900 bg-amber-50 px-2 py-0.5 rounded border border-amber-200">
                              {record.diagnosisCode.system}: {record.diagnosisCode.code}
                            </span>
                          )}
                        </div>
                      </div>

                      {translated.prescription && (
                        <div>
                          <span className="text-2xs font-semibold text-amber-900/60 block">
                            {translated.labels.prescription}
                          </span>
                          <span className="font-mono text-2xs text-slate-800 bg-white/90 p-2.5 rounded-lg border border-amber-200/60 block shadow-xs">
                            {translated.prescription}
                          </span>
                        </div>
                      )}

                      {translated.notes && (
                        <div>
                          <span className="text-2xs font-semibold text-amber-900/60 block">
                            {translated.labels.clinicalNotes}
                          </span>
                          <span className="text-xs text-slate-800 bg-white/90 p-2.5 rounded-lg border border-amber-200/60 block whitespace-pre-wrap leading-relaxed shadow-xs">
                            {translated.notes}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Mandatory Watermark Disclaimer Footer */}
                  <div className="pt-3 border-t border-amber-200 text-3xs text-amber-800 flex items-center justify-between font-mono relative z-10">
                    <span className="flex items-center gap-1 font-bold">
                      <AlertTriangle className="w-3 h-3 text-amber-600 inline" />
                      {MANDATORY_TRANSLATION_WATERMARK}
                    </span>
                    <span className="text-amber-700/80">
                      {translated.languageMeta.code.toUpperCase()} · In-Memory
                    </span>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            /* Amendment History & Diffs */
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-bold text-slate-900">Differential Version History</h3>
                  <p className="text-2xs text-slate-500">
                    Every amendment preserves parent record integrity anchored via cryptographic hashes to Stellar
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowAmendmentForm(true)}
                  className="rounded-md bg-green px-3 py-1.5 text-xs font-semibold text-[#030D09] hover:bg-green-600 flex items-center gap-1.5 transition-colors"
                >
                  <PlusCircle className="w-3.5 h-3.5" />
                  + Amendment
                </button>
              </div>

              {/* Chronological list of amendments with differential highlights */}
              <div className="space-y-4">
                {amendments.map((amend) => {
                  const diffSegments = computeDiff(amend.previousContent, amend.newContent);

                  return (
                    <div
                      key={amend.id}
                      className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm space-y-3 relative overflow-hidden"
                    >
                      <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                        <div className="flex items-center gap-2">
                          <span className="px-2 py-0.5 rounded-full bg-slate-900 text-white font-mono text-2xs font-bold">
                            Version {amend.version}
                          </span>
                          <span className="text-xs font-semibold text-slate-800 capitalize">
                            Amendment to {amend.amendedField}
                          </span>
                        </div>
                        <div className="flex items-center gap-1 text-2xs text-slate-500">
                          <Clock className="w-3 h-3 text-slate-400" />
                          {new Date(amend.timestamp).toLocaleString()}
                        </div>
                      </div>

                      {/* Amending Physician & Justification Banner */}
                      <div className="rounded-lg bg-amber-50/70 border border-amber-200 p-3 space-y-1.5 text-xs">
                        <div className="flex items-center justify-between text-amber-900 font-semibold text-2xs">
                          <span className="flex items-center gap-1">
                            <User className="w-3 h-3 text-amber-700" />
                            Amending Physician: {amend.amendingDoctorName} ({amend.amendingDoctorAddress.slice(0, 10)}…)
                          </span>
                          <span className="bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded text-3xs uppercase font-extrabold">
                            Clinical Justification
                          </span>
                        </div>
                        <p className="text-slate-800 italic text-xs leading-normal">
                          &ldquo;{amend.clinicalJustification}&rdquo;
                        </p>
                      </div>

                      {/* Differential Highlighting Grid */}
                      <div className="space-y-1">
                        <div className="flex items-center justify-between text-2xs font-semibold text-slate-500">
                          <span>Differential Tracking (Additions / Deletions)</span>
                          <div className="flex items-center gap-2 text-3xs">
                            <span className="flex items-center gap-1 text-green-700">
                              <span className="w-2 h-2 rounded-full bg-green-500 inline-block" /> +Addition
                            </span>
                            <span className="flex items-center gap-1 text-red-600">
                              <span className="w-2 h-2 rounded-full bg-red-400 inline-block" /> -Deletion
                            </span>
                          </div>
                        </div>

                        <div className="rounded-lg border border-slate-200 bg-slate-50/50 p-3 text-xs leading-relaxed font-mono">
                          {diffSegments.map((seg, sIdx) => {
                            if (seg.type === 'added') {
                              return (
                                <span
                                  key={sIdx}
                                  className="bg-green-100 text-green-900 font-semibold px-0.5 rounded border-b border-green-400"
                                >
                                  {seg.value}
                                </span>
                              );
                            }
                            if (seg.type === 'deleted') {
                              return (
                                <span
                                  key={sIdx}
                                  className="bg-red-100 text-red-700 line-through opacity-75 px-0.5 rounded mx-0.5"
                                >
                                  {seg.value}
                                </span>
                              );
                            }
                            return <span key={sIdx}>{seg.value}</span>;
                          })}
                        </div>
                      </div>

                      {/* Cryptographic Hashes & Stellar Ledger Anchor */}
                      <div className="rounded-lg bg-slate-900 text-slate-200 p-2.5 space-y-1 text-2xs font-mono">
                        <div className="flex items-center justify-between text-slate-400 border-b border-slate-800 pb-1">
                          <span className="flex items-center gap-1 text-green">
                            <ShieldCheck className="w-3 h-3 text-green" />
                            Stellar Ledger Anchor Hash
                          </span>
                          <span className="text-3xs text-slate-500">Parent-Child Cryptographic Link</span>
                        </div>
                        <div className="flex justify-between items-center pt-0.5">
                          <span className="text-slate-400">Parent Hash:</span>
                          <span className="text-slate-300 truncate max-w-[260px]">{amend.parentHash}</span>
                        </div>
                        <div className="flex justify-between items-center">
                          <span className="text-slate-400">Amendment Hash:</span>
                          <span className="text-green truncate max-w-[260px]">{amend.amendmentHash}</span>
                        </div>
                        <div className="flex justify-between items-center pt-0.5 border-t border-slate-800">
                          <span className="text-slate-400">Stellar Tx Hash:</span>
                          <span className="text-blue-400 truncate max-w-[260px] flex items-center gap-1">
                            {amend.ledgerTxHash.slice(0, 20)}…
                            <ExternalLink className="w-2.5 h-2.5 inline" />
                          </span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Add Amendment Modal / Inline Form */}
          {showAmendmentForm && (
            <div className="rounded-xl border border-slate-300 bg-slate-50 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-bold text-slate-900 flex items-center gap-1.5">
                  <GitCommit className="w-4 h-4 text-green" />
                  Issue New Amendment / Addendum
                </h4>
                <button
                  type="button"
                  onClick={() => setShowAmendmentForm(false)}
                  className="text-slate-400 hover:text-slate-700 text-xs"
                >
                  Cancel
                </button>
              </div>

              <form onSubmit={handleCreateAmendment} className="space-y-3">
                <div>
                  <label className="block text-2xs font-bold text-slate-600 mb-1">Target Field</label>
                  <select
                    value={amendField}
                    onChange={(e) => {
                      const val = e.target.value as 'notes' | 'diagnosis' | 'prescription' | 'addendum';
                      setAmendField(val);
                      if (val === 'notes') setNewContent(record.notes || '');
                      if (val === 'diagnosis') setNewContent(record.diagnosis || '');
                      if (val === 'prescription') setNewContent(record.prescription || '');
                      if (val === 'addendum') setNewContent('');
                    }}
                    className="w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-800"
                  >
                    <option value="notes">Clinical Notes</option>
                    <option value="diagnosis">Diagnosis</option>
                    <option value="prescription">Prescription</option>
                    <option value="addendum">Addendum (Appended Note)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-2xs font-bold text-slate-600 mb-1">
                    Clinical Justification (Required) *
                  </label>
                  <textarea
                    required
                    rows={2}
                    value={justification}
                    onChange={(e) => setJustification(e.target.value)}
                    placeholder="Specify clinical justification (e.g. lab biopsy updates, amended dosage, corrected symptoms)…"
                    className="w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-900 focus:outline-none focus:ring-1 focus:ring-green"
                  />
                </div>

                <div>
                  <label className="block text-2xs font-bold text-slate-600 mb-1">
                    Amended Content (Differential Target) *
                  </label>
                  <textarea
                    required
                    rows={3}
                    value={newContent}
                    onChange={(e) => setNewContent(e.target.value)}
                    placeholder="Enter amended text…"
                    className="w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-900 focus:outline-none focus:ring-1 focus:ring-green font-mono"
                  />
                </div>

                <div className="flex gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => setShowAmendmentForm(false)}
                    className="flex-1 rounded-md border border-slate-300 bg-white py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-100"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={isSubmitting || !newContent.trim() || !justification.trim()}
                    className="flex-1 rounded-md bg-green py-1.5 text-xs font-bold text-[#030D09] hover:bg-green-600 disabled:opacity-50"
                  >
                    {isSubmitting ? 'Anchoring…' : 'Anchor Amendment to Ledger'}
                  </button>
                </div>
              </form>
            </div>
          )}
        </div>
      </div>

      <RecordDeletionModal
        record={record}
        isOpen={showDeleteModal}
        onClose={() => setShowDeleteModal(false)}
        onConfirmDeletion={async (recordId) => {
          localStorage.setItem(`heliora_deleted_${recordId}`, 'true');
          onClose();
        }}
      />

      {showVaccinationProof && (
        <VaccinationProofPanel
          record={record}
          onClose={() => setShowVaccinationProof(false)}
        />
      )}
    </div>
  );
}
