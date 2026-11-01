import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  X,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Clock,
  ChevronLeft,
  ChevronRight,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Save,
  ScanText,
  ShieldCheck,
  Flag,
  Info,
  History,
  Columns,
  Play,
  Loader2,
} from 'lucide-react';
import {
  DocumentDiagnostics,
  DiagnosticAttempt,
  DiagnosticPage,
  DiagnosticRegion,
  RegionStatus,
} from '../types';

interface DiagnosticsWorkspaceProps {
  isOpen: boolean;
  onClose: () => void;
  documentName: string;
  documentId: string | null;
  pageUrls: Record<string, string>;
  onRetryRegion: (pageId: string, regionId: string) => Promise<void>;
  onApplyCorrection: (pageId: string, regionId: string, text: string) => void;
  onSelectRegion?: (pageId: string, regionId: string) => void;
}

const STATUS_STYLES: Record<RegionStatus, { label: string; chip: string; icon: React.ReactNode }> = {
  provisional: {
    label: 'Provisional',
    chip: 'bg-slate-100 text-slate-700 border-slate-300',
    icon: <Clock className="w-3 h-3" />,
  },
  review_required: {
    label: 'Review Required',
    chip: 'bg-amber-50 text-amber-700 border-amber-300',
    icon: <AlertTriangle className="w-3 h-3" />,
  },
  verified: {
    label: 'Verified',
    chip: 'bg-emerald-50 text-emerald-700 border-emerald-300',
    icon: <CheckCircle2 className="w-3 h-3" />,
  },
  failed: {
    label: 'Failed',
    chip: 'bg-rose-50 text-rose-700 border-rose-300',
    icon: <XCircle className="w-3 h-3" />,
  },
};

const SEVERITY_STYLES: Record<string, string> = {
  info: 'bg-sky-50 text-sky-700 border-sky-200',
  warning: 'bg-amber-50 text-amber-700 border-amber-200',
  error: 'bg-rose-50 text-rose-700 border-rose-200',
};

