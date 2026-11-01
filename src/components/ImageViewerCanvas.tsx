import React, { useRef, useState, useEffect, useCallback } from 'react';
import {
  Trash2,
  Play,
  Move,
  Tag,
  Hash,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Sliders,
} from 'lucide-react';
import { DocumentPage, LayoutZone, ImageFilters, ZoneType } from '../types';

interface ImageViewerCanvasProps {
  page: DocumentPage | null;
  zoomLevel: number;
  onZoomChange: (newZoom: number) => void;
  drawMode: 'select' | 'pan';
  filters: ImageFilters;
  activeZoneId: string | null;
  onSelectZone: (zoneId: string | null) => void;
  onUpdateZones: (zones: LayoutZone[]) => void;
  onRecognizeZone: (zone: LayoutZone) => void;
}

export const ImageViewerCanvas: React.FC<ImageViewerCanvasProps> = ({
  page,
  zoomLevel,
  onZoomChange,
  drawMode,
  filters,
  activeZoneId,
  onSelectZone,
  onUpdateZones,
  onRecognizeZone,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  // Pan offsets
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });

  // Custom drawing new zone
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawStart, setDrawStart] = useState({ x: 0, y: 0 });
  const [currentDrawRect, setCurrentDrawRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  // Dragging / Resizing existing zone
  const [draggingZoneId, setDraggingZoneId] = useState<string | null>(null);
  const [resizingHandle, setResizingHandle] = useState<string | null>(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });

  // Reset pan when page changes
  useEffect(() => {
    setPan({ x: 0, y: 0 });
  }, [page?.id]);

  // Fit a newly opened page into the viewer so it is visible right away. The old
  // fixed default zoom (0.9) clipped large landscape scans such as the 2142x1609
  // rasters produced from scanned Tamil volumes.
  const lastFittedSize = useRef<string | null>(null);
  useEffect(() => {
    const width = page?.width || 0;
    const height = page?.height || 0;
    const container = containerRef.current;
    if (!width || !height || !container) return;

    const signature = `${width}x${height}`;
    if (lastFittedSize.current === signature) return;

    const { clientWidth, clientHeight } = container;
    if (!clientWidth || !clientHeight) return;

    lastFittedSize.current = signature;
    const fit = Math.min((clientWidth - 48) / width, (clientHeight - 48) / height);
    onZoomChange(Math.min(4, Math.max(0.1, Number(fit.toFixed(3)))));
  }, [page?.width, page?.height, onZoomChange]);

  // Wheel zoom
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      if (e.cancelable) {
        e.preventDefault();
      }
      const zoomFactor = e.deltaY < 0 ? 1.15 : 0.85;
      const newZoom = Math.min(4.0, Math.max(0.2, zoomLevel * zoomFactor));
      onZoomChange(newZoom);
    },
    [zoomLevel, onZoomChange]
  );

  // Convert client coordinates to image coordinate space
  const clientToImageCoords = useCallback(
    (clientX: number, clientY: number) => {
      if (!imgRef.current) return { x: 0, y: 0 };
      const rect = imgRef.current.getBoundingClientRect();
      const scaleX = (page?.width || 900) / rect.width;
      const scaleY = (page?.height || 1200) / rect.height;
      const x = Math.max(0, Math.min(page?.width || 900, (clientX - rect.left) * scaleX));
      const y = Math.max(0, Math.min(page?.height || 1200, (clientY - rect.top) * scaleY));
      return { x, y };
    },
    [page?.width, page?.height]
  );

  // Pointer Down
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button === 1 || drawMode === 'pan' || e.altKey) {
      // Middle click or pan mode
      setIsPanning(true);
      setPanStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
      return;
    }

    if (drawMode === 'select' && !draggingZoneId && !resizingHandle) {
      const coords = clientToImageCoords(e.clientX, e.clientY);
      setIsDrawing(true);
      setDrawStart(coords);
      setCurrentDrawRect({ x: coords.x, y: coords.y, w: 0, h: 0 });
      onSelectZone(null);
    }
  };

  // Pointer Move
  const handleMouseMove = (e: React.MouseEvent) => {
    if (isPanning) {
      setPan({ x: e.clientX - panStart.x, y: e.clientY - panStart.y });
      return;
    }

    if (isDrawing) {
      const coords = clientToImageCoords(e.clientX, e.clientY);
      const x = Math.min(drawStart.x, coords.x);
      const y = Math.min(drawStart.y, coords.y);
      const w = Math.abs(coords.x - drawStart.x);
      const h = Math.abs(coords.y - drawStart.y);
      setCurrentDrawRect({ x, y, w, h });
      return;
    }

    if (draggingZoneId && page) {
      const coords = clientToImageCoords(e.clientX, e.clientY);
      const updated = page.detectedZones.map((z) => {
        if (z.id === draggingZoneId) {
          const newX = Math.max(0, Math.min((page.width || 900) - z.width, coords.x - dragOffset.x));
          const newY = Math.max(0, Math.min((page.height || 1200) - z.height, coords.y - dragOffset.y));
          return { ...z, x: Math.round(newX), y: Math.round(newY) };
        }
        return z;
      });
      onUpdateZones(updated);
      return;
    }

    if (resizingHandle && activeZoneId && page) {
      const coords = clientToImageCoords(e.clientX, e.clientY);
      const updated = page.detectedZones.map((z) => {
        if (z.id === activeZoneId) {
          let { x, y, width, height } = z;
          if (resizingHandle.includes('e')) width = Math.max(20, coords.x - x);
          if (resizingHandle.includes('s')) height = Math.max(20, coords.y - y);
          if (resizingHandle.includes('w')) {
            const right = x + width;
            x = Math.min(right - 20, coords.x);
            width = right - x;
          }
          if (resizingHandle.includes('n')) {
            const bottom = y + height;
            y = Math.min(bottom - 20, coords.y);
            height = bottom - y;
          }
          return { ...z, x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
        }
        return z;
      });
      onUpdateZones(updated);
    }
  };

  // Pointer Up
  const handleMouseUp = () => {
    setIsPanning(false);

    if (isDrawing && currentDrawRect && page) {
      if (currentDrawRect.w > 20 && currentDrawRect.h > 20) {
        const nextOrder = page.detectedZones.length + 1;
        const newZone: LayoutZone = {
          id: `custom-zone-${Date.now()}`,
          order: nextOrder,
          col: 1,
          type: 'column',
          x: Math.round(currentDrawRect.x),
          y: Math.round(currentDrawRect.y),
          width: Math.round(currentDrawRect.w),
          height: Math.round(currentDrawRect.h),
          confidence: 99.0,
        };
        onUpdateZones([...page.detectedZones, newZone]);
        onSelectZone(newZone.id);
      }
      setIsDrawing(false);
      setCurrentDrawRect(null);
    }

    setDraggingZoneId(null);
    setResizingHandle(null);
  };

  // Delete a zone
  const handleDeleteZone = (zoneId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!page) return;
    const filtered = page.detectedZones
      .filter((z) => z.id !== zoneId)
      .map((z, idx) => ({ ...z, order: idx + 1 }));
    onUpdateZones(filtered);
    if (activeZoneId === zoneId) onSelectZone(null);
  };

  // Change zone type
  const handleChangeZoneType = (zoneId: string, newType: ZoneType, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!page) return;
    const updated = page.detectedZones.map((z) => (z.id === zoneId ? { ...z, type: newType } : z));
    onUpdateZones(updated);
  };

  // Generate CSS filter string
  const getFilterStyle = (): React.CSSProperties => {
    let filterString = `brightness(${filters.brightness}%) contrast(${filters.contrast}%)`;
    if (filters.binarize) {
      filterString += `grayscale(100%) contrast(350%)`;
    }
    if (filters.invert) {
      filterString += `invert(100%)`;
    }
    return { filter: filterString };
  };

  if (!page) {
    return (
      <div className="flex-1 bg-[#e2e8f0] flex flex-col items-center justify-center text-slate-500 p-8">
        <Sliders className="w-12 h-12 mb-3 text-slate-600 opacity-50" />
        <h3 className="text-sm font-semibold text-slate-700">No Document Loaded</h3>
        <p className="text-xs text-slate-600 mt-1 max-w-sm text-center">
          Open a PDF or an image scan to begin OCR recognition.
        </p>
      </div>
    );
  }

  const pageWidth = page.width || 900;
  const pageHeight = page.height || 1200;

  return (
    <div
      ref={containerRef}
      onWheel={handleWheel}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      className={`flex-1 bg-[#f1f5f9] relative overflow-hidden flex items-center justify-center select-none ${ drawMode === 'pan' || isPanning ? 'cursor-grab active:cursor-grabbing' : 'cursor-crosshair' }`}
    >
      {/* Canvas workspace area transformed by zoom and pan */}
      <div
        style={{
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoomLevel})`,
          transformOrigin: 'center center',
          transition: isPanning || isDrawing || draggingZoneId || resizingHandle ? 'none' : 'transform 0.05s ease-out',
        }}
        className="relative shadow-2xl bg-white border border-[#cbd5e1]"
      >
        {/* Document Page Image */}
        <img
          ref={imgRef}
          src={page.url}
          alt={`Page ${page.pageNumber}`}
          style={{
            ...getFilterStyle(),
            transform: `rotate(${page.rotation || 0}deg)`,
            width: `${pageWidth}px`,
            height: `${pageHeight}px`,
          }}
          className="max-w-none block pointer-events-none"
          draggable={false}
        />

        {/* Word bounding box highlights (when word boxes available) */}
        {page.words && page.words.length > 0 && (
          <div className="absolute inset-0 pointer-events-none">
            {page.words.map((w, i) => (
              <div
                key={i}
                className="absolute border border-amber-400/40 bg-amber-50 hover:bg-amber-400/30"
                style={{
                  left: `${w.x}px`,
                  top: `${w.y}px`,
                  width: `${w.width}px`,
                  height: `${w.height}px`,
                }}
                title={`${w.text} (${Math.round(w.confidence)}%)`}
              />
            ))}
          </div>
        )}

        {/* Layout Detection Zones (Multi-columns, Headlines, Boxes) */}
        {page.detectedZones.map((zone) => {
          const isActive = activeZoneId === zone.id;
          const isHeadline = zone.type === 'headline';

          return (
            <div
              key={zone.id}
              onClick={(e) => {
                e.stopPropagation();
                onSelectZone(zone.id);
              }}
              onMouseDown={(e) => {
                if (e.button === 0) {
                  e.stopPropagation();
                  onSelectZone(zone.id);
                  setDraggingZoneId(zone.id);
                  const coords = clientToImageCoords(e.clientX, e.clientY);
                  setDragOffset({ x: coords.x - zone.x, y: coords.y - zone.y });
                }
              }}
              style={{
                left: `${zone.x}px`,
                top: `${zone.y}px`,
                width: `${zone.width}px`,
                height: `${zone.height}px`,
              }}
              className={`absolute border-2 transition-shadow cursor-move ${ isActive ? 'border-blue-500 bg-blue-500/15 shadow-lg ring-2 ring-blue-400/40' : isHeadline ? 'border-indigo-500/80 bg-indigo-500/15 hover:border-indigo-400' : 'border-blue-500/80 bg-blue-500/10 hover:border-blue-400' }`}
            >
              {/* Zone Header Badge: Reading Order & Zone Type */}
              <div
                className={`absolute -top-6 left-0 flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-bold shadow-md pointer-events-auto ${ isActive ? 'bg-blue-600 text-white' : isHeadline ? 'bg-indigo-700 text-white' : 'bg-[#f1f5f9] text-blue-700 border border-blue-500/50' }`}
              >
                <span className="flex items-center gap-0.5">
                  <Hash className="w-2.5 h-2.5" />
                  {zone.order}
                </span>
                <span className="text-[9px] uppercase tracking-wider font-semibold opacity-90">
                  {zone.type}
                </span>
              </div>

              {/* Active Zone Quick Actions Bar */}
              {isActive && (
                <div
                  onMouseDown={(e) => e.stopPropagation()}
                  className="absolute -top-7 right-0 flex items-center gap-1 bg-[#f1f5f9] border border-blue-500/60 rounded px-1.5 py-0.5 shadow-xl text-[10px] pointer-events-auto"
                >
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onRecognizeZone(zone);
                    }}
                    title="Recognize this zone only"
                    className="p-1 hover:bg-emerald-600 rounded text-emerald-600 hover:text-white flex items-center gap-0.5"
                  >
                    <Play className="w-3 h-3 fill-current" />
                    <span>OCR</span>
                  </button>
                  <div className="h-3 w-px bg-slate-200"></div>
                  <button
                    onClick={(e) =>
                      handleChangeZoneType(
                        zone.id,
                        zone.type === 'column' ? 'headline' : zone.type === 'headline' ? 'body' : 'column',
                        e
                      )
                    }
                    title="Toggle zone type (Headline / Column / Body)"
                    className="p-1 hover:bg-[#e2e8f0] rounded text-slate-700 flex items-center gap-0.5"
                  >
                    <Tag className="w-2.5 h-2.5" />
                    <span>Type</span>
                  </button>
                  <div className="h-3 w-px bg-slate-200"></div>
                  <button
                    onClick={(e) => handleDeleteZone(zone.id, e)}
                    title="Delete zone"
                    className="p-1 hover:bg-rose-600 rounded text-rose-600 hover:text-white"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              )}

              {/* 8 Resizing Anchor Handles for Active Zone */}
              {isActive && (
                <>
                  {['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((handle) => {
                    let posStyle: React.CSSProperties = {};
                    if (handle.includes('n')) posStyle.top = -4;
                    if (handle.includes('s')) posStyle.bottom = -4;
                    if (handle.includes('w')) posStyle.left = -4;
                    if (handle.includes('e')) posStyle.right = -4;
                    if (handle === 'n' || handle === 's') posStyle.left = '50%';
                    if (handle === 'w' || handle === 'e') posStyle.top = '50%';

                    return (
                      <div
                        key={handle}
                        onMouseDown={(e) => {
                          e.stopPropagation();
                          setResizingHandle(handle);
                        }}
                        style={posStyle}
                        className={`absolute w-2.5 h-2.5 bg-blue-500 border border-white rounded-xs shadow-xs z-20 ${ handle === 'nw' || handle === 'se' ? 'cursor-nwse-resize' : handle === 'ne' || handle === 'sw' ? 'cursor-nesw-resize' : handle === 'n' || handle === 's' ? 'cursor-ns-resize' : 'cursor-ew-resize' }`}
                      />
                    );
                  })}
                </>
              )}
            </div>
          );
        })}

        {/* Temporary Drawing Rectangle */}
        {isDrawing && currentDrawRect && (
          <div
            style={{
              left: `${currentDrawRect.x}px`,
              top: `${currentDrawRect.y}px`,
              width: `${currentDrawRect.w}px`,
              height: `${currentDrawRect.h}px`,
            }}
            className="absolute border-2 border-emerald-400 bg-emerald-500/20 pointer-events-none border-dashed"
          />
        )}
      </div>

      {/* Floating Canvas Quick Controls (bottom-left) */}
      <div className="absolute bottom-4 left-4 flex items-center gap-1 bg-[#ffffff]/90 backdrop-blur-xs border border-[#cbd5e1] rounded px-2 py-1 text-slate-800 text-xs shadow-lg">
        <button
          onClick={() => onZoomChange(Math.max(0.2, zoomLevel - 0.2))}
          title="Zoom Out"
          className="p-1 hover:bg-[#f1f5f9] rounded"
        >
          <ZoomOut className="w-3.5 h-3.5" />
        </button>
        <span className="font-mono text-[11px] min-w-12 text-center text-slate-700 font-semibold">
          {Math.round(zoomLevel * 100)}%
        </span>
        <button
          onClick={() => onZoomChange(Math.min(4.0, zoomLevel + 0.2))}
          title="Zoom In"
          className="p-1 hover:bg-[#f1f5f9] rounded"
        >
          <ZoomIn className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => onZoomChange(1.0)}
          title="100% Zoom"
          className="px-1.5 py-0.5 hover:bg-[#f1f5f9] rounded text-[10px] text-blue-600 font-bold"
        >
          1:1
        </button>
        <button
          onClick={() => setPan({ x: 0, y: 0 })}
          title="Reset Pan"
          className="p-1 hover:bg-[#f1f5f9] rounded text-slate-600"
        >
          <Maximize2 className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Drawing mode indicator pill (top-right) */}
      <div className="absolute top-3 right-3 bg-[#ffffff]/90 backdrop-blur-xs border border-[#cbd5e1] rounded-full px-3 py-1 text-[11px] text-slate-700 shadow-md flex items-center gap-1.5">
        <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
        <span>
          Mode: <strong className="text-slate-900 capitalize">{drawMode}</strong> (
          {drawMode === 'select' ? 'Click & drag to create column zone' : 'Drag image to pan'}
          )
        </span>
      </div>
    </div>
  );
};
