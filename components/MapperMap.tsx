"use client";

import React, { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { Coord } from "@/lib/geoPipeline";

const ESUT_CENTER: Coord = [7.5375, 6.3052];

const SATELLITE_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    esri: {
      type: "raster",
      tiles: [
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      ],
      tileSize: 256,
      maxzoom: 19,
    },
    labels: {
      type: "raster",
      tiles: [
        "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
      ],
      tileSize: 256,
      maxzoom: 19,
    },
  },
  layers: [
    { id: "esri-sat", type: "raster", source: "esri" },
    { id: "esri-labels", type: "raster", source: "labels" },
  ],
};

const STREETS_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      maxzoom: 19,
    },
  },
  layers: [{ id: "osm-streets", type: "raster", source: "osm" }],
};

export interface MapJunctionPin {
  id: string;
  lng: number;
  lat: number;
  status: "open" | "claimed" | "done";
  created_by: string;
  claimed_by: string | null;
  note?: string | null;
}

export interface MapPhotoPin {
  id: string;
  lng: number;
  lat: number;
  category: string;
  label: string | null;
  heading: number | null;
  image_url: string;
  scout_name?: string;
  zone?: string;
}

interface MapperMapProps {
  paths: { id: string; name?: string | null; coordinates: Coord[] }[];
  activePath: Coord[];
  frontierEndpoints?: { id: string; pathId: string; coord: Coord; which: "start" | "end" }[];
  junctionPins: MapJunctionPin[];
  photoPins: MapPhotoPin[];
  teammates: { name: string; lng: number; lat: number }[];
  userCoord: Coord | null;
  heading: number | null;
  isRecording: boolean;
  guideTarget: Coord | null;
  focusCoord: Coord | null;
  onSelectJunctionPin: (pinId: string) => void;
  onSelectPhotoPin?: (pinId: string) => void;
  onSelectPath?: (pathId: string) => void;
  onSelectFrontier?: (frontierId: string) => void;
  onMapClick?: (coord: Coord) => void;
}

