import React, { useState, useRef, useEffect } from 'react';
import {
  FileText,
  FolderOpen,
  Save,
  Download,
  Settings,
  HelpCircle,
  RotateCw,
  RotateCcw,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Columns,
  Play,
  Layers,
  FileCode,
  FileCheck,
} from 'lucide-react';
import { OCREngine } from '../types';
import { WindowControls } from './WindowControls';

interface PulanMenuBarProps {
  onOpenFile: () => void;
  onSaveText: () => void;
  onExport: (format: 'docx' | 'txt' | 'json' | 'html') => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFitWindow: () => void;
  onFitWidth: () => void;
  onActualSize: () => void;
  onRotateCW: () => void;
  onRotateCCW: () => void;
  onDetectLayoutCurrent: () => void;
  onDetectLayoutAll: () => void;
  onRecognizeCurrent: () => void;
  onRecognizeAll: () => void;
  onClearZones: () => void;
  onClearEditor: () => void;
  selectedEngine: OCREngine;
  onSelectEngine: (engine: OCREngine) => void;
  onOpenAbout: () => void;
  onDownloadPythonScript: () => void;
}

export const PulanMenuBar: React.FC<PulanMenuBarProps> = ({
  onOpenFile,
  onSaveText,
  onExport,
  onZoomIn,
  onZoomOut,
  onFitWindow,
  onFitWidth,
  onActualSize,
  onRotateCW,
  onRotateCCW,
  onDetectLayoutCurrent,
  onDetectLayoutAll,
  onRecognizeCurrent,
  onRecognizeAll,
  onClearZones,
  onClearEditor,
  selectedEngine,
  onSelectEngine,
  onOpenAbout,
  onDownloadPythonScript,
}) => {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const menuBarRef = useRef<HTMLDivElement>(null);

  // Close menus on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuBarRef.current && !menuBarRef.current.contains(e.target as Node)) {
        setOpenMenu(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const toggleMenu = (name: string) => {
    setOpenMenu(openMenu === name ? null : name);
  };

  const handleAction = (cb: () => void) => {
    setOpenMenu(null);
    cb();
  };

  return (
    <div
      ref={menuBarRef}
      className="bg-[#ffffff] text-[#475569] text-xs font-sans select-none flex items-center px-2 border-b border-[#e2e8f0] z-40 relative h-7 app-drag-region"
    >
      {/* App name. Centred on the panel itself (absolute, not "whatever space is left"),
          so it stays in the middle of the window whatever the menus and window controls
          measure. pointer-events-none keeps it from ever swallowing a menu click. */}
      <div className="absolute left-1/2 -translate-x-1/2 hidden sm:flex items-center gap-1.5 text-slate-800 font-semibold tracking-wide pointer-events-none">
        <span className="w-2.5 h-2.5 rounded-full bg-blue-500 inline-block shadow-sm shadow-blue-400"></span>
        <span>Pulan Tamil OCR 1.0</span>
      </div>

      {/* File Menu */}
      <div className="relative app-no-drag">
        <button
          onClick={() => toggleMenu('file')}
          onMouseEnter={() => openMenu && setOpenMenu('file')}
          className={`px-2.5 py-1 rounded transition-colors ${ openMenu === 'file' ? 'bg-[#e2e8f0] text-slate-900' : 'hover:bg-[#f1f5f9] hover:text-slate-900' }`}
        >
          File
        </button>
        {openMenu === 'file' && (
          <div className="absolute top-full left-0 mt-0.5 w-64 bg-[#ffffff] text-slate-800 border border-[#cbd5e1] shadow-xl rounded py-1 z-50 text-xs">
            <button
              onClick={() => handleAction(onOpenFile)}
              className="w-full text-left px-3 py-1.5 hover:bg-blue-600 hover:text-white flex items-center justify-between"
            >
              <span className="flex items-center gap-2">
                <FolderOpen className="w-3.5 h-3.5 text-blue-600" /> Open PDF / Images...
              </span>
              <span className="text-[10px] text-slate-600">Ctrl+O</span>
            </button>
            <div className="border-t border-[#cbd5e1] my-1"></div>
            <button
              onClick={() => handleAction(onSaveText)}
              className="w-full text-left px-3 py-1.5 hover:bg-blue-600 hover:text-white flex items-center justify-between"
            >
              <span className="flex items-center gap-2">
                <Save className="w-3.5 h-3.5 text-emerald-600" /> Save OCR Text As...
              </span>
              <span className="text-[10px] text-slate-600">Ctrl+S</span>
            </button>
            <div className="border-t border-[#cbd5e1] my-1"></div>
            <div className="px-3 py-1 text-[10px] text-slate-600 font-semibold uppercase tracking-wider">
              Export Recognized Document
            </div>
            <button
              onClick={() => handleAction(() => onExport('docx'))}
              className="w-full text-left px-4 py-1 hover:bg-blue-600 hover:text-white flex items-center gap-2"
            >
              <FileText className="w-3.5 h-3.5 text-blue-700" /> Export to Word (.docx)
            </button>
            <button
              onClick={() => handleAction(() => onExport('txt'))}
              className="w-full text-left px-4 py-1 hover:bg-blue-600 hover:text-white flex items-center gap-2"
            >
              <FileCode className="w-3.5 h-3.5 text-slate-700" /> Export to Plain Text (.txt)
            </button>
            <button
              onClick={() => handleAction(() => onExport('json'))}
              className="w-full text-left px-4 py-1 hover:bg-blue-600 hover:text-white flex items-center gap-2"
            >
              <FileCheck className="w-3.5 h-3.5 text-amber-600" /> Export to JSON (.json)
            </button>
            <button
              onClick={() => handleAction(() => onExport('html'))}
              className="w-full text-left px-4 py-1 hover:bg-blue-600 hover:text-white flex items-center gap-2"
            >
              <FileCode className="w-3.5 h-3.5 text-orange-600" /> Export to HTML (.html)
            </button>
            <div className="border-t border-[#cbd5e1] my-1"></div>
            <button
              onClick={() => handleAction(onDownloadPythonScript)}
              className="w-full text-left px-3 py-1.5 hover:bg-blue-600 hover:text-white flex items-center gap-2 text-emerald-700"
            >
              <Download className="w-3.5 h-3.5 text-emerald-600" /> Download Standalone Python App (.py)
            </button>
          </div>
        )}
      </div>

      {/* Edit Menu */}
      <div className="relative app-no-drag">
        <button
          onClick={() => toggleMenu('edit')}
          onMouseEnter={() => openMenu && setOpenMenu('edit')}
          className={`px-2.5 py-1 rounded transition-colors ${ openMenu === 'edit' ? 'bg-[#e2e8f0] text-slate-900' : 'hover:bg-[#f1f5f9] hover:text-slate-900' }`}
        >
          Edit
        </button>
        {openMenu === 'edit' && (
          <div className="absolute top-full left-0 mt-0.5 w-48 bg-[#ffffff] text-slate-800 border border-[#cbd5e1] shadow-xl rounded py-1 z-50 text-xs">
            <button
              onClick={() => handleAction(onClearEditor)}
              className="w-full text-left px-3 py-1.5 hover:bg-blue-600 hover:text-white"
            >
              Clear Editor Text
            </button>
          </div>
        )}
      </div>

      {/* View Menu */}
      <div className="relative app-no-drag">
        <button
          onClick={() => toggleMenu('view')}
          onMouseEnter={() => openMenu && setOpenMenu('view')}
          className={`px-2.5 py-1 rounded transition-colors ${ openMenu === 'view' ? 'bg-[#e2e8f0] text-slate-900' : 'hover:bg-[#f1f5f9] hover:text-slate-900' }`}
        >
          View
        </button>
        {openMenu === 'view' && (
          <div className="absolute top-full left-0 mt-0.5 w-52 bg-[#ffffff] text-slate-800 border border-[#cbd5e1] shadow-xl rounded py-1 z-50 text-xs">
            <button
              onClick={() => handleAction(onZoomIn)}
              className="w-full text-left px-3 py-1.5 hover:bg-blue-600 hover:text-white flex items-center justify-between"
            >
              <span className="flex items-center gap-2">
                <ZoomIn className="w-3.5 h-3.5 text-blue-600" /> Zoom In
              </span>
              <span className="text-[10px] text-slate-600">+</span>
            </button>
            <button
              onClick={() => handleAction(onZoomOut)}
              className="w-full text-left px-3 py-1.5 hover:bg-blue-600 hover:text-white flex items-center justify-between"
            >
              <span className="flex items-center gap-2">
                <ZoomOut className="w-3.5 h-3.5 text-blue-600" /> Zoom Out
              </span>
              <span className="text-[10px] text-slate-600">-</span>
            </button>
            <button
              onClick={() => handleAction(onFitWindow)}
              className="w-full text-left px-3 py-1.5 hover:bg-blue-600 hover:text-white flex items-center gap-2"
            >
              <Maximize2 className="w-3.5 h-3.5 text-blue-600" /> Fit to Window
            </button>
            <button
              onClick={() => handleAction(onFitWidth)}
              className="w-full text-left px-3 py-1.5 hover:bg-blue-600 hover:text-white flex items-center gap-2"
            >
              <Maximize2 className="w-3.5 h-3.5 text-blue-600" /> Fit to Width
            </button>
            <button
              onClick={() => handleAction(onActualSize)}
              className="w-full text-left px-3 py-1.5 hover:bg-blue-600 hover:text-white"
            >
              Actual Size (100%)
            </button>
            <div className="border-t border-[#cbd5e1] my-1"></div>
            <button
              onClick={() => handleAction(onRotateCCW)}
              className="w-full text-left px-3 py-1.5 hover:bg-blue-600 hover:text-white flex items-center gap-2"
            >
              <RotateCcw className="w-3.5 h-3.5 text-slate-700" /> Rotate 90° CCW
            </button>
            <button
              onClick={() => handleAction(onRotateCW)}
              className="w-full text-left px-3 py-1.5 hover:bg-blue-600 hover:text-white flex items-center gap-2"
            >
              <RotateCw className="w-3.5 h-3.5 text-slate-700" /> Rotate 90° CW
            </button>
          </div>
        )}
      </div>

      {/* Layout Detection Menu */}
      <div className="relative app-no-drag">
        <button
          onClick={() => toggleMenu('layout')}
          onMouseEnter={() => openMenu && setOpenMenu('layout')}
          className={`px-2.5 py-1 rounded transition-colors font-medium text-blue-700 ${ openMenu === 'layout' ? 'bg-[#e2e8f0] text-slate-900' : 'hover:bg-[#f1f5f9] hover:text-slate-900' }`}
        >
          Layout
        </button>
        {openMenu === 'layout' && (
          <div className="absolute top-full left-0 mt-0.5 w-64 bg-[#ffffff] text-slate-800 border border-[#cbd5e1] shadow-xl rounded py-1 z-50 text-xs">
            <button
              onClick={() => handleAction(onDetectLayoutAll)}
              className="w-full text-left px-3 py-1.5 bg-blue-100 hover:bg-blue-600 hover:text-white flex items-center gap-2 font-medium text-blue-700"
            >
              <Layers className="w-3.5 h-3.5 text-blue-600" /> Detect Layout (All Pages)
            </button>
            <button
              onClick={() => handleAction(onDetectLayoutCurrent)}
              className="w-full text-left px-3 py-1.5 hover:bg-blue-600 hover:text-white flex items-center gap-2"
            >
              <Columns className="w-3.5 h-3.5 text-indigo-600" /> Detect Layout (Current Page)
            </button>
            <div className="border-t border-[#cbd5e1] my-1"></div>
            <button
              onClick={() => handleAction(onClearZones)}
              className="w-full text-left px-3 py-1.5 hover:bg-rose-600 hover:text-white text-rose-600"
            >
              Clear All Detection Zones
            </button>
          </div>
        )}
      </div>

      {/* OCR Engine Menu */}
      <div className="relative app-no-drag">
        <button
          onClick={() => toggleMenu('ocr')}
          onMouseEnter={() => openMenu && setOpenMenu('ocr')}
          className={`px-2.5 py-1 rounded transition-colors ${ openMenu === 'ocr' ? 'bg-[#e2e8f0] text-slate-900' : 'hover:bg-[#f1f5f9] hover:text-slate-900' }`}
        >
          OCR
        </button>
        {openMenu === 'ocr' && (
          <div className="absolute top-full left-0 mt-0.5 w-72 bg-[#ffffff] text-slate-800 border border-[#cbd5e1] shadow-xl rounded py-1 z-50 text-xs">
            <button
              onClick={() => handleAction(onRecognizeCurrent)}
              className="w-full text-left px-3 py-1.5 hover:bg-blue-600 hover:text-white flex items-center gap-2 font-medium text-emerald-700"
            >
              <Play className="w-3.5 h-3.5 text-emerald-600" /> Recognize Current Page
            </button>
            <button
              onClick={() => handleAction(onRecognizeAll)}
              className="w-full text-left px-3 py-1.5 hover:bg-blue-600 hover:text-white flex items-center gap-2 font-medium text-blue-700"
            >
              <Layers className="w-3.5 h-3.5 text-blue-600" /> Recognize All Pages (Batch Queue)
            </button>
            <div className="border-t border-[#cbd5e1] my-1"></div>
            <div className="px-3 py-1 text-[10px] text-slate-600 font-semibold uppercase tracking-wider">
              Select Tamil OCR Engine:
            </div>
            {[
              { id: 'tesseract', label: 'Tesseract OCR (Tamil tam+eng)', badge: 'Native LSTM' },
              { id: 'surya', label: 'Surya OCR (Multilingual Layout)', badge: 'Transformer' },
              { id: 'chandra', label: 'Chandra OCR (Indic Newspaper/Column)', badge: 'Dense Layout' },
              { id: 'gnana70', label: 'gnana70 / tamil_ocr (Gnana Prasath)', badge: 'CRNN/Scene' },
              { id: 'gemini', label: 'Google Gemini 2.5 Flash Vision', badge: 'AI Multimodal' },
            ].map((eng) => (
              <button
                key={eng.id}
                onClick={() => handleAction(() => onSelectEngine(eng.id as OCREngine))}
                className={`w-full text-left px-3 py-1.5 flex items-center justify-between ${ selectedEngine === eng.id ? 'bg-blue-100 text-blue-700 font-semibold' : 'hover:bg-[#f1f5f9] hover:text-slate-900' }`}
              >
                <span>{eng.label}</span>
                <span className="text-[9px] bg-[#ffffff] px-1.5 py-0.5 rounded text-slate-600 border border-[#cbd5e1]">
                  {eng.badge}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Help Menu */}
      <div className="relative app-no-drag">
        <button
          onClick={() => toggleMenu('help')}
          onMouseEnter={() => openMenu && setOpenMenu('help')}
          className={`px-2.5 py-1 rounded transition-colors ${ openMenu === 'help' ? 'bg-[#e2e8f0] text-slate-900' : 'hover:bg-[#f1f5f9] hover:text-slate-900' }`}
        >
          Help
        </button>
        {openMenu === 'help' && (
          <div className="absolute top-full left-0 mt-0.5 w-60 bg-[#ffffff] text-slate-800 border border-[#cbd5e1] shadow-xl rounded py-1 z-50 text-xs">
            <button
              onClick={() => handleAction(onOpenAbout)}
              className="w-full text-left px-3 py-1.5 hover:bg-blue-600 hover:text-white flex items-center gap-2"
            >
              <HelpCircle className="w-3.5 h-3.5 text-blue-600" /> About Pulan Tamil OCR
            </button>
            <a
              href="https://github.com/gnana70/tamil_ocr"
              target="_blank"
              rel="noreferrer"
              className="w-full text-left px-3 py-1.5 hover:bg-blue-600 hover:text-white flex items-center gap-2 block"
            >
              <FileCode className="w-3.5 h-3.5 text-slate-600" /> gnana70/tamil_ocr Repository
            </a>
          </div>
        )}
      </div>

      {/* Window controls, pulled to the panel edge the way a title bar has them. The
          engine in use is not repeated here: the toolbar's Engine selector is the one
          place that states it. */}
      <div className="ml-auto -mr-2 shrink-0 app-no-drag">
        <WindowControls />
      </div>
    </div>
  );
};
