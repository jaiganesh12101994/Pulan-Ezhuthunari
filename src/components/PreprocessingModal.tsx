import React from 'react';
import { X, Sliders, RotateCcw, Contrast, Sun } from 'lucide-react';
import { ImageFilters } from '../types';

interface PreprocessingModalProps {
  isOpen: boolean;
  onClose: () => void;
  filters: ImageFilters;
  onChangeFilters: (filters: ImageFilters) => void;
  onResetFilters: () => void;
}

export const PreprocessingModal: React.FC<PreprocessingModalProps> = ({
  isOpen,
  onClose,
  filters,
  onChangeFilters,
  onResetFilters,
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-[#ffffff] border border-[#cbd5e1] rounded-lg shadow-2xl max-w-md w-full text-slate-800 overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        <div className="p-3.5 border-b border-[#e2e8f0] bg-[#f1f5f9] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sliders className="w-4 h-4 text-blue-600" />
            <h3 className="text-sm font-semibold text-slate-900">Image Preprocessing & Binarization</h3>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-[#f1f5f9] text-slate-600">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-4 text-xs">
          {/* Brightness */}
          <div>
            <div className="flex justify-between text-slate-700 font-medium mb-1">
              <span className="flex items-center gap-1.5">
                <Sun className="w-3.5 h-3.5 text-amber-600" /> Brightness
              </span>
              <span className="font-mono text-slate-600">{filters.brightness}%</span>
            </div>
            <input
              type="range"
              min="50"
              max="160"
              value={filters.brightness}
              onChange={(e) => onChangeFilters({ ...filters, brightness: Number(e.target.value) })}
              className="w-full accent-blue-500 cursor-pointer"
            />
          </div>

          {/* Contrast */}
          <div>
            <div className="flex justify-between text-slate-700 font-medium mb-1">
              <span className="flex items-center gap-1.5">
                <Contrast className="w-3.5 h-3.5 text-blue-600" /> Contrast
              </span>
              <span className="font-mono text-slate-600">{filters.contrast}%</span>
            </div>
            <input
              type="range"
              min="60"
              max="240"
              value={filters.contrast}
              onChange={(e) => onChangeFilters({ ...filters, contrast: Number(e.target.value) })}
              className="w-full accent-blue-500 cursor-pointer"
            />
          </div>

          {/* Binarization Toggle */}
          <div className="pt-2 border-t border-[#e2e8f0] flex items-center justify-between">
            <div>
              <div className="font-semibold text-slate-900">Otsu Binarization (B&W)</div>
              <div className="text-[11px] text-slate-600">Cleans document background and noise</div>
            </div>
            <input
              type="checkbox"
              checked={filters.binarize}
              onChange={(e) => onChangeFilters({ ...filters, binarize: e.target.checked })}
              className="w-4 h-4 rounded text-blue-600 focus:ring-0 cursor-pointer"
            />
          </div>

          {/* Invert Colors */}
          <div className="pt-2 border-t border-[#e2e8f0] flex items-center justify-between">
            <div>
              <div className="font-semibold text-slate-900">Invert Colors (Negative)</div>
              <div className="text-[11px] text-slate-600">White text on dark background</div>
            </div>
            <input
              type="checkbox"
              checked={filters.invert}
              onChange={(e) => onChangeFilters({ ...filters, invert: e.target.checked })}
              className="w-4 h-4 rounded text-blue-600 focus:ring-0 cursor-pointer"
            />
          </div>
        </div>

        <div className="p-3 border-t border-[#e2e8f0] bg-[#f1f5f9] flex items-center justify-between">
          <button
            onClick={onResetFilters}
            className="flex items-center gap-1.5 px-3 py-1.5 text-slate-600 hover:text-slate-900 rounded hover:bg-[#f1f5f9] text-xs"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Reset Defaults</span>
          </button>
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded font-medium text-xs shadow-xs"
          >
            Apply & Close
          </button>
        </div>
      </div>
    </div>
  );
};
