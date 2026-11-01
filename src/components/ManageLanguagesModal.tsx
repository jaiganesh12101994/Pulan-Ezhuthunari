import React, { useState, useEffect } from 'react';
import {
  X,
  Languages,
  Download,
  Trash2,
  CheckCircle2,
  Loader2,
  Search,
  HardDrive,
  RefreshCw,
  AlertCircle,
  Sparkles,
} from 'lucide-react';
import { TessLanguageInfo } from '../types';

interface ManageLanguagesModalProps {
  isOpen: boolean;
  onClose: () => void;
  selectedLanguages: string[];
  onToggleLanguage: (code: string) => void;
  onLanguagesUpdated?: () => void | Promise<void>;
}

export const ManageLanguagesModal: React.FC<ManageLanguagesModalProps> = ({
  isOpen,
  onClose,
  selectedLanguages,
  onToggleLanguage,
  onLanguagesUpdated,
}) => {
  const [languages, setLanguages] = useState<TessLanguageInfo[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [downloadingCode, setDownloadingCode] = useState<string | null>(null);
  const [deletingCode, setDeletingCode] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [filterCategory, setFilterCategory] = useState<'all' | 'indic' | 'international'>('all');
  const [message, setMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);

  const fetchLanguages = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/tesseract/languages');
      const data = await res.json();
      if (data.languages) {
        setLanguages(data.languages);
      }
    } catch (err) {
      console.error('Failed to fetch languages:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchLanguages();
    }
  }, [isOpen]);

  const handleDownload = async (code: string) => {
    setDownloadingCode(code);
    setMessage(null);
    try {
      const res = await fetch('/api/tesseract/download-language', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ langCode: code }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Download failed');

      await fetchLanguages();
      // Auto-activate the freshly downloaded model so it is usable immediately
      if (!selectedLanguages.includes(code)) {
        onToggleLanguage(code);
      }
      if (onLanguagesUpdated) await onLanguagesUpdated();

      setMessage({
        text: data.message
          ? `${data.message} — added to active OCR languages.`
          : `Downloaded ${code}.traineddata and added it to the active OCR languages!`,
        type: 'success',
      });
    } catch (err: any) {
      setMessage({ text: err.message || 'Failed to download language model', type: 'error' });
    } finally {
      setDownloadingCode(null);
    }
  };

  const handleDelete = async (code: string) => {
    if (code === 'tam') return;
    setDeletingCode(code);
    setMessage(null);
    try {
      const res = await fetch(`/api/tesseract/languages/${code}`, {
        method: 'DELETE',
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Delete failed');

      setMessage({ text: `Removed ${code}.traineddata`, type: 'success' });
      await fetchLanguages();
      if (onLanguagesUpdated) await onLanguagesUpdated();
    } catch (err: any) {
      setMessage({ text: err.message || 'Failed to delete language model', type: 'error' });
    } finally {
      setDeletingCode(null);
    }
  };

  if (!isOpen) return null;

  const filtered = languages.filter((l) => {
    const matchesSearch =
      l.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      l.nativeName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      l.code.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesCat = filterCategory === 'all' || l.category === filterCategory;
    return matchesSearch && matchesCat;
  });

  const installedCount = languages.filter((l) => l.isInstalled).length;

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-[#ffffff] border border-[#cbd5e1] rounded-lg shadow-2xl max-w-2xl w-full text-slate-800 overflow-hidden animate-in fade-in zoom-in-95 duration-150 flex flex-col max-h-[85vh]">
        {/* Modal Header */}
        <div className="p-4 border-b border-[#e2e8f0] bg-[#f1f5f9] flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-blue-100 border border-blue-300 rounded text-blue-600">
              <Languages className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold text-slate-900">
                  Manage Tesseract Languages (மொழி மேலாண்மை)
                </h3>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 border border-emerald-300 font-mono font-medium">
                  {installedCount} Installed
                </span>
              </div>
              <p className="text-xs text-slate-600">
                Download and manage trained LSTM models for multi-language OCR (saved to `engines/tessdata/`)
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-[#f1f5f9] text-slate-600 hover:text-slate-900"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Status Message Notification */}
        {message && (
          <div
            className={`px-4 py-2 text-xs flex items-center gap-2 border-b ${ message.type === 'success' ? 'bg-emerald-100 text-emerald-700 border-emerald-300' : 'bg-rose-100 text-rose-600 border-rose-300' }`}
          >
            {message.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 shrink-0" />
            ) : (
              <AlertCircle className="w-4 h-4 shrink-0" />
            )}
            <span>{message.text}</span>
          </div>
        )}

        {/* Toolbar: Search and Filter Tabs */}
        <div className="p-3 border-b border-[#e2e8f0] bg-[#f8fafc] flex flex-wrap items-center justify-between gap-2 text-xs">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-600" />
            <input
              type="text"
              placeholder="Search language name, script or code (e.g. hin, tel, Hindi)..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-[#ffffff] border border-[#cbd5e1] rounded pl-8 pr-3 py-1.5 text-xs text-slate-800 placeholder-slate-500 outline-hidden focus:border-blue-500"
            />
          </div>

          <div className="flex items-center gap-1 bg-[#ffffff] p-0.5 rounded border border-[#cbd5e1]">
            {(['all', 'indic', 'international'] as const).map((cat) => (
              <button
                key={cat}
                onClick={() => setFilterCategory(cat)}
                className={`px-2.5 py-1 rounded capitalize font-medium transition-colors ${ filterCategory === cat ? 'bg-blue-600 text-white' : 'text-slate-600 hover:text-slate-900 hover:bg-[#f1f5f9]' }`}
              >
                {cat === 'indic' ? 'Indic (இந்திய மொழிகள்)' : cat}
              </button>
            ))}
          </div>

          <button
            onClick={async () => {
              await fetchLanguages();
              if (onLanguagesUpdated) await onLanguagesUpdated();
            }}
            title="Refresh installed models"
            className="p-1.5 rounded hover:bg-[#f1f5f9] text-slate-600 hover:text-slate-900 border border-[#cbd5e1]"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {/* Languages Table / List */}
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {loading && languages.length === 0 ? (
            <div className="text-center py-12 text-slate-600 flex flex-col items-center">
              <Loader2 className="w-6 h-6 animate-spin text-blue-600 mb-2" />
              <span>Scanning engines/tessdata repository...</span>
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-8 text-slate-500 text-xs">
              No language found matching "{searchQuery}"
            </div>
          ) : (
            filtered.map((lang) => {
              const isSelected = selectedLanguages.includes(lang.code);
              const isDownloading = downloadingCode === lang.code;
              const isDeleting = deletingCode === lang.code;

              return (
                <div
                  key={lang.code}
                  className={`p-2.5 rounded-md border transition-all flex items-center justify-between gap-3 ${ lang.isInstalled ? isSelected ? 'bg-blue-100 border-blue-300' : 'bg-[#ffffff] border-[#cbd5e1]' : 'bg-[#f8fafc]/60 border-[#e2e8f0] opacity-80 hover:opacity-100' }`}
                >
                  {/* Left: Checkbox (if installed) + Language Details */}
                  <div className="flex items-center gap-3">
                    {lang.isInstalled ? (
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => onToggleLanguage(lang.code)}
                        title="Include in active OCR multi-language configuration"
                        className="w-4 h-4 rounded border-[#94a3b8] text-blue-600 focus:ring-0 cursor-pointer"
                      />
                    ) : (
                      <div className="w-4 h-4 rounded border border-dashed border-slate-300 flex items-center justify-center">
                        <span className="w-1.5 h-1.5 rounded-full bg-slate-200"></span>
                      </div>
                    )}

                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold text-slate-900">{lang.name}</span>
                        <span className="text-[11px] text-blue-600 font-medium font-tamil">
                          {lang.nativeName}
                        </span>
                        <span className="text-[10px] px-1 bg-[#f1f5f9] text-slate-600 rounded font-mono border border-[#e2e8f0]">
                          {lang.code}
                        </span>
                        {lang.code === 'tam' && (
                          <span className="text-[9px] px-1 bg-amber-100 text-amber-600 rounded border border-amber-300 font-semibold">
                            Primary
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-2 mt-0.5 text-[11px] text-slate-600">
                        <span>{lang.approxSize}</span>
                        <span>•</span>
                        <span className="capitalize">{lang.category}</span>
                        {lang.isInstalled && (
                          <>
                            <span>•</span>
                            <span className="text-emerald-600 flex items-center gap-0.5">
                              <CheckCircle2 className="w-3 h-3" /> Ready Offline
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Right Actions: Download / Remove */}
                  <div className="flex items-center gap-1.5">
                    {lang.isInstalled ? (
                      <>
                        <button
                          onClick={() => onToggleLanguage(lang.code)}
                          className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${ isSelected ? 'bg-blue-600 text-white' : 'bg-[#f1f5f9] hover:bg-[#e2e8f0] text-slate-700' }`}
                        >
                          {isSelected ? 'Active' : 'Select'}
                        </button>
                        {lang.code !== 'tam' && (
                          <button
                            onClick={() => handleDelete(lang.code)}
                            disabled={isDeleting}
                            title={`Remove ${lang.code}.traineddata from workspace`}
                            className="p-1 hover:bg-rose-100 rounded text-slate-600 hover:text-rose-600 transition-colors"
                          >
                            {isDeleting ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <Trash2 className="w-3.5 h-3.5" />
                            )}
                          </button>
                        )}
                      </>
                    ) : (
                      <button
                        onClick={() => handleDownload(lang.code)}
                        disabled={isDownloading}
                        className="flex items-center gap-1.5 px-3 py-1 bg-emerald-700 hover:bg-emerald-600 text-white rounded text-xs font-medium shadow-xs border border-emerald-500/50 disabled:opacity-50 transition-colors"
                      >
                        {isDownloading ? (
                          <>
                            <Loader2 className="w-3 h-3 animate-spin" />
                            <span>Downloading...</span>
                          </>
                        ) : (
                          <>
                            <Download className="w-3 h-3" />
                            <span>Download Model</span>
                          </>
                        )}
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Modal Footer */}
        <div className="p-3 border-t border-[#e2e8f0] bg-[#f1f5f9] flex items-center justify-between text-xs">
          <div className="text-slate-600 flex items-center gap-1">
            <HardDrive className="w-3.5 h-3.5 text-blue-600" />
            <span>
              Active OCR Languages:{''}
              <strong className="text-slate-900 font-mono">{selectedLanguages.join('+') || 'tam'}</strong>
            </span>
          </div>
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded text-xs font-semibold shadow-xs"
          >
            Apply & Done
          </button>
        </div>
      </div>
    </div>
  );
};
