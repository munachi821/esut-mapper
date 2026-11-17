'use client';

import React, { useEffect, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Coord } from '@/lib/geoPipeline';

const ESUT_CENTER: Coord = [7.54, 6.307];

const SATELLITE_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    esri: {
      type: 'raster',
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      tileSize: 256,
      maxzoom: 19,
    },
    labels: {
      type: 'raster',
      tiles: ['https://a.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}.png'],
      tileSize: 256,
      maxzoom: 19,
    },
  },
  layers: [
    { id: 'esri-sat', type: 'raster', source: 'esri' },
    { id: 'carto-labels', type: 'raster', source: 'labels' },
  ],
};

const STREETS_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: [
        'https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png',
        'https://b.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png',
        'https://c.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png',
      ],
      tileSize: 256,
      maxzoom: 19,
    },
  },
  layers: [{ id: 'osm-streets', type: 'raster', source: 'osm' }],
};

export interface MapJunctionPin {
  id: string;
  lng: number;
  lat: number;
  status: 'open' | 'claimed' | 'done';
  created_by: string;
  claimed_by: string | null;
}

export interface MapPhotoPin {
  id: string;
  lng: number;
  lat: number;
  category: string;
  label: string | null;
  heading: number | null;
  image_url: string;
}

interface MapperMapProps {
  paths: { id: string; coordinates: Coord[] }[];
  activePath: Coord[];
  junctionPins: MapJunctionPin[];
  photoPins: MapPhotoPin[];
  teammates: { name: string; lng: number; lat: number }[];
  userCoord: Coord | null;
  heading: number | null;
  isRecording: boolean;
  guideTarget: Coord | null;
  focusCoord: Coord | null;
  onSelectJunctionPin: (pinId: string) => void;
}

