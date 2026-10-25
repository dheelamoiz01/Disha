"use client";

import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import Map, { Marker, Source, Layer, ScaleControl, MapRef, Popup } from "react-map-gl/maplibre";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { TrailPoint } from "@/services/control-room/trail_service";
import { formatIST, formatTimeOnlyIST } from "@/lib/utils/time";
import {
  Crosshair,
  Maximize2,
  Minimize2,
  Plus,
  Minus,
  MapPin,
  Flag,
  Navigation,
  Compass,
  AlertTriangle,
} from "lucide-react";

if (typeof window !== "undefined") {
  maplibregl.setWorkerUrl("/maplibre/maplibre-gl-worker.mjs");
}

type MapLayerType = "streets" | "navigation" | "satellite" | "dark";

const MAP_STYLES: Record<MapLayerType, any> = {
  satellite: {
    version: 8,
    sources: {
      "esri-satellite-backup": {
        type: "raster",
        tiles: [
          "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        ],
        tileSize: 256,
        attribution: "Tiles &copy; Esri, Maxar, Earthstar Geographics",
        maxzoom: 19,
      },
      "esri-labels-backup": {
        type: "raster",
        tiles: [
          "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
        ],
        tileSize: 256,
        maxzoom: 19,
      },
      "satellite-hybrid-tiles": {
        type: "raster",
        tiles: process.env.NEXT_PUBLIC_MAP_TILES_SATELLITE
          ? [process.env.NEXT_PUBLIC_MAP_TILES_SATELLITE]
          : [
              "https://mt0.google.com/vt/lyrs=y&hl=en&x={x}&y={y}&z={z}",
              "https://mt1.google.com/vt/lyrs=y&hl=en&x={x}&y={y}&z={z}",
              "https://mt2.google.com/vt/lyrs=y&hl=en&x={x}&y={y}&z={z}",
              "https://mt3.google.com/vt/lyrs=y&hl=en&x={x}&y={y}&z={z}",
            ],
        tileSize: 256,
        attribution: '&copy; Google Maps &mdash; High-Precision Satellite & Street Labels',
        maxzoom: 20,
      },
    },
    layers: [
      {
        id: "esri-satellite-base-layer",
        type: "raster",
        source: "esri-satellite-backup",
        minzoom: 0,
        maxzoom: 22,
      },
      {
        id: "satellite-hybrid-layer",
        type: "raster",
        source: "satellite-hybrid-tiles",
        minzoom: 0,
        maxzoom: 22,
      },
      {
        id: "esri-labels-overlay-layer",
        type: "raster",
        source: "esri-labels-backup",
        minzoom: 0,
        maxzoom: 22,
      },
    ],
  },
  streets: {
    version: 8,
    sources: {
      "osm-streets-backup": {
        type: "raster",
        tiles: [
          "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
        ],
        tileSize: 256,
        attribution: "&copy; OpenStreetMap contributors",
        maxzoom: 19,
      },
      "street-tiles": {
        type: "raster",
        tiles: process.env.NEXT_PUBLIC_MAP_TILES_STREETS
          ? [process.env.NEXT_PUBLIC_MAP_TILES_STREETS]
          : [
              "https://mt0.google.com/vt/lyrs=m&hl=en&x={x}&y={y}&z={z}",
              "https://mt1.google.com/vt/lyrs=m&hl=en&x={x}&y={y}&z={z}",
              "https://mt2.google.com/vt/lyrs=m&hl=en&x={x}&y={y}&z={z}",
              "https://mt3.google.com/vt/lyrs=m&hl=en&x={x}&y={y}&z={z}",
            ],
        tileSize: 256,
        attribution: '&copy; Google Maps &mdash; Detailed Street & POI Network',
        maxzoom: 20,
      },
    },
    layers: [
      {
        id: "osm-streets-base-layer",
        type: "raster",
        source: "osm-streets-backup",
        minzoom: 0,
        maxzoom: 22,
      },
      {
        id: "street-layer",
        type: "raster",
        source: "street-tiles",
        minzoom: 0,
        maxzoom: 22,
      },
    ],
  },
  navigation: process.env.NEXT_PUBLIC_MAP_STYLE_NAVIGATION || "https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json",
  dark: process.env.NEXT_PUBLIC_MAP_STYLE_DARK || "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
};

interface TrailMapProps {
  locations: TrailPoint[];
  activeIndex: number | null;
  onSelectIndex: (index: number) => void;
  staffName: string;
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
}

export default function TrailMap({
  locations,
  activeIndex,
  onSelectIndex,
  staffName,
  isFullscreen = false,
  onToggleFullscreen,
}: TrailMapProps) {
  const mapRef = useRef<MapRef | null>(null);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [layerType, setLayerType] = useState<MapLayerType>("satellite");
  const [popupPoint, setPopupPoint] = useState<{ point: TrailPoint; index: number } | null>(null);

  const [viewState, setViewState] = useState({
    longitude: 74.2562,
    latitude: 22.8333,
    zoom: 13,
  });

  const validLocations = useMemo(
    () =>
      locations.filter(
        (l) =>
          Number.isFinite(l.latitude) &&
          Number.isFinite(l.longitude) &&
          Math.abs(l.latitude) <= 90 &&
          Math.abs(l.longitude) <= 180
      ),
    [locations]
  );

  const startPoint = validLocations[0] || null;
  const endPoint = validLocations.length > 1 ? validLocations[validLocations.length - 1] : null;
  const activePoint =
    activeIndex != null && activeIndex >= 0 && activeIndex < validLocations.length
      ? validLocations[activeIndex]
      : null;

  // Build GeoJSON LineString feature for the recorded route
  const routeGeoJSON = useMemo(() => {
    if (validLocations.length < 2) return null;

    const coordinates = validLocations.map((l) => [l.longitude, l.latitude]);

    return {
      type: "FeatureCollection" as const,
      features: [
        {
          type: "Feature" as const,
          geometry: {
            type: "LineString" as const,
            coordinates,
          },
          properties: {},
        },
      ],
    };
  }, [validLocations]);

  // Fit bounds whenever locations change
  const fitTrailBounds = useCallback(() => {
    if (!mapRef.current || validLocations.length === 0) return;

    if (validLocations.length === 1) {
      const p = validLocations[0];
      mapRef.current.flyTo({
        center: [p.longitude, p.latitude],
        zoom: 17,
        duration: 800,
      });
      return;
    }

    const bounds = new maplibregl.LngLatBounds();
    validLocations.forEach((p) => {
      bounds.extend([p.longitude, p.latitude]);
    });

    mapRef.current.fitBounds(bounds, {
      padding: { top: 70, bottom: 90, left: 60, right: 60 },
      maxZoom: 18.5,
      duration: 1000,
    });
  }, [validLocations]);

  useEffect(() => {
    if (mapLoaded && validLocations.length > 0) {
      fitTrailBounds();
    }
  }, [mapLoaded, validLocations, fitTrailBounds]);

  // Resize and invalidate map canvas on fullscreen transition
  useEffect(() => {
    const t1 = setTimeout(() => mapRef.current?.resize(), 60);
    const t2 = setTimeout(() => mapRef.current?.resize(), 260);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [isFullscreen]);

  // Smooth ease-to when active playback point changes
  useEffect(() => {
    if (activePoint && mapRef.current) {
      mapRef.current.easeTo({
        center: [activePoint.longitude, activePoint.latitude],
        duration: 300,
      });
    }
  }, [activePoint]);

  return (
    <div className="relative h-full w-full overflow-hidden bg-slate-950">
      <Map
        ref={mapRef}
        {...viewState}
        maxZoom={22}
        minZoom={3}
        onMove={(evt) => setViewState(evt.viewState)}
        onLoad={() => setMapLoaded(true)}
        onError={(e) => {
          console.warn("Trail map tile/layer notice:", e);
        }}
        mapStyle={MAP_STYLES[layerType]}
        mapLib={maplibregl}
        style={{ width: "100%", height: "100%" }}
        attributionControl={{ compact: true }}
      >
        <ScaleControl position="bottom-left" />

        {/* Route Polyline */}
        {routeGeoJSON && (
          <Source id="route-source" type="geojson" data={routeGeoJSON}>
            {/* Glowing route outline / background */}
            <Layer
              id="route-casing"
              type="line"
              paint={{
                "line-color": "#0284c7",
                "line-width": 7,
                "line-opacity": 0.45,
                "line-blur": 2,
              }}
            />
            {/* Main high-contrast route path */}
            <Layer
              id="route-line"
              type="line"
              paint={{
                "line-color": "#38bdf8",
                "line-width": 4,
                "line-opacity": 0.95,
              }}
            />
          </Source>
        )}

        {/* Start Marker (Green) */}
        {startPoint && (
          <Marker
            longitude={startPoint.longitude}
            latitude={startPoint.latitude}
            anchor="bottom"
            onClick={(e) => {
              e.originalEvent.stopPropagation();
              onSelectIndex(0);
              setPopupPoint({ point: startPoint, index: 0 });
            }}
          >
            <div className="flex flex-col items-center cursor-pointer group">
              <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-600 text-white text-[10px] font-black shadow-lg border-2 border-white ring-2 ring-emerald-500/50 group-hover:scale-110 transition-transform">
                <Flag size={11} className="fill-white" />
                <span>START</span>
              </span>
              <span className="h-2 w-2 -mt-1 rotate-45 bg-emerald-600 border-r-2 border-b-2 border-white" />
              <span className="mt-0.5 text-[9px] font-mono font-bold bg-slate-900/90 text-emerald-300 px-1.5 py-0.2 rounded border border-emerald-800 shadow">
                {formatTimeOnlyIST(startPoint.recordedAt, false)}
              </span>
            </div>
          </Marker>
        )}

        {/* End / Latest Marker (Red/Indigo) */}
        {endPoint && (
          <Marker
            longitude={endPoint.longitude}
            latitude={endPoint.latitude}
            anchor="bottom"
            onClick={(e) => {
              e.originalEvent.stopPropagation();
              onSelectIndex(validLocations.length - 1);
              setPopupPoint({ point: endPoint, index: validLocations.length - 1 });
            }}
          >
            <div className="flex flex-col items-center cursor-pointer group">
              <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-rose-600 text-white text-[10px] font-black shadow-lg border-2 border-white ring-2 ring-rose-500/50 group-hover:scale-110 transition-transform">
                <Flag size={11} className="fill-white" />
                <span>END</span>
              </span>
              <span className="h-2 w-2 -mt-1 rotate-45 bg-rose-600 border-r-2 border-b-2 border-white" />
              <span className="mt-0.5 text-[9px] font-mono font-bold bg-slate-900/90 text-rose-300 px-1.5 py-0.2 rounded border border-rose-800 shadow">
                {formatTimeOnlyIST(endPoint.recordedAt, false)}
              </span>
            </div>
          </Marker>
        )}

        {/* Intermediate Trail Dots */}
        {validLocations.map((l, idx) => {
          if (idx === 0 || idx === validLocations.length - 1) return null;
          const isSelected = activeIndex === idx;
          const isOptimal = l.accuracy <= 10;
          const isVerified = l.accuracy <= 20;

          return (
            <Marker
              key={l.id || `pt-${idx}`}
              longitude={l.longitude}
              latitude={l.latitude}
              anchor="center"
              onClick={(e) => {
                e.originalEvent.stopPropagation();
                onSelectIndex(idx);
                setPopupPoint({ point: l, index: idx });
              }}
            >
              <button
                type="button"
                aria-label={`Point ${idx + 1}`}
                className="group relative flex items-center justify-center cursor-pointer outline-none"
              >
                <span
                  className={`rounded-full transition-all ${
                    isSelected
                      ? "h-4 w-4 bg-sky-400 ring-4 ring-sky-300/60 scale-125"
                      : isOptimal
                        ? "h-2 w-2 bg-emerald-400 group-hover:scale-150 ring-1 ring-slate-900"
                        : isVerified
                          ? "h-2 w-2 bg-sky-400 group-hover:scale-150 ring-1 ring-slate-900"
                          : "h-2 w-2 bg-amber-400 group-hover:scale-150 ring-1 ring-slate-900"
                  }`}
                />
              </button>
            </Marker>
          );
        })}

        {/* Animated Playback Cursor Reticle */}
        {activePoint && (
          <Marker
            longitude={activePoint.longitude}
            latitude={activePoint.latitude}
            anchor="center"
          >
            <div className="relative flex items-center justify-center pointer-events-none">
              <span className="absolute h-8 w-8 rounded-full border-2 border-sky-400 bg-sky-400/25 animate-ping" />
              <span className="h-5 w-5 rounded-full bg-sky-500 border-2 border-white ring-2 ring-sky-400 shadow-xl flex items-center justify-center">
                <Navigation size={11} className="text-white transform -rotate-45" />
              </span>
            </div>
          </Marker>
        )}

        {/* Click Popup Details */}
        {popupPoint && (
          <Popup
            longitude={popupPoint.point.longitude}
            latitude={popupPoint.point.latitude}
            anchor="top"
            closeOnClick={false}
            onClose={() => setPopupPoint(null)}
            className="trail-popup"
          >
            <div className="p-1 min-w-[200px] text-slate-900">
              <div className="flex items-center justify-between gap-2 border-b border-slate-200 pb-1 mb-1">
                <span className="font-bold text-xs text-slate-800">
                  Point #{popupPoint.index + 1}
                </span>
                <span
                  className={`text-[9px] font-bold px-1.5 py-0.2 rounded font-mono ${
                    popupPoint.point.accuracy <= 10
                      ? "bg-emerald-100 text-emerald-800"
                      : popupPoint.point.accuracy <= 20
                        ? "bg-sky-100 text-sky-800"
                        : "bg-amber-100 text-amber-800"
                  }`}
                >
                  ±{Math.round(popupPoint.point.accuracy)}m
                  {popupPoint.point.accuracy <= 10
                    ? " (≤10m Optimal)"
                    : popupPoint.point.accuracy <= 20
                      ? " (≤20m Verified)"
                      : " (Low Acc)"}
                </span>
              </div>
              <div className="text-[11px] font-medium text-slate-600 mb-0.5">
                Time:{" "}
                <span className="font-bold text-slate-800">
                  {formatTimeOnlyIST(popupPoint.point.recordedAt)}
                </span>
              </div>
              <div className="text-[10px] font-mono text-slate-500 mb-1">
                {popupPoint.point.latitude.toFixed(6)}, {popupPoint.point.longitude.toFixed(6)}
              </div>
              <div className="flex items-center justify-between text-[10px] text-slate-600 pt-1 border-t border-slate-100">
                <span>Source: {popupPoint.point.source}</span>
                {popupPoint.point.speedKmh != null && (
                  <span className="font-semibold text-slate-700">
                    {popupPoint.point.speedKmh} km/h
                  </span>
                )}
              </div>
            </div>
          </Popup>
        )}
      </Map>

      {/* Top Left Header Pill - Responsive (hidden on narrow mobile to avoid overlap) */}
      <div className="absolute left-3 top-3 z-10 hidden sm:flex items-center gap-2 pointer-events-none">
        <div className="flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-900/95 px-3 py-1.5 text-xs font-bold text-slate-200 shadow-xl backdrop-blur-md">
          <Compass size={15} className="text-sky-400" />
          <span className="truncate max-w-[160px] md:max-w-[240px]">Trail Map &bull; {staffName}</span>
        </div>
        <div className="flex items-center gap-1.5 rounded-xl border border-slate-800 bg-slate-900/95 px-2.5 py-1.5 text-xs font-semibold text-slate-300 shadow-xl backdrop-blur-md">
          <span className="h-2 w-2 rounded-full bg-emerald-400" />
          <span>{validLocations.length} points</span>
        </div>
      </div>

      {/* Top Right Controls: Map Layer Switcher & Full Screen Toggle */}
      <div className="absolute right-3 top-3 z-20 flex items-center gap-2">
        <div className="flex items-center bg-slate-900/95 border border-slate-700/80 rounded-xl p-1 shadow-2xl backdrop-blur-md">
          <button
            type="button"
            onClick={() => setLayerType("streets")}
            className={`px-2 sm:px-2.5 py-1 text-xs font-semibold rounded-lg transition-all cursor-pointer ${
              layerType === "streets"
                ? "bg-sky-600 text-white shadow-sm"
                : "text-slate-300 hover:text-white hover:bg-slate-800"
            }`}
          >
            Streets
          </button>
          <button
            type="button"
            onClick={() => setLayerType("navigation")}
            className={`px-2 sm:px-2.5 py-1 text-xs font-semibold rounded-lg transition-all cursor-pointer ${
              layerType === "navigation"
                ? "bg-sky-600 text-white shadow-sm"
                : "text-slate-300 hover:text-white hover:bg-slate-800"
            }`}
          >
            Navigation
          </button>
          <button
            type="button"
            onClick={() => setLayerType("satellite")}
            className={`px-2 sm:px-2.5 py-1 text-xs font-semibold rounded-lg transition-all cursor-pointer ${
              layerType === "satellite"
                ? "bg-sky-600 text-white shadow-sm"
                : "text-slate-300 hover:text-white hover:bg-slate-800"
            }`}
          >
            Satellite
          </button>
          <button
            type="button"
            onClick={() => setLayerType("dark")}
            className={`px-2 sm:px-2.5 py-1 text-xs font-semibold rounded-lg transition-all cursor-pointer ${
              layerType === "dark"
                ? "bg-sky-600 text-white shadow-sm"
                : "text-slate-300 hover:text-white hover:bg-slate-800"
            }`}
          >
            Dark
          </button>
        </div>

        {onToggleFullscreen && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggleFullscreen();
            }}
            onMouseDown={(e) => e.stopPropagation()}
            onTouchStart={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            aria-label={isFullscreen ? "Exit Full Screen" : "Full Screen"}
            title={isFullscreen ? "Exit Full Screen (Esc)" : "Full Screen Map"}
            className={`flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 rounded-xl border text-xs font-bold shadow-2xl backdrop-blur-md transition-all active:scale-95 cursor-pointer whitespace-nowrap ${
              isFullscreen
                ? "border-rose-500/80 bg-rose-950/80 hover:bg-rose-900 text-rose-200"
                : "border-sky-500/80 bg-sky-950/80 hover:bg-sky-900 text-sky-200"
            }`}
          >
            {isFullscreen ? (
              <>
                <Minimize2 size={15} className="text-rose-400 flex-shrink-0" />
                <span className="hidden xs:inline sm:inline">Exit Full Screen</span>
              </>
            ) : (
              <>
                <Maximize2 size={15} className="text-sky-400 flex-shrink-0" />
                <span className="hidden xs:inline sm:inline">Full Screen</span>
              </>
            )}
          </button>
        )}
      </div>

      {/* Floating Control Stack - Bottom Right */}
      <div className="absolute right-3 bottom-20 z-10 flex flex-col items-center gap-2">
        {/* Fit Trail Bounds */}
        <button
          type="button"
          onClick={fitTrailBounds}
          disabled={validLocations.length === 0}
          title="Fit full route trail in view"
          className="flex h-10 w-10 items-center justify-center rounded-xl border border-slate-700 bg-slate-900/95 text-slate-200 shadow-xl backdrop-blur-md transition-all hover:bg-slate-800 hover:text-white active:scale-95 disabled:opacity-40 cursor-pointer"
        >
          <Crosshair size={18} />
        </button>

        {/* Zoom In / Out */}
        <div className="flex flex-col items-center rounded-xl border border-slate-700 bg-slate-900/95 shadow-xl backdrop-blur-md overflow-hidden">
          <button
            type="button"
            onClick={() => mapRef.current?.zoomIn({ duration: 300 })}
            title="Zoom in (up to 22x deep zoom)"
            className="flex h-9 w-9 items-center justify-center text-slate-200 hover:bg-slate-800 hover:text-white transition-colors cursor-pointer border-b border-slate-800"
          >
            <Plus size={18} />
          </button>
          <div className="px-1 py-1 text-[9px] font-mono font-bold text-sky-400 text-center select-none border-b border-slate-800 w-full bg-slate-950/60">
            {viewState.zoom.toFixed(1)}z
          </div>
          <button
            type="button"
            onClick={() => mapRef.current?.zoomOut({ duration: 300 })}
            title="Zoom out"
            className="flex h-9 w-9 items-center justify-center text-slate-200 hover:bg-slate-800 hover:text-white transition-colors cursor-pointer"
          >
            <Minus size={18} />
          </button>
        </div>
      </div>

      {/* Empty State Overlay */}
      {validLocations.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center p-4 pointer-events-none z-10">
          <div className="max-w-xs rounded-2xl border border-slate-800 bg-slate-900/95 p-6 text-center shadow-2xl backdrop-blur-md">
            <MapPin size={36} className="mx-auto mb-2 text-slate-500" />
            <h3 className="text-sm font-bold text-white">No Route Recorded</h3>
            <p className="mt-1 text-xs text-slate-400 leading-relaxed">
              No GPS location coordinates were recorded for this staff member on the selected date.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