export const DiagnosticsWorkspace: React.FC<DiagnosticsWorkspaceProps> = ({
  isOpen,
  onClose,
  documentName,
  documentId,
  pageUrls,
  onRetryRegion,
  onApplyCorrection,
  onSelectRegion,
}) => {
  const [data, setData] = useState<DocumentDiagnostics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ pageId: string; regionId: string } | null>(null);
  const [tab, setTab] = useState<'text' | 'info' | 'history'>('text');
  const [draft, setDraft] = useState('');
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [onlyReview, setOnlyReview] = useState(false);
  const [comparison, setComparison] = useState<'pageCrop' | 'ocrCrop' | 'preprocessed'>('ocrCrop');
  const dragRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const requestRef = useRef(0);
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const [fit, setFit] = useState(1);


  const load = useCallback(
    async (selectFirst = false) => {
      if (!documentId) return;
      const requestId = ++requestRef.current;
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/diagnostics/${encodeURIComponent(documentId)}`);
        const payload: DocumentDiagnostics = await res.json();
        if (requestId !== requestRef.current) return; // superseded by a newer request
        if (!res.ok || payload.error) throw new Error(payload.error || 'Unable to read diagnostics');
        setData(payload);
        const regions = payload.pages.flatMap((page) =>
          page.regions.map((region) => ({ pageId: page.pageId, regionId: region.regionId }))
        );
        setSelected((current) => {
          if (current && regions.some((r) => r.pageId === current.pageId && r.regionId === current.regionId)) {
            return current;
          }
          if (selectFirst && regions.length) return regions[0];
          return current;
        });
      } catch (err: any) {
        if (requestId === requestRef.current) setError(err.message || 'Unable to read diagnostics');
      } finally {
        if (requestId === requestRef.current) setLoading(false);
      }
    },
    [documentId]
  );

  useEffect(() => {
    if (!isOpen) return;
    setSelected(null);
    setNotice(null);
    setZoom(1);
    setPan({ x: 0, y: 0 });
    if (documentId) load(true);
    else setData(null);
  }, [isOpen, documentId, load]);

  const flatRegions = useMemo(() => {
    if (!data) return [] as Array<{ page: DiagnosticPage; region: DiagnosticRegion }>;
    return data.pages.flatMap((page) => page.regions.map((region) => ({ page, region })));
  }, [data]);

  const visibleRegions = useMemo(
    () => (onlyReview ? flatRegions.filter((item) => item.region.status !== 'verified') : flatRegions),
    [flatRegions, onlyReview]
  );

  const current = useMemo(() => {
    if (!selected) return null;
    return (
      flatRegions.find(
        (item) => item.page.pageId === selected.pageId && item.region.regionId === selected.regionId
      ) || null
    );
  }, [flatRegions, selected]);

  const counts = useMemo(() => {
    const summary: Record<RegionStatus, number> = {
      provisional: 0,
      review_required: 0,
      verified: 0,
      failed: 0,
    };
    flatRegions.forEach(({ region }) => {
      summary[region.status] = (summary[region.status] || 0) + 1;
    });
    return summary;
  }, [flatRegions]);

  useEffect(() => {
    setDraft(current ? current.region.finalText : '');
    setTab('text');
  }, [current?.page.pageId, current?.region.regionId, current?.region.finalText]);

  // Fit factor for placing region overlays on the rendered page image
  useEffect(() => {
    const element = viewerRef.current;
    const pageWidth = current?.page.width;
    const pageHeight = current?.page.height;
    if (!element || !pageWidth || !pageHeight) return;
    const update = () => {
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      setFit(Math.min(rect.width / pageWidth, rect.height / pageHeight));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [current?.page.pageId, current?.page.width, current?.page.height, isOpen, tab]);

  const step = (direction: 1 | -1) => {
    if (!visibleRegions.length) return;
    const index = visibleRegions.findIndex(
      (item) => item.page.pageId === selected?.pageId && item.region.regionId === selected?.regionId
    );
    const nextIndex = index === -1 ? 0 : (index + direction + visibleRegions.length) % visibleRegions.length;
    const next = visibleRegions[nextIndex];
    setSelected({ pageId: next.page.pageId, regionId: next.region.regionId });
    onSelectRegion?.(next.page.pageId, next.region.regionId);
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  const saveCorrection = async (
    payload: { correctedText?: string; verified?: boolean; unresolved?: boolean; note?: string },
    label: string
  ) => {
    if (!documentId || !current) return;
    setBusy(label);
    setNotice(null);
    try {
      const res = await fetch(`/api/diagnostics/${encodeURIComponent(documentId)}/correction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pageId: current.page.pageId,
          regionId: current.region.regionId,
          ...payload,
        }),
      });
      const updated: DocumentDiagnostics = await res.json();
      if (!res.ok || updated.error) throw new Error(updated.error || 'Unable to save the correction');
      setData(updated);
      if (payload.correctedText !== undefined) {
        onApplyCorrection(current.page.pageId, current.region.regionId, payload.correctedText);
      }
      setNotice(`${label} saved.`);
    } catch (err: any) {
      setNotice(err.message || 'Unable to save');
    } finally {
      setBusy(null);
    }
  };

  const retryRegion = async () => {
    if (!current) return;
    setBusy('retry');
    setNotice(null);
    try {
      await onRetryRegion(current.page.pageId, current.region.regionId);
      await load();
      setNotice('OCR re-run completed — a new attempt was recorded.');
    } catch (err: any) {
      setNotice(err.message || 'Retry failed');
    } finally {
      setBusy(null);
    }
  };

  if (!isOpen) return null;

  const latest: DiagnosticAttempt | undefined = current?.region.latest;
  const findings = latest?.quality?.findings || [];
  const pageUrl = current ? pageUrls[current.page.pageId] : undefined;
  const box = current?.region.box;
  const page = current?.page;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4">
      <div className="w-full max-w-[1500px] h-[92vh] bg-white rounded-xl shadow-2xl border border-slate-200 flex flex-col overflow-hidden">
        <header className="flex items-center justify-between gap-3 px-5 py-3 border-b border-slate-200 bg-slate-50">
          <div className="flex items-center gap-3 min-w-0">
            <ScanText className="w-5 h-5 text-blue-600 shrink-0" />
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-slate-900 truncate">
                OCR Diagnostics — {documentName || 'Document'}
              </h2>
              <p className="text-[11px] text-slate-500 truncate">
                {documentId ? `document ${documentId}` : 'run OCR once to create diagnostics for this document'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => load()}
              disabled={loading || !documentId}
              className="p-1.5 rounded border border-slate-300 text-slate-600 hover:bg-slate-100 disabled:opacity-50"
              title="Reload diagnostics"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded border border-slate-300 text-slate-600 hover:bg-slate-100"
              title="Close"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </header>

        {(notice || error) && (
          <div
            className={`px-5 py-2 text-[12px] border-b ${
              error ? 'bg-rose-50 text-rose-700 border-rose-200' : 'bg-sky-50 text-sky-700 border-sky-200'
            }`}
          >
            {error || notice}
          </div>
        )}

        <div className="flex-1 grid grid-cols-12 gap-3 p-3 overflow-hidden">
          {/* region navigator */}
          <aside className="col-span-12 lg:col-span-3 flex flex-col border border-slate-200 rounded-lg overflow-hidden">
            <div className="flex items-center justify-between px-3 py-2 bg-slate-50 border-b border-slate-200">
              <span className="text-[11px] font-semibold text-slate-600 uppercase tracking-wide">
                Regions ({visibleRegions.length})
              </span>
              <label className="flex items-center gap-1 text-[11px] text-slate-600">
                <input
                  type="checkbox"
                  checked={onlyReview}
                  onChange={(event) => setOnlyReview(event.target.checked)}
                  className="accent-blue-600"
                />
                needs review
              </label>
            </div>
            <div className="flex-1 overflow-y-auto">
              {!documentId && (
                <p className="p-3 text-[12px] text-slate-500">
                  No diagnostics yet. Run OCR (page or batch) and reopen this workspace.
                </p>
              )}
              {documentId && !loading && !visibleRegions.length && (
                <p className="p-3 text-[12px] text-slate-500">No regions recorded for this document yet.</p>
              )}
              {visibleRegions.map(({ page: regionPage, region }) => {
                const isSelected =
                  selected?.pageId === regionPage.pageId && selected?.regionId === region.regionId;
                const style = STATUS_STYLES[region.status] || STATUS_STYLES.provisional;
                return (
                  <button
                    key={`${regionPage.pageId}-${region.regionId}`}
                    onClick={() => {
                      setSelected({ pageId: regionPage.pageId, regionId: region.regionId });
                      onSelectRegion?.(regionPage.pageId, region.regionId);
                    }}
                    className={`w-full text-left px-3 py-2 border-b border-slate-100 transition-colors ${
                      isSelected ? 'bg-blue-50' : 'hover:bg-slate-50'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[12px] font-medium text-slate-800 truncate">
                        p{regionPage.pageNumber ?? '?'} · {region.regionId}
                      </span>
                      <span
                        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-medium ${style.chip}`}
                      >
                        {style.icon}
                        {style.label}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 mt-1 text-[10px] text-slate-500">
                      <span>conf {region.latest?.confidence ?? '—'}</span>
                      <span>{region.retryCount} retries</span>
                      {region.correctedText ? <span className="text-emerald-600">corrected</span> : null}
                      {region.unresolved ? <span className="text-amber-600">unresolved</span> : null}
                    </div>
                  </button>
                );
              })}
            </div>
            <div className="flex items-center justify-between px-2 py-2 bg-slate-50 border-t border-slate-200">
              <button
                onClick={() => step(-1)}
                className="inline-flex items-center gap-1 px-2 py-1 rounded border border-slate-300 text-[11px] text-slate-700 hover:bg-white"
              >
                <ChevronLeft className="w-3 h-3" /> Previous
              </button>
              <button
                onClick={() => step(1)}
                className="inline-flex items-center gap-1 px-2 py-1 rounded border border-slate-300 text-[11px] text-slate-700 hover:bg-white"
              >
                Next <ChevronRight className="w-3 h-3" />
              </button>
            </div>
          </aside>

          {/* viewer */}
          <section className="col-span-12 lg:col-span-5 flex flex-col gap-3 overflow-hidden">
            {/* A. original page viewer with region overlays */}
            <div className="flex-1 flex flex-col border border-slate-200 rounded-lg overflow-hidden min-h-0">
              <div className="flex items-center justify-between px-3 py-2 bg-slate-50 border-b border-slate-200">
                <span className="text-[11px] font-semibold text-slate-600 uppercase tracking-wide">
                  Original page{page?.pageNumber ? ` · p${page.pageNumber}` : ''}
                </span>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setZoom((value) => Math.max(0.4, +(value - 0.2).toFixed(2)))}
                    className="p-1 rounded border border-slate-300 text-slate-600 hover:bg-white"
                    title="Zoom out"
                  >
                    <ZoomOut className="w-3.5 h-3.5" />
                  </button>
                  <span className="text-[11px] text-slate-600 w-10 text-center">{Math.round(zoom * 100)}%</span>
                  <button
                    onClick={() => setZoom((value) => Math.min(4, +(value + 0.2).toFixed(2)))}
                    className="p-1 rounded border border-slate-300 text-slate-600 hover:bg-white"
                    title="Zoom in"
                  >
                    <ZoomIn className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => {
                      setZoom(1);
                      setPan({ x: 0, y: 0 });
                    }}
                    className="p-1 rounded border border-slate-300 text-slate-600 hover:bg-white"
                    title="Fit to view"
                  >
                    <Maximize2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
              <div
                ref={viewerRef}
                className="flex-1 relative overflow-hidden bg-slate-100 min-h-0 cursor-grab active:cursor-grabbing"
                onMouseDown={(event) => {
                  dragRef.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
                }}
                onMouseMove={(event) => {
                  const drag = dragRef.current;
                  if (!drag) return;
                  setPan({ x: drag.panX + (event.clientX - drag.x), y: drag.panY + (event.clientY - drag.y) });
                }}
                onMouseUp={() => {
                  dragRef.current = null;
                }}
                onMouseLeave={() => {
                  dragRef.current = null;
                }}
                onWheel={(event) => {
                  event.preventDefault();
                  setZoom((value) => Math.max(0.4, Math.min(4, +(value - event.deltaY / 1200).toFixed(2))));
                }}
              >
                {pageUrl && page?.width && page?.height ? (
                  <div
                    className="absolute left-1/2 top-1/2"
                    style={{
                      width: page.width * fit,
                      height: page.height * fit,
                      transform: `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                    }}
                  >
                    <img
                      src={pageUrl}
                      alt={`page ${page.pageNumber ?? ''}`}
                      className="w-full h-full select-none"
                      draggable={false}
                    />
                    {page.regions.map((region) => {
                      if (!region.box) return null;
                      const isSelected =
                        region.regionId === current?.region.regionId && page.pageId === current?.page.pageId;
                      return (
                        <button
                          key={region.regionId}
                          onClick={() => {
                            setSelected({ pageId: page.pageId, regionId: region.regionId });
                            onSelectRegion?.(page.pageId, region.regionId);
                          }}
                          className={`absolute border-2 ${
                            isSelected
                              ? 'border-blue-600 bg-blue-500/20'
                              : region.status === 'review_required' || region.status === 'failed'
                              ? 'border-amber-500/80 bg-amber-400/10'
                              : region.status === 'verified'
                              ? 'border-emerald-500/70 bg-emerald-400/10'
                              : 'border-slate-500/60 bg-slate-400/10'
                          }`}
                          style={{
                            left: region.box.x * fit,
                            top: region.box.y * fit,
                            width: region.box.width * fit,
                            height: region.box.height * fit,
                          }}
                          title={`${region.regionId} (${region.status})`}
                        />
                      );
                    })}
                  </div>
                ) : (
                  <div className="h-full flex items-center justify-center p-4 text-[12px] text-slate-500 text-center">
                    {pageUrl
                      ? 'Page dimensions were not recorded for this region, so overlays cannot be placed.'
                      : 'Page image is not available in this session. Reopen the document to view it.'}
                  </div>
                )}
              </div>
            </div>
            {/* comparison strip follows */}
            <div className="border border-slate-200 rounded-lg overflow-hidden">
              <div className="flex items-center justify-between px-3 py-2 bg-slate-50 border-b border-slate-200">
                <span className="text-[11px] font-semibold text-slate-600 uppercase tracking-wide">
                  Image comparison
                </span>
                <span className="text-[10px] text-slate-500">
                  {latest?.variant ? `winning profile: ${latest.variant}` : 'no attempt recorded'}
                </span>
              </div>
              <div className="grid grid-cols-4 gap-2 p-2">
                {(
                  [
                    { key: 'page', label: 'Original page', artifact: null },
                    { key: 'pageCrop', label: 'Detected region', artifact: latest?.artifacts?.pageCrop },
                    { key: 'ocrCrop', label: 'OCR crop', artifact: latest?.artifacts?.ocrCrop },
                    { key: 'preprocessed', label: 'Preprocessed', artifact: latest?.artifacts?.preprocessed },
                  ] as const
                ).map((entry) => {
                  const artifact = entry.artifact;
                  const src =
                    entry.key === 'page'
                      ? pageUrl
                      : artifact && data
                      ? `${data.artifactBaseUrl}${artifact.name}`
                      : undefined;
                  const isActive =
                    entry.key === 'page' ? comparison === 'pageCrop' && false : comparison === entry.key;
                  return (
                    <button
                      key={entry.key}
                      onClick={() => {
                        if (entry.key !== 'page') setComparison(entry.key as typeof comparison);
                      }}
                      className={`rounded border overflow-hidden text-left ${
                        isActive ? 'border-blue-500 ring-1 ring-blue-300' : 'border-slate-200 hover:border-slate-400'
                      }`}
                      title={artifact ? `${artifact.name.slice(0, 12)}… · ${artifact.bytes} bytes` : entry.label}
                    >
                      <div className="h-20 bg-slate-100 flex items-center justify-center overflow-hidden">
                        {src ? (
                          <img src={src} alt={entry.label} className="max-h-20 max-w-full object-contain" />
                        ) : (
                          <span className="text-[10px] text-slate-400 px-1 text-center">not stored</span>
                        )}
                      </div>
                      <div className="px-1.5 py-1 text-[10px] font-medium text-slate-700 truncate">
                        {entry.label}
                      </div>
                    </button>
                  );
                })}
              </div>
              <div className="px-3 py-2 border-t border-slate-200 bg-slate-50 text-[11px] text-slate-600 space-y-0.5">
                {box && (
                  <p>
                    crop x{box.x} y{box.y} · {box.width}×{box.height}px · page {page?.width ?? '?'}×
                    {page?.height ?? '?'} @ {page?.renderDpi ?? '—'} dpi · rotation {page?.rotation ?? 0}°
                    {latest?.columnCount && latest.columnCount > 1
                      ? ` · read as ${latest.columnCount} columns`
                      : ''}
                  </p>
                )}
                {latest?.transformations?.length ? (
                  <p>
                    profile {latest.variant}:{' '}
                    {latest.transformations
                      .map((item) =>
                        item.name === 'deskew'
                          ? `deskew ${item.degrees}°`
                          : item.name === 'scale'
                          ? `scale ×${item.factor}`
                          : String(item.name)
                      )
                      .join(' · ')}
                  </p>
                ) : null}
                {latest?.crop ? (
                  <p>
                    preprocessed size {latest.settings?.targetLineHeight ? '' : ''}
                    {String((latest.settings?.targetLineHeight as number) ?? '')}px target line height · crop{' '}
                    {latest.crop.width}×{latest.crop.height}px
                  </p>
                ) : null}
              </div>
            </div>
          </section>


          {/* detail panel */}
          <section className="col-span-12 lg:col-span-4 flex flex-col border border-slate-200 rounded-lg overflow-hidden min-h-0">
            <div className="flex items-center gap-1 px-2 py-1.5 bg-slate-50 border-b border-slate-200">
              {(
                [
                  { key: 'text', label: 'Text', icon: <Columns className="w-3.5 h-3.5" /> },
                  { key: 'info', label: 'Diagnostics', icon: <Info className="w-3.5 h-3.5" /> },
                  { key: 'history', label: 'History', icon: <History className="w-3.5 h-3.5" /> },
                ] as const
              ).map((entry) => (
                <button
                  key={entry.key}
                  onClick={() => setTab(entry.key)}
                  className={`inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-medium transition-colors ${
                    tab === entry.key
                      ? 'bg-blue-600 text-white'
                      : 'text-slate-600 hover:bg-slate-200 hover:text-slate-900'
                  }`}
                >
                  {entry.icon}
                  {entry.label}
                </button>
              ))}
              <button
                onClick={retryRegion}
                disabled={!current || busy !== null}
                className="ml-auto inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-medium bg-slate-700 text-white hover:bg-slate-800 disabled:opacity-50"
                title="Re-run OCR for this region with the automatic retry budget"
              >
                {busy === 'retry' ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Play className="w-3.5 h-3.5" />
                )}
                Retry region
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-3 space-y-3 min-h-0">
              {!current && (
                <p className="text-[12px] text-slate-500">
                  Select a region on the left, or run OCR to record regions for this document.
                </p>
              )}

              {current && tab === 'text' && (
                <>
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[11px] font-semibold text-slate-600 uppercase tracking-wide">
                        Raw engine output (immutable)
                      </span>
                      <button
                        onClick={() => setDraft(latest?.rawText || '')}
                        className="text-[10px] text-blue-600 hover:underline"
                      >
                        use as final
                      </button>
                    </div>
                    <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-relaxed bg-slate-50 border border-slate-200 rounded p-2 text-slate-700">
                      {latest?.rawText || '(no raw text recorded)'}
                    </pre>
                  </div>

                  {latest?.normalizedText && latest.normalizedText !== latest?.rawText && (
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[11px] font-semibold text-slate-600 uppercase tracking-wide">
                          Normalized (automatic)
                        </span>
                        <button
                          onClick={() => setDraft(latest?.normalizedText || '')}
                          className="text-[10px] text-blue-600 hover:underline"
                        >
                          use as final
                        </button>
                      </div>
                      <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-relaxed bg-white border border-slate-200 rounded p-2 text-slate-700">
                        {latest.normalizedText}
                      </pre>
                    </div>
                  )}
                </>
              )}
              {/* final text and other tabs follow */}
              {current && tab === 'text' && (
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[11px] font-semibold text-slate-600 uppercase tracking-wide">
                      Final text {current.region.correctedText ? '(corrected)' : '(from OCR)'}
                    </span>
                    <span className="text-[10px] text-slate-500">{draft.length} chars</span>
                  </div>
                  <textarea
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    rows={10}
                    spellCheck={false}
                    className="w-full text-[12px] leading-relaxed text-slate-800 bg-white border border-slate-300 rounded p-2 focus:outline-none focus:ring-2 focus:ring-blue-400"
                  />
                  <div className="flex items-center gap-2 mt-1">
                    <button
                      onClick={() => saveCorrection({ correctedText: draft }, 'Correction')}
                      disabled={busy !== null || draft === current.region.finalText}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                    >
                      {busy === 'Correction' ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Save className="w-3.5 h-3.5" />
                      )}
                      Save correction
                    </button>
                    <span className="text-[10px] text-slate-500">
                      corrected text is used in the exported document
                    </span>
                  </div>
                </div>
              )}

              {current && tab === 'info' && (
                <div className="space-y-4">
                  <div>
                    <h4 className="text-[11px] font-semibold text-slate-600 uppercase tracking-wide mb-1">
                      Identifiers &amp; rendering
                    </h4>
                    <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
                      <dt className="text-slate-500">document</dt>
                      <dd className="text-slate-800 break-all">{data?.documentId}</dd>
                      <dt className="text-slate-500">page / region</dt>
                      <dd className="text-slate-800 break-all">
                        {current.page.pageId} / {current.region.regionId}
                      </dd>
                      <dt className="text-slate-500">PDF page</dt>
                      <dd className="text-slate-800">{current.page.pageNumber ?? '—'}</dd>
                      <dt className="text-slate-500">render DPI</dt>
                      <dd className="text-slate-800">{current.page.renderDpi ?? '—'}</dd>
                      <dt className="text-slate-500">page pixels</dt>
                      <dd className="text-slate-800">
                        {current.page.width ?? '?'}×{current.page.height ?? '?'}
                      </dd>
                      <dt className="text-slate-500">rotation</dt>
                      <dd className="text-slate-800">{current.page.rotation ?? 0}°</dd>
                      <dt className="text-slate-500">region type</dt>
                      <dd className="text-slate-800">{current.region.type ?? '—'}</dd>
                      <dt className="text-slate-500">crop box</dt>
                      <dd className="text-slate-800">
                        {box ? `x${box.x} y${box.y} ${box.width}×${box.height}` : '—'}
                      </dd>
                      <dt className="text-slate-500">columns read</dt>
                      <dd className="text-slate-800">{latest?.columnCount ?? 1}</dd>
                    </dl>
                  </div>

                  <div>
                    <h4 className="text-[11px] font-semibold text-slate-600 uppercase tracking-wide mb-1">
                      Engine &amp; effective settings
                    </h4>
                    <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
                      <dt className="text-slate-500">engine</dt>
                      <dd className="text-slate-800">
                        {latest?.engine ?? '—'}
                        {latest?.pipeline ? ` (${latest.pipeline})` : ''}
                      </dd>
                      <dt className="text-slate-500">version</dt>
                      <dd className="text-slate-800">{latest?.engineVersion ?? '—'}</dd>
                      <dt className="text-slate-500">models</dt>
                      <dd className="text-slate-800 break-all">{latest?.model ?? '—'}</dd>
                      <dt className="text-slate-500">duration</dt>
                      <dd className="text-slate-800">
                        {latest?.durationMs !== undefined ? `${latest.durationMs} ms` : '—'}
                      </dd>
                      <dt className="text-slate-500">confidence</dt>
                      <dd className="text-slate-800">
                        {latest?.confidence !== undefined ? `${latest.confidence}%` : 'not reported'}
                      </dd>
                      <dt className="text-slate-500">status</dt>
                      <dd className="text-slate-800">{current.region.status}</dd>
                    </dl>
                    {latest?.settings && (
                      <p className="mt-1 text-[11px] text-slate-700 break-words">
                        {Object.entries(latest.settings)
                          .map(([key, value]) => `${key}=${String(value)}`)
                          .join(' · ')}
                      </p>
                    )}
                  </div>

                  <div>
                    <h4 className="text-[11px] font-semibold text-slate-600 uppercase tracking-wide mb-1">
                      Quality checks ({findings.length})
                    </h4>
                    {!findings.length && (
                      <p className="text-[11px] text-slate-500">No findings for the selected attempt.</p>
                    )}
                    <ul className="space-y-1">
                      {findings.map((item, index) => (
                        <li
                          key={`${item.code}-${index}`}
                          className={`px-2 py-1 rounded border text-[11px] ${
                            SEVERITY_STYLES[item.severity] || SEVERITY_STYLES.info
                          }`}
                        >
                          <span className="font-semibold uppercase text-[10px] mr-1">{item.severity}</span>
                          {item.message}
                        </li>
                      ))}
                    </ul>
                  </div>

                  {(latest?.warnings?.length || latest?.error) && (
                    <div>
                      <h4 className="text-[11px] font-semibold text-slate-600 uppercase tracking-wide mb-1">
                        Warnings &amp; errors
                      </h4>
                      <ul className="space-y-1 text-[11px]">
                        {latest?.error && (
                          <li className="px-2 py-1 rounded border bg-rose-50 text-rose-700 border-rose-200">
                            {latest.error}
                          </li>
                        )}
                        {(latest?.warnings || []).map((warning, index) => (
                          <li
                            key={index}
                            className="px-2 py-1 rounded border bg-amber-50 text-amber-700 border-amber-200"
                          >
                            {warning}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              {current && tab === 'history' && (
                <div className="space-y-4">
                  <div>
                    <h4 className="text-[11px] font-semibold text-slate-600 uppercase tracking-wide mb-1">
                      Attempts ({current.region.attempts.length}) — retry history
                    </h4>
                    <div className="space-y-2">
                      {current.region.attempts.map((attempt) => (
                        <div key={attempt.attempt} className="border border-slate-200 rounded p-2 bg-white">
                          <div className="flex items-center justify-between text-[11px]">
                            <span className="font-semibold text-slate-800">
                              Attempt {attempt.attempt + 1}
                              {attempt.attempt === current.region.attempts.length - 1 ? ' (latest)' : ''}
                            </span>
                            <span className="text-slate-500">
                              {attempt.variant ?? '—'} · {attempt.confidence ?? '—'}% ·{' '}
                              {attempt.durationMs ?? '—'} ms
                            </span>
                          </div>
                          {attempt.retry?.strategy && (
                            <p className="text-[10px] text-slate-500 mt-0.5">
                              retry strategy: {attempt.retry.strategy}
                              {attempt.retry.description ? ` — ${attempt.retry.description}` : ''}
                            </p>
                          )}
                          {attempt.error && <p className="text-[10px] text-rose-600 mt-0.5">{attempt.error}</p>}
                          <div className="flex items-start gap-2 mt-1">
                            {attempt.artifacts?.preprocessed && data && (
                              <img
                                src={`${data.artifactBaseUrl}${attempt.artifacts.preprocessed.name}`}
                                alt={`attempt ${attempt.attempt + 1} preprocessed`}
                                className="max-h-16 border border-slate-200 rounded"
                              />
                            )}
                            {attempt.candidates && attempt.candidates.length > 0 && (
                              <table className="text-[10px] text-slate-600 flex-1">
                                <thead>
                                  <tr className="text-slate-500">
                                    <th className="text-left font-medium">profile</th>
                                    <th className="text-right font-medium">conf</th>
                                    <th className="text-right font-medium">chars</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {attempt.candidates.map((candidate) => (
                                    <tr
                                      key={candidate.variant}
                                      className={
                                        candidate.variant === attempt.variant
                                          ? 'text-blue-700 font-semibold'
                                          : undefined
                                      }
                                    >
                                      <td className="pr-2">{candidate.variant}</td>
                                      <td className="text-right">{candidate.meanConfidence}</td>
                                      <td className="text-right">{candidate.characters}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div>
                    <h4 className="text-[11px] font-semibold text-slate-600 uppercase tracking-wide mb-1">
                      Corrections ({current.region.correctionHistory?.length || 0})
                    </h4>
                    {current.region.correctedText ? (
                      <p className="text-[11px] text-slate-700 mb-1">
                        Verified: {current.region.verified ? 'yes' : 'no'}
                        {current.region.unresolved ? ' · flagged unresolved' : ''}
                      </p>
                    ) : (
                      <p className="text-[11px] text-slate-500">
                        No manual correction recorded for this region.
                      </p>
                    )}
                    <ul className="space-y-1">
                      {(current.region.correctionHistory || []).map((entry, index) => (
                        <li key={index} className="text-[11px] text-slate-600 border-l-2 border-blue-300 pl-2">
                          <span className="text-slate-400">{entry.at}</span>{' '}
                          {entry.from ? 'edited' : 'created'}
                          {entry.to ? ` → ${entry.to.slice(0, 40)}${entry.to.length > 40 ? '…' : ''}` : ''}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}

            </div>

            <div className="border-t border-slate-200 p-2 bg-slate-50 flex flex-wrap items-center gap-2">
              <button
                onClick={() => saveCorrection({ verified: true }, 'Verification')}
                disabled={!current || busy !== null}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-medium bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                {busy === 'Verification' ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <ShieldCheck className="w-3.5 h-3.5" />
                )}
                Accept &amp; verify
              </button>
              <button
                onClick={() => saveCorrection({ verified: false }, 'Verification')}
                disabled={!current || busy !== null || !current?.region.verified}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-medium bg-white border border-slate-300 text-slate-700 hover:bg-slate-100 disabled:opacity-50"
              >
                Unverify
              </button>
              <button
                onClick={() => saveCorrection({ unresolved: !current?.region.unresolved }, 'Flag')}
                disabled={!current || busy !== null}
                className={`inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-medium border ${
                  current?.region.unresolved
                    ? 'bg-amber-500 text-white border-amber-600 hover:bg-amber-600'
                    : 'bg-white border-slate-300 text-slate-700 hover:bg-slate-100'
                } disabled:opacity-50`}
              >
                <Flag className="w-3.5 h-3.5" />
                {current?.region.unresolved ? 'Unresolved' : 'Mark unresolved'}
              </button>
              <span className="text-[10px] text-slate-500 ml-auto">
                {current ? `${current.page.pageId}/${current.region.regionId}` : 'no region selected'}
              </span>
            </div>
          </section>

        </div>

        <footer className="flex items-center justify-between gap-3 px-5 py-2 border-t border-slate-200 bg-slate-50">
          <div className="flex items-center gap-2 flex-wrap">
            {(['provisional', 'review_required', 'verified', 'failed'] as RegionStatus[]).map((status) => (
              <span
                key={status}
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[11px] font-medium ${STATUS_STYLES[status].chip}`}
              >
                {STATUS_STYLES[status].icon}
                {counts[status]} {STATUS_STYLES[status].label}
              </span>
            ))}
          </div>
          <p className="text-[11px] text-slate-500">
            Quality findings are diagnostic signals — historical Tamil spelling and rare Siddha terms are never
            flagged for being uncommon.
          </p>
        </footer>
      </div>
    </div>
  );
};