export default function MapperMap({
  paths,
  activePath,
  junctionPins,
  photoPins,
  teammates,
  userCoord,
  heading,
  isRecording,
  guideTarget,
  focusCoord,
  onSelectJunctionPin,
}: MapperMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [isSatellite, setIsSatellite] = useState(true);

  const latestRef = useRef({ paths, activePath, junctionPins, photoPins, teammates, userCoord, guideTarget });

  const syncAllSources = (map: maplibregl.Map) => {
    const d = latestRef.current;

    (map.getSource('synced-paths') as maplibregl.GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features: d.paths.map((p) => ({
        type: 'Feature',
        properties: { id: p.id },
        geometry: { type: 'LineString', coordinates: p.coordinates },
      })),
    });

    (map.getSource('active-path') as maplibregl.GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features:
        d.activePath.length >= 2
          ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: d.activePath } }]
          : [],
    });

    (map.getSource('guide-line') as maplibregl.GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features:
        d.userCoord && d.guideTarget
          ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [d.userCoord, d.guideTarget] } }]
          : [],
    });

    (map.getSource('junction-pins') as maplibregl.GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features: d.junctionPins.map((pin) => ({
        type: 'Feature',
        properties: { id: pin.id, status: pin.status },
        geometry: { type: 'Point', coordinates: [pin.lng, pin.lat] },
      })),
    });

    (map.getSource('photo-pins') as maplibregl.GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features: d.photoPins.map((p) => ({
        type: 'Feature',
        properties: { id: p.id },
        geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
      })),
    });

    (map.getSource('teammates') as maplibregl.GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features: d.teammates.map((t) => ({
        type: 'Feature',
        properties: { name: t.name },
        geometry: { type: 'Point', coordinates: [t.lng, t.lat] },
      })),
    });

    (map.getSource('user-pos') as maplibregl.GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features: d.userCoord
        ? [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: d.userCoord } }]
        : [],
    });
  };

  const ensureLayers = (map: maplibregl.Map) => {
    const emptyFC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
    ['synced-paths', 'active-path', 'guide-line', 'junction-pins', 'photo-pins', 'teammates', 'user-pos'].forEach(
      (id) => {
        if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: emptyFC });
      }
    );

    if (!map.getLayer('synced-paths-layer')) {
      map.addLayer({
        id: 'synced-paths-layer',
        type: 'line',
        source: 'synced-paths',
        paint: { 'line-color': '#22c55e', 'line-width': 4, 'line-opacity': 0.9 },
        layout: { 'line-cap': 'round', 'line-join': 'round' },
      });
    }

    if (!map.getLayer('active-path-layer')) {
      map.addLayer({
        id: 'active-path-layer',
        type: 'line',
        source: 'active-path',
        paint: { 'line-color': '#22d3ee', 'line-width': 4.5, 'line-dasharray': [2, 1.5] },
      });
    }

    if (!map.getLayer('guide-line-layer')) {
      map.addLayer({
        id: 'guide-line-layer',
        type: 'line',
        source: 'guide-line',
        paint: { 'line-color': '#facc15', 'line-width': 3, 'line-dasharray': [1.5, 2] },
      });
    }

    if (!map.getLayer('junction-pins-pulse')) {
      map.addLayer({
        id: 'junction-pins-pulse',
        type: 'circle',
        source: 'junction-pins',
        filter: ['==', ['get', 'status'], 'open'],
        paint: { 'circle-radius': 14, 'circle-color': '#f97316', 'circle-opacity': 0.35 },
      });
    }

    if (!map.getLayer('junction-pins-layer')) {
      map.addLayer({
        id: 'junction-pins-layer',
        type: 'circle',
        source: 'junction-pins',
        paint: {
          'circle-radius': 8,
          'circle-stroke-width': 2,
          'circle-stroke-color': '#ffffff',
          'circle-color': ['match', ['get', 'status'], 'open', '#f97316', 'claimed', '#eab308', '#22c55e'],
        },
      });
    }

    if (!map.getLayer('photo-pins-layer')) {
      map.addLayer({
        id: 'photo-pins-layer',
        type: 'circle',
        source: 'photo-pins',
        paint: {
          'circle-radius': 5.5,
          'circle-color': '#3b82f6',
          'circle-stroke-width': 1.5,
          'circle-stroke-color': '#ffffff',
        },
      });
    }

    if (!map.getLayer('teammates-layer')) {
      map.addLayer({
        id: 'teammates-layer',
        type: 'circle',
        source: 'teammates',
        paint: {
          'circle-radius': 7,
          'circle-color': '#a855f7',
          'circle-stroke-width': 2,
          'circle-stroke-color': '#ffffff',
        },
      });
    }

    if (!map.getLayer('user-pos-layer')) {
      map.addLayer({
        id: 'user-pos-layer',
        type: 'circle',
        source: 'user-pos',
        paint: {
          'circle-radius': 8.5,
          'circle-color': '#0ea5e9',
          'circle-stroke-width': 3,
          'circle-stroke-color': '#ffffff',
        },
      });
    }

    syncAllSources(map);
  };

  useEffect(() => {
    if (!containerRef.current) return;
    maplibregl.setWorkerUrl('/maplibre-gl-worker.mjs');
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: SATELLITE_STYLE,
      center: focusCoord ?? ESUT_CENTER,
      zoom: 17.5,
      pitch: 0,
    });
    mapRef.current = map;

    map.on('load', () => ensureLayers(map));
    map.on('style.load', () => ensureLayers(map));
    map.on('click', 'junction-pins-layer', (e) => {
      const id = e.features?.[0]?.properties?.id;
      if (id) onSelectJunctionPin(id);
    });

    let frameId: number;
    const animatePulse = (t: number) => {
      if (map.getLayer('junction-pins-pulse')) {
        map.setPaintProperty('junction-pins-pulse', 'circle-radius', 10 + Math.sin(t / 300) * 6);
        map.setPaintProperty('junction-pins-pulse', 'circle-opacity', 0.45 - Math.sin(t / 300) * 0.25);
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
    latestRef.current = { paths, activePath, junctionPins, photoPins, teammates, userCoord, guideTarget };
    const map = mapRef.current;
    if (map && map.isStyleLoaded()) syncAllSources(map);
  }, [paths, activePath, junctionPins, photoPins, teammates, userCoord, guideTarget]);

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
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" />
      <button
        onClick={toggleBaseMap}
        className="absolute right-3 top-3 z-10 rounded-xl bg-slate-900/90 px-3 py-2 text-xs font-bold text-white shadow-lg ring-1 ring-slate-700"
      >
        {isSatellite ? '🗺️ Streets' : '🛰️ Satellite'}
      </button>
    </div>
  );
}
