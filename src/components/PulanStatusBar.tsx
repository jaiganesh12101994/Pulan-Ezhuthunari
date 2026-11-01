import React from 'react';
import { Layers, Activity, CheckCircle2, Cpu } from 'lucide-react';
import { OCREngine } from '../types';

interface PulanStatusBarProps {
  statusMessage: string;
  currentPage: number;
  totalPages: number;
  zoomLevel: number;
  engine: OCREngine;
  zonesCount: number;
  pageWidth?: number;
  pageHeight?: number;
}

export const PulanStatusBar: React.FC<PulanStatusBarProps> = ({
  statusMessage,
  currentPage,
  totalPages,
  zoomLevel,
  engine,
  zonesCount,
  pageWidth = 900,
  pageHeight = 1200,
}) => {
  return (
    <div className="bg-[#e2e8f0] text-slate-700 border-t border-[#e2e8f0] px-3 py-1 flex items-center justify-between text-[11px] font-sans select-none h-6.5 shrink-0">
      {/* Left Status Message */}
      <div className="flex items-center gap-2 overflow-hidden truncate">
        <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0"></span>
        <span className="truncate text-slate-800">{statusMessage}</span>
      </div>

      {/* Right Metrics & Environment Info */}
      <div className="flex items-center gap-4 text-slate-600 font-mono text-[10px] shrink-0">
        <div className="flex items-center gap-1">
          <Layers className="w-3 h-3 text-blue-600" />
          <span>
            {zonesCount} {zonesCount === 1 ? 'Zone' : 'Zones'}
          </span>
        </div>

        <div className="h-3 w-px bg-[#e2e8f0]"></div>

        <div>
          <span>{pageWidth}×{pageHeight} px</span>
        </div>

        <div className="h-3 w-px bg-[#e2e8f0]"></div>

        <div>
          <span>{Math.round(zoomLevel * 100)}%</span>
        </div>

        <div className="h-3 w-px bg-[#e2e8f0]"></div>

        <div className="flex items-center gap-1 text-slate-800">
          <Cpu className="w-3 h-3 text-amber-600" />
          <span className="uppercase font-semibold text-blue-700">{engine}</span>
        </div>

        <div className="h-3 w-px bg-[#e2e8f0]"></div>

        <div className="font-semibold text-slate-700">
          Page {currentPage} of {totalPages}
        </div>
      </div>
    </div>
  );
};
