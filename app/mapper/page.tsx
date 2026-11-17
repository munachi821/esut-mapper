'use client';

import React, { Suspense, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import dynamic from 'next/dynamic';
import { useSearchParams } from 'next/navigation';
import { createClient } from '@supabase/supabase-js';
import {
  calculatePathDistance,
  Coord,
  findTopologicalSnap,
  haversineMeters,
  processGpsPoint,
  suggestTurnLabel,
} from '@/lib/geoPipeline';
import { compressToWebP, playCadenceChime, unlockAudioContext } from '@/lib/mapperUtils';
import { enqueueOffline, getQueuedItems, QueuedItem, removeQueuedItem } from '@/lib/offlineQueue';
import type { MapJunctionPin, MapPhotoPin } from '@/components/MapperMap';

const MapperMap = dynamic(() => import('@/components/MapperMap'), { ssr: false });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''
);

const ZONES = [
  'Zone 1: Main Gate / Admin',
  'Zone 2: Engineering / ETF',
  'Zone 3: Sciences / SLT',
  'Zone 4: Library / Senate',
  'Zone 5: Hostels / Medical',
];

const QUICK_BUILDINGS = ['ETF', 'Senate', 'SLT', 'Library', 'Admin'];
const PHOTO_CATEGORIES = ['Cadence View', 'Building Entrance', 'Junction / Turn', 'Shortcut'] as const;
const CADENCE_TARGET_M = 20;

interface PathRecord {
  id: string;
  scout_name: string;
  zone: string;
  coordinates: Coord[];
  distance_m: number;
}

let cachedProfileRaw: string | null = null;
let cachedProfileObj: { name: string; zone: string } | null = null;

const subscribeProfile = (cb: () => void) => {
  window.addEventListener('storage', cb);
  window.addEventListener('esut-profile-updated', cb);
  return () => {
    window.removeEventListener('storage', cb);
    window.removeEventListener('esut-profile-updated', cb);
  };
};

const getProfileSnapshot = () => {
  const raw = localStorage.getItem('esut_scout_profile');
  if (raw !== cachedProfileRaw) {
    cachedProfileRaw = raw;
    try {
      cachedProfileObj = raw ? JSON.parse(raw) : null;
    } catch {
      cachedProfileObj = null;
    }
  }
  return cachedProfileObj;
};

const getProfileServerSnapshot = () => null;

