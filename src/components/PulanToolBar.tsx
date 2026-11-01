import React, { useState, useRef, useEffect } from 'react';
import {
  FolderOpen,
  ChevronLeft,
  ChevronRight,
  ZoomIn,
  ZoomOut,
  Maximize2,
  RotateCcw,
  RotateCw,
  Layers,
  Columns,
  Play,
  FileText,
  FileCode,
  FileCheck,
  MousePointer,
  Square,
  Contrast,
  SlidersHorizontal,
  Loader2,
  Languages,
  Settings2,
  Check,
  ChevronDown,
  Globe,
  Download,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  Sliders,
  Type,
  BookOpen,
  ScanText,
  KeyRound,
  Cpu,
  PlugZap,
  TerminalSquare,
  ShieldCheck,
} from 'lucide-react';
import { OCREngine, ImageFilters, EngineOptionsState, EngineStatus, TessLanguageInfo, AiProviderInfo, AiProviderSettings, isAiEngineId } from '../types';

interface PulanToolBarProps {
  onOpenFile: () => void;
  currentPage: number;
  totalPages: number;
  onPrevPage: () => void;
  onNextPage: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFitWindow: () => void;
  onFitWidth: () => void;
  onActualSize: () => void;
  zoomLevel: number;
  onRotateCW: () => void;
  onRotateCCW: () => void;
  drawMode: 'select' | 'pan';
  onSetDrawMode: (mode: 'select' | 'pan') => void;
  filters: ImageFilters;
  onToggleBinarize: () => void;
  onToggleInvert: () => void;
  layoutMode: string;
  onSetLayoutMode: (mode: string) => void;
  onDetectLayoutAllPages: () => void;
  onDetectLayoutCurrentPage: () => void;
  isDetectingLayout: boolean;
  selectedEngine: OCREngine;
  onSelectEngine: (engine: OCREngine) => void;
  engineOptions: EngineOptionsState;
  onChangeEngineOptions: (options: EngineOptionsState) => void;
  onOpenManageLanguages: () => void;
  installedLanguages: TessLanguageInfo[];
  engineStatus?: EngineStatus | null;
  onRefreshEngineStatus?: () => void | Promise<unknown>;
  aiProvidersInfo?: AiProviderInfo[];
  /** Open the in-app sign-in panel for a subscription. */
  onOpenSignIn?: (provider: 'claude' | 'chatgpt' | 'google') => void;
  onRecognizePage: () => void;
  onRecognizeAllPages: () => void;
  onOpenDiagnostics: () => void;
  diagnosticsRegionCount?: number;
  isRecognizing: boolean;
  onExport: (format: 'docx' | 'txt' | 'json' | 'html') => void;
  onOpenPreprocessingModal: () => void;
}

