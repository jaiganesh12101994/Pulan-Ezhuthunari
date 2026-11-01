import React from 'react';
import { X, HelpCircle, ExternalLink, Cpu, Download, CheckCircle2 } from 'lucide-react';

interface AboutModalProps {
  isOpen: boolean;
  onClose: () => void;
  onDownloadPythonScript: () => void;
}

export const AboutModal: React.FC<AboutModalProps> = ({ isOpen, onClose, onDownloadPythonScript }) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-[#ffffff] border border-[#cbd5e1] rounded-lg shadow-2xl max-w-lg w-full text-slate-800 overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        <div className="p-4 border-b border-[#e2e8f0] bg-[#f1f5f9] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-full bg-blue-500 inline-block shadow-sm"></span>
            <h3 className="text-sm font-semibold text-slate-900">About Pulan Tamil OCR</h3>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-[#f1f5f9] text-slate-600">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-3.5 text-xs text-slate-700">
          <p>
            <strong>Pulan Tamil OCR</strong> (புலன் தமிழ் எழுத்துணரி) is a comprehensive multi-engine OCR workspace
            specialized for complex Tamil documents, multi-column layouts, and historical/modern script recognition.
          </p>

          <div className="bg-[#f1f5f9] p-3 rounded border border-[#e2e8f0] space-y-2">
            <div className="flex items-center justify-between">
              <div className="font-semibold text-blue-600 flex items-center gap-1.5">
                <Cpu className="w-3.5 h-3.5" /> Bundled Offline OCR Engines:
              </div>
              <span className="text-[10px] bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded border border-emerald-300 font-mono font-medium">
                Bundled Inside App
              </span>
            </div>
            <ul className="space-y-1.5 pl-2 text-slate-700">
              <li>
                <strong className="text-slate-900">1. Tesseract OCR (Tamil):</strong> Bundled inside `engines/tessdata/tam.traineddata` (LSTM Tamil & English models with layout PSM 1, 3, 4, 6).
              </li>
              <li>
                <strong className="text-slate-900">2. gnana70 / tamil_ocr:</strong> Full engine repository bundled in `engines/ocr_tamil/` with CRAFT detector & Tamil compound ligatures.
              </li>
              <li>
                <strong className="text-slate-900">3. Surya & Chandra Indic OCR:</strong> Pipeline bundled in `engines/surya_chandra/` for multi-column newspaper segmentation & textline detection.
              </li>
              <li>
                <strong className="text-slate-900">4. Google Gemini 2.5 Flash:</strong> AI multimodal engine for palm-leaf manuscripts and handwritten Tamil.
              </li>
            </ul>
          </div>

          <div className="space-y-1">
            <div className="font-semibold text-slate-800">Key Features:</div>
            <div className="grid grid-cols-2 gap-1.5 text-slate-600 text-[11px]">
              <div className="flex items-center gap-1">
                <CheckCircle2 className="w-3 h-3 text-emerald-600 shrink-0" />
                <span>Single-click Layout Detection</span>
              </div>
              <div className="flex items-center gap-1">
                <CheckCircle2 className="w-3 h-3 text-emerald-600 shrink-0" />
                <span>Multi-column reading order</span>
              </div>
              <div className="flex items-center gap-1">
                <CheckCircle2 className="w-3 h-3 text-emerald-600 shrink-0" />
                <span>Export DOCX, TXT, JSON, HTML</span>
              </div>
              <div className="flex items-center gap-1">
                <CheckCircle2 className="w-3 h-3 text-emerald-600 shrink-0" />
                <span>Tamil Virtual Keyboard</span>
              </div>
            </div>
          </div>

          <div className="pt-2 border-t border-[#e2e8f0] flex items-center justify-between">
            <button
              onClick={onDownloadPythonScript}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-700 hover:bg-emerald-600 text-white rounded text-xs font-medium transition-colors"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Download Standalone Python App</span>
            </button>
            <button
              onClick={onClose}
              className="px-4 py-1.5 bg-[#f1f5f9] hover:bg-[#e2e8f0] text-slate-800 rounded text-xs"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
