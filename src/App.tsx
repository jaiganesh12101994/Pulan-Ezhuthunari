import React, { useState, useEffect, useRef, useCallback } from 'react';
import { PulanMenuBar } from './components/PulanMenuBar';
import { PulanToolBar } from './components/PulanToolBar';
import { DocumentTreePanel } from './components/DocumentTreePanel';
import { ImageViewerCanvas } from './components/ImageViewerCanvas';
import { TextEditorPanel } from './components/TextEditorPanel';
import { PulanStatusBar } from './components/PulanStatusBar';
import { PreprocessingModal } from './components/PreprocessingModal';
import { AboutModal } from './components/AboutModal';
import { BatchModal } from './components/BatchModal';
import { ManageLanguagesModal } from './components/ManageLanguagesModal';
import { DiagnosticsWorkspace } from './components/DiagnosticsWorkspace';
import { SubscriptionSignInModal } from './components/SubscriptionSignInModal';
import {
  DocumentPage,
  LayoutZone,
  OCREngine,
  ImageFilters,
  EngineOptionsState,
  EngineStatus,
  TessLanguageInfo,
  AiProviderInfo,
  isAiEngineId,
} from './types';

export default function App() {
  // Document state
  const [documentName, setDocumentName] = useState<string>('tamil_multicolumn_document.pdf');
  const [pages, setPages] = useState<DocumentPage[]>([]);
  const [currentPageIndex, setCurrentPageIndex] = useState<number>(0);
  const [selectedPageIds, setSelectedPageIds] = useState<Set<string>>(new Set());

  // OCR & Layout state
  const [selectedEngine, setSelectedEngine] = useState<OCREngine>('tesseract');
  const [layoutMode, setLayoutMode] = useState<string>('auto');
  const [isDetectingLayout, setIsDetectingLayout] = useState<boolean>(false);
  const [isRecognizing, setIsRecognizing] = useState<boolean>(false);
  const [activeZoneId, setActiveZoneId] = useState<string | null>(null);

  // Engine-specific options (Tesseract languages & PSM, Surya, Chandra, gnana70, Gemini)
  const [engineOptions, setEngineOptions] = useState<EngineOptionsState>({
    tesseract: {
      languages: ['tam', 'eng'],
      psm: '6',
    },
    surya: {
      layoutMode: 'auto',
      readingOrder: 'top_down',
    },
    chandra: {
      scriptMode: 'modern',
      diacriticLevel: 'normal',
    },
    gnana70: {
      detector: 'craft_words',
      ligatureFusion: true,
    },
    gemini: {
      promptMode: 'raw',
    },
    aiProviders: {
      // The Claude subscription is the default: no API key, and it is what the
      // toolbar's "Check sign-in" button verifies.
      claude: { useSubscription: true, apiKey: '', baseUrl: '', model: '', cliPath: '', maxTurns: 4 },
      // The Gemini engine defaults to the Google subscription too: its API-key path is
      // configured through GEMINI_API_KEY, not through this panel.
      gemini: { useSubscription: true, apiKey: '', baseUrl: '', model: '', cliPath: '', maxTurns: 4 },
      chatgpt: { useSubscription: false, apiKey: '', baseUrl: '', model: '', cliPath: '', maxTurns: 4 },
      openaiCompatible: { useSubscription: false, apiKey: '', baseUrl: '', model: '', cliPath: '', maxTurns: 4 },
    },
  });

  // AI provider settings (including any pasted keys) stay in this browser only
  useEffect(() => {
    try {
      const stored = localStorage.getItem('pulan.aiProviders');
      if (stored) {
        const parsed = JSON.parse(stored);
        setEngineOptions((prev) => ({
          ...prev,
          aiProviders: {
            gemini: { ...prev.aiProviders.gemini, ...(parsed.gemini || {}) },
            claude: { ...prev.aiProviders.claude, ...(parsed.claude || {}) },
            chatgpt: { ...prev.aiProviders.chatgpt, ...(parsed.chatgpt || {}) },
            openaiCompatible: {
              ...prev.aiProviders.openaiCompatible,
              ...(parsed.openaiCompatible || {}),
            },
          },
        }));
      }
    } catch (err) {
      console.warn('Stored AI provider settings could not be read:', err);
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem('pulan.aiProviders', JSON.stringify(engineOptions.aiProviders));
    } catch {
      // private browsing / storage disabled: settings simply do not persist
    }
  }, [engineOptions.aiProviders]);

  const [installedLanguages, setInstalledLanguages] = useState<TessLanguageInfo[]>([]);
  const [showManageLanguagesModal, setShowManageLanguagesModal] = useState<boolean>(false);
  const [engineStatus, setEngineStatus] = useState<EngineStatus | null>(null);

  // OCR diagnostics workspace state
  const [showDiagnostics, setShowDiagnostics] = useState<boolean>(false);
  const [diagnosticsId, setDiagnosticsId] = useState<string | null>(null);
  const [renderDpi, setRenderDpi] = useState<number | undefined>(undefined);

  // AI vision providers (Claude / ChatGPT / OpenAI-compatible) availability
  const [aiProvidersInfo, setAiProvidersInfo] = useState<AiProviderInfo[]>([]);

  // Check that the OCR backends (Tesseract binary, Python, Pillow) are actually usable
  const refreshEngineStatus = async (): Promise<EngineStatus | null> => {
    try {
      const res = await fetch('/api/engines/status');
      const data = await res.json();
      const status: EngineStatus = {
        ...data,
        tesseract: data.tesseract || { available: false, path: null, version: null },
      };
      setEngineStatus(status);
      if (!status.tesseract?.available) {
        setStatusMessage(
          'OCR engine unavailable: Tesseract binary not found. Install Tesseract or set TESSERACT_CMD, then press Recheck in the toolbar.'
        );
      }
      return status;
    } catch (err) {
      console.error('Failed to read OCR engine status:', err);
      return null;
    }
  };

  /** Per-provider settings shaped for the server. */
  const aiSettingsFor = (engine: string) => {
    const key =
      engine === 'gemini'
        ? 'gemini'
        : engine === 'claude'
        ? 'claude'
        : engine === 'chatgpt'
        ? 'chatgpt'
        : 'openaiCompatible';
    const settings = engineOptions.aiProviders[key];
    return {
      useSubscription: settings.useSubscription,
      apiKey: settings.apiKey,
      baseUrl: settings.baseUrl,
      model: settings.model,
      cliPath: settings.cliPath,
      maxTurns: settings.maxTurns,
    };
  };

  // Payload fragment carrying the selected engine together with its per-engine options
  const buildOcrEnginePayload = () => ({
    engine: selectedEngine,
    language: engineOptions.tesseract.languages.join('+') || 'tam+eng',
    psm: engineOptions.tesseract.psm,
    engineOptions,
    // Vision-model settings for the AI engines (Claude / ChatGPT / compatible)
    ai: isAiEngineId(selectedEngine) ? aiSettingsFor(selectedEngine) : undefined,
  });

  // Diagnostic context so every OCR attempt is persisted with its page/region identity
  const buildDiagnosticContext = (page: DocumentPage, pageIndex: number, zone?: LayoutZone) => ({
    documentName,
    pageId: page.id,
    pageNumber: page.pageNumber,
    pageWidth: page.width,
    pageHeight: page.height,
    renderDpi,
    rotation: page.rotation ?? 0,
    regionId: zone ? zone.id : `${page.id}-fullpage`,
    regionType: zone ? zone.type : 'page',
    retryBudget: 2,
  });

  // Read the rasterization DPI once so diagnostic records carry the real render resolution
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/config');
        const data = await res.json();
        if (!cancelled && typeof data.renderDpi === 'number') setRenderDpi(data.renderDpi);
      } catch {
        // diagnostics still work without the DPI hint
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** Which AI providers are configured (server key, or a subscription sign-in). */
  const refreshAiProviders = useCallback(async () => {
    try {
      const res = await fetch('/api/ai/providers');
      const data = await res.json();
      if (Array.isArray(data.providers)) setAiProvidersInfo(data.providers);
    } catch {
      // the AI engines report their own configuration errors when used
    }
  }, []);

  useEffect(() => {
    void refreshAiProviders();
  }, [refreshAiProviders]);

  // Toggle a Tesseract language in/out of the active multi-language selection
  const handleToggleTessLanguage = (code: string) => {
    setEngineOptions((prev) => {
      const current = prev.tesseract.languages;
      let next: string[];
      if (current.includes(code)) {
        if (current.length === 1) return prev; // always keep at least one language
        next = current.filter((c) => c !== code);
      } else {
        next = [...current, code];
      }
      return { ...prev, tesseract: { ...prev.tesseract, languages: next } };
    });
  };

  // Load installed Tesseract language models (.traineddata) from engines/tessdata
  const refreshInstalledLanguages = async (): Promise<TessLanguageInfo[]> => {
    try {
      const res = await fetch('/api/tesseract/languages');
      const data = await res.json();
      const list: TessLanguageInfo[] = data.languages || [];
      setInstalledLanguages(list);
      return list;
    } catch (err) {
      console.error('Failed to fetch Tesseract languages:', err);
      return [];
    }
  };

  // Called after a language download / removal inside the Manage Languages modal
  const handleLanguagesUpdated = async () => {
    const list = await refreshInstalledLanguages();
    if (list.length === 0) return;
    const installedCodes = new Set(list.filter((l) => l.isInstalled).map((l) => l.code));
    setEngineOptions((prev) => {
      const kept = prev.tesseract.languages.filter((c) => installedCodes.has(c));
      if (kept.length === 0) kept.push('tam');
      if (kept.length === prev.tesseract.languages.length) return prev;
      return { ...prev, tesseract: { ...prev.tesseract, languages: kept } };
    });
  };

  // Canvas & View state
  const [zoomLevel, setZoomLevel] = useState<number>(0.9);
  const [drawMode, setDrawMode] = useState<'select' | 'pan'>('select');
  const [filters, setFilters] = useState<ImageFilters>({
    brightness: 100,
    contrast: 100,
    binarize: false,
    threshold: 140,
    invert: false,
  });

  // Editor state
  const [editorMode, setEditorMode] = useState<'page' | 'combined'>('page');
  const [combinedText, setCombinedText] = useState<string>('');
  const [statusMessage, setStatusMessage] = useState<string>('Ready');

  // Modals state
  const [showPreprocessingModal, setShowPreprocessingModal] = useState<boolean>(false);
  const [showAboutModal, setShowAboutModal] = useState<boolean>(false);
  // Which subscription's in-app sign-in panel is open, if any.
  const [signInProvider, setSignInProvider] = useState<'claude' | 'chatgpt' | 'google' | null>(null);
  const [batchModal, setBatchModal] = useState<{
    isOpen: boolean;
    title: string;
    total: number;
    current: number;
    currentMessage: string;
    isComplete: boolean;
    /** A cancel is in flight; the run stops at the next page or zone boundary. */
    isCancelling: boolean;
    /** The run stopped early because the user cancelled it. */
    wasCancelled: boolean;
    /** The run stopped because something failed; the message is the reason. */
    hasError: boolean;
  }>({
    isOpen: false,
    title: '',
    total: 0,
    current: 0,
    currentMessage: '',
    isComplete: false,
    isCancelling: false,
    wasCancelled: false,
    hasError: false,
  });

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Load installed Tesseract language models so the engine options panel can list them
  useEffect(() => {
    refreshInstalledLanguages();
  }, []);

  // Verify the OCR backend (Tesseract binary) is reachable on startup
  useEffect(() => {
    refreshEngineStatus();
  }, []);

  const currentPage = pages[currentPageIndex] || null;

  // Cancelling a long run. The flag stops the loop at the next page or zone boundary,
  // and the controller aborts the request already in flight so the wait ends at once
  // instead of after the page finishes.
  const batchCancelRef = useRef(false);
  const batchAbortRef = useRef<AbortController | null>(null);

  /** Start a run: a fresh cancel flag and a controller for the requests it will make. */
  const beginBatchRun = (): AbortSignal => {
    batchCancelRef.current = false;
    const controller = new AbortController();
    batchAbortRef.current = controller;
    return controller.signal;
  };

  /**
   * Stop the run in flight. A request already sent to the server cannot be recalled —
   * the server finishes the page it is working on and its answer is discarded — so the
   * promise is that nothing further is started, not that work stops mid-page.
   */
  const handleCancelBatch = () => {
    batchCancelRef.current = true;
    batchAbortRef.current?.abort();
    setBatchModal((prev) => ({
      ...prev,
      isCancelling: true,
      currentMessage: 'Cancelling — stopping after the page already in flight...',
    }));
    setStatusMessage('Cancelling...');
  };

  // File Upload Handler
  const handleOpenFileClick = () => {
    if (fileInputRef.current) {
      fileInputRef.current.click();
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const fileCount = files.length;
    const signal = beginBatchRun();
    setStatusMessage('Uploading and preparing document pages...');
    setBatchModal({
      isOpen: true,
      title: 'Opening Document — Preparing Pages',
      total: fileCount,
      current: 0,
      currentMessage: 'Uploading file(s) to the OCR backend...',
      isComplete: false,
      isCancelling: false,
      wasCancelled: false,
      hasError: false,
    });

    const formData = new FormData();
    for (let i = 0; i < files.length; i++) {
      formData.append('files', files[i]);
    }

    // Stay open on failure: a long message in the status bar is easy to miss, and the
    // dialog is where the user is looking.
    let keepOpen = false;

    try {
      // Streamed upload: rasterizing a scanned PDF takes seconds per page, so the
      // server reports progress while it works instead of leaving the UI frozen.
      const res = await fetch('/api/upload-stream', {
        method: 'POST',
        body: formData,
        signal,
      });
      if (!res.ok) {
        // The server explains upload failures in JSON - a file over the size limit, no
        // disk space left, too many files. The status code on its own ("HTTP 500") said
        // nothing, which is how a large book looked like a broken app.
        let detail = `Upload failed (HTTP ${res.status})`;
        try {
          const body = await res.json();
          if (body?.error) detail = body.error;
        } catch {
          // not JSON: keep the status-only message
        }
        throw new Error(detail);
      }

      let doneEvent: any = null;
      let streamError: string | null = null;

      const handleLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let event: any;
        try {
          event = JSON.parse(trimmed);
        } catch {
          return; // ignore partial or unexpected lines
        }

        if (event.type === 'progress') {
          if (event.message) {
            setStatusMessage(event.message);
            setBatchModal((prev) => ({
              ...prev,
              total: event.total || prev.total,
              current: event.page ?? prev.current,
              currentMessage: event.message,
            }));
          }
        } else if (event.type === 'done') {
          doneEvent = event;
        } else if (event.type === 'error') {
          streamError = event.error || 'Upload failed';
        }
      };

      if (res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          lines.forEach(handleLine);
        }
        buffer += decoder.decode();
        handleLine(buffer);
      } else {
        (await res.text()).split('\n').forEach(handleLine);
      }

      if (streamError) throw new Error(streamError);
      if (!doneEvent) throw new Error('Upload did not return any document pages');

      const newPages: DocumentPage[] = (doneEvent.pages || []).map((p: any) => ({
        id: p.id,
        pageNumber: p.pageNumber,
        fileName: p.fileName,
        url: p.url,
        filePath: p.filePath,
        width: p.width,
        height: p.height,
        detectedZones: [],
        ocrStatus: 'idle',
        rotation: 0,
      }));

      if (newPages.length === 0) throw new Error('Upload produced no document pages');

      setDocumentName(doneEvent.documentName);
      setPages(newPages);
      setCurrentPageIndex(0);
      setSelectedPageIds(new Set(newPages.map((p) => p.id)));
      setStatusMessage(`Successfully loaded ${newPages.length} pages from ${doneEvent.documentName}`);
    } catch (err: any) {
      if (batchCancelRef.current) {
        // Nothing is added to the open document, so there is nothing half-loaded to fix.
        keepOpen = true;
        setStatusMessage('Upload cancelled — no pages were added to the document.');
        setBatchModal((prev) => ({
          ...prev,
          isComplete: true,
          isCancelling: false,
          wasCancelled: true,
          hasError: false,
          currentMessage: 'Cancelled — no pages were added to the document.',
        }));
      } else {
        const message = err?.message || 'Upload failed';
        keepOpen = true;
        setStatusMessage(`Error: ${message}`);
        setBatchModal((prev) => ({
          ...prev,
          isComplete: true,
          isCancelling: false,
          wasCancelled: false,
          hasError: true,
          currentMessage: message,
        }));
      }
    } finally {
      batchAbortRef.current = null;
      batchCancelRef.current = false;
      if (!keepOpen) setBatchModal((prev) => ({ ...prev, isOpen: false }));
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  // 1-CLICK ACTION: Detect Layout (All Pages)
  const handleDetectLayoutAllPages = async () => {
    if (pages.length === 0) return;

    const signal = beginBatchRun();
    setIsDetectingLayout(true);
    setBatchModal({
      isOpen: true,
      title: 'Detecting Multi-Column Layout Across All Pages',
      total: pages.length,
      current: 0,
      currentMessage: 'Analyzing vertical and horizontal column gutters...',
      isComplete: false,
      isCancelling: false,
      wasCancelled: false,
      hasError: false,
    });

    try {
      const updatedPages = [...pages];
      let analyzed = 0;

      for (let i = 0; i < updatedPages.length; i++) {
        if (batchCancelRef.current) break;

        const p = updatedPages[i];
        setBatchModal((prev) => ({
          ...prev,
          current: i + 1,
          currentMessage: `Analyzing page ${i + 1} of ${updatedPages.length} (${p.fileName})...`,
        }));

        const res = await fetch('/api/layout-detect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal,
          body: JSON.stringify({
            image: p.url,
            filePath: p.filePath,
            mode: layoutMode,
            engine: selectedEngine,
            ai: isAiEngineId(selectedEngine) ? aiSettingsFor(selectedEngine) : undefined,
          }),
        });

        const data = await res.json();
        if (data.success && data.zones) {
          updatedPages[i] = {
            ...p,
            detectedZones: data.zones,
            width: data.width || p.width,
            height: data.height || p.height,
          };
        } else if (data.error) {
          throw new Error(data.error);
        }
        analyzed = i + 1;
      }

      setPages(updatedPages);

      if (batchCancelRef.current) {
        setBatchModal((prev) => ({
          ...prev,
          isComplete: true,
          isCancelling: false,
          wasCancelled: true,
          currentMessage: `Cancelled — ${analyzed} of ${updatedPages.length} pages were analyzed. Pages already done keep their zones.`,
        }));
        setStatusMessage(`Layout detection cancelled after ${analyzed} of ${updatedPages.length} pages.`);
      } else {
        setBatchModal((prev) => ({
          ...prev,
          isComplete: true,
          isCancelling: false,
          currentMessage: `Success! Multi-column layout detected across all ${updatedPages.length} pages.`,
        }));
        setStatusMessage(`Layout detected across all ${updatedPages.length} pages in reading order.`);
      }
    } catch (err: any) {
      if (batchCancelRef.current) {
        setBatchModal((prev) => ({
          ...prev,
          isComplete: true,
          isCancelling: false,
          wasCancelled: true,
          currentMessage: 'Cancelled — the page in flight was stopped. Pages already done keep their zones.',
        }));
        setStatusMessage('Layout detection cancelled.');
      } else {
        setStatusMessage(`Layout detection error: ${err.message}`);
        setBatchModal((prev) => ({
          ...prev,
          isComplete: true,
          isCancelling: false,
          hasError: true,
          currentMessage: `Failed: ${err.message}`,
        }));
      }
    } finally {
      batchAbortRef.current = null;
      batchCancelRef.current = false;
      setIsDetectingLayout(false);
    }
  };

  // Detect Layout (Current Page)
  const handleDetectLayoutCurrentPage = async () => {
    if (!currentPage) return;
    setIsDetectingLayout(true);
    setStatusMessage(`Detecting columns for Page ${currentPage.pageNumber}...`);

    try {
      const res = await fetch('/api/layout-detect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: currentPage.url,
          filePath: currentPage.filePath,
          mode: layoutMode,
          engine: selectedEngine,
          ai: isAiEngineId(selectedEngine) ? aiSettingsFor(selectedEngine) : undefined,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Detection failed');

      const updated = pages.map((p, idx) =>
        idx === currentPageIndex
          ? {
              ...p,
              detectedZones: data.zones || [],
              width: data.width || p.width,
              height: data.height || p.height,
            }
          : p
      );
      setPages(updated);
      setStatusMessage(
        `Page ${currentPage.pageNumber}: Detected ${data.zones?.length || 0} reading zones (${
          data.provider ? `${selectedEngine.toUpperCase()} · ${data.model || data.provider}` : selectedEngine.toUpperCase()
        })`
      );
    } catch (err: any) {
      setStatusMessage(`Error: ${err.message}`);
    } finally {
      setIsDetectingLayout(false);
    }
  };

  // Run OCR on Current Page
  const handleRecognizePage = async () => {
    if (!currentPage) return;
    setIsRecognizing(true);
    setStatusMessage(`Running ${selectedEngine.toUpperCase()} Tamil OCR on Page ${currentPage.pageNumber}...`);

    try {
      // If zones exist, recognize in reading order and join
      const zones = currentPage.detectedZones;
      let finalPageText = '';
      const zoneTexts: Record<string, string> = {};

      if (zones.length > 0) {
        // Sort zones by reading order
        const sorted = [...zones].sort((a, b) => a.order - b.order);
        const textParts: string[] = [];

        for (const zone of sorted) {
          const res = await fetch('/api/ocr', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              image: currentPage.url,
              filePath: currentPage.filePath,
              zone: { x: zone.x, y: zone.y, width: zone.width, height: zone.height },
              ...buildDiagnosticContext(currentPage, currentPageIndex, zone),
              ...buildOcrEnginePayload(),
            }),
          });
          const data = await res.json();
          if (!res.ok || data.error) {
            throw new Error(data.error || `OCR failed for zone ${zone.order}`);
          }
          if (data.diagnosticsId) setDiagnosticsId(data.diagnosticsId);
          if (data.text) {
            zoneTexts[zone.id] = data.text;
            textParts.push(data.text);
          }
        }
        finalPageText = textParts.join('\n\n');
      } else {
        // Full page OCR
        const res = await fetch('/api/ocr', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            image: currentPage.url,
            filePath: currentPage.filePath,
            ...buildDiagnosticContext(currentPage, currentPageIndex),
            ...buildOcrEnginePayload(),
          }),
        });
        const data = await res.json();
        if (!res.ok || data.error) {
          throw new Error(data.error || 'OCR failed for this page');
        }
        if (data.diagnosticsId) setDiagnosticsId(data.diagnosticsId);
        finalPageText = data.text || '';
      }

      // Update page, keeping each zone's own text so corrections assemble correctly
      const updated = pages.map((p, idx) =>
        idx === currentPageIndex
          ? {
              ...p,
              detectedZones: p.detectedZones.map((zone) =>
                zoneTexts[zone.id] !== undefined ? { ...zone, text: zoneTexts[zone.id] } : zone
              ),
              ocrText: finalPageText,
              ocrStatus: 'done' as const,
            }
          : p
      );
      setPages(updated);

      // Rebuild combined text
      const allText = updated
        .map((p) => p.ocrText ? `=== Page ${p.pageNumber} ===\n${p.ocrText}` : '')
        .filter(Boolean)
        .join('\n\n');
      setCombinedText(allText);

      setStatusMessage(`Page ${currentPage.pageNumber} recognized successfully with ${selectedEngine.toUpperCase()}.`);
    } catch (err: any) {
      setStatusMessage(`OCR Error: ${err.message}`);
      setPages((prev) =>
        prev.map((p, idx) =>
          idx === currentPageIndex ? { ...p, ocrStatus: 'error' as const, error: err.message } : p
        )
      );
    } finally {
      setIsRecognizing(false);
    }
  };

  // Run OCR on a single specific zone
  const handleRecognizeZone = async (zone: LayoutZone) => {
    if (!currentPage) return;
    setStatusMessage(`Recognizing Zone #${zone.order} (${zone.type}) with ${selectedEngine.toUpperCase()}...`);

    try {
      const res = await fetch('/api/ocr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: currentPage.url,
          filePath: currentPage.filePath,
          zone: { x: zone.x, y: zone.y, width: zone.width, height: zone.height },
          ...buildOcrEnginePayload(),
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || `Zone #${zone.order} OCR failed`);
      }
      if (data.text) {
        const currentText = currentPage.ocrText || '';
        const updatedPageText = currentText ? `${currentText}\n\n[Zone #${zone.order}]\n${data.text}` : data.text;
        
        const updated = pages.map((p, idx) =>
          idx === currentPageIndex
            ? { ...p, ocrText: updatedPageText, ocrStatus: 'done' as const }
            : p
        );
        setPages(updated);
        setStatusMessage(`Zone #${zone.order} recognized (${selectedEngine.toUpperCase()}).`);
      }
    } catch (err: any) {
      setStatusMessage(`Zone OCR failed: ${err.message}`);
    }
  };

  // Recognize All Pages (Batch OCR)
  const handleRecognizeAllPages = async () => {
    if (pages.length === 0) return;

    const signal = beginBatchRun();
    setIsRecognizing(true);
    setBatchModal({
      isOpen: true,
      title: `Batch OCR Processing with ${selectedEngine.toUpperCase()}`,
      total: pages.length,
      current: 0,
      currentMessage: 'Starting Tamil OCR engine...',
      isComplete: false,
      isCancelling: false,
      wasCancelled: false,
      hasError: false,
    });

    try {
      const updatedPages = [...pages];
      const combinedParts: string[] = [];
      let completedPages = 0;

      for (let i = 0; i < updatedPages.length; i++) {
        if (batchCancelRef.current) break;

        const p = updatedPages[i];
        setBatchModal((prev) => ({
          ...prev,
          current: i + 1,
          currentMessage: `Running OCR on Page ${i + 1} of ${updatedPages.length} with ${selectedEngine.toUpperCase()}...`,
        }));

        let pageResult = '';
        const zoneTexts: Record<string, string> = {};
        if (p.detectedZones && p.detectedZones.length > 0) {
          const sorted = [...p.detectedZones].sort((a, b) => a.order - b.order);
          const zTexts = [];
          for (const z of sorted) {
            if (batchCancelRef.current) break;

            setBatchModal((prev) => ({
              ...prev,
              currentMessage: `Running OCR on Page ${i + 1} of ${updatedPages.length}, zone #${z.order} of ${sorted.length} with ${selectedEngine.toUpperCase()}...`,
            }));

            const res = await fetch('/api/ocr', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              signal,
              body: JSON.stringify({
                image: p.url,
                filePath: p.filePath,
                zone: { x: z.x, y: z.y, width: z.width, height: z.height },
                ...buildDiagnosticContext(p, i, z),
                ...buildOcrEnginePayload(),
              }),
            });
            const d = await res.json();
            if (!res.ok || d.error) {
              throw new Error(d.error || `OCR failed on page ${p.pageNumber}`);
            }
            if (d.diagnosticsId) setDiagnosticsId(d.diagnosticsId);
            if (d.text) {
              zoneTexts[z.id] = d.text;
              zTexts.push(d.text);
            }
          }
          pageResult = zTexts.join('\n\n');
        } else {
          const res = await fetch('/api/ocr', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal,
            body: JSON.stringify({
              image: p.url,
              filePath: p.filePath,
              ...buildDiagnosticContext(p, i),
              ...buildOcrEnginePayload(),
            }),
          });
          const d = await res.json();
          if (!res.ok || d.error) {
            throw new Error(d.error || `OCR failed on page ${p.pageNumber}`);
          }
          if (d.diagnosticsId) setDiagnosticsId(d.diagnosticsId);
          pageResult = d.text || '';
        }

        // A cancel between zones leaves this page half-done, so it is not published as
        // finished: a page marked done with only some of its zones would be a lie.
        if (batchCancelRef.current) break;

        updatedPages[i] = {
          ...p,
          detectedZones: p.detectedZones.map((zone) =>
            zoneTexts[zone.id] !== undefined ? { ...zone, text: zoneTexts[zone.id] } : zone
          ),
          ocrText: pageResult,
          ocrStatus: 'done',
        };
        combinedParts.push(`=== Page ${p.pageNumber} ===\n${pageResult}`);
        completedPages = i + 1;
      }

      setPages(updatedPages);

      if (batchCancelRef.current) {
        // The combined view is deliberately left alone: replacing a complete document's
        // text with a half-finished run's pages would destroy work the user already had.
        setBatchModal((prev) => ({
          ...prev,
          isComplete: true,
          isCancelling: false,
          wasCancelled: true,
          currentMessage: `Cancelled — ${completedPages} of ${updatedPages.length} pages were recognized. Pages already done keep their text.`,
        }));
        setStatusMessage(
          `Batch OCR cancelled after ${completedPages} of ${updatedPages.length} pages.`
        );
      } else {
        setCombinedText(combinedParts.join('\n\n'));
        setBatchModal((prev) => ({
          ...prev,
          isComplete: true,
          isCancelling: false,
          currentMessage: `Batch OCR completed across all ${updatedPages.length} pages!`,
        }));
        setStatusMessage(`Completed batch Tamil OCR across all ${updatedPages.length} pages.`);
      }
    } catch (err: any) {
      if (batchCancelRef.current) {
        setBatchModal((prev) => ({
          ...prev,
          isComplete: true,
          isCancelling: false,
          wasCancelled: true,
          currentMessage:
            'Cancelled — the page in flight was stopped. Pages already done keep their text.',
        }));
        setStatusMessage('Batch OCR cancelled.');
      } else {
        setStatusMessage(`Batch OCR error: ${err.message}`);
        setBatchModal((prev) => ({
          ...prev,
          isComplete: true,
          isCancelling: false,
          hasError: true,
          currentMessage: `Error: ${err.message}`,
        }));
      }
    } finally {
      batchAbortRef.current = null;
      batchCancelRef.current = false;
      setIsRecognizing(false);
    }
  };

  // Re-run OCR for one recorded region (used by the diagnostics workspace)
  const handleRetryRegion = async (pageId: string, regionId: string) => {
    const pageIndex = pages.findIndex((p) => p.id === pageId);
    if (pageIndex === -1) {
      throw new Error('That region belongs to a page which is no longer open.');
    }
    const page = pages[pageIndex];
    const zone = page.detectedZones.find((z) => z.id === regionId);

    const res = await fetch('/api/ocr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image: page.url,
        filePath: page.filePath,
        ...(zone ? { zone: { x: zone.x, y: zone.y, width: zone.width, height: zone.height } } : {}),
        ...buildDiagnosticContext(page, pageIndex, zone),
        retryBudget: 2,
        ...buildOcrEnginePayload(),
      }),
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      throw new Error(data.error || 'OCR retry failed');
    }
    if (data.diagnosticsId) setDiagnosticsId(data.diagnosticsId);
  };

  // Apply a corrected region text to the assembled document text
  const handleApplyCorrection = (pageId: string, regionId: string, text: string) => {
    setPages((prev) => {
      const updated = prev.map((page) => {
        if (page.id !== pageId) return page;
        const zones = page.detectedZones.map((zone) =>
          zone.id === regionId ? { ...zone, text } : zone
        );
        // Rebuild the page text only when every zone carries its own text, so a
        // partial correction can never drop the rest of the page
        const withText = zones.filter((zone) => (zone.text || '').trim().length > 0);
        const assembled =
          zones.length > 0 && withText.length === zones.length
            ? [...zones].sort((a, b) => a.order - b.order).map((zone) => zone.text).join('\n\n')
            : page.ocrText;
        return { ...page, detectedZones: zones, ocrText: assembled };
      });
      setCombinedText(
        updated
          .map((page) => (page.ocrText ? `=== Page ${page.pageNumber} ===\n${page.ocrText}` : ''))
          .filter(Boolean)
          .join('\n\n')
      );
      return updated;
    });
    setStatusMessage('Correction saved — the assembled text now uses the corrected region.');
  };

  // Export Document (DOCX, TXT, JSON, HTML)
  const handleExport = async (format: 'docx' | 'txt' | 'json' | 'html') => {
    const textToExport = editorMode === 'page' ? currentPage?.ocrText || '' : combinedText;
    if (!textToExport.trim()) {
      setStatusMessage('Warning: No text to export. Please run OCR first.');
      return;
    }

    setStatusMessage(`Preparing ${format.toUpperCase()} export...`);

    const blocks: Array<{ page: number; type: string; text: string }> = [];

    if (editorMode === 'page' && currentPage) {
      blocks.push({
        page: currentPage.pageNumber,
        type: 'body',
        text: currentPage.ocrText || textToExport,
      });
    } else {
      pages.forEach((p) => {
        if (p.ocrText) {
          blocks.push({
            page: p.pageNumber,
            type: 'body',
            text: p.ocrText,
          });
        }
      });
      if (blocks.length === 0) {
        blocks.push({ page: 1, type: 'body', text: textToExport });
      }
    }

    try {
      const res = await fetch('/api/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          format,
          blocks,
          meta: {
            title: documentName.replace(/\.[^/.]+$/, ''),
            engine: selectedEngine,
            pages_count: pages.length,
          },
        }),
      });

      if (!res.ok) throw new Error('Export request failed');

      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${documentName.replace(/\.[^/.]+$/, '')}_OCR.${format}`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);

      setStatusMessage(`Exported ${format.toUpperCase()} document successfully.`);
    } catch (err: any) {
      setStatusMessage(`Export failed: ${err.message}`);
    }
  };

  // Download Standalone Python Application
  const handleDownloadPythonScript = () => {
    const a = document.createElement('a');
    a.href = '/api/download-python-app';
    a.download = 'pulan_tamil_ocr.py';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setStatusMessage('Downloaded standalone Python desktop app (pulan_tamil_ocr.py).');
  };

  // Page selection and modifications
  const handleUpdateCurrentZones = (zones: LayoutZone[]) => {
    if (!currentPage) return;
    const updated = pages.map((p, idx) => (idx === currentPageIndex ? { ...p, detectedZones: zones } : p));
    setPages(updated);
  };

  const handleRotateCurrentPage = (pageId: string) => {
    const updated = pages.map((p) =>
      p.id === pageId ? { ...p, rotation: ((p.rotation || 0) + 90) % 360 } : p
    );
    setPages(updated);
  };

  const handleDeletePage = (pageId: string) => {
    const remaining = pages.filter((p) => p.id !== pageId);
    setPages(remaining);
    if (currentPageIndex >= remaining.length) {
      setCurrentPageIndex(Math.max(0, remaining.length - 1));
    }
  };

  const handleMovePage = (fromIndex: number, toIndex: number) => {
    if (fromIndex < 0 || toIndex < 0 || fromIndex >= pages.length || toIndex >= pages.length) return;
    const newPages = [...pages];
    const [moved] = newPages.splice(fromIndex, 1);
    newPages.splice(toIndex, 0, moved);
    setPages(newPages);
    setCurrentPageIndex(toIndex);
  };

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-[#f1f5f9] text-slate-900 font-sans">
      {/* Hidden File Input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept=".pdf,image/png,image/jpeg,image/tiff,image/webp"
        onChange={handleFileUpload}
        className="hidden"
      />

      {/* 1. Pulan Tamil OCR Desktop Menu Bar */}
      <PulanMenuBar
        onOpenFile={handleOpenFileClick}
        onSaveText={() => handleExport('txt')}
        onExport={handleExport}
        onZoomIn={() => setZoomLevel((z) => Math.min(4.0, z + 0.2))}
        onZoomOut={() => setZoomLevel((z) => Math.max(0.2, z - 0.2))}
        onFitWindow={() => setZoomLevel(0.85)}
        onFitWidth={() => setZoomLevel(1.2)}
        onActualSize={() => setZoomLevel(1.0)}
        onRotateCW={() => currentPage && handleRotateCurrentPage(currentPage.id)}
        onRotateCCW={() =>
          currentPage &&
          setPages((prev) =>
            prev.map((p, idx) =>
              idx === currentPageIndex ? { ...p, rotation: ((p.rotation || 0) + 270) % 360 } : p
            )
          )
        }
        onDetectLayoutCurrent={handleDetectLayoutCurrentPage}
        onDetectLayoutAll={handleDetectLayoutAllPages}
        onRecognizeCurrent={handleRecognizePage}
        onRecognizeAll={handleRecognizeAllPages}
        onClearZones={() => handleUpdateCurrentZones([])}
        onClearEditor={() => {
          if (editorMode === 'page' && currentPage) {
            setPages((prev) =>
              prev.map((p, idx) => (idx === currentPageIndex ? { ...p, ocrText: '' } : p))
            );
          } else {
            setCombinedText('');
          }
        }}
        selectedEngine={selectedEngine}
        onSelectEngine={setSelectedEngine}
        onOpenAbout={() => setShowAboutModal(true)}
        onDownloadPythonScript={handleDownloadPythonScript}
      />

      {/* 2. Pulan Tamil OCR Main Action Toolbar */}
      <PulanToolBar
        onOpenFile={handleOpenFileClick}
        currentPage={currentPageIndex + 1}
        totalPages={pages.length}
        onPrevPage={() => setCurrentPageIndex((i) => Math.max(0, i - 1))}
        onNextPage={() => setCurrentPageIndex((i) => Math.min(pages.length - 1, i + 1))}
        onZoomIn={() => setZoomLevel((z) => Math.min(4.0, z + 0.2))}
        onZoomOut={() => setZoomLevel((z) => Math.max(0.2, z - 0.2))}
        onFitWindow={() => setZoomLevel(0.85)}
        onFitWidth={() => setZoomLevel(1.2)}
        onActualSize={() => setZoomLevel(1.0)}
        zoomLevel={zoomLevel}
        onRotateCW={() => currentPage && handleRotateCurrentPage(currentPage.id)}
        onRotateCCW={() =>
          currentPage &&
          setPages((prev) =>
            prev.map((p, idx) =>
              idx === currentPageIndex ? { ...p, rotation: ((p.rotation || 0) + 270) % 360 } : p
            )
          )
        }
        drawMode={drawMode}
        onSetDrawMode={setDrawMode}
        filters={filters}
        onToggleBinarize={() => setFilters((f) => ({ ...f, binarize: !f.binarize }))}
        onToggleInvert={() => setFilters((f) => ({ ...f, invert: !f.invert }))}
        layoutMode={layoutMode}
        onSetLayoutMode={setLayoutMode}
        onDetectLayoutAllPages={handleDetectLayoutAllPages}
        onDetectLayoutCurrentPage={handleDetectLayoutCurrentPage}
        isDetectingLayout={isDetectingLayout}
        selectedEngine={selectedEngine}
        onSelectEngine={setSelectedEngine}
        engineOptions={engineOptions}
        onChangeEngineOptions={setEngineOptions}
        onOpenManageLanguages={() => setShowManageLanguagesModal(true)}
        installedLanguages={installedLanguages}
        engineStatus={engineStatus}
        onRefreshEngineStatus={refreshEngineStatus}
        aiProvidersInfo={aiProvidersInfo}
        onOpenSignIn={setSignInProvider}
        onRecognizePage={handleRecognizePage}
        onRecognizeAllPages={handleRecognizeAllPages}
        onOpenDiagnostics={() => setShowDiagnostics(true)}
        diagnosticsRegionCount={undefined}
        isRecognizing={isRecognizing}
        onExport={handleExport}
        onOpenPreprocessingModal={() => setShowPreprocessingModal(true)}
      />

      {/* 3. Three-Panel Workspace: Left Document Tree | Center Image Viewer | Right Text Editor */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Panel: Document Tree & Thumbnails */}
        <DocumentTreePanel
          documentName={documentName}
          pages={pages}
          currentPageIndex={currentPageIndex}
          onSelectPage={setCurrentPageIndex}
          selectedPageIds={selectedPageIds}
          onToggleSelectPage={(id) => {
            const next = new Set(selectedPageIds);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            setSelectedPageIds(next);
          }}
          onSelectAllPages={() => setSelectedPageIds(new Set(pages.map((p) => p.id)))}
          onDeselectAllPages={() => setSelectedPageIds(new Set())}
          onRotatePage={handleRotateCurrentPage}
          onDeletePage={handleDeletePage}
          onMovePage={handleMovePage}
        />

        {/* Center Panel: Interactive Image / PDF Canvas */}
        <ImageViewerCanvas
          page={currentPage}
          zoomLevel={zoomLevel}
          onZoomChange={setZoomLevel}
          drawMode={drawMode}
          filters={filters}
          activeZoneId={activeZoneId}
          onSelectZone={setActiveZoneId}
          onUpdateZones={handleUpdateCurrentZones}
          onRecognizeZone={handleRecognizeZone}
        />

        {/* Right Panel: Pulan Tamil OCR Text Editor */}
        <TextEditorPanel
          currentPage={currentPage}
          combinedText={combinedText}
          editorMode={editorMode}
          onSetEditorMode={setEditorMode}
          pageText={currentPage?.ocrText || ''}
          onChangePageText={(newText) => {
            if (!currentPage) return;
            setPages((prev) =>
              prev.map((p, idx) => (idx === currentPageIndex ? { ...p, ocrText: newText } : p))
            );
          }}
          onChangeCombinedText={setCombinedText}
          onExport={handleExport}
          onClearText={() => {
            if (editorMode === 'page' && currentPage) {
              setPages((prev) =>
                prev.map((p, idx) => (idx === currentPageIndex ? { ...p, ocrText: '' } : p))
              );
            } else {
              setCombinedText('');
            }
          }}
          selectedEngineName={selectedEngine.toUpperCase()}
        />
      </div>

      {/* 4. Bottom Status Bar */}
      <PulanStatusBar
        statusMessage={statusMessage}
        currentPage={pages.length > 0 ? currentPageIndex + 1 : 0}
        totalPages={pages.length}
        zoomLevel={zoomLevel}
        engine={selectedEngine}
        zonesCount={currentPage?.detectedZones.length || 0}
        pageWidth={currentPage?.width}
        pageHeight={currentPage?.height}
      />

      {/* Modals */}
      <PreprocessingModal
        isOpen={showPreprocessingModal}
        onClose={() => setShowPreprocessingModal(false)}
        filters={filters}
        onChangeFilters={setFilters}
        onResetFilters={() =>
          setFilters({
            brightness: 100,
            contrast: 100,
            binarize: false,
            threshold: 140,
            invert: false,
          })
        }
      />

      <AboutModal
        isOpen={showAboutModal}
        onClose={() => setShowAboutModal(false)}
        onDownloadPythonScript={handleDownloadPythonScript}
      />

      <SubscriptionSignInModal
        isOpen={signInProvider !== null}
        provider={signInProvider || 'claude'}
        cliPath={
          signInProvider === 'chatgpt'
            ? engineOptions.aiProviders.chatgpt.cliPath
            : signInProvider === 'google'
            ? engineOptions.aiProviders.gemini.cliPath
            : engineOptions.aiProviders.claude.cliPath
        }
        onClose={() => setSignInProvider(null)}
        onChanged={refreshAiProviders}
      />

      <BatchModal
        isOpen={batchModal.isOpen}
        title={batchModal.title}
        total={batchModal.total}
        current={batchModal.current}
        currentMessage={batchModal.currentMessage}
        isComplete={batchModal.isComplete}
        isCancelling={batchModal.isCancelling}
        wasCancelled={batchModal.wasCancelled}
        hasError={batchModal.hasError}
        onCancel={handleCancelBatch}
        onClose={() => setBatchModal((prev) => ({ ...prev, isOpen: false }))}
      />

      {/* Tesseract language model manager (download / remove .traineddata) */}
      <ManageLanguagesModal
        isOpen={showManageLanguagesModal}
        onClose={() => setShowManageLanguagesModal(false)}
        selectedLanguages={engineOptions.tesseract.languages}
        onToggleLanguage={handleToggleTessLanguage}
        onLanguagesUpdated={handleLanguagesUpdated}
      />

      {/* OCR diagnostics workspace: quality checks, crops, retries and corrections */}
      <DiagnosticsWorkspace
        isOpen={showDiagnostics}
        onClose={() => setShowDiagnostics(false)}
        documentName={documentName}
        documentId={diagnosticsId}
        pageUrls={Object.fromEntries(pages.map((page) => [page.id, page.url]))}
        onRetryRegion={handleRetryRegion}
        onApplyCorrection={handleApplyCorrection}
        onSelectRegion={(pageId, regionId) => {
          const index = pages.findIndex((page) => page.id === pageId);
          if (index !== -1) setCurrentPageIndex(index);
          setActiveZoneId(regionId);
        }}
      />
    </div>
  );
}