export const PulanToolBar: React.FC<PulanToolBarProps> = ({
  onOpenFile,
  currentPage,
  totalPages,
  onPrevPage,
  onNextPage,
  onZoomIn,
  onZoomOut,
  onFitWindow,
  onFitWidth,
  onActualSize,
  zoomLevel,
  onRotateCW,
  onRotateCCW,
  drawMode,
  onSetDrawMode,
  filters,
  onToggleBinarize,
  onToggleInvert,
  layoutMode,
  onSetLayoutMode,
  onDetectLayoutAllPages,
  onDetectLayoutCurrentPage,
  isDetectingLayout,
  selectedEngine,
  onSelectEngine,
  engineOptions,
  onChangeEngineOptions,
  onOpenManageLanguages,
  installedLanguages,
  engineStatus,
  onRefreshEngineStatus,
  aiProvidersInfo,
  onOpenSignIn,
  onRecognizePage,
  onRecognizeAllPages,
  onOpenDiagnostics,
  diagnosticsRegionCount,
  isRecognizing,
  onExport,
  onOpenPreprocessingModal,
}) => {
  const [showLangDropdown, setShowLangDropdown] = useState(false);
  const [testingAi, setTestingAi] = useState(false);
  const [aiTestResult, setAiTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const langDropdownRef = useRef<HTMLDivElement>(null);

  // Close language dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (langDropdownRef.current && !langDropdownRef.current.contains(e.target as Node)) {
        setShowLangDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const currentLanguages = engineOptions.tesseract.languages || ['tam', 'eng'];

  // Languages available offline inside engines/tessdata (fallback keeps the selector usable)
  const installedList = installedLanguages.filter((l) => l.isInstalled);
  const availableLanguages: TessLanguageInfo[] = installedList.length
    ? installedList
    : [
        { code: 'tam', name: 'Tamil', nativeName: 'தமிழ்', approxSize: '~1.6 MB', isInstalled: true, category: 'indic' },
        { code: 'eng', name: 'English', nativeName: 'English', approxSize: '~4.1 MB', isInstalled: true, category: 'international' },
      ];
  const downloadableCount = installedLanguages.filter((l) => !l.isInstalled).length;
  // Selected languages whose .traineddata file is not present in engines/tessdata yet
  const missingLanguages = currentLanguages.filter(
    (code) => !availableLanguages.some((l) => l.code === code)
  );

  const toggleLanguage = (code: string) => {
    let next: string[];
    if (currentLanguages.includes(code)) {
      if (currentLanguages.length === 1) return; // keep at least one
      next = currentLanguages.filter((c) => c !== code);
    } else {
      next = [...currentLanguages, code];
    }
    onChangeEngineOptions({
      ...engineOptions,
      tesseract: {
        ...engineOptions.tesseract,
        languages: next,
      },
    });
  };

  const setLanguagesExact = (langs: string[]) => {
    onChangeEngineOptions({
      ...engineOptions,
      tesseract: {
        ...engineOptions.tesseract,
        languages: langs,
      },
    });
  };

  // --- AI vision provider panel state -------------------------------------
  const aiKey: 'gemini' | 'claude' | 'chatgpt' | 'openaiCompatible' =
    selectedEngine === 'gemini'
      ? 'gemini'
      : selectedEngine === 'claude'
      ? 'claude'
      : selectedEngine === 'chatgpt'
      ? 'chatgpt'
      : 'openaiCompatible';
  const aiSettings = engineOptions.aiProviders[aiKey];
  const aiInfo = aiProvidersInfo?.find((item) => item.engine === selectedEngine);
  // Engines whose subscription runs through a local CLI the user signs in to.
  const aiHasSubscription =
    selectedEngine === 'gemini' || selectedEngine === 'claude' || selectedEngine === 'chatgpt';

  const updateAiSettings = (patch: Partial<AiProviderSettings>) => {
    onChangeEngineOptions({
      ...engineOptions,
      aiProviders: {
        ...engineOptions.aiProviders,
        [aiKey]: { ...aiSettings, ...patch },
      },
    });
  };

  const runAiTest = async () => {
    setAiTestResult(null);
    setTestingAi(true);
    try {
      const res = await fetch('/api/ai/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          engine: selectedEngine,
          ai: {
            useSubscription: aiSettings.useSubscription,
            apiKey: aiSettings.apiKey,
            baseUrl: aiSettings.baseUrl,
            model: aiSettings.model,
            cliPath: aiSettings.cliPath,
            maxTurns: aiSettings.maxTurns,
          },
        }),
      });
      const data = await res.json();
      setAiTestResult({ ok: !!data.success, message: data.message || data.error || 'No answer from the server' });
    } catch (err: any) {
      setAiTestResult({ ok: false, message: err.message || 'Connection test failed' });
    } finally {
      setTestingAi(false);
    }
  };

  /** The backend actually in use, in one phrase, for the badge and the footer. */
  const aiBackendLabel = () => {
    if (!aiSettings.useSubscription) {
      return `${aiInfo?.label || 'API'} (API key)`;
    }
    if (selectedEngine === 'claude') {
      if (aiInfo && !aiInfo.subscription.available) {
        // Two different problems, two different fixes.
        return aiInfo.subscription.sdkVersion
          ? 'Claude Code not found'
          : 'Agent SDK not installed';
      }
      return aiInfo?.subscription.account || 'Claude subscription (via Claude Code)';
    }
    return aiInfo?.subscription.available ? `${aiInfo.subscription.bin} ready` : 'CLI not found';
  };

  const aiBackendReady = aiSettings.useSubscription
    ? !!aiInfo?.subscription.available && aiInfo?.subscription.signedIn !== false
    : !!(aiInfo?.envKeyConfigured || aiSettings.apiKey);

  return (
    <div className="bg-[#f1f5f9] text-slate-800 border-b border-[#e2e8f0] px-3 py-1.5 flex flex-wrap items-center gap-1.5 text-xs shadow-sm select-none">
      {/* 1. Open Document Group */}
      <div className="flex items-center gap-1">
        <button
          onClick={onOpenFile}
          title="Open Document (PDF or Images)"
          className="flex items-center gap-1.5 px-2.5 py-1.5 bg-[#f1f5f9] hover:bg-[#e2e8f0] text-slate-900 rounded border border-[#cbd5e1] font-medium transition-colors shadow-xs active:translate-y-px"
        >
          <FolderOpen className="w-4 h-4 text-amber-600" />
          <span>Open File</span>
        </button>
      </div>

      <div className="h-6 w-px bg-[#e2e8f0] mx-0.5"></div>

      {/* 2. Page Navigation */}
      <div className="flex items-center gap-1 bg-[#ffffff] px-1.5 py-0.5 rounded border border-[#cbd5e1]">
        <button
          onClick={onPrevPage}
          disabled={currentPage <= 1}
          title="Previous Page"
          className="p-1 hover:bg-[#e2e8f0] rounded disabled:opacity-30 disabled:hover:bg-transparent text-slate-700"
        >
          <ChevronLeft className="w-3.5 h-3.5" />
        </button>
        <span className="font-mono text-[11px] px-1 text-slate-700 min-w-16 text-center">
          {totalPages > 0 ? `${currentPage} / ${totalPages}` : '0 / 0'}
        </span>
        <button
          onClick={onNextPage}
          disabled={currentPage >= totalPages}
          title="Next Page"
          className="p-1 hover:bg-[#e2e8f0] rounded disabled:opacity-30 disabled:hover:bg-transparent text-slate-700"
        >
          <ChevronRight className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* 3. Zoom Controls */}
      <div className="flex items-center gap-0.5 bg-[#ffffff] p-0.5 rounded border border-[#cbd5e1]">
        <button
          onClick={onZoomOut}
          title="Zoom Out"
          className="p-1.5 hover:bg-[#e2e8f0] rounded text-slate-700"
        >
          <ZoomOut className="w-3.5 h-3.5" />
        </button>
        <span className="font-mono text-[11px] px-1 text-slate-700 min-w-10 text-center font-semibold">
          {Math.round(zoomLevel * 100)}%
        </span>
        <button
          onClick={onZoomIn}
          title="Zoom In"
          className="p-1.5 hover:bg-[#e2e8f0] rounded text-slate-700"
        >
          <ZoomIn className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={onFitWindow}
          title="Fit to Window"
          className="px-1.5 py-1 text-[10px] hover:bg-[#e2e8f0] rounded text-slate-700 font-medium"
        >
          Fit
        </button>
        <button
          onClick={onFitWidth}
          title="Fit Width"
          className="px-1.5 py-1 text-[10px] hover:bg-[#e2e8f0] rounded text-slate-700 font-medium"
        >
          Width
        </button>
        <button
          onClick={onActualSize}
          title="Actual 100% Size"
          className="px-1.5 py-1 text-[10px] hover:bg-[#e2e8f0] rounded text-slate-700 font-medium"
        >
          1:1
        </button>
      </div>

      {/* 4. Page Rotation & Mode */}
      <div className="flex items-center gap-0.5 bg-[#ffffff] p-0.5 rounded border border-[#cbd5e1]">
        <button
          onClick={onRotateCCW}
          title="Rotate Counter-Clockwise (90° Left)"
          className="p-1.5 hover:bg-[#e2e8f0] rounded text-slate-700"
        >
          <RotateCcw className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={onRotateCW}
          title="Rotate Clockwise (90° Right)"
          className="p-1.5 hover:bg-[#e2e8f0] rounded text-slate-700"
        >
          <RotateCw className="w-3.5 h-3.5" />
        </button>
        <div className="h-4 w-px bg-[#e2e8f0] my-auto mx-0.5"></div>
        <button
          onClick={() => onSetDrawMode('pan')}
          title="Pan Mode (Drag Image)"
          className={`p-1.5 rounded transition-colors ${ drawMode === 'pan' ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-[#e2e8f0]' }`}
        >
          <MousePointer className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => onSetDrawMode('select')}
          title="Zone Select / Draw Mode (Drag to create OCR zone)"
          className={`p-1.5 rounded transition-colors ${ drawMode === 'select' ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-[#e2e8f0]' }`}
        >
          <Square className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* 5. Preprocessing filters */}
      <div className="flex items-center gap-0.5 bg-[#ffffff] p-0.5 rounded border border-[#cbd5e1]">
        <button
          onClick={onToggleBinarize}
          title="Toggle Binarize (Otsu Black & White Threshold)"
          className={`px-2 py-1 rounded text-[11px] font-medium transition-colors ${ filters.binarize ? 'bg-purple-600 text-white' : 'text-slate-700 hover:bg-[#e2e8f0]' }`}
        >
          <span className="flex items-center gap-1">
            <Contrast className="w-3 h-3" /> Binarize
          </span>
        </button>
        <button
          onClick={onOpenPreprocessingModal}
          title="Adjust Brightness, Contrast & Threshold"
          className="p-1.5 rounded hover:bg-[#e2e8f0] text-slate-700"
        >
          <SlidersHorizontal className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="h-6 w-px bg-[#e2e8f0] mx-0.5"></div>

      {/* 6. Layout Detection Group */}
      <div className="flex items-center gap-1">
        <select
          value={layoutMode}
          onChange={(e) => onSetLayoutMode(e.target.value)}
          title="Layout Mode"
          className="bg-[#ffffff] text-slate-800 border border-[#cbd5e1] rounded px-2 py-1 text-[11px] font-medium outline-hidden"
        >
          <option value="auto">Auto Multi-Column</option>
          <option value="2col">2-Columns Layout</option>
          <option value="3col">3-Columns Layout</option>
          <option value="single">Single Block</option>
        </select>

        {/* PRIMARY ACTION: Detect Layout (All Pages) in single button */}
        <button
          onClick={onDetectLayoutAllPages}
          disabled={isDetectingLayout || totalPages === 0}
          title="Detect multi-column layout across all pages in 1 click"
          className="flex items-center gap-1.5 px-3 py-1.5 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white rounded font-semibold text-xs shadow-md shadow-blue-900/10 border border-blue-400/40 active:translate-y-px disabled:opacity-50"
        >
          {isDetectingLayout ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-900" />
          ) : (
            <Layers className="w-3.5 h-3.5 text-blue-700" />
          )}
          <span>Detect Layout (All Pages)</span>
        </button>

        <button
          onClick={onDetectLayoutCurrentPage}
          disabled={isDetectingLayout || totalPages === 0}
          title="Detect columns and zones for Current Page only"
          className="flex items-center gap-1 px-2 py-1.5 bg-[#f1f5f9] hover:bg-[#e2e8f0] text-slate-800 rounded border border-[#cbd5e1] text-[11px] font-medium transition-colors"
        >
          <Columns className="w-3 h-3 text-cyan-600" />
          <span>Page Layout</span>
        </button>
      </div>

      <div className="h-6 w-px bg-[#e2e8f0] mx-0.5"></div>

      {/* 7. OCR Engine Selector & DYNAMIC ENGINE OPTIONS PANEL */}
      <div className="flex items-center gap-1.5 bg-[#f8fafc] px-2 py-1 rounded border border-[#cbd5e1]">
        <div className="flex items-center gap-1">
          <span className="text-[11px] text-slate-600 font-medium">Engine:</span>
          <select
            value={selectedEngine}
            onChange={(e) => onSelectEngine(e.target.value as OCREngine)}
            className="bg-[#ffffff] text-black border border-blue-300 font-semibold rounded px-2 py-0.5 text-xs outline-hidden focus:ring-1 focus:ring-blue-500"
          >
            <option value="tesseract">Tesseract OCR (Multi-Language)</option>
            <option value="surya">Surya OCR (Tamil Layout/Line)</option>
            <option value="chandra">Chandra OCR (Indic Column/News)</option>
            <option value="gnana70">gnana70 / tamil_ocr (Gnana Prasath)</option>
            <option value="gemini">Google Gemini 2.5 Flash Tamil</option>
            <option value="claude">Claude (Anthropic) Vision</option>
            <option value="chatgpt">ChatGPT (OpenAI) Vision</option>
            <option value="openai-compatible">OpenAI-compatible AI (Ollama, LM Studio, ...)</option>
          </select>
        </div>

        {/* Engine backend availability badge (Tesseract binary found or not) */}
        {engineStatus && (
          engineStatus.tesseract?.available ? (
            <span
              title={`Tesseract ready: ${engineStatus.tesseract.version || 'installed'}${ engineStatus.tesseract.path ?`\n${engineStatus.tesseract.path}`: '' }`}
              className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-100 text-emerald-700 border border-emerald-300"
            >
              <CheckCircle2 className="w-3 h-3" />
              Engine Ready
            </span>
          ) : (
            <span className="flex items-center gap-1">
              <span
                title={
                  engineStatus.error ||
                  'Tesseract binary not found. Install Tesseract (tesseract-ocr-w64-setup-*.exe) or set the TESSERACT_CMD environment variable, then restart the app.'
                }
                className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-rose-100 text-rose-600 border border-rose-300"
              >
                <AlertTriangle className="w-3 h-3" />
                Tesseract not found
              </span>
              {onRefreshEngineStatus && (
                <button
                  onClick={() => onRefreshEngineStatus()}
                  title="Re-check the OCR engine installation"
                  className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-[#f1f5f9] hover:bg-[#e2e8f0] text-slate-800 border border-[#cbd5e1]"
                >
                  <RefreshCw className="w-3 h-3" />
                  Recheck
                </button>
              )}
            </span>
          )
        )}

        {/* --- DYNAMIC OPTION: TESSERACT ENGINE OPTIONS --- */}
        {selectedEngine === 'tesseract' && (
          <div className="flex items-center gap-1.5 pl-1 border-l border-[#cbd5e1]">
            {/* Quick Language Pills */}
            <div className="flex items-center gap-1">
              <span className="text-[11px] text-slate-600 font-medium">Languages:</span>
              <div className="flex items-center gap-0.5 bg-[#ffffff] p-0.5 rounded border border-[#cbd5e1]">
                <button
                  onClick={() => setLanguagesExact(['tam'])}
                  title="Tamil Only"
                  className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors ${ currentLanguages.length === 1 && currentLanguages.includes('tam') ? 'bg-blue-600 text-white font-bold' : 'text-slate-700 hover:bg-[#e2e8f0]' }`}
                >
                  தமிழ்
                </button>
                <button
                  onClick={() => setLanguagesExact(['tam', 'eng'])}
                  title="Bilingual: Tamil + English (tam+eng)"
                  className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors ${ currentLanguages.includes('tam') && currentLanguages.includes('eng') && currentLanguages.length === 2 ? 'bg-blue-600 text-white font-bold' : 'text-slate-700 hover:bg-[#e2e8f0]' }`}
                >
                  தமிழ்+Eng
                </button>
              </div>
            </div>

            {/* Multi-language Dropdown Popover */}
            <div className="relative" ref={langDropdownRef}>
              <button
                onClick={() => setShowLangDropdown(!showLangDropdown)}
                title="Select multiple languages for OCR"
                className="flex items-center gap-1 px-2 py-1 bg-[#ffffff] hover:bg-[#e2e8f0] rounded border border-[#cbd5e1] text-[11px] font-mono text-blue-700"
              >
                <Globe className="w-3 h-3 text-blue-600" />
                <span className="font-semibold">{currentLanguages.join('+') || 'tam'}</span>
                <ChevronDown className="w-3 h-3 text-slate-600" />
              </button>

              {showLangDropdown && (
                <div className="absolute top-full left-0 mt-1 bg-[#ffffff] border border-[#cbd5e1] rounded-md shadow-xl p-2 z-50 min-w-[240px] text-xs">
                  <div className="font-semibold text-slate-800 mb-1.5 pb-1 border-b border-[#e2e8f0] flex items-center justify-between">
                    <span>Installed Languages</span>
                    <span className="text-[10px] text-slate-600 font-normal">Check to combine</span>
                  </div>

                  {missingLanguages.length > 0 && (
                    <div className="mb-1.5 px-1.5 py-1 rounded bg-amber-100 border border-amber-300 text-[10px] text-amber-600">
                      {missingLanguages.join(',')} model not downloaded yet — use “Manage & Download More…”
                    </div>
                  )}

                  <div className="space-y-1 max-h-48 overflow-y-auto pr-1">
                    {availableLanguages.map((l) => (
                      <label
                        key={l.code}
                        className="flex items-center gap-2 p-1 rounded hover:bg-[#f1f5f9] cursor-pointer text-slate-700"
                      >
                        <input
                          type="checkbox"
                          checked={currentLanguages.includes(l.code)}
                          onChange={() => toggleLanguage(l.code)}
                          className="rounded border-[#94a3b8] text-blue-600 focus:ring-0 w-3.5 h-3.5"
                        />
                        <span className="font-medium text-slate-800">{l.name}</span>
                        <span className="text-[10px] text-blue-600 font-tamil ml-auto">
                          {l.nativeName}
                        </span>
                      </label>
                    ))}
                  </div>

                  <div className="mt-2 pt-1.5 border-t border-[#e2e8f0]">
                    <button
                      onClick={() => {
                        setShowLangDropdown(false);
                        onOpenManageLanguages();
                      }}
                      className="w-full flex items-center justify-center gap-1 py-1 bg-blue-100 hover:bg-blue-100 border border-blue-300 rounded text-[11px] text-blue-700 font-medium transition-colors"
                    >
                      <Download className="w-3 h-3" />
                      Manage &amp; Download More...
                    </button>
                    {downloadableCount > 0 && (
                      <div className="mt-1 text-center text-[10px] text-slate-500">
                        +{downloadableCount} more Tesseract models available
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Multi-language active badge */}
            {currentLanguages.length > 1 && (
              <span
                title={`Multi-language OCR active: ${currentLanguages.join(' + ')}`}
                className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 border border-emerald-300 font-semibold"
              >
                Multi ({currentLanguages.length})
              </span>
            )}

            {/* Manage Languages Dialog Button */}
            <button
              onClick={onOpenManageLanguages}
              title="Download new language data (.traineddata) or manage installed models"
              className="flex items-center gap-1 px-2 py-1 bg-blue-100 hover:bg-blue-100 text-blue-700 border border-blue-300 rounded text-[11px] font-medium transition-colors"
            >
              <Languages className="w-3.5 h-3.5 text-blue-600" />
              <span>Manage Languages...</span>
            </button>

            {/* Tesseract PSM Mode Selector */}
            <div className="flex items-center gap-1">
              <span className="text-[11px] text-slate-600 font-medium">PSM:</span>
              <select
                value={engineOptions.tesseract.psm}
                onChange={(e) =>
                  onChangeEngineOptions({
                    ...engineOptions,
                    tesseract: {
                      ...engineOptions.tesseract,
                      psm: e.target.value,
                    },
                  })
                }
                title="Page Segmentation Mode (PSM)"
                className="bg-[#ffffff] text-slate-800 border border-[#cbd5e1] rounded px-1.5 py-0.5 text-[11px] font-mono outline-hidden"
              >
                <option value="6">PSM 6: Uniform Block</option>
                <option value="3">PSM 3: Fully Automatic</option>
                <option value="4">PSM 4: Single Column Variable</option>
                <option value="1">PSM 1: Auto with OSD</option>
                <option value="11">PSM 11: Sparse Text</option>
              </select>
            </div>
          </div>
        )}

        {/* --- DYNAMIC OPTION: SURYA OCR OPTIONS --- */}
        {selectedEngine === 'surya' && (
          <div className="flex items-center gap-1.5 pl-1 border-l border-[#cbd5e1]">
            <span className="text-[11px] text-slate-600 font-medium">Layout:</span>
            <select
              value={engineOptions.surya.layoutMode}
              onChange={(e) =>
                onChangeEngineOptions({
                  ...engineOptions,
                  surya: {
                    ...engineOptions.surya,
                    layoutMode: e.target.value as any,
                  },
                })
              }
              className="bg-[#ffffff] text-slate-800 border border-[#cbd5e1] rounded px-1.5 py-0.5 text-[11px] outline-hidden"
            >
              <option value="auto">Auto Columns</option>
              <option value="2col">2-Columns Strict</option>
              <option value="3col">3-Columns Strict</option>
              <option value="single">Single Block</option>
            </select>

            <span className="text-[11px] text-slate-600 font-medium ml-1">Order:</span>
            <select
              value={engineOptions.surya.readingOrder}
              onChange={(e) =>
                onChangeEngineOptions({
                  ...engineOptions,
                  surya: {
                    ...engineOptions.surya,
                    readingOrder: e.target.value as any,
                  },
                })
              }
              className="bg-[#ffffff] text-slate-800 border border-[#cbd5e1] rounded px-1.5 py-0.5 text-[11px] outline-hidden"
            >
              <option value="top_down">Top-to-Bottom</option>
              <option value="column_first">Column-by-Column</option>
            </select>
          </div>
        )}

        {/* --- DYNAMIC OPTION: CHANDRA INDIC OCR OPTIONS --- */}
        {selectedEngine === 'chandra' && (
          <div className="flex items-center gap-1.5 pl-1 border-l border-[#cbd5e1]">
            <span className="text-[11px] text-slate-600 font-medium">Script:</span>
            <select
              value={engineOptions.chandra.scriptMode}
              onChange={(e) =>
                onChangeEngineOptions({
                  ...engineOptions,
                  chandra: {
                    ...engineOptions.chandra,
                    scriptMode: e.target.value as any,
                  },
                })
              }
              className="bg-[#ffffff] text-slate-800 border border-[#cbd5e1] rounded px-1.5 py-0.5 text-[11px] outline-hidden"
            >
              <option value="modern">Modern Standard Tamil</option>
              <option value="sangam">Classical Sangam Tamil</option>
              <option value="bilingual">Bilingual Tamil-English</option>
            </select>

            <span className="text-[11px] text-slate-600 font-medium ml-1">Diacritics:</span>
            <select
              value={engineOptions.chandra.diacriticLevel}
              onChange={(e) =>
                onChangeEngineOptions({
                  ...engineOptions,
                  chandra: {
                    ...engineOptions.chandra,
                    diacriticLevel: e.target.value as any,
                  },
                })
              }
              className="bg-[#ffffff] text-slate-800 border border-[#cbd5e1] rounded px-1.5 py-0.5 text-[11px] outline-hidden"
            >
              <option value="normal">Normal Sharpening</option>
              <option value="enhanced">Pulli & Kombu High</option>
              <option value="palm_leaf">Palm-leaf Ancient</option>
            </select>
          </div>
        )}

        {/* --- DYNAMIC OPTION: GNANA70 TAMIL OCR OPTIONS --- */}
        {selectedEngine === 'gnana70' && (
          <div className="flex items-center gap-1.5 pl-1 border-l border-[#cbd5e1]">
            <span className="text-[11px] text-slate-600 font-medium">Detector:</span>
            <select
              value={engineOptions.gnana70.detector}
              onChange={(e) =>
                onChangeEngineOptions({
                  ...engineOptions,
                  gnana70: {
                    ...engineOptions.gnana70,
                    detector: e.target.value as any,
                  },
                })
              }
              className="bg-[#ffffff] text-slate-800 border border-[#cbd5e1] rounded px-1.5 py-0.5 text-[11px] outline-hidden"
            >
              <option value="craft_words">CRAFT Word-Level</option>
              <option value="craft_lines">CRAFT Line-Level</option>
            </select>

            <label className="flex items-center gap-1 text-[11px] text-slate-700 cursor-pointer ml-1">
              <input
                type="checkbox"
                checked={engineOptions.gnana70.ligatureFusion}
                onChange={(e) =>
                  onChangeEngineOptions({
                    ...engineOptions,
                    gnana70: {
                      ...engineOptions.gnana70,
                      ligatureFusion: e.target.checked,
                    },
                  })
                }
                className="w-3.5 h-3.5 rounded border-[#94a3b8] text-blue-600 focus:ring-0"
              />
              <span>Ligatures Fusion</span>
            </label>
          </div>
        )}

        {/* --- DYNAMIC OPTION: GOOGLE GEMINI OPTIONS --- */}
        {selectedEngine === 'gemini' && (
          <div className="flex items-center gap-1.5 pl-1 border-l border-[#cbd5e1]">
            <span className="text-[11px] text-slate-600 font-medium">Format:</span>
            <select
              value={engineOptions.gemini.promptMode}
              onChange={(e) =>
                onChangeEngineOptions({
                  ...engineOptions,
                  gemini: {
                    ...engineOptions.gemini,
                    promptMode: e.target.value as any,
                  },
                })
              }
              className="bg-[#ffffff] text-slate-800 border border-[#cbd5e1] rounded px-1.5 py-0.5 text-[11px] outline-hidden"
            >
              <option value="raw">Accurate Raw Text</option>
              <option value="markdown">Markdown & Columns</option>
              <option value="palm_leaf">Palm-leaf Calligraphy</option>
              <option value="tables">Table & Forms Extractor</option>
            </select>
          </div>
        )}
        {/* --- DYNAMIC OPTION: AI VISION PROVIDERS (Claude / ChatGPT / compatible) --- */}
        {isAiEngineId(selectedEngine) && (
          <div className="flex items-center gap-1.5 pl-1 border-l border-[#cbd5e1] flex-wrap">
            {aiHasSubscription && (
              <label
                className="flex items-center gap-1 text-[11px] text-slate-700"
                title={
                  aiInfo?.subscription.available
                    ? `Use the local ${aiInfo.subscription.bin} CLI (subscription login, no API key)`
                    : `The ${aiInfo?.subscription.bin || 'CLI'} was not found — install it and sign in to use a subscription instead of an API key`
                }
              >
                <input
                  type="checkbox"
                  checked={aiSettings.useSubscription}
                  onChange={(e) => updateAiSettings({ useSubscription: e.target.checked })}
                  className="accent-blue-600"
                />
                <TerminalSquare className="w-3.5 h-3.5 text-slate-600" />
                Subscription
              </label>
            )}

            {!aiSettings.useSubscription && (
              <label className="flex items-center gap-1 text-[11px] text-slate-600">
                <KeyRound className="w-3.5 h-3.5 text-amber-600" />
                <input
                  type="password"
                  value={aiSettings.apiKey}
                  onChange={(e) => updateAiSettings({ apiKey: e.target.value })}
                  placeholder={aiInfo?.envKeyConfigured ? `${aiInfo.envKeyName} is set` : 'API key'}
                  className="w-40 bg-[#ffffff] text-slate-800 border border-[#cbd5e1] rounded px-1.5 py-0.5 text-[11px] outline-hidden"
                  title={`Kept in this browser only, and sent to the provider you configure. Leave empty to use ${aiInfo?.envKeyName || 'the server environment'}.`}
                />
              </label>
            )}

            <label className="flex items-center gap-1 text-[11px] text-slate-600">
              <Globe className="w-3.5 h-3.5 text-slate-500" />
              <input
                type="text"
                value={aiSettings.baseUrl}
                onChange={(e) => updateAiSettings({ baseUrl: e.target.value })}
                placeholder={aiInfo?.defaultBaseUrl || 'https://endpoint/v1'}
                className="w-52 bg-[#ffffff] text-slate-800 border border-[#cbd5e1] rounded px-1.5 py-0.5 text-[11px] outline-hidden"
                title="Endpoint base URL. Leave empty for the provider default."
              />
            </label>

            <label className="flex items-center gap-1 text-[11px] text-slate-600">
              <Cpu className="w-3.5 h-3.5 text-slate-500" />
              <input
                type="text"
                value={aiSettings.model}
                onChange={(e) => updateAiSettings({ model: e.target.value })}
                placeholder={aiInfo?.defaultModel || 'model name'}
                className="w-40 bg-[#ffffff] text-slate-800 border border-[#cbd5e1] rounded px-1.5 py-0.5 text-[11px] outline-hidden"
                title="Model name served by the endpoint."
              />
            </label>

            {aiSettings.useSubscription && (
              <>
                {selectedEngine === 'claude' && (
                  <label className="flex items-center gap-1 text-[11px] text-slate-600">
                    <TerminalSquare className="w-3.5 h-3.5 text-slate-500" />
                    <input
                      type="text"
                      value={aiSettings.cliPath}
                      onChange={(e) => updateAiSettings({ cliPath: e.target.value })}
                      placeholder="claude path (bundled)"
                      className="w-40 bg-[#ffffff] text-slate-800 border border-[#cbd5e1] rounded px-1.5 py-0.5 text-[11px] outline-hidden"
                      title={
                        aiInfo?.subscription.bin
                          ? `Leave empty to use ${aiInfo.subscription.bin}. Set this only to run a different Claude Code installation.`
                          : 'Leave empty to use the CLI bundled with the claude-agent-sdk package.'
                      }
                    />
                  </label>
                )}

                <button
                  onClick={() =>
                    onOpenSignIn?.(
                      selectedEngine === 'gemini'
                        ? 'google'
                        : selectedEngine === 'chatgpt'
                        ? 'chatgpt'
                        : 'claude'
                    )
                  }
                  title="Sign in to your subscription from inside the app: the panel shows the sign-in link and takes the code, so no terminal is needed"
                  className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-blue-700 hover:bg-blue-600 text-white border border-blue-500/40"
                >
                  <ShieldCheck className="w-3 h-3" />
                  {aiBackendReady ? 'Account' : 'Sign in'}
                </button>
              </>
            )}

            <button
              onClick={runAiTest}
              disabled={testingAi}
              title="Send a tiny request to verify the key, endpoint or subscription"
              className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-[#f1f5f9] hover:bg-[#e2e8f0] text-slate-800 border border-[#cbd5e1] disabled:opacity-50"
            >
              {testingAi ? <Loader2 className="w-3 h-3 animate-spin" /> : <PlugZap className="w-3 h-3" />}
              Test
            </button>

            {aiInfo && (
              <span
                className={`px-1.5 py-0.5 rounded text-[10px] font-medium border ${
                  aiBackendReady
                    ? 'bg-emerald-100 text-emerald-700 border-emerald-300'
                    : 'bg-amber-100 text-amber-700 border-amber-300'
                }`}
                title={
                  aiSettings.useSubscription
                    ? `${aiBackendLabel()}${aiInfo.subscription.bin ? ` — ${aiInfo.subscription.bin} ${aiInfo.subscription.version || ''}` : ''}`
                    : aiInfo.envKeyConfigured
                    ? `Using ${aiInfo.envKeyName} from the server environment`
                    : 'No key set: paste one, or set the environment variable'
                }
              >
                {aiBackendLabel()}
              </span>
            )}

            {aiTestResult && (
              <span
                className={`px-1.5 py-0.5 rounded text-[10px] border max-w-[320px] truncate ${
                  aiTestResult.ok
                    ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                    : 'bg-rose-50 text-rose-700 border-rose-200'
                }`}
                title={aiTestResult.message}
              >
                {aiTestResult.message}
              </span>
            )}

            {selectedEngine === 'claude' && aiSettings.useSubscription && (
              <span
                className="text-[10px] text-slate-500 italic"
                title="Usage draws on the same subscription limits as the Claude apps and Claude Code. The page reaches Claude through this app's own read-only OCR tools: file, shell and web access are refused."
              >
                Uses your Claude subscription limits
              </span>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center gap-1 ml-auto">
        <button
          onClick={onRecognizePage}
          disabled={isRecognizing || totalPages === 0}
          title="Run Tamil OCR on current page"
          className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded font-semibold text-xs shadow-xs border border-emerald-400/40 active:translate-y-px disabled:opacity-50"
        >
          {isRecognizing ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Play className="w-3.5 h-3.5 fill-current" />
          )}
          <span>Recognize Page</span>
        </button>

        <button
          onClick={onRecognizeAllPages}
          disabled={isRecognizing || totalPages === 0}
          title="Run batch Tamil OCR on all pages"
          className="flex items-center gap-1.5 px-2.5 py-1.5 bg-blue-700 hover:bg-blue-600 text-white rounded font-medium text-xs shadow-xs border border-blue-500/40 active:translate-y-px disabled:opacity-50"
        >
          <Layers className="w-3.5 h-3.5" />
          <span>Batch OCR</span>
        </button>

        <button
          onClick={onOpenDiagnostics}
          disabled={totalPages === 0}
          title="Open the OCR diagnostics workspace: quality checks, crops, retries and corrections"
          className="flex items-center gap-1.5 px-2.5 py-1.5 bg-slate-700 hover:bg-slate-600 text-white rounded font-medium text-xs shadow-xs border border-slate-500/40 active:translate-y-px disabled:opacity-50"
        >
          <ScanText className="w-3.5 h-3.5" />
          <span>Diagnostics</span>
          {diagnosticsRegionCount ? (
            <span className="ml-0.5 px-1 rounded bg-white/20 text-[10px] font-semibold">
              {diagnosticsRegionCount}
            </span>
          ) : null}
        </button>

        {/* 9. Quick Export buttons */}
        <div className="flex items-center bg-[#ffffff] rounded border border-[#cbd5e1] p-0.5 ml-1">
          <button
            onClick={() => onExport('docx')}
            title="Export to Microsoft Word (.docx)"
            className="px-2 py-1 text-[11px] font-medium text-blue-600 hover:bg-[#e2e8f0] rounded flex items-center gap-1"
          >
            <FileText className="w-3 h-3" /> DOCX
          </button>
          <button
            onClick={() => onExport('txt')}
            title="Export to Text file (.txt)"
            className="px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-[#e2e8f0] rounded"
          >
            TXT
          </button>
          <button
            onClick={() => onExport('json')}
            title="Export to JSON with zones and coordinates (.json)"
            className="px-2 py-1 text-[11px] font-medium text-amber-600 hover:bg-[#e2e8f0] rounded"
          >
            JSON
          </button>
          <button
            onClick={() => onExport('html')}
            title="Export to HTML (.html)"
            className="px-2 py-1 text-[11px] font-medium text-emerald-600 hover:bg-[#e2e8f0] rounded"
          >
            HTML
          </button>
        </div>
      </div>
    </div>
  );
};