export default function MapperMap({
  paths,
  activePath,
  frontierEndpoints = [],
  junctionPins,
  photoPins,
  teammates,
  userCoord,
  heading,
  isRecording,
  guideTarget,
  focusCoord,
  onSelectJunctionPin,
  onSelectPhotoPin,
  onSelectPath,
  onSelectFrontier,
  onMapClick,
}: MapperMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [isSatellite, setIsSatellite] = useState(true);
  const callbacksRef = useRef({
    onSelectJunctionPin,
    onSelectPhotoPin,
    onSelectPath,
    onSelectFrontier,
    onMapClick,
  });

  const latestRef = useRef({
    paths,
    activePath,
    frontierEndpoints,
    junctionPins,
    photoPins,
    teammates,
    userCoord,
    guideTarget,
  });

  const syncAllSources = (map: maplibregl.Map) => {
    const d = latestRef.current;

    (
      map.getSource("synced-paths") as maplibregl.GeoJSONSource | undefined
    )?.setData({
      type: "FeatureCollection",
      features: d.paths.map((p) => ({
        type: "Feature",
        properties: { id: p.id },
        geometry: { type: "LineString", coordinates: p.coordinates },
      })),
    });

    (
      map.getSource("active-path") as maplibregl.GeoJSONSource | undefined
    )?.setData({
      type: "FeatureCollection",
      features:
        d.activePath.length >= 2
          ? [
              {
                type: "Feature",
                properties: {},
                geometry: { type: "LineString", coordinates: d.activePath },
              },
            ]
          : [],
    });

    (
      map.getSource("guide-line") as maplibregl.GeoJSONSource | undefined
    )?.setData({
      type: "FeatureCollection",
      features:
        d.userCoord && d.guideTarget
          ? [
              {
                type: "Feature",
                properties: {},
                geometry: {
                  type: "LineString",
                  coordinates: [d.userCoord, d.guideTarget],
                },
              },
            ]
          : [],
    });

    (
      map.getSource("junction-pins") as maplibregl.GeoJSONSource | undefined
    )?.setData({
      type: "FeatureCollection",
      features: d.junctionPins.map((pin) => ({
        type: "Feature",
        properties: { id: pin.id, status: pin.status },
        geometry: { type: "Point", coordinates: [pin.lng, pin.lat] },
      })),
    });

    (
      map.getSource("photo-pins") as maplibregl.GeoJSONSource | undefined
    )?.setData({
      type: "FeatureCollection",
      features: d.photoPins.map((p) => ({
        type: "Feature",
        properties: { id: p.id },
        geometry: { type: "Point", coordinates: [p.lng, p.lat] },
      })),
    });

    (
      map.getSource("teammates") as maplibregl.GeoJSONSource | undefined
    )?.setData({
      type: "FeatureCollection",
      features: d.teammates.map((t) => ({
        type: "Feature",
        properties: { name: t.name },
        geometry: { type: "Point", coordinates: [t.lng, t.lat] },
      })),
    });

    (
      map.getSource("user-pos") as maplibregl.GeoJSONSource | undefined
    )?.setData({
      type: "FeatureCollection",
      features: d.userCoord
        ? [
            {
              type: "Feature",
              properties: {},
              geometry: { type: "Point", coordinates: d.userCoord },
            },
          ]
        : [],
    });

    (
      map.getSource("frontier-endpoints") as
        | maplibregl.GeoJSONSource
        | undefined
    )?.setData({
      type: "FeatureCollection",
      features: d.frontierEndpoints.map((f) => ({
        type: "Feature",
        properties: { id: f.id, pathId: f.pathId },
        geometry: { type: "Point", coordinates: f.coord },
      })),
    });
  };

  const ensureLayers = (map: maplibregl.Map) => {
    const emptyFC: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: [],
    };
    [
      "synced-paths",
      "frontier-endpoints",
      "active-path",
      "guide-line",
      "junction-pins",
      "photo-pins",
      "teammates",
      "user-pos",
    ].forEach((id) => {
      if (!map.getSource(id))
        map.addSource(id, { type: "geojson", data: emptyFC });
    });

    if (!map.getLayer("synced-paths-casing")) {
      map.addLayer({
        id: "synced-paths-casing",
        type: "line",
        source: "synced-paths",
        paint: {
          "line-color": "#082f49",
          "line-width": 9,
          "line-opacity": 0.8,
        },
        layout: { "line-cap": "round", "line-join": "round" },
      });
    }

    if (!map.getLayer("synced-paths-layer")) {
      map.addLayer({
        id: "synced-paths-layer",
        type: "line",
        source: "synced-paths",
        paint: {
          "line-color": "#0ea5e9",
          "line-width": 5,
          "line-opacity": 0.95,
        },
        layout: { "line-cap": "round", "line-join": "round" },
      });
    }

    if (!map.getLayer("synced-paths-dots")) {
      map.addLayer({
        id: "synced-paths-dots",
        type: "line",
        source: "synced-paths",
        paint: {
          "line-color": "#e0f2fe",
          "line-width": 2.5,
          "line-dasharray": [0.15, 1.8],
          "line-opacity": 0.95,
        },
        layout: { "line-cap": "round", "line-join": "round" },
      });
    }

    if (!map.getLayer("frontier-endpoints-layer")) {
      map.addLayer({
        id: "frontier-endpoints-layer",
        type: "circle",
        source: "frontier-endpoints",
        paint: {
          "circle-radius": 6.5,
          "circle-color": "#082f49",
          "circle-stroke-width": 3,
          "circle-stroke-color": "#7dd3fc",
        },
      });
    }

    if (!map.getLayer("active-path-casing")) {
      map.addLayer({
        id: "active-path-casing",
        type: "line",
        source: "active-path",
        paint: {
          "line-color": "#022c22",
          "line-width": 8,
          "line-opacity": 0.85,
        },
        layout: { "line-cap": "round", "line-join": "round" },
      });
    }

    if (!map.getLayer("active-path-layer")) {
      map.addLayer({
        id: "active-path-layer",
        type: "line",
        source: "active-path",
        paint: {
          "line-color": "#34d399",
          "line-width": 4.5,
          "line-dasharray": [1.5, 1.5],
        },
        layout: { "line-cap": "round", "line-join": "round" },
      });
    }

    if (!map.getLayer("guide-line-layer")) {
      map.addLayer({
        id: "guide-line-layer",
        type: "line",
        source: "guide-line",
        paint: {
          "line-color": "#facc15",
          "line-width": 3,
          "line-dasharray": [1.5, 2],
        },
      });
    }

    if (!map.getLayer("junction-pins-pulse")) {
      map.addLayer({
        id: "junction-pins-pulse",
        type: "circle",
        source: "junction-pins",
        filter: ["==", ["get", "status"], "open"],
        paint: {
          "circle-radius": 14,
          "circle-color": "#f97316",
          "circle-opacity": 0.35,
        },
      });
    }

    if (!map.getLayer("junction-pins-layer")) {
      map.addLayer({
        id: "junction-pins-layer",
        type: "circle",
        source: "junction-pins",
        paint: {
          "circle-radius": 8,
          "circle-stroke-width": 2,
          "circle-stroke-color": "#ffffff",
          "circle-color": [
            "match",
            ["get", "status"],
            "open",
            "#f97316",
            "claimed",
            "#eab308",
            "#22c55e",
          ],
        },
      });
    }

    if (!map.getLayer("photo-pins-layer")) {
      map.addLayer({
        id: "photo-pins-layer",
        type: "circle",
        source: "photo-pins",
        paint: {
          "circle-radius": 6.5,
          "circle-color": "#38bdf8",
          "circle-stroke-width": 2,
          "circle-stroke-color": "#ffffff",
        },
      });
    }

    if (!map.getLayer("teammates-layer")) {
      map.addLayer({
        id: "teammates-layer",
        type: "circle",
        source: "teammates",
        paint: {
          "circle-radius": 7,
          "circle-color": "#a855f7",
          "circle-stroke-width": 2,
          "circle-stroke-color": "#ffffff",
        },
      });
    }

    if (!map.getLayer("user-pos-layer")) {
      map.addLayer({
        id: "user-pos-layer",
        type: "circle",
        source: "user-pos",
        paint: {
          "circle-radius": 8.5,
          "circle-color": "#0ea5e9",
          "circle-stroke-width": 3,
          "circle-stroke-color": "#ffffff",
        },
      });
    }

    syncAllSources(map);
  };

  useEffect(() => {
    if (!containerRef.current) return;
    maplibregl.setWorkerUrl("/maplibre-gl-worker.mjs");
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: SATELLITE_STYLE,
      center: focusCoord ?? ESUT_CENTER,
      zoom: 16.5,
      pitch: 0,
      attributionControl: false,
    });
    mapRef.current = map;

    map.on("load", () => ensureLayers(map));
    map.on("style.load", () => ensureLayers(map));
    map.on("click", (e) => {
      const pinHits = map.queryRenderedFeatures(e.point, {
        layers: ["junction-pins-layer"],
      });
      if (pinHits.length > 0) {
        const id = pinHits[0]?.properties?.id;
        if (id) callbacksRef.current.onSelectJunctionPin(id);
        return;
      }
      const photoHits = map.queryRenderedFeatures(e.point, {
        layers: ["photo-pins-layer"],
      });
      if (photoHits.length > 0) {
        const id = photoHits[0]?.properties?.id;
        if (id) callbacksRef.current.onSelectPhotoPin?.(id);
        return;
      }
      const frontierHits = map.queryRenderedFeatures(e.point, {
        layers: ["frontier-endpoints-layer"],
      });
      if (frontierHits.length > 0) {
        const id = frontierHits[0]?.properties?.id;
        if (id) callbacksRef.current.onSelectFrontier?.(id);
        return;
      }
      const pathHits = map.queryRenderedFeatures(e.point, {
        layers: ["synced-paths-layer", "synced-paths-casing"],
      });
      if (pathHits.length > 0) {
        const id = pathHits[0]?.properties?.id;
        if (id) callbacksRef.current.onSelectPath?.(id);
        return;
      }
      callbacksRef.current.onMapClick?.([e.lngLat.lng, e.lngLat.lat]);
    });

    let frameId: number;
    const animatePulse = (t: number) => {
      if (map.getLayer("junction-pins-pulse")) {
        map.setPaintProperty(
          "junction-pins-pulse",
          "circle-radius",
          10 + Math.sin(t / 300) * 6,
        );
        map.setPaintProperty(
          "junction-pins-pulse",
          "circle-opacity",
          0.45 - Math.sin(t / 300) * 0.25,
        );
      }
      frameId = requestAnimationFrame(animatePulse);
    };
    frameId = requestAnimationFrame(animatePulse);

    return () => {
      cancelAnimationFrame(frameId);
      map.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    callbacksRef.current = {
      onSelectJunctionPin,
      onSelectPhotoPin,
      onSelectPath,
      onSelectFrontier,
      onMapClick,
    };
  }, [
    onSelectJunctionPin,
    onSelectPhotoPin,
    onSelectPath,
    onSelectFrontier,
    onMapClick,
  ]);

  useEffect(() => {
    latestRef.current = {
      paths,
      activePath,
      frontierEndpoints,
      junctionPins,
      photoPins,
      teammates,
      userCoord,
      guideTarget,
    };
    const map = mapRef.current;
    if (map && map.isStyleLoaded()) syncAllSources(map);
  }, [
    paths,
    activePath,
    frontierEndpoints,
    junctionPins,
    photoPins,
    teammates,
    userCoord,
    guideTarget,
  ]);

  useEffect(() => {
    const map = mapRef.current;
    if (map && focusCoord) map.flyTo({ center: focusCoord, zoom: 18 });
  }, [focusCoord]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !userCoord || !isRecording) return;
    map.easeTo({
      center: userCoord,
      pitch: 45,
      bearing: heading ?? map.getBearing(),
      duration: 500,
    });
  }, [userCoord, heading, isRecording]);

  const toggleBaseMap = () => {
    const map = mapRef.current;
    if (!map) return;
    const nextSat = !isSatellite;
    setIsSatellite(nextSat);
    map.setStyle(nextSat ? SATELLITE_STYLE : STREETS_STYLE);
  };

  return (
    <div className="relative size-full">
      <div ref={containerRef} className="size-full" />
      <div
        role="toolbar"
        aria-label="Map view controls"
        className="absolute right-3 top-20 z-10 flex flex-col gap-1 rounded-2xl border border-slate-200/90 bg-white/95 p-1 shadow-lg backdrop-blur-md"
      >
        <button
          type="button"
          onClick={toggleBaseMap}
          aria-label={isSatellite ? "Switch to street map" : "Switch to satellite imagery"}
          className="flex items-center gap-2 rounded-xl px-2.5 py-2 text-xs font-semibold text-slate-800 transition-transform duration-150 ease-out hover:bg-slate-100 active:scale-95"
        >
          <svg
            className="size-4 text-sky-600"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <polygon points="12 2 2 7 12 12 22 7 12 2" />
            <polyline points="2 17 12 22 22 17" />
            <polyline points="2 12 12 17 22 12" />
          </svg>
          <span>{isSatellite ? "Streets" : "Satellite"}</span>
        </button>
        <div className="h-px bg-slate-200" />
        <button
          type="button"
          onClick={() =>
            mapRef.current?.flyTo({ center: ESUT_CENTER, zoom: 16.5, pitch: 0 })
          }
          aria-label="Center map on ESUT Agbani"
          className="flex items-center gap-2 rounded-xl px-2.5 py-2 text-xs font-semibold text-slate-700 transition-transform duration-150 ease-out hover:bg-slate-100 active:scale-95"
        >
          <svg
            className="size-4 text-slate-600"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <circle cx="12" cy="12" r="10" />
            <circle cx="12" cy="12" r="3" />
          </svg>
          <span>ESUT</span>
        </button>
        {userCoord && (
          <>
            <div className="h-px bg-slate-200" />
            <button
              type="button"
              onClick={() =>
                mapRef.current?.flyTo({ center: userCoord, zoom: 17.5 })
              }
              aria-label="Center map on my GPS position"
              className="flex items-center gap-2 rounded-xl px-2.5 py-2 text-xs font-semibold text-slate-700 transition-transform duration-150 ease-out hover:bg-slate-100 active:scale-95"
            >
              <svg
                className="size-4 text-sky-600"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <polygon points="3 11 22 2 13 21 11 13 3 11" />
              </svg>
              <span>Locate</span>
            </button>
          </>
        )}
      </div>
    </div>
  );
}
