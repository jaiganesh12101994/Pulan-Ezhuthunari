export type OCREngine =
  | 'tesseract'
  | 'surya'
  | 'chandra'
  | 'gnana70'
  | 'gemini'
  | 'claude'
  | 'chatgpt'
  | 'openai-compatible';

/** Engines that run through a vision model (Gemini, Claude, ChatGPT, compatible endpoint). */
export const AI_ENGINE_IDS = ['gemini', 'claude', 'chatgpt', 'openai-compatible'] as const;

export type AiEngineId = (typeof AI_ENGINE_IDS)[number];

export function isAiEngineId(engine: string): engine is AiEngineId {
  return (AI_ENGINE_IDS as readonly string[]).includes(engine);
}

/**
 * Render resolutions offered for rasterizing PDF pages.
 *
 * Sharper pages read Tamil markedly better — a two-column scan holds far more detail per
 * glyph at 300 DPI than at 200 — so 300 is the default. It stays a setting because the
 * cost grows with the square of the resolution, in both render time and temp space.
 */
export const RENDER_DPI_OPTIONS = [200, 300, 400, 600] as const;
export const DEFAULT_RENDER_DPI = 300;

/** Settings for one AI provider, entered in the engine options panel. */
export interface AiProviderSettings {
  /**
   * Use the subscription instead of an API key: a Claude Code sign-in, the codex CLI,
   * or — for the Gemini engine — the Antigravity CLI with a Google account.
   */
  useSubscription: boolean;
  apiKey: string;
  baseUrl: string;
  model: string;
  /** Claude subscription only: path to the `claude` executable, when not the bundled one. */
  cliPath: string;
  /** Claude subscription only: maximum turns per answer. */
  maxTurns: number;
}

export interface AiProviderInfo {
  engine: AiEngineId;
  label: string;
  defaultModel: string;
  defaultBaseUrl: string;
  envKeyConfigured: boolean;
  envKeyName: string;
  subscription: {
    kind: 'claude-agent' | 'codex-cli' | 'antigravity-cli' | null;
    available: boolean;
    bin: string | null;
    version: string | null;
    /** Claude subscription only: the SDK version, and the account once checked. */
    sdkVersion?: string | null;
    signedIn?: boolean | null;
    account?: string | null;
  };
}

export type ZoneType = 'headline' | 'column' | 'body' | 'table' | 'caption';

export interface LayoutZone {
  id: string;
  order: number;
  col: number;
  type: ZoneType;
  x: number;
  y: number;
  width: number;
  height: number;
  confidence?: number;
  text?: string;
}

export interface WordBox {
  text: string;
  confidence: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DocumentPage {
  id: string;
  pageNumber: number;
  fileName: string;
  url: string;
  filePath?: string;
  width: number;
  height: number;
  detectedZones: LayoutZone[];
  ocrStatus: 'idle' | 'detecting' | 'processing' | 'done' | 'error';
  ocrText?: string;
  words?: WordBox[];
  error?: string;
  rotation?: number; // 0, 90, 180, 270
}

export interface SampleDoc {
  id: string;
  title: string;
  description: string;
  type: string;
  pages: Array<{
    pageNumber: number;
    url: string;
    title: string;
  }>;
}

export interface ImageFilters {
  brightness: number; // 50 to 150 (default 100)
  contrast: number; // 50 to 200 (default 100)
  binarize: boolean;
  threshold: number; // 0 to 255 (default 140)
  invert: boolean;
}

export interface TessLanguageInfo {
  code: string;
  name: string;
  nativeName: string;
  approxSize: string;
  isInstalled: boolean;
  category: 'indic' | 'international' | 'system';
  filePath?: string;
  fileSizeBytes?: number;
}

export interface EngineStatus {
  python?: string;
  platform?: string;
  pillow?: boolean;
  pytesseract?: boolean;
  tesseract: {
    available: boolean;
    path: string | null;
    version: string | null;
  };
  tessdataDir?: string | null;
  tessdataLanguages?: string[];
  error?: string;
}

export interface EngineOptionsState {
  tesseract: {
    languages: string[]; // e.g. ['tam', 'eng']
    psm: string; // '1', '3', '4', '6', '11'
  };
  surya: {
    layoutMode: 'auto' | '2col' | '3col' | 'single';
    readingOrder: 'top_down' | 'column_first';
  };
  chandra: {
    scriptMode: 'sangam' | 'modern' | 'bilingual';
    diacriticLevel: 'normal' | 'enhanced' | 'palm_leaf';
  };
  gnana70: {
    detector: 'craft_words' | 'craft_lines';
    ligatureFusion: boolean;
  };
  gemini: {
    promptMode: 'raw' | 'markdown' | 'palm_leaf' | 'tables';
  };
  /** Vision-model providers: Gemini, Claude, ChatGPT and any OpenAI-compatible endpoint. */
  aiProviders: {
    gemini: AiProviderSettings;
    claude: AiProviderSettings;
    chatgpt: AiProviderSettings;
    openaiCompatible: AiProviderSettings;
  };
}

/** Processing states shared by the engine, the diagnostics store and the UI. */
export type RegionStatus = 'provisional' | 'review_required' | 'verified' | 'failed';

export type QualitySeverity = 'info' | 'warning' | 'error';

/** A diagnostic signal from the quality checks (not proof of wrong text). */
export interface QualityFinding {
  code: string;
  severity: QualitySeverity;
  message: string;
  detail?: Record<string, unknown>;
}

/** Content-addressed diagnostic image (page crop, OCR crop, preprocessed crop). */
export interface DiagnosticArtifact {
  name: string;
  hash: string;
  bytes: number;
}

export interface DiagnosticBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DiagnosticAttempt {
  attempt: number;
  recordedAt?: string;
  durationMs?: number;
  engine?: string;
  engineVersion?: string;
  model?: string;
  pipeline?: string;
  pipelineOptions?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  regionBox?: DiagnosticBox;
  crop?: { width: number; height: number };
  columnCount?: number;
  columns?: DiagnosticBox[];
  variant?: string;
  transformations?: Array<Record<string, unknown>>;
  candidates?: Array<{
    variant: string;
    quality: number;
    meanConfidence: number;
    characters: number;
  }>;
  rawText?: string;
  normalizedText?: string;
  confidence?: number;
  status?: RegionStatus;
  quality?: { status: RegionStatus; findings: QualityFinding[]; warningCodes: string[] };
  retry?: {
    strategy?: string | null;
    description?: string | null;
    budget?: number;
    attemptedStrategies?: string[];
  };
  artifacts?: Record<string, DiagnosticArtifact | null>;
  warnings?: string[];
  error?: string | null;
}

export interface DiagnosticRegion {
  regionId: string;
  type?: string;
  box?: DiagnosticBox;
  attempts: DiagnosticAttempt[];
  latest?: DiagnosticAttempt;
  retryCount: number;
  correctedText?: string | null;
  verified: boolean;
  unresolved: boolean;
  correctionHistory?: Array<{
    at: string;
    from?: string | null;
    to?: string | null;
    note?: string | null;
  }>;
  finalText: string;
  status: RegionStatus;
}

export interface DiagnosticPage {
  pageId: string;
  pageNumber?: number;
  width?: number;
  height?: number;
  renderDpi?: number;
  rotation?: number;
  regions: DiagnosticRegion[];
}

/** Aggregated diagnostics for one document (GET /api/diagnostics/:documentId). */
export interface DocumentDiagnostics {
  success?: boolean;
  error?: string;
  documentId: string;
  pageCount: number;
  regionCount: number;
  pages: DiagnosticPage[];
  artifactBaseUrl: string;
}