function MapperScreen() {
  const searchParams = useSearchParams();

  const profile = useSyncExternalStore(subscribeProfile, getProfileSnapshot, getProfileServerSnapshot);
  const [nameInput, setNameInput] = useState('');
  const [zoneInput, setZoneInput] = useState(ZONES[1]);
  const [sessionReady, setSessionReady] = useState(false);

  const [userCoord, setUserCoord] = useState<Coord | null>(null);
  const [accuracy, setAccuracy] = useState<number | null>(null);
  const [heading, setHeading] = useState<number | null>(null);
  const userCoordRef = useRef<Coord | null>(null);
  const accuracyRef = useRef<number | null>(null);
  const headingRef = useRef<number | null>(null);

  const [recState, setRecState] = useState<'IDLE' | 'RECORDING' | 'PAUSED'>('IDLE');
  const recStateRef = useRef<'IDLE' | 'RECORDING' | 'PAUSED'>('IDLE');
  const [activePath, setActivePath] = useState<Coord[]>([]);
  const activePathRef = useRef<Coord[]>([]);
  const [pathDistance, setPathDistance] = useState(0);
  const lastTickTsRef = useRef<number | null>(null);
  const startSnapMetaRef = useRef<{ splitTargetPathId?: string; splitSegmentIdx?: number; splitCoord?: Coord }>({});

  const [cadenceMeters, setCadenceMeters] = useState(0);
  const [isSnapDue, setIsSnapDue] = useState(false);
  const anchorCoordRef = useRef<Coord | null>(null);
  const alertFiredRef = useRef(false);

  const [paths, setPaths] = useState<PathRecord[]>([]);
  const [junctionPins, setJunctionPins] = useState<MapJunctionPin[]>([]);
  const [photoPins, setPhotoPins] = useState<MapPhotoPin[]>([]);
  const [teammates, setTeammates] = useState<{ name: string; lng: number; lat: number }[]>([]);
  const [selectedPin, setSelectedPin] = useState<MapJunctionPin | null>(null);
  const [guidePin, setGuidePin] = useState<MapJunctionPin | null>(null);
  const [arrivedPin, setArrivedPin] = useState<MapJunctionPin | null>(null);
  const arrivedPinIdsRef = useRef<Set<string>>(new Set());
  const [focusCoord, setFocusCoord] = useState<Coord | null>(() => {
    const lat = parseFloat(searchParams.get('lat') ?? '');
    const lng = parseFloat(searchParams.get('lng') ?? '');
    return !Number.isNaN(lat) && !Number.isNaN(lng) ? [lng, lat] : null;
  });

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const frozenTelemetryRef = useRef<{ coord: Coord; accuracy: number | null; heading: number | null } | null>(null);
  const [frozenHeading, setFrozenHeading] = useState<number | null>(null);
  const [pendingBlob, setPendingBlob] = useState<Blob | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [photoCategory, setPhotoCategory] = useState<string>('Cadence View');
  const [photoLabel, setPhotoLabel] = useState('');
  const [isSavingPhoto, setIsSavingPhoto] = useState(false);

  const [queueCount, setQueueCount] = useState(0);
  const isFlushingRef = useRef(false);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const lastPresenceTsRef = useRef(0);

  useEffect(() => {
    const onVisibility = async () => {
      if (document.visibilityState === 'visible' && sessionReady) {
        try {
          await (navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<unknown> } }).wakeLock?.request('screen');
        } catch {
          /* ignore */
        }
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [sessionReady]);

  const flushQueue = useCallback(async () => {
    if (!navigator.onLine || isFlushingRef.current) return;
    isFlushingRef.current = true;
    try {
      const items = await getQueuedItems();
      for (const item of items) {
        try {
          await processQueuedItem(item);
          await removeQueuedItem(item.id);
        } catch {
          break;
        }
      }
      const left = await getQueuedItems();
      setQueueCount(left.length);
    } finally {
      isFlushingRef.current = false;
    }
  }, []);

  useEffect(() => {
    getQueuedItems().then((items) => setQueueCount(items.length));
    window.addEventListener('online', flushQueue);
    const interval = setInterval(flushQueue, 15000);
    return () => {
      window.removeEventListener('online', flushQueue);
      clearInterval(interval);
    };
  }, [flushQueue]);

  useEffect(() => {
    if (!profile) return;

    const hydrate = async () => {
      const [pRes, jRes, pinRes] = await Promise.all([
        supabase.from('paths').select('*'),
        supabase.from('junction_pins').select('*'),
        supabase.from('pins').select('*'),
      ]);
      if (pRes.data) setPaths(pRes.data);
      if (jRes.data) {
        setJunctionPins(jRes.data);
        const deepPinId = searchParams.get('pinId');
        const target = jRes.data.find((p: MapJunctionPin) => p.id === deepPinId);
        if (target) {
          setFocusCoord([target.lng, target.lat]);
          setSelectedPin(target);
        }
      }
      if (pinRes.data) setPhotoPins(pinRes.data);
    };
    hydrate();

    const channel = supabase
      .channel('campus-mapper-live', { config: { presence: { key: profile.name } } })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'paths' }, (payload) => {
        if (payload.eventType === 'INSERT') {
          setPaths((prev) => [...prev, payload.new as PathRecord]);
        } else if (payload.eventType === 'UPDATE') {
          setPaths((prev) => prev.map((p) => (p.id === (payload.new as PathRecord).id ? (payload.new as PathRecord) : p)));
        }
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'junction_pins' }, (payload) => {
        if (payload.eventType === 'INSERT') {
          setJunctionPins((prev) => [...prev, payload.new as MapJunctionPin]);
        } else if (payload.eventType === 'UPDATE') {
          setJunctionPins((prev) =>
            prev.map((p) => (p.id === (payload.new as MapJunctionPin).id ? (payload.new as MapJunctionPin) : p))
          );
        }
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'pins' }, (payload) => {
        setPhotoPins((prev) => [...prev, payload.new as MapPhotoPin]);
      })
      .on('presence', { event: 'sync' }, () => {
        const state = channel.presenceState() as Record<string, { name: string; lng?: number; lat?: number }[]>;
        const others: { name: string; lng: number; lat: number }[] = [];
        for (const [key, presences] of Object.entries(state)) {
          const latest = presences[0];
          if (key !== profile.name && latest?.lng && latest?.lat) {
            others.push({ name: key, lng: latest.lng, lat: latest.lat });
          }
        }
        setTeammates(others);
      })
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          await channel.track({ name: profile.name, zone: profile.zone });
        }
      });
    channelRef.current = channel;

    return () => {
      channelRef.current = null;
      supabase.removeChannel(channel);
    };
  }, [profile, searchParams]);

  const startHardwareSession = async (scoutProfile: { name: string; zone: string }) => {
    localStorage.setItem('esut_scout_profile', JSON.stringify(scoutProfile));
    window.dispatchEvent(new Event('esut-profile-updated'));
    unlockAudioContext();

    const DevOrient = DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<'granted' | 'denied'> };
    if (typeof DevOrient?.requestPermission === 'function') {
      try {
        await DevOrient.requestPermission();
      } catch {
        /* ignore */
      }
    }

    try {
      await (navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<unknown> } }).wakeLock?.request('screen');
    } catch {
      /* ignore */
    }

    const onOrientation = (e: DeviceOrientationEvent) => {
      const wk = (e as DeviceOrientationEvent & { webkitCompassHeading?: number }).webkitCompassHeading;
      const deg = typeof wk === 'number' ? Math.round(wk) : e.alpha !== null ? Math.round((360 - e.alpha) % 360) : null;
      if (deg !== null) {
        headingRef.current = deg;
        setHeading(deg);
      }
    };
    window.addEventListener('deviceorientationabsolute' as keyof WindowEventMap, onOrientation as EventListener);
    window.addEventListener('deviceorientation', onOrientation);

    if ('geolocation' in navigator) {
      navigator.geolocation.watchPosition(
        (pos) => {
          const coord: Coord = [pos.coords.longitude, pos.coords.latitude];
          const acc = Math.round(pos.coords.accuracy);
          userCoordRef.current = coord;
          accuracyRef.current = acc;
          setUserCoord(coord);
          setAccuracy(acc);

          const nowMs = Date.now();
          if (nowMs - lastPresenceTsRef.current >= 2000) {
            lastPresenceTsRef.current = nowMs;
            channelRef.current?.track({ name: scoutProfile.name, zone: scoutProfile.zone, lng: coord[0], lat: coord[1] });
          }

          if (acc > 15) return;

          setGuidePin((currentGuide) => {
            if (currentGuide && !arrivedPinIdsRef.current.has(currentGuide.id)) {
              const dist = haversineMeters(coord, [currentGuide.lng, currentGuide.lat]);
              if (dist <= 5) {
                arrivedPinIdsRef.current.add(currentGuide.id);
                navigator.vibrate?.([200, 100, 200]);
                setArrivedPin(currentGuide);
                return null;
              }
            }
            return currentGuide;
          });

          if (recStateRef.current === 'RECORDING') {
            const res = processGpsPoint({
              incoming: coord,
              accuracy: acc,
              timestamp: pos.timestamp,
              lastTimestamp: lastTickTsRef.current,
              activePath: activePathRef.current,
            });

            if (res.accepted) {
              lastTickTsRef.current = pos.timestamp;
              activePathRef.current = res.nextPath;
              setActivePath(res.nextPath);
              setPathDistance(calculatePathDistance(res.nextPath));

              if (anchorCoordRef.current) {
                const cDist = Math.round(haversineMeters(anchorCoordRef.current, coord));
                setCadenceMeters(Math.min(CADENCE_TARGET_M, cDist));
                if (cDist >= CADENCE_TARGET_M && !alertFiredRef.current) {
                  alertFiredRef.current = true;
                  setIsSnapDue(true);
                  navigator.vibrate?.([200, 100, 200]);
                  playCadenceChime();
                }
              }
            }
          }
        },
        (err) => console.warn(err.message),
        { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
      );
    }

    setSessionReady(true);
  };

  const handleStartPath = (overrideStart?: Coord) => {
    const base = overrideStart ?? userCoordRef.current;
    if (!base) return alert('Waiting for GPS lock...');

    const snap = findTopologicalSnap(base, junctionPins, paths, 6);
    startSnapMetaRef.current = snap.splitTargetPathId
      ? { splitTargetPathId: snap.splitTargetPathId, splitSegmentIdx: snap.splitSegmentIdx, splitCoord: snap.coord }
      : {};

    activePathRef.current = [snap.coord];
    setActivePath([snap.coord]);
    setPathDistance(0);
    anchorCoordRef.current = snap.coord;
    alertFiredRef.current = false;
    setIsSnapDue(false);
    setCadenceMeters(0);
    recStateRef.current = 'RECORDING';
    setRecState('RECORDING');
  };

  const handleStopAndSavePath = async () => {
    recStateRef.current = 'IDLE';
    setRecState('IDLE');
    const raw = activePathRef.current;
    activePathRef.current = [];
    setActivePath([]);

    if (raw.length < 2 || !profile) return;

    const endSnap = findTopologicalSnap(raw[raw.length - 1], junctionPins, paths, 6);
    const finalCoords = endSnap.snapped ? [...raw.slice(0, -1), endSnap.coord] : raw;
    const dist = calculatePathDistance(finalCoords);

    const payload = {
      scout_name: profile.name,
      zone: profile.zone,
      coordinates: finalCoords,
      distance_m: dist,
      split_path_id: startSnapMetaRef.current.splitTargetPathId ?? null,
      split_segment_idx: startSnapMetaRef.current.splitSegmentIdx ?? null,
      split_coord: startSnapMetaRef.current.splitCoord ?? null,
    };

    try {
      const { error } = await supabase.rpc('save_path_with_split', {
        p_scout_name: payload.scout_name,
        p_zone: payload.zone,
        p_coordinates: payload.coordinates,
        p_distance_m: payload.distance_m,
        p_split_path_id: payload.split_path_id,
        p_split_segment_idx: payload.split_segment_idx,
        p_split_coord: payload.split_coord,
      });
      if (error) throw error;
    } catch {
      await enqueueOffline({ id: crypto.randomUUID(), type: 'path', createdAt: Date.now(), payload });
      setQueueCount((c) => c + 1);
    }
  };

  const handleUndoLast3 = () => {
    const next = activePathRef.current.length > 3 ? activePathRef.current.slice(0, -3) : activePathRef.current.slice(0, 1);
    activePathRef.current = next;
    setActivePath(next);
    setPathDistance(calculatePathDistance(next));
  };

  const handleTapSnap = () => {
    const coord = userCoordRef.current;
    if (!coord) return alert('Waiting for GPS lock...');
    frozenTelemetryRef.current = { coord, accuracy: accuracyRef.current, heading: headingRef.current };
    setFrozenHeading(headingRef.current);
    setPhotoCategory(isSnapDue ? 'Cadence View' : 'Building Entrance');
    setPhotoLabel(suggestTurnLabel(activePathRef.current));
    fileInputRef.current?.click();
  };

  const handlePhotoFilePicked = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) {
      frozenTelemetryRef.current = null;
      setFrozenHeading(null);
      return;
    }
    const blob = await compressToWebP(file, 1080, 0.75);
    setPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(blob);
    });
    setPendingBlob(blob);
  };

  const handleSavePhotoPin = async () => {
    if (!pendingBlob || !frozenTelemetryRef.current || !profile) return;
    setIsSavingPhoto(true);
    const { coord, accuracy: acc, heading: hdg } = frozenTelemetryRef.current;

    const payload = {
      lat: coord[1],
      lng: coord[0],
      accuracy: acc,
      heading: hdg,
      category: photoCategory,
      label: photoLabel.trim(),
      scout_name: profile.name,
      zone: profile.zone,
    };

    try {
      await uploadPhotoRecord(pendingBlob, payload);
    } catch {
      await enqueueOffline({ id: crypto.randomUUID(), type: 'photo', createdAt: Date.now(), blob: pendingBlob, payload });
      setQueueCount((c) => c + 1);
    } finally {
      anchorCoordRef.current = coord;
      alertFiredRef.current = false;
      setCadenceMeters(0);
      setIsSnapDue(false);
      frozenTelemetryRef.current = null;
      setFrozenHeading(null);
      setPreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
      setPendingBlob(null);
      setIsSavingPhoto(false);
    }
  };

  const handleFlagBranch = async () => {
    const coord =
      recStateRef.current !== 'IDLE' && activePathRef.current.length > 0
        ? activePathRef.current[activePathRef.current.length - 1]
        : userCoordRef.current;
    if (!coord || !profile) return alert('Waiting for GPS lock...');
    navigator.vibrate?.(60);

    const payload = { lat: coord[1], lng: coord[0], created_by: profile.name };
    try {
      const { data, error } = await supabase.from('junction_pins').insert(payload).select().single();
      if (error) throw error;
      if (data) {
        const link = `${window.location.origin}/mapper?pinId=${data.id}&lat=${data.lat}&lng=${data.lng}`;
        navigator.clipboard?.writeText(link).catch(() => {});
      }
    } catch {
      await enqueueOffline({ id: crypto.randomUUID(), type: 'pin', createdAt: Date.now(), payload });
      setQueueCount((c) => c + 1);
    }
  };

  const handleClaimPin = async (pin: MapJunctionPin) => {
    if (!profile) return;
    await supabase.from('junction_pins').update({ status: 'claimed', claimed_by: profile.name }).eq('id', pin.id);
    setGuidePin(pin);
    setSelectedPin(null);
  };

  const handleExportGeoJSON = () => {
    const fc = {
      type: 'FeatureCollection',
      features: [
        ...paths.map((p) => ({
          type: 'Feature',
          properties: { type: 'path', scout: p.scout_name, zone: p.zone, distance_m: p.distance_m },
          geometry: { type: 'LineString', coordinates: p.coordinates },
        })),
        ...photoPins.map((ph) => ({
          type: 'Feature',
          properties: { type: 'pin', category: ph.category, label: ph.label, heading: ph.heading },
          geometry: { type: 'Point', coordinates: [ph.lng, ph.lat] },
        })),
      ],
    };
    const blob = new Blob([JSON.stringify(fc, null, 2)], { type: 'application/geo+json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `esut-agbani-${new Date().toISOString().slice(0, 10)}.geojson`;
    a.click();
  };

  const gpsBad = accuracy === null || accuracy > 15;

  return (
    <div className="flex h-[100dvh] w-screen flex-col overflow-hidden bg-slate-950 text-white select-none">
      {(!profile || !sessionReady) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/95 p-5">
          <div className="w-full max-w-sm rounded-3xl border border-slate-800 bg-slate-900 p-6 shadow-2xl">
            <h1 className="mb-1 text-xl font-bold">ESUT Campus Mapper</h1>
            <p className="mb-4 text-xs text-slate-400">
              {profile
                ? `Welcome back, ${profile.name}. Tap below to enable GPS, Compass & Wake Lock.`
                : 'Enter your scout name and assigned ESUT Agbani zone.'}
            </p>
            {!profile && (
              <>
                <input
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  placeholder="Your Name (e.g., Munachi)"
                  className="mb-3 w-full rounded-xl bg-slate-800 px-3 py-3 text-sm outline-none ring-1 ring-slate-700 focus:ring-emerald-500"
                />
                <select
                  value={zoneInput}
                  onChange={(e) => setZoneInput(e.target.value)}
                  className="mb-4 w-full rounded-xl bg-slate-800 px-3 py-3 text-sm outline-none ring-1 ring-slate-700"
                >
                  {ZONES.map((z) => (
                    <option key={z} value={z}>
                      {z}
                    </option>
                  ))}
                </select>
              </>
            )}
            <button
              onClick={() => {
                const p = profile ?? { name: nameInput.trim() || 'Scout', zone: zoneInput };
                startHardwareSession(p);
              }}
              className="w-full rounded-2xl bg-emerald-600 py-3.5 text-sm font-bold text-white active:scale-95"
            >
              Start Mapping Session
            </button>
          </div>
        </div>
      )}

      <header className="flex h-[56px] shrink-0 items-center justify-between border-b border-slate-800 bg-slate-900/90 px-3 backdrop-blur">
        <div className="flex items-center gap-1.5">
          <span className="rounded-lg bg-slate-800 px-2 py-1 text-[11px] font-bold">
            {profile?.zone.split(':')[0] ?? 'Zone'} • {profile?.name ?? 'Scout'}
          </span>
          <span
            className={`rounded-lg px-2 py-1 text-[11px] font-bold ${
              gpsBad ? 'bg-red-500/20 text-red-400' : 'bg-emerald-500/20 text-emerald-400'
            }`}
          >
            ● {accuracy !== null ? `±${accuracy}m` : 'No GPS'}
          </span>
        </div>

        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
            queueCount > 0 ? 'bg-amber-500/20 text-amber-300' : 'bg-emerald-500/15 text-emerald-400'
          }`}
        >
          {queueCount > 0 ? `● ${queueCount} Pending` : 'Synced ✓'}
        </span>

        <div className="flex items-center gap-1.5">
          <div className="flex -space-x-1">
            {teammates.slice(0, 3).map((t) => (
              <span
                key={t.name}
                className="flex h-6 w-6 items-center justify-center rounded-full border border-slate-900 bg-purple-600 text-[10px] font-bold"
              >
                {t.name[0]}
              </span>
            ))}
          </div>
          <button
            onClick={handleExportGeoJSON}
            className="rounded-lg bg-slate-800 px-2 py-1 text-[11px] font-bold hover:bg-slate-700"
          >
            .geojson
          </button>
        </div>
      </header>

      <main className="relative flex-1">
        <MapperMap
          paths={paths}
          activePath={activePath}
          junctionPins={junctionPins}
          photoPins={photoPins}
          teammates={teammates}
          userCoord={userCoord}
          heading={heading}
          isRecording={recState === 'RECORDING'}
          guideTarget={guidePin ? [guidePin.lng, guidePin.lat] : null}
          focusCoord={focusCoord}
          onSelectJunctionPin={(id) => {
            const found = junctionPins.find((p) => p.id === id);
            if (found) setSelectedPin(found);
          }}
        />

        {recState !== 'IDLE' && (
          <button
            onClick={handleUndoLast3}
            className="absolute left-3 top-3 z-10 rounded-xl bg-slate-900/90 px-3 py-2 text-xs font-bold shadow-lg ring-1 ring-slate-700"
          >
            ↩ Undo 3 pts
          </button>
        )}
      </main>

      <footer className="flex h-[180px] shrink-0 flex-col justify-between border-t border-slate-800 bg-slate-900 px-3 pb-4 pt-3">
        <div>
          <div className="mb-1.5 flex justify-between text-xs font-semibold">
            <span className={isSnapDue ? 'animate-pulse text-emerald-400' : 'text-slate-300'}>
              {isSnapDue ? '📸 SNAP NOW (20m reached)' : `${cadenceMeters}m / ${CADENCE_TARGET_M}m to next photo`}
            </span>
            <span className="text-sky-400">{pathDistance}m recorded</span>
          </div>
          <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-800">
            <div
              className={`h-full transition-all duration-300 ${isSnapDue ? 'animate-pulse bg-emerald-400' : 'bg-sky-500'}`}
              style={{ width: `${Math.min(100, (cadenceMeters / CADENCE_TARGET_M) * 100)}%` }}
            />
          </div>
        </div>

        <div className="flex h-20 gap-2">
          {recState === 'IDLE' ? (
            <button
              onClick={() => handleStartPath()}
              className="w-[40%] rounded-2xl bg-emerald-600 text-sm font-bold text-white shadow-lg active:scale-95"
            >
              ▶ Start Path
            </button>
          ) : (
            <div className="flex w-[40%] gap-1.5">
              <button
                onClick={() => {
                  const next = recState === 'RECORDING' ? 'PAUSED' : 'RECORDING';
                  recStateRef.current = next;
                  setRecState(next);
                }}
                className="flex-1 rounded-2xl bg-amber-500 text-xs font-bold text-slate-950 active:scale-95"
              >
                {recState === 'RECORDING' ? '⏸ Pause' : '▶ Resume'}
              </button>
              <button
                onClick={handleStopAndSavePath}
                className="flex-1 rounded-2xl bg-rose-600 text-xs font-bold text-white active:scale-95"
              >
                ⏹ Save
              </button>
            </div>
          )}

          <button
            onClick={handleTapSnap}
            className={`w-[35%] rounded-2xl text-sm font-bold text-white shadow-lg active:scale-95 ${
              isSnapDue ? 'animate-pulse bg-emerald-500' : 'bg-sky-600'
            }`}
          >
            📷 Snap
          </button>

          <button
            onClick={handleFlagBranch}
            className="w-[25%] rounded-2xl bg-orange-600 text-sm font-bold text-white shadow-lg active:scale-95"
          >
            🚩 Branch
          </button>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={handlePhotoFilePicked}
        />
      </footer>

      {pendingBlob && (
        <div className="fixed inset-0 z-50 flex items-end bg-black/60">
          <div className="w-full rounded-t-3xl bg-slate-900 p-4 pb-6">
            <h3 className="mb-3 text-base font-bold">
              Tag Photo ({frozenHeading ?? '--'}°)
            </h3>
            {previewUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={previewUrl} alt="Captured preview" className="mb-3 h-28 w-full rounded-xl object-cover" />
            )}
            <div className="mb-3 grid grid-cols-2 gap-2">
              {PHOTO_CATEGORIES.map((cat) => (
                <button
                  key={cat}
                  onClick={() => setPhotoCategory(cat)}
                  className={`rounded-xl px-3 py-2.5 text-xs font-semibold ${
                    photoCategory === cat ? 'bg-sky-600 text-white' : 'bg-slate-800 text-slate-300'
                  }`}
                >
                  {cat}
                </button>
              ))}
            </div>
            {photoCategory === 'Building Entrance' && (
              <div className="mb-2 flex flex-wrap gap-1.5">
                {QUICK_BUILDINGS.map((b) => (
                  <button
                    key={b}
                    onClick={() => setPhotoLabel(b)}
                    className="rounded-lg bg-slate-800 px-2.5 py-1 text-xs text-slate-300"
                  >
                    + {b}
                  </button>
                ))}
              </div>
            )}
            <input
              value={photoLabel}
              onChange={(e) => setPhotoLabel(e.target.value)}
              placeholder="Building / Turn label..."
              className="mb-4 w-full rounded-xl bg-slate-800 px-3 py-3 text-sm outline-none ring-1 ring-slate-700"
            />
            <div className="flex gap-2">
              <button
                onClick={() => {
                  setPendingBlob(null);
                  frozenTelemetryRef.current = null;
                  setFrozenHeading(null);
                  setPreviewUrl((prev) => {
                    if (prev) URL.revokeObjectURL(prev);
                    return null;
                  });
                }}
                className="flex-1 rounded-xl bg-slate-800 py-3 text-sm font-bold"
              >
                Cancel
              </button>
              <button
                disabled={isSavingPhoto}
                onClick={handleSavePhotoPin}
                className="flex-[2] rounded-xl bg-emerald-600 py-3 text-sm font-bold"
              >
                {isSavingPhoto ? 'Saving...' : 'Save Pin'}
              </button>
            </div>
          </div>
        </div>
      )}

      {selectedPin && (
        <div className="fixed inset-0 z-50 flex items-end bg-black/50" onClick={() => setSelectedPin(null)}>
          <div className="w-full rounded-t-3xl bg-slate-900 p-4 pb-6" onClick={(e) => e.stopPropagation()}>
            <p className="text-sm font-bold">Flagged by {selectedPin.created_by}</p>
            <p className="mb-4 text-xs text-slate-400">
              {userCoord
                ? `${Math.round(haversineMeters(userCoord, [selectedPin.lng, selectedPin.lat]))}m away`
                : 'Distance unknown'}{' '}
              • Status: {selectedPin.status}
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => handleClaimPin(selectedPin)}
                className="flex-1 rounded-xl bg-amber-500 py-3 text-sm font-bold text-slate-950"
              >
                Claim & Guide Me
              </button>
              <button
                onClick={() => {
                  navigator.clipboard?.writeText(
                    `${window.location.origin}/mapper?pinId=${selectedPin.id}&lat=${selectedPin.lat}&lng=${selectedPin.lng}`
                  );
                  setSelectedPin(null);
                }}
                className="flex-1 rounded-xl bg-slate-800 py-3 text-sm font-bold"
              >
                Copy Link
              </button>
            </div>
          </div>
        </div>
      )}

      {arrivedPin && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-5">
          <div className="w-full max-w-sm rounded-3xl bg-slate-900 p-5 text-center">
            <p className="mb-1 text-base font-bold text-emerald-400">Arrived at Shortcut!</p>
            <p className="mb-4 text-xs text-slate-300">Start recording from this exact junction?</p>
            <button
              onClick={async () => {
                const pin = arrivedPin;
                setArrivedPin(null);
                await supabase.from('junction_pins').update({ status: 'done' }).eq('id', pin.id);
                handleStartPath([pin.lng, pin.lat]);
              }}
              className="w-full rounded-2xl bg-emerald-600 py-3 text-sm font-bold"
            >
              Start Recording Here
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function MapperPage() {
  return (
    <Suspense fallback={<div className="flex h-[100dvh] items-center justify-center bg-slate-950 text-white">Loading Mapper...</div>}>
      <MapperScreen />
    </Suspense>
  );
}

async function uploadPhotoRecord(
  blob: Blob,
  payload: Extract<QueuedItem, { type: 'photo' }>['payload']
) {
  const safeZone = payload.zone.split(':')[0].replace(/\s+/g, '-').toLowerCase();
  const path = `${safeZone}/${Date.now()}_${payload.scout_name}.webp`;
  const { error: upErr } = await supabase.storage
    .from('campus-photos')
    .upload(path, blob, { contentType: 'image/webp' });
  if (upErr) throw upErr;

  const { data } = supabase.storage.from('campus-photos').getPublicUrl(path);
  const { error: dbErr } = await supabase.from('pins').insert({ ...payload, image_url: data.publicUrl });
  if (dbErr) throw dbErr;
}

async function processQueuedItem(item: QueuedItem) {
  if (item.type === 'path') {
    const { error } = await supabase.rpc('save_path_with_split', {
      p_scout_name: item.payload.scout_name,
      p_zone: item.payload.zone,
      p_coordinates: item.payload.coordinates,
      p_distance_m: item.payload.distance_m,
      p_split_path_id: item.payload.split_path_id ?? null,
      p_split_segment_idx: item.payload.split_segment_idx ?? null,
      p_split_coord: item.payload.split_coord ?? null,
    });
    if (error) throw error;
  } else if (item.type === 'pin') {
    const { error } = await supabase.from('junction_pins').insert(item.payload);
    if (error) throw error;
  } else if (item.type === 'photo') {
    await uploadPhotoRecord(item.blob, item.payload);
  }
}
