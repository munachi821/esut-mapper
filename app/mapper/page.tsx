'use client';

import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import dynamic from 'next/dynamic';
import { useSearchParams } from 'next/navigation';
import { createClient } from '@supabase/supabase-js';
import {
  calculatePathDistance,
  computePathOverlapRatio,
  Coord,
  findFrontierEndpoints,
  findTopologicalSnap,
  FrontierEndpoint,
  haversineMeters,
  isPointNearExistingPaths,
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

const QUICK_BUILDINGS = [
  'ETF',
  'Senate',
  'SLT',
  'Library',
  'Admin',
  'Engineering',
  'Law',
  'Medical',
  'Hostels',
  'Main Gate',
  'Cafeteria',
];

const QUICK_PATH_NAMES = [
  'Main Road',
  'Footpath',
  'Shortcut',
  'Covered Walkway',
  'Stairs',
  'ETF Area',
  'Senate Area',
  'SLT Area',
  'Hostels Area',
];

const QUICK_BRANCH_NOTES = [
  'Shortcut',
  'Unmapped Footpath',
  'Side Gate',
  'Stairs',
  'Towards ETF',
  'Towards Hostels',
  'Towards SLT',
];

const PHOTO_CATEGORIES = ['Cadence View', 'Building Entrance', 'Junction / Turn', 'Shortcut'] as const;
const CADENCE_TARGET_M = 50;
const ESUT_CENTER: Coord = [7.5375, 6.3052];
const ACTIVE_WALK_DRAFT_KEY = 'esut_active_walk_draft';

interface WalkDraft {
  activePath: Coord[];
  startSnapMeta: { splitTargetPathId?: string; splitSegmentIdx?: number; splitCoord?: Coord };
  anchorCoord: Coord | null;
  savedAt: number;
}

interface PathRecord {
  id: string;
  scout_name: string;
  zone: string;
  name?: string | null;
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
const subscribeNoop = () => () => {};
const getIsLocalhost = () =>
  typeof window !== 'undefined' &&
  (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
const getIsLocalhostServer = () => false;

function MapperScreen() {
  const searchParams = useSearchParams();
  const isLocalhost = useSyncExternalStore(subscribeNoop, getIsLocalhost, getIsLocalhostServer);
  const showSimButton = isLocalhost || searchParams.get('sim') === '1';

  const profile = useSyncExternalStore(subscribeProfile, getProfileSnapshot, getProfileServerSnapshot);
  const [nameInput, setNameInput] = useState('');
  const [zoneInput, setZoneInput] = useState(ZONES[1]);
  const [sessionReady, setSessionReady] = useState(false);
  const [isZonePickerOpen, setIsZonePickerOpen] = useState(false);
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

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

  const [pendingPathSave, setPendingPathSave] = useState<{
    coords: Coord[];
    distance: number;
    overlapRatio: number;
    endSnapMeta: { splitTargetPathId?: string; splitSegmentIdx?: number; splitCoord?: Coord };
  } | null>(null);
  const [pathNameInput, setPathNameInput] = useState('');
  const [isSavingPath, setIsSavingPath] = useState(false);

  const [isOverlappingPath, setIsOverlappingPath] = useState(false);
  const overlapStreakRef = useRef(0);
  const [recoveredDraft, setRecoveredDraft] = useState<WalkDraft | null>(null);
  const [pauseJumpPrompt, setPauseJumpPrompt] = useState<{ distance: number } | null>(null);

  const [isBranchModalOpen, setIsBranchModalOpen] = useState(false);
  const [branchCoord, setBranchCoord] = useState<Coord | null>(null);
  const [branchNoteInput, setBranchNoteInput] = useState('Shortcut');
  const [isSavingBranch, setIsSavingBranch] = useState(false);

  const [cadenceMeters, setCadenceMeters] = useState(0);
  const [isSnapDue, setIsSnapDue] = useState(false);
  const anchorCoordRef = useRef<Coord | null>(null);
  const alertFiredRef = useRef(false);

  const [paths, setPaths] = useState<PathRecord[]>([]);
  const pathsRef = useRef<PathRecord[]>([]);
  const [junctionPins, setJunctionPins] = useState<MapJunctionPin[]>([]);
  const [photoPins, setPhotoPins] = useState<MapPhotoPin[]>([]);
  const [teammates, setTeammates] = useState<{ name: string; lng: number; lat: number }[]>([]);
  const [selectedPin, setSelectedPin] = useState<MapJunctionPin | null>(null);
  const [selectedPhotoPin, setSelectedPhotoPin] = useState<MapPhotoPin | null>(null);
  const [selectedPath, setSelectedPath] = useState<PathRecord | null>(null);
  const [selectedFrontier, setSelectedFrontier] = useState<FrontierEndpoint | null>(null);
  const [guidePin, setGuidePin] = useState<MapJunctionPin | null>(null);
  const [guideFrontier, setGuideFrontier] = useState<{ coord: Coord; label: string } | null>(null);
  const [arrivedPin, setArrivedPin] = useState<MapJunctionPin | null>(null);
  const [arrivedFrontier, setArrivedFrontier] = useState<{ coord: Coord; label: string } | null>(null);
  const arrivedPinIdsRef = useRef<Set<string>>(new Set());
  const hasAbsoluteOrientationRef = useRef(false);
  const [focusCoord, setFocusCoord] = useState<Coord | null>(() => {
    const lat = parseFloat(searchParams.get('lat') ?? '');
    const lng = parseFloat(searchParams.get('lng') ?? '');
    return !Number.isNaN(lat) && !Number.isNaN(lng) ? [lng, lat] : null;
  });

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [isCameraOpen, setIsCameraOpen] = useState(false);
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
  const [simMode, setSimMode] = useState(false);
  const simModeRef = useRef(false);

  const showToast = useCallback((msg: string) => {
    setToastMsg(msg);
    setTimeout(() => {
      setToastMsg((curr) => (curr === msg ? null : curr));
    }, 2800);
  }, []);

  const frontierEndpoints = useMemo(() => findFrontierEndpoints(paths, 6), [paths]);

  useEffect(() => {
    pathsRef.current = paths;
  }, [paths]);

  const clearWalkDraft = useCallback(() => {
    try {
      localStorage.removeItem(ACTIVE_WALK_DRAFT_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  const saveWalkDraft = useCallback((coords: Coord[]) => {
    if (simModeRef.current || coords.length < 2) return;
    try {
      const draft: WalkDraft = {
        activePath: coords,
        startSnapMeta: startSnapMetaRef.current,
        anchorCoord: anchorCoordRef.current,
        savedAt: Date.now(),
      };
      localStorage.setItem(ACTIVE_WALK_DRAFT_KEY, JSON.stringify(draft));
    } catch {
      /* ignore */
    }
  }, []);

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
          setPaths((prev) => (prev.some((p) => p.id === (payload.new as PathRecord).id) ? prev : [...prev, payload.new as PathRecord]));
        } else if (payload.eventType === 'UPDATE') {
          setPaths((prev) => prev.map((p) => (p.id === (payload.new as PathRecord).id ? (payload.new as PathRecord) : p)));
        } else if (payload.eventType === 'DELETE') {
          const oldId = (payload.old as { id?: string })?.id;
          if (oldId) setPaths((prev) => prev.filter((p) => p.id !== oldId));
        }
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'junction_pins' }, (payload) => {
        if (payload.eventType === 'INSERT') {
          setJunctionPins((prev) =>
            prev.some((p) => p.id === (payload.new as MapJunctionPin).id) ? prev : [...prev, payload.new as MapJunctionPin]
          );
        } else if (payload.eventType === 'UPDATE') {
          setJunctionPins((prev) =>
            prev.map((p) => (p.id === (payload.new as MapJunctionPin).id ? (payload.new as MapJunctionPin) : p))
          );
        } else if (payload.eventType === 'DELETE') {
          const oldId = (payload.old as { id?: string })?.id;
          if (oldId) setJunctionPins((prev) => prev.filter((p) => p.id !== oldId));
        }
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pins' }, (payload) => {
        if (payload.eventType === 'INSERT') {
          setPhotoPins((prev) =>
            prev.some((p) => p.id === (payload.new as MapPhotoPin).id) ? prev : [...prev, payload.new as MapPhotoPin]
          );
        } else if (payload.eventType === 'DELETE') {
          const oldId = (payload.old as { id?: string })?.id;
          if (oldId) setPhotoPins((prev) => prev.filter((p) => p.id !== oldId));
        }
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

  const ingestGpsTick = useCallback(
    (coord: Coord, acc: number, timestamp: number, scoutName?: string, scoutZone?: string) => {
      userCoordRef.current = coord;
      accuracyRef.current = acc;
      setUserCoord(coord);
      setAccuracy(acc);

      const nowMs = Date.now();
      if (!simModeRef.current && scoutName && scoutZone && nowMs - lastPresenceTsRef.current >= 2000) {
        lastPresenceTsRef.current = nowMs;
        channelRef.current?.track({ name: scoutName, zone: scoutZone, lng: coord[0], lat: coord[1] });
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

      setGuideFrontier((currentFrontier) => {
        if (currentFrontier) {
          const dist = haversineMeters(coord, currentFrontier.coord);
          if (dist <= 5) {
            navigator.vibrate?.([200, 100, 200]);
            setArrivedFrontier(currentFrontier);
            return null;
          }
        }
        return currentFrontier;
      });

      if (recStateRef.current === 'RECORDING') {
        const res = processGpsPoint({
          incoming: coord,
          accuracy: acc,
          timestamp,
          lastTimestamp: simModeRef.current ? null : lastTickTsRef.current,
          activePath: activePathRef.current,
        });

        if (res.accepted) {
          lastTickTsRef.current = timestamp;
          activePathRef.current = res.nextPath;
          setActivePath(res.nextPath);
          setPathDistance(calculatePathDistance(res.nextPath));
          saveWalkDraft(res.nextPath);

          const overlap = isPointNearExistingPaths(coord, pathsRef.current, 5);
          if (overlap.near) {
            overlapStreakRef.current += 1;
            if (overlapStreakRef.current >= 3) setIsOverlappingPath(true);
          } else {
            overlapStreakRef.current = 0;
            setIsOverlappingPath(false);
          }

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
    [saveWalkDraft]
  );

  const toggleSimMode = () => {
    const next = !simModeRef.current;
    simModeRef.current = next;
    setSimMode(next);
    if (next) {
      setFocusCoord(ESUT_CENTER);
      ingestGpsTick(ESUT_CENTER, 4, Date.now(), profile?.name, profile?.zone);
      showToast('Simulation active: tap map to step along roads (local only)');
    } else {
      // Wipe all simulated data, active walk state, fake GPS, and open sim modals
      setPaths((prev) => prev.filter((p) => !p.id.startsWith('sim-')));
      setJunctionPins((prev) => prev.filter((p) => !p.id.startsWith('sim-')));
      setPhotoPins((prev) => {
        prev.forEach((p) => {
          if (p.id.startsWith('sim-') && p.image_url.startsWith('blob:')) {
            URL.revokeObjectURL(p.image_url);
          }
        });
        return prev.filter((p) => !p.id.startsWith('sim-'));
      });

      recStateRef.current = 'IDLE';
      setRecState('IDLE');
      activePathRef.current = [];
      setActivePath([]);
      setPathDistance(0);
      lastTickTsRef.current = null;
      startSnapMetaRef.current = {};
      anchorCoordRef.current = null;
      alertFiredRef.current = false;
      overlapStreakRef.current = 0;
      setCadenceMeters(0);
      setIsSnapDue(false);
      setIsOverlappingPath(false);

      userCoordRef.current = null;
      accuracyRef.current = null;
      setUserCoord(null);
      setAccuracy(null);

      setGuidePin(null);
      setGuideFrontier(null);
      setArrivedPin(null);
      setArrivedFrontier(null);
      setSelectedPin(null);
      setSelectedPhotoPin(null);
      setSelectedPath(null);
      setSelectedFrontier(null);
      setPendingPathSave(null);
      setPauseJumpPrompt(null);
      setIsBranchModalOpen(false);
      setBranchCoord(null);
      setPendingBlob(null);
      frozenTelemetryRef.current = null;
      setFrozenHeading(null);
      setPreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
      arrivedPinIdsRef.current.forEach((id) => {
        if (id.startsWith('sim-')) arrivedPinIdsRef.current.delete(id);
      });

      showToast('Switched to live GPS — all simulation state cleared');
    }
  };

  const handleZoneChange = (nextZone: string) => {
    if (!profile) return;
    const updated = { ...profile, zone: nextZone };
    localStorage.setItem('esut_scout_profile', JSON.stringify(updated));
    window.dispatchEvent(new Event('esut-profile-updated'));
    setIsZonePickerOpen(false);
    showToast(`Active zone set to ${nextZone.split(':')[0]}`);
  };

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

    const onAbsoluteOrientation = (e: DeviceOrientationEvent) => {
      if (e.alpha === null) return;
      hasAbsoluteOrientationRef.current = true;
      const deg = Math.round((360 - e.alpha) % 360);
      headingRef.current = deg;
      setHeading(deg);
    };
    const onRelativeOrientation = (e: DeviceOrientationEvent) => {
      const wk = (e as DeviceOrientationEvent & { webkitCompassHeading?: number }).webkitCompassHeading;
      if (typeof wk === 'number') {
        const deg = Math.round(wk);
        headingRef.current = deg;
        setHeading(deg);
        return;
      }
      if (hasAbsoluteOrientationRef.current || e.alpha === null) return;
      const deg = Math.round((360 - e.alpha) % 360);
      headingRef.current = deg;
      setHeading(deg);
    };
    window.addEventListener('deviceorientationabsolute' as keyof WindowEventMap, onAbsoluteOrientation as EventListener);
    window.addEventListener('deviceorientation', onRelativeOrientation);

    if ('geolocation' in navigator) {
      navigator.geolocation.watchPosition(
        (pos) => {
          if (simModeRef.current) return;
          const coord: Coord = [pos.coords.longitude, pos.coords.latitude];
          const acc = Math.round(pos.coords.accuracy);
          ingestGpsTick(coord, acc, pos.timestamp, scoutProfile.name, scoutProfile.zone);
        },
        (err) => console.warn(err.message),
        { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
      );
    }

    try {
      const rawDraft = localStorage.getItem(ACTIVE_WALK_DRAFT_KEY);
      if (rawDraft) {
        const parsed = JSON.parse(rawDraft) as WalkDraft;
        if (Array.isArray(parsed?.activePath) && parsed.activePath.length >= 2) {
          setRecoveredDraft(parsed);
        }
      }
    } catch {
      /* ignore */
    }

    setSessionReady(true);
  };

  const handleStartPath = (overrideStart?: Coord) => {
    if (recStateRef.current !== 'IDLE' && activePathRef.current.length >= 2) {
      showToast('Save or discard your current path before starting a new one');
      return;
    }
    const base = overrideStart ?? userCoordRef.current;
    if (!base) {
      showToast('Wait for GPS lock or enable Sim in the top bar');
      return;
    }

    const snap = findTopologicalSnap(base, junctionPins, paths, 6);
    startSnapMetaRef.current = snap.splitTargetPathId
      ? { splitTargetPathId: snap.splitTargetPathId, splitSegmentIdx: snap.splitSegmentIdx, splitCoord: snap.coord }
      : {};

    activePathRef.current = [snap.coord];
    setActivePath([snap.coord]);
    setPathDistance(0);
    overlapStreakRef.current = 0;
    setIsOverlappingPath(false);
    anchorCoordRef.current = snap.coord;
    alertFiredRef.current = false;
    setIsSnapDue(false);
    setCadenceMeters(0);
    setGuideFrontier(null);
    recStateRef.current = 'RECORDING';
    setRecState('RECORDING');
    if (snap.snapped) showToast('Connected to junction — walk onto an unmapped path');
  };

  const handleTogglePauseResume = () => {
    if (recState === 'RECORDING') {
      recStateRef.current = 'PAUSED';
      setRecState('PAUSED');
      return;
    }
    const curr = userCoordRef.current;
    const last = activePathRef.current[activePathRef.current.length - 1];
    if (curr && last) {
      const gap = Math.round(haversineMeters(last, curr));
      if (gap > 15) {
        setPauseJumpPrompt({ distance: gap });
        return;
      }
    }
    recStateRef.current = 'RECORDING';
    setRecState('RECORDING');
  };

  const handleOpenSavePathSheet = () => {
    const raw = activePathRef.current;
    if (raw.length < 2) {
      recStateRef.current = 'IDLE';
      setRecState('IDLE');
      activePathRef.current = [];
      setActivePath([]);
      clearWalkDraft();
      showToast('Walk at least 2 points before saving a path');
      return;
    }

    recStateRef.current = 'PAUSED';
    setRecState('PAUSED');

    const endSnap = findTopologicalSnap(raw[raw.length - 1], junctionPins, paths, 6);
    const finalCoords = endSnap.snapped ? [...raw.slice(0, -1), endSnap.coord] : raw;
    const dist = calculatePathDistance(finalCoords);
    const overlapRatio = computePathOverlapRatio(finalCoords, paths, 5);

    setPathNameInput('');
    setConfirmDeleteId(null);
    setPendingPathSave({
      coords: finalCoords,
      distance: dist,
      overlapRatio,
      endSnapMeta: endSnap.splitTargetPathId
        ? { splitTargetPathId: endSnap.splitTargetPathId, splitSegmentIdx: endSnap.splitSegmentIdx, splitCoord: endSnap.coord }
        : {},
    });
  };

  const handleConfirmSavePath = async () => {
    if (!pendingPathSave || !profile) return;
    setIsSavingPath(true);

    const payload: Extract<QueuedItem, { type: 'path' }>['payload'] = {
      scout_name: profile.name,
      zone: profile.zone,
      name: pathNameInput.trim() || null,
      coordinates: pendingPathSave.coords,
      distance_m: pendingPathSave.distance,
      split_path_id: startSnapMetaRef.current.splitTargetPathId ?? null,
      split_segment_idx: startSnapMetaRef.current.splitSegmentIdx ?? null,
      split_coord: startSnapMetaRef.current.splitCoord ?? null,
      end_split_path_id: pendingPathSave.endSnapMeta.splitTargetPathId ?? null,
      end_split_segment_idx: pendingPathSave.endSnapMeta.splitSegmentIdx ?? null,
      end_split_coord: pendingPathSave.endSnapMeta.splitCoord ?? null,
    };

    try {
      if (simModeRef.current) {
        setPaths((prev) => [
          ...prev,
          {
            id: `sim-${crypto.randomUUID()}`,
            scout_name: payload.scout_name,
            zone: payload.zone,
            name: payload.name ?? null,
            coordinates: payload.coordinates,
            distance_m: payload.distance_m,
          },
        ]);
        showToast(`Sim path previewed (${payload.distance_m}m — not saved to DB)`);
      } else {
        await savePathRpc(payload);
        showToast(`Path saved (${payload.distance_m}m)`);
      }
    } catch {
      await enqueueOffline({ id: crypto.randomUUID(), type: 'path', createdAt: Date.now(), payload });
      setQueueCount((c) => c + 1);
      showToast('Saved offline — will sync when connected');
    } finally {
      recStateRef.current = 'IDLE';
      setRecState('IDLE');
      activePathRef.current = [];
      setActivePath([]);
      setPathDistance(0);
      overlapStreakRef.current = 0;
      setIsOverlappingPath(false);
      setPendingPathSave(null);
      setIsSavingPath(false);
      clearWalkDraft();
    }
  };

  const handleDiscardActivePath = () => {
    recStateRef.current = 'IDLE';
    setRecState('IDLE');
    activePathRef.current = [];
    setActivePath([]);
    setPathDistance(0);
    overlapStreakRef.current = 0;
    setIsOverlappingPath(false);
    setPendingPathSave(null);
    setConfirmDeleteId(null);
    clearWalkDraft();
    showToast('Active path discarded');
  };

  const handleUndoLast3 = () => {
    const next = activePathRef.current.length > 3 ? activePathRef.current.slice(0, -3) : activePathRef.current.slice(0, 1);
    activePathRef.current = next;
    setActivePath(next);
    setPathDistance(calculatePathDistance(next));
    showToast('Removed last 3 points');
  };

  const stopCameraStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setIsCameraOpen(false);
  }, []);

  useEffect(() => {
    if (isCameraOpen && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
      videoRef.current.play().catch(() => {});
    }
  }, [isCameraOpen]);

  const handleTapSnap = async () => {
    const coord = userCoordRef.current;
    if (!coord) {
      showToast('Wait for GPS lock or enable Sim in the top bar');
      return;
    }
    frozenTelemetryRef.current = { coord, accuracy: accuracyRef.current, heading: headingRef.current };
    setFrozenHeading(headingRef.current);
    setPhotoCategory(isSnapDue ? 'Cadence View' : 'Building Entrance');
    setPhotoLabel(isSnapDue ? '' : suggestTurnLabel(activePathRef.current));

    if (navigator.mediaDevices?.getUserMedia) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        });
        streamRef.current = stream;
        setIsCameraOpen(true);
        return;
      } catch {
        // Fallback to native file/camera input
      }
    }
    fileInputRef.current?.click();
  };

  const handleCaptureVideoFrame = () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) return;
    const maxWidth = 1080;
    const scale = video.videoWidth > maxWidth ? maxWidth / video.videoWidth : 1;
    const w = Math.round(video.videoWidth * scale);
    const h = Math.round(video.videoHeight * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, w, h);
    canvas.toBlob(
      (blob) => {
        stopCameraStream();
        if (!blob) return;
        setPreviewUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return URL.createObjectURL(blob);
        });
        setPendingBlob(blob);
      },
      'image/webp',
      0.75
    );
  };

  const handlePhotoFilePicked = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) {
      frozenTelemetryRef.current = null;
      setFrozenHeading(null);
      return;
    }
    try {
      const blob = await compressToWebP(file, 1080, 0.75);
      setPreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return URL.createObjectURL(blob);
      });
      setPendingBlob(blob);
    } catch {
      showToast('Could not read image file');
      frozenTelemetryRef.current = null;
      setFrozenHeading(null);
    }
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
      if (simModeRef.current) {
        const simUrl = URL.createObjectURL(pendingBlob);
        setPhotoPins((prev) => [
          ...prev,
          {
            id: `sim-${crypto.randomUUID()}`,
            lat: payload.lat,
            lng: payload.lng,
            category: payload.category,
            label: payload.label || null,
            heading: payload.heading,
            image_url: simUrl,
            scout_name: payload.scout_name,
            zone: payload.zone,
          },
        ]);
        showToast('Sim photo pin previewed (not saved to DB)');
      } else {
        await uploadPhotoRecord(pendingBlob, payload);
        showToast('Photo pin saved');
      }
    } catch {
      await enqueueOffline({ id: crypto.randomUUID(), type: 'photo', createdAt: Date.now(), blob: pendingBlob, payload });
      setQueueCount((c) => c + 1);
      showToast('Saved offline — will sync when connected');
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

  const handleOpenFlagBranch = () => {
    const coord =
      recStateRef.current !== 'IDLE' && activePathRef.current.length > 0
        ? activePathRef.current[activePathRef.current.length - 1]
        : userCoordRef.current;
    if (!coord || !profile) {
      showToast('Wait for GPS lock or enable Sim in the top bar');
      return;
    }
    navigator.vibrate?.(60);
    setBranchCoord(coord);
    setBranchNoteInput('Shortcut');
    setIsBranchModalOpen(true);
  };

  const handleConfirmFlagBranch = async () => {
    if (!branchCoord || !profile) return;
    setIsSavingBranch(true);
    const payload = {
      lat: branchCoord[1],
      lng: branchCoord[0],
      created_by: profile.name,
      note: branchNoteInput.trim() || 'Shortcut',
    };
    try {
      if (simModeRef.current) {
        setJunctionPins((prev) => [
          ...prev,
          {
            id: `sim-${crypto.randomUUID()}`,
            lat: payload.lat,
            lng: payload.lng,
            status: 'open',
            created_by: payload.created_by,
            claimed_by: null,
            note: payload.note,
          },
        ]);
        showToast(
          recStateRef.current !== 'IDLE'
            ? 'Branch pinned — keep walking your current route'
            : 'Sim shortcut pin previewed (not saved to DB)'
        );
      } else {
        const { data, error } = await supabase.from('junction_pins').insert(payload).select().single();
        if (error) throw error;
        if (data) {
          const link = `${window.location.origin}/mapper?pinId=${data.id}&lat=${data.lat}&lng=${data.lng}`;
          navigator.clipboard?.writeText(link).catch(() => {});
          showToast(
            recStateRef.current !== 'IDLE'
              ? 'Branch pinned — keep walking your current route'
              : 'Shortcut pin dropped and link copied'
          );
        }
      }
    } catch {
      await enqueueOffline({ id: crypto.randomUUID(), type: 'pin', createdAt: Date.now(), payload });
      setQueueCount((c) => c + 1);
      showToast('Saved offline — will sync when connected');
    } finally {
      setIsSavingBranch(false);
      setIsBranchModalOpen(false);
      setBranchCoord(null);
    }
  };

  const handleClaimPin = async (pin: MapJunctionPin) => {
    if (!profile) return;
    if (simModeRef.current || pin.id.startsWith('sim-')) {
      setJunctionPins((prev) =>
        prev.map((p) => (p.id === pin.id ? { ...p, status: 'claimed', claimed_by: profile.name } : p))
      );
    } else {
      await supabase.from('junction_pins').update({ status: 'claimed', claimed_by: profile.name }).eq('id', pin.id);
    }
    setGuidePin(pin);
    setSelectedPin(null);
    showToast('Shortcut claimed — follow the dashed guide line');
  };

  const handleDeleteJunctionPin = async (id: string) => {
    if (!id.startsWith('sim-')) {
      await supabase.from('junction_pins').delete().eq('id', id);
    }
    setJunctionPins((prev) => prev.filter((p) => p.id !== id));
    setSelectedPin(null);
    setConfirmDeleteId(null);
    showToast('Shortcut pin deleted');
  };

  const handleDeletePhotoPin = async (id: string) => {
    if (!id.startsWith('sim-')) {
      await supabase.from('pins').delete().eq('id', id);
    }
    setPhotoPins((prev) => prev.filter((p) => p.id !== id));
    setSelectedPhotoPin(null);
    setConfirmDeleteId(null);
    showToast('Photo pin deleted');
  };

  const handleDeletePath = async (id: string) => {
    if (!id.startsWith('sim-')) {
      await supabase.from('paths').delete().eq('id', id);
    }
    setPaths((prev) => prev.filter((p) => p.id !== id));
    setSelectedPath(null);
    setConfirmDeleteId(null);
    showToast('Mapped path deleted');
  };

  const handleExportGeoJSON = () => {
    const fc = {
      type: 'FeatureCollection',
      features: [
        ...paths.map((p) => ({
          type: 'Feature',
          properties: {
            type: 'path',
            id: p.id,
            name: p.name ?? null,
            scout: p.scout_name,
            zone: p.zone,
            distance_m: p.distance_m,
          },
          geometry: { type: 'LineString', coordinates: p.coordinates },
        })),
        ...photoPins.map((ph) => ({
          type: 'Feature',
          properties: {
            type: 'pin',
            id: ph.id,
            category: ph.category,
            label: ph.label,
            heading: ph.heading,
            image_url: ph.image_url,
          },
          geometry: { type: 'Point', coordinates: [ph.lng, ph.lat] },
        })),
      ],
    };
    const blob = new Blob([JSON.stringify(fc, null, 2)], { type: 'application/geo+json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `esut-agbani-${new Date().toISOString().slice(0, 10)}.geojson`;
    a.click();
    showToast('Downloaded campus GeoJSON');
  };

  const gpsBad = accuracy === null || accuracy > 15;
  const cadenceRatio = Math.min(1, cadenceMeters / CADENCE_TARGET_M);

  return (
    <div className="relative h-dvh w-screen overflow-hidden bg-slate-100 text-slate-900 select-none">
      {/* Full-bleed Map Canvas */}
      <MapperMap
        paths={paths}
        activePath={activePath}
        frontierEndpoints={frontierEndpoints}
        junctionPins={junctionPins}
        photoPins={photoPins}
        teammates={teammates}
        userCoord={userCoord}
        heading={heading}
        isRecording={recState === 'RECORDING'}
        guideTarget={guidePin ? [guidePin.lng, guidePin.lat] : guideFrontier?.coord ?? null}
        focusCoord={focusCoord}
        onSelectJunctionPin={(id) => {
          const found = junctionPins.find((p) => p.id === id);
          if (found) {
            setConfirmDeleteId(null);
            setSelectedPin(found);
          }
        }}
        onSelectPhotoPin={(id) => {
          const found = photoPins.find((p) => p.id === id);
          if (found) {
            setConfirmDeleteId(null);
            setSelectedPhotoPin(found);
          }
        }}
        onSelectFrontier={(id) => {
          const found = frontierEndpoints.find((f) => f.id === id);
          if (found) {
            setConfirmDeleteId(null);
            setSelectedFrontier(found);
          }
        }}
        onSelectPath={(id) => {
          const found = paths.find((p) => p.id === id);
          if (found) {
            setConfirmDeleteId(null);
            setSelectedPath(found);
          }
        }}
        onMapClick={(coord) => {
          if (!simModeRef.current) return;
          ingestGpsTick(coord, 4, Date.now(), profile?.name, profile?.zone);
        }}
      />

      {/* Top Floating Instrument Bar */}
      <header className="pointer-events-none absolute inset-x-3 top-3 z-20 mx-auto flex max-w-lg items-center justify-between gap-2 rounded-2xl border border-slate-200/90 bg-white/95 px-3 py-2 shadow-lg backdrop-blur-md">
        <div className="pointer-events-auto flex min-w-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => setIsZonePickerOpen(true)}
            aria-label="Switch active campus zone"
            className="flex min-w-0 items-center gap-1.5 rounded-xl border border-slate-200 bg-slate-100 px-2.5 py-1.5 text-xs font-medium text-slate-900 transition-transform duration-150 ease-out hover:bg-slate-200/70 active:scale-95"
          >
            <span className="size-2 shrink-0 rounded-full bg-sky-400" />
            <span className="truncate">
              {profile?.zone.split(':')[0] ?? 'Zone 1'} / {profile?.name ?? 'Scout'}
            </span>
            <svg className="size-3.5 shrink-0 text-slate-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>

          <span
            className={`flex shrink-0 items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-xs font-medium tabular-nums ${
              gpsBad
                ? 'border-rose-200 bg-rose-50 text-rose-700'
                : 'border-emerald-200 bg-emerald-50 text-emerald-700'
            }`}
          >
            <span className={`size-1.5 rounded-full ${gpsBad ? 'bg-rose-500' : 'bg-emerald-400'}`} />
            {accuracy !== null ? `±${accuracy}m` : 'No GPS'}
          </span>
        </div>

        <div className="pointer-events-auto flex shrink-0 items-center gap-1.5">
          {queueCount > 0 && (
            <span className="rounded-xl border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs font-medium text-amber-800 tabular-nums">
              {queueCount} queued
            </span>
          )}

          {teammates.length > 0 && (
            <div className="flex -space-x-1">
              {teammates.slice(0, 3).map((t) => (
                <span
                  key={t.name}
                  title={t.name}
                  className="flex size-6 items-center justify-center rounded-full border border-white bg-slate-200 text-[10px] font-semibold text-slate-800"
                >
                  {t.name[0]}
                </span>
              ))}
            </div>
          )}

          {showSimButton && (
            <button
              type="button"
              onClick={toggleSimMode}
              aria-pressed={simMode}
              className={`rounded-xl border px-2.5 py-1.5 text-xs font-medium transition-transform duration-150 ease-out active:scale-95 ${
                simMode
                  ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
                  : 'border-slate-200 bg-slate-100 text-slate-700 hover:bg-slate-200/70'
              }`}
            >
              {simMode ? 'Sim: On' : 'Sim'}
            </button>
          )}

          <button
            type="button"
            onClick={() => setIsHelpOpen(true)}
            aria-label="Open map legend and quick guide"
            className="flex size-8 items-center justify-center rounded-xl border border-slate-200 bg-slate-100 text-xs font-semibold text-slate-800 transition-transform duration-150 ease-out hover:bg-slate-200/70 active:scale-95"
          >
            ?
          </button>

          <button
            type="button"
            onClick={handleExportGeoJSON}
            aria-label="Export mapped data as GeoJSON"
            className="flex size-8 items-center justify-center rounded-xl border border-slate-200 bg-slate-100 text-slate-800 transition-transform duration-150 ease-out hover:bg-slate-200/70 active:scale-95"
          >
            <svg className="size-4 text-slate-700" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </button>
        </div>
      </header>

      {/* Non-blocking Status Banner */}
      {toastMsg && (
        <div role="status" aria-live="polite" className="pointer-events-none absolute inset-x-0 top-20 z-30 flex justify-center px-4">
          <div className="rounded-xl bg-slate-900 px-3.5 py-2 text-xs font-medium text-white shadow-lg">
            {toastMsg}
          </div>
        </div>
      )}

      {/* Simulation Instruction Pill */}
      {simMode && !toastMsg && (
        <div className="pointer-events-none absolute left-3 top-20 z-10 rounded-xl border border-emerald-200 bg-white/95 px-3 py-1.5 text-xs font-semibold text-emerald-700 shadow">
          Tap map to step along ESUT roads
        </div>
      )}

      {/* Bottom Floating Control Dock */}
      <footer className="pointer-events-auto absolute inset-x-3 bottom-3 z-20 mx-auto max-w-lg rounded-3xl border border-slate-200/90 bg-white/95 p-3.5 pb-[max(0.875rem,env(safe-area-inset-bottom))] shadow-lg backdrop-blur-md">
        {/* Weak GPS Recording Alert */}
        {recState === 'RECORDING' && gpsBad && (
          <div className="mb-2.5 flex items-center justify-between gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700 tabular-nums">
            <span>Weak GPS ({accuracy !== null ? `±${accuracy}m` : 'none'}) — waiting for clearer signal</span>
          </div>
        )}

        {/* Duplicate Overlap Alert */}
        {recState === 'RECORDING' && isOverlappingPath && (
          <div className="mb-2.5 flex items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            <span className="font-medium">Already mapped — walking on an existing path</span>
            <div className="flex shrink-0 gap-1.5">
              <button
                type="button"
                onClick={handleTogglePauseResume}
                className="rounded-lg bg-slate-100 px-2 py-1 text-[11px] font-semibold text-slate-900"
              >
                Pause
              </button>
              <button
                type="button"
                onClick={handleDiscardActivePath}
                className="rounded-lg bg-rose-600 px-2 py-1 text-[11px] font-semibold text-white"
              >
                Discard
              </button>
            </div>
          </div>
        )}

        {/* Contextual Idle Prompt OR Active Cadence & Distance Telemetry Row */}
        {recState === 'IDLE' ? (
          <div className="mb-3 flex items-center justify-between gap-2 text-xs text-slate-700">
            <span className="truncate">
              Stand at an unmapped road or blue ring, then tap Start Path
            </span>
          </div>
        ) : (
          <div className="mb-3">
            <div className="mb-1.5 flex items-center justify-between gap-2 text-xs">
              <span className={`font-medium tabular-nums ${isSnapDue ? 'text-emerald-600' : 'text-slate-700'}`}>
                {isSnapDue
                  ? `50m reached — snap a road view photo`
                  : `Next road photo: ${cadenceMeters}m / ${CADENCE_TARGET_M}m`}
              </span>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleUndoLast3}
                  className="rounded-lg border border-slate-200 bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-700 transition-transform duration-150 ease-out hover:bg-slate-200/70 active:scale-95"
                >
                  Undo 3 pts
                </button>
                <span className="rounded-lg border border-slate-200 bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-800 tabular-nums">
                  {pathDistance}m
                </span>
              </div>
            </div>

            {/* Compositor-only scaleX progress bar */}
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
              <div
                className={`size-full origin-left rounded-full transition-transform duration-150 ease-out ${
                  isSnapDue ? 'bg-emerald-400' : 'bg-sky-400'
                }`}
                style={{ transform: `scaleX(${cadenceRatio})` }}
              />
            </div>
          </div>
        )}

        {/* Disciplined Action Grid: One primary accent, quiet secondary surfaces */}
        <div className="grid grid-cols-12 gap-2">
          {recState === 'IDLE' ? (
            <button
              type="button"
              onClick={() => handleStartPath()}
              className="col-span-5 flex h-13 items-center justify-center gap-2 rounded-2xl bg-emerald-600 text-sm font-semibold text-white shadow transition-transform duration-150 ease-out hover:bg-emerald-700 active:scale-95"
            >
              <svg className="size-4 fill-current" viewBox="0 0 24 24">
                <polygon points="5 3 19 12 5 21 5 3" />
              </svg>
              <span>Start Path</span>
            </button>
          ) : (
            <div className="col-span-5 grid grid-cols-2 gap-1.5">
              <button
                type="button"
                onClick={handleTogglePauseResume}
                className="flex h-13 flex-col items-center justify-center rounded-2xl border border-slate-200 bg-slate-100 text-xs font-medium text-slate-800 transition-transform duration-150 ease-out hover:bg-slate-200/70 active:scale-95"
              >
                {recState === 'RECORDING' ? (
                  <>
                    <svg className="mb-0.5 size-3.5 fill-current text-amber-600" viewBox="0 0 24 24">
                      <rect x="6" y="4" width="4" height="16" />
                      <rect x="14" y="4" width="4" height="16" />
                    </svg>
                    <span>Pause</span>
                  </>
                ) : (
                  <>
                    <svg className="mb-0.5 size-3.5 fill-current text-emerald-600" viewBox="0 0 24 24">
                      <polygon points="5 3 19 12 5 21 5 3" />
                    </svg>
                    <span>Resume</span>
                  </>
                )}
              </button>
              <button
                type="button"
                onClick={handleOpenSavePathSheet}
                className="flex h-13 flex-col items-center justify-center rounded-2xl bg-emerald-600 text-xs font-semibold text-white transition-transform duration-150 ease-out hover:bg-emerald-700 active:scale-95"
              >
                <svg className="mb-0.5 size-3.5 fill-current" viewBox="0 0 24 24">
                  <polyline points="20 6 9 17 4 12" fill="none" stroke="currentColor" strokeWidth="3" />
                </svg>
                <span>Save</span>
              </button>
            </div>
          )}

          <button
            type="button"
            onClick={handleTapSnap}
            className={`col-span-4 flex h-13 items-center justify-center gap-2 rounded-2xl text-sm font-semibold transition-transform duration-150 ease-out active:scale-95 ${
              isSnapDue
                ? 'bg-emerald-600 text-white shadow'
                : 'border border-slate-200 bg-slate-100 text-slate-900 hover:bg-slate-200/70'
            }`}
          >
            <svg
              className={`size-4 ${isSnapDue ? 'text-white' : 'text-sky-600'}`}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
              <circle cx="12" cy="13" r="4" />
            </svg>
            <span>Snap</span>
          </button>

          <button
            type="button"
            onClick={handleOpenFlagBranch}
            className="col-span-3 flex h-13 flex-col items-center justify-center rounded-2xl border border-slate-200 bg-slate-100 text-xs font-medium text-slate-800 transition-transform duration-150 ease-out hover:bg-slate-200/70 active:scale-95"
          >
            <svg className="mb-0.5 size-3.5 text-amber-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
              <line x1="4" y1="22" x2="4" y2="15" />
            </svg>
            <span>Branch</span>
          </button>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="sr-only"
          onChange={handlePhotoFilePicked}
        />
      </footer>

      {/* Onboarding & Hardware Handshake Modal */}
      {(!profile || !sessionReady) && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="onboarding-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-5 backdrop-blur-sm"
        >
          <div className="w-full max-w-sm rounded-3xl border border-slate-200 bg-white p-6 shadow-xl">
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-medium text-slate-700">
              <span className="size-2 rounded-full bg-emerald-400" />
              ESUT Agbani Field Mapper
            </div>
            <h1 id="onboarding-title" className="mb-1 text-xl font-semibold text-balance text-slate-900">
              {profile ? `Ready to map, ${profile.name}` : 'Set up your scout profile'}
            </h1>
            <p className="mb-5 text-xs leading-relaxed text-pretty text-slate-500">
              {profile
                ? 'Start the session to enable GPS tracking, compass heading, and screen wake lock.'
                : 'Enter your name and starting zone. You can switch zones at any time from the top bar.'}
            </p>
            {!profile && (
              <>
                <label htmlFor="scout-name-input" className="mb-1.5 block text-xs font-medium text-slate-700">
                  Scout name
                </label>
                <input
                  id="scout-name-input"
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  placeholder="Munachi"
                  className="mb-3.5 w-full rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-sm text-slate-900 outline-none focus:border-emerald-500"
                />
                <label htmlFor="scout-zone-select" className="mb-1.5 block text-xs font-medium text-slate-700">
                  Starting zone
                </label>
                <select
                  id="scout-zone-select"
                  value={zoneInput}
                  onChange={(e) => setZoneInput(e.target.value)}
                  className="mb-5 w-full rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-sm text-slate-900 outline-none focus:border-emerald-500"
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
              type="button"
              onClick={() => {
                const p = profile ?? { name: nameInput.trim() || 'Scout', zone: zoneInput };
                startHardwareSession(p);
              }}
              className="w-full rounded-2xl bg-emerald-600 py-3 text-sm font-semibold text-white transition-transform duration-150 ease-out hover:bg-emerald-700 active:scale-95"
            >
              Start Mapping Session
            </button>
          </div>
        </div>
      )}

      {/* 1-Tap Map Legend & Quick Guide Sheet */}
      {isHelpOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Map legend and quick guide"
          className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/40"
          onClick={() => setIsHelpOpen(false)}
        >
          <div
            className="w-full max-w-lg rounded-t-3xl border-t border-slate-200 bg-white p-5 pb-[max(1.5rem,env(safe-area-inset-bottom))]"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="mb-1 text-base font-semibold text-balance">Map guide</h2>
            <p className="mb-4 text-xs text-pretty text-slate-500">
              Walk unmapped roads with Start Path, snap photos at buildings or every 50m, and drop Branch pins at side shortcuts.
            </p>
            <div className="mb-4 space-y-2.5 rounded-2xl border border-slate-200 bg-slate-50 p-3.5 text-xs">
              <div className="flex items-center gap-3">
                <span className="h-1.5 w-6 shrink-0 rounded-full bg-sky-400 ring-2 ring-sky-950" />
                <span className="text-slate-800">Blue dotted line — already mapped (skip these)</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="size-3.5 shrink-0 rounded-full border-2 border-sky-300 bg-sky-950" />
                <span className="text-slate-800">Hollow blue ring — unfinished road end (tap to continue)</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="size-3.5 shrink-0 rounded-full border-2 border-white bg-orange-500" />
                <span className="text-slate-800">Orange dot — unmapped shortcut (tap to claim &amp; walk)</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="h-1.5 w-6 shrink-0 rounded-full border border-dashed border-emerald-400 bg-emerald-400/40" />
                <span className="text-slate-800">Green dashed line — the path you are recording right now</span>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setIsHelpOpen(false)}
              className="w-full rounded-xl bg-emerald-600 py-2.5 text-xs font-semibold text-white"
            >
              Got it
            </button>
          </div>
        </div>
      )}

      {/* Quick Zone Switcher Sheet */}
      {isZonePickerOpen && profile && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Switch active campus zone"
          className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/40"
          onClick={() => setIsZonePickerOpen(false)}
        >
          <div
            className="w-full max-w-lg rounded-t-3xl border-t border-slate-200 bg-white p-5 pb-[max(1.5rem,env(safe-area-inset-bottom))]"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="mb-1 text-base font-semibold text-balance">Switch active zone</h2>
            <p className="mb-3 text-xs text-pretty text-slate-500">
              Choose the campus zone you are walking in right now.
            </p>
            <div className="space-y-1.5">
              {ZONES.map((z) => {
                const active = profile.zone === z;
                return (
                  <button
                    type="button"
                    key={z}
                    onClick={() => handleZoneChange(z)}
                    className={`flex w-full items-center justify-between rounded-xl border px-3.5 py-2.5 text-left text-xs font-medium ${
                      active
                        ? 'border-emerald-300 bg-emerald-50 text-emerald-800'
                        : 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-200/70'
                    }`}
                  >
                    <span>{z}</span>
                    {active && <span className="text-emerald-600">Current</span>}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Save Path & Name Area/Route Modal */}
      {pendingPathSave && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="save-path-title"
          className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/45"
        >
          <div className="w-full max-w-lg rounded-t-3xl border-t border-slate-200 bg-white p-5 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <h2 id="save-path-title" className="text-base font-semibold text-balance tabular-nums">
                  Save {pendingPathSave.distance}m path
                </h2>
                <p className="text-xs text-pretty text-slate-500 tabular-nums">
                  {pendingPathSave.coords.length} points recorded. Add an optional road or area name.
                </p>
              </div>
              {confirmDeleteId === 'active-path' ? (
                <button
                  type="button"
                  onClick={handleDiscardActivePath}
                  className="rounded-xl bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white"
                >
                  Confirm Discard
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmDeleteId('active-path')}
                  className="rounded-xl border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-xs font-medium text-rose-700"
                >
                  Discard
                </button>
              )}
            </div>

            {pendingPathSave.overlapRatio >= 0.75 && (
              <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-pretty text-amber-900 tabular-nums">
                {Math.round(pendingPathSave.overlapRatio * 100)}% of this walk overlaps an already-mapped path. Discard it unless this is a separate parallel footpath.
              </div>
            )}

            <div className="mb-3 flex flex-wrap gap-1.5">
              {QUICK_PATH_NAMES.map((chip) => (
                <button
                  type="button"
                  key={chip}
                  onClick={() => setPathNameInput((prev) => (prev ? `${prev}, ${chip}` : chip))}
                  className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-200/70"
                >
                  + {chip}
                </button>
              ))}
            </div>

            <input
              value={pathNameInput}
              onChange={(e) => setPathNameInput(e.target.value)}
              placeholder="Road or shortcut name (e.g., Main Road to ETF)"
              className="mb-4 w-full rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-sm text-slate-900 outline-none focus:border-emerald-500"
            />

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setPendingPathSave(null);
                  setConfirmDeleteId(null);
                  recStateRef.current = 'RECORDING';
                  setRecState('RECORDING');
                }}
                className="flex-1 rounded-xl border border-slate-200 bg-slate-50 py-3 text-xs font-semibold text-slate-800"
              >
                Keep Walking
              </button>
              <button
                type="button"
                disabled={isSavingPath}
                onClick={handleConfirmSavePath}
                className="flex-[2] rounded-xl bg-emerald-600 py-3 text-xs font-semibold text-white"
              >
                {isSavingPath ? 'Saving...' : 'Save Path'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Flag Shortcut / Branch Modal */}
      {isBranchModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="flag-branch-title"
          className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/45"
          onClick={() => setIsBranchModalOpen(false)}
        >
          <div
            className="w-full max-w-lg rounded-t-3xl border-t border-slate-200 bg-white p-5 pb-[max(1.5rem,env(safe-area-inset-bottom))]"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="flag-branch-title" className="mb-1 text-base font-semibold text-balance">
              Flag unmapped shortcut
            </h2>
            <p className="mb-3 text-xs text-pretty text-slate-500">
              Drop a pin here so you or a teammate can map this branch next.
            </p>
            <div className="mb-3 flex flex-wrap gap-1.5">
              {QUICK_BRANCH_NOTES.map((chip) => (
                <button
                  type="button"
                  key={chip}
                  onClick={() => setBranchNoteInput(chip)}
                  className={`rounded-lg border px-2.5 py-1 text-xs font-medium ${
                    branchNoteInput === chip
                      ? 'border-amber-300 bg-amber-50 text-amber-900'
                      : 'border-slate-200 bg-slate-50 text-slate-700'
                  }`}
                >
                  {chip}
                </button>
              ))}
            </div>
            <input
              value={branchNoteInput}
              onChange={(e) => setBranchNoteInput(e.target.value)}
              placeholder="Where does this shortcut lead?"
              className="mb-4 w-full rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-sm text-slate-900 outline-none focus:border-amber-400"
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setIsBranchModalOpen(false)}
                className="flex-1 rounded-xl border border-slate-200 bg-slate-50 py-3 text-xs font-semibold text-slate-800"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isSavingBranch}
                onClick={handleConfirmFlagBranch}
                className="flex-[2] rounded-xl bg-emerald-600 py-3 text-xs font-semibold text-white"
              >
                {isSavingBranch
                  ? 'Dropping Pin...'
                  : recState !== 'IDLE'
                    ? 'Drop Pin & Continue Route'
                    : 'Drop Shortcut Pin'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Live Camera Viewfinder Modal */}
      {isCameraOpen && (
        <div role="dialog" aria-modal="true" aria-label="Camera viewfinder" className="fixed inset-0 z-50 flex flex-col bg-black">
          <video ref={videoRef} autoPlay playsInline muted className="flex-1 object-cover" />
          <div className="flex items-center justify-between gap-3 bg-slate-950 px-4 py-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
            <button
              type="button"
              onClick={() => {
                stopCameraStream();
                frozenTelemetryRef.current = null;
                setFrozenHeading(null);
              }}
              className="rounded-xl border border-white/10 bg-slate-900 px-4 py-3 text-xs font-semibold text-slate-200"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleCaptureVideoFrame}
              className="flex-1 rounded-2xl bg-emerald-500 py-3.5 text-sm font-semibold text-slate-950 transition-transform duration-150 ease-out active:scale-95"
            >
              Capture Photo
            </button>
            <button
              type="button"
              onClick={() => {
                stopCameraStream();
                fileInputRef.current?.click();
              }}
              className="rounded-xl border border-white/10 bg-slate-900 px-3.5 py-3 text-xs font-semibold text-slate-200"
            >
              Upload File
            </button>
          </div>
        </div>
      )}

      {/* Tag Captured Photo Modal */}
      {pendingBlob && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="tag-photo-title"
          className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/45"
        >
          <div className="w-full max-w-lg rounded-t-3xl border-t border-slate-200 bg-white p-5 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
            <div className="mb-3 flex items-center justify-between">
              <h2 id="tag-photo-title" className="text-base font-semibold text-balance">
                Tag photo pin
              </h2>
              <span className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs font-medium text-slate-700 tabular-nums">
                Heading: {frozenHeading ?? '--'}°
              </span>
            </div>
            {previewUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={previewUrl} alt="Captured preview" className="mb-3 h-32 w-full rounded-2xl object-cover" />
            )}
            <div className="mb-3 grid grid-cols-2 gap-2">
              {PHOTO_CATEGORIES.map((cat) => (
                <button
                  type="button"
                  key={cat}
                  onClick={() => setPhotoCategory(cat)}
                  className={`rounded-xl border px-3 py-2 text-xs font-medium ${
                    photoCategory === cat
                      ? 'border-emerald-300 bg-emerald-50 text-emerald-800'
                      : 'border-slate-200 bg-slate-50 text-slate-700'
                  }`}
                >
                  {cat}
                </button>
              ))}
            </div>
            <div className="mb-2.5 flex flex-wrap gap-1.5">
              {QUICK_BUILDINGS.map((b) => (
                <button
                  type="button"
                  key={b}
                  onClick={() => setPhotoLabel(b)}
                  className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-200/70"
                >
                  + {b}
                </button>
              ))}
            </div>
            <input
              value={photoLabel}
              onChange={(e) => setPhotoLabel(e.target.value)}
              placeholder="Building name or turn label (optional for 50m road views)"
              className="mb-4 w-full rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-sm text-slate-900 outline-none focus:border-emerald-500"
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setPendingBlob(null);
                  frozenTelemetryRef.current = null;
                  setFrozenHeading(null);
                  setPreviewUrl((prev) => {
                    if (prev) URL.revokeObjectURL(prev);
                    return null;
                  });
                }}
                className="flex-1 rounded-xl border border-slate-200 bg-slate-50 py-3 text-xs font-semibold text-slate-800"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isSavingPhoto}
                onClick={handleSavePhotoPin}
                className="flex-[2] rounded-xl bg-emerald-600 py-3 text-xs font-semibold text-white"
              >
                {isSavingPhoto ? 'Saving...' : 'Save Pin'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Inspect / Claim Shortcut Junction Pin Modal */}
      {selectedPin && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Shortcut pin details"
          className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/40"
          onClick={() => setSelectedPin(null)}
        >
          <div
            className="w-full max-w-lg rounded-t-3xl border-t border-slate-200 bg-white p-5 pb-[max(1.5rem,env(safe-area-inset-bottom))]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-1 flex items-center justify-between gap-2">
              <h2 className="text-base font-semibold text-balance">{selectedPin.note || 'Flagged shortcut'}</h2>
              {confirmDeleteId === selectedPin.id ? (
                <button
                  type="button"
                  onClick={() => handleDeleteJunctionPin(selectedPin.id)}
                  className="rounded-lg bg-rose-600 px-2.5 py-1 text-xs font-semibold text-white"
                >
                  Confirm Delete
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmDeleteId(selectedPin.id)}
                  className="rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-1 text-xs font-medium text-rose-700"
                >
                  Delete
                </button>
              )}
            </div>
            <p className="mb-4 text-xs text-slate-500 tabular-nums">
              Flagged by {selectedPin.created_by} (
              {userCoord
                ? `${Math.round(haversineMeters(userCoord, [selectedPin.lng, selectedPin.lat]))}m away`
                : 'distance unknown'}
              , status: {selectedPin.status})
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => handleClaimPin(selectedPin)}
                className="flex-1 rounded-xl border border-slate-200 bg-slate-50 py-3 text-xs font-semibold text-slate-900"
              >
                Claim & Guide
              </button>
              <button
                type="button"
                onClick={() => {
                  setSelectedPin(null);
                  handleStartPath([selectedPin.lng, selectedPin.lat]);
                }}
                className="flex-1 rounded-xl bg-emerald-600 py-3 text-xs font-semibold text-white"
              >
                Start Path Here
              </button>
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard?.writeText(
                    `${window.location.origin}/mapper?pinId=${selectedPin.id}&lat=${selectedPin.lat}&lng=${selectedPin.lng}`
                  );
                  setSelectedPin(null);
                  showToast('Link copied');
                }}
                className="rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-3 text-xs font-semibold text-slate-700"
              >
                Share
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Inspect Photo Pin Modal */}
      {selectedPhotoPin && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Photo pin details"
          className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/40"
          onClick={() => setSelectedPhotoPin(null)}
        >
          <div
            className="w-full max-w-lg rounded-t-3xl border-t border-slate-200 bg-white p-5 pb-[max(1.5rem,env(safe-area-inset-bottom))]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-start justify-between gap-2">
              <div>
                <span className="rounded-md border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-sky-700">
                  {selectedPhotoPin.category}
                </span>
                <h2 className="mt-1 text-base font-semibold text-balance">
                  {selectedPhotoPin.label || 'Road view photo'}
                </h2>
                <p className="text-xs text-slate-500 tabular-nums">
                  {selectedPhotoPin.scout_name ? `Mapped by ${selectedPhotoPin.scout_name}, ` : ''}
                  heading {selectedPhotoPin.heading ?? '--'}°
                </p>
              </div>
              {confirmDeleteId === selectedPhotoPin.id ? (
                <button
                  type="button"
                  onClick={() => handleDeletePhotoPin(selectedPhotoPin.id)}
                  className="rounded-xl bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white"
                >
                  Confirm Delete
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmDeleteId(selectedPhotoPin.id)}
                  className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-medium text-rose-700"
                >
                  Delete Pin
                </button>
              )}
            </div>
            {selectedPhotoPin.image_url && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={selectedPhotoPin.image_url}
                alt={selectedPhotoPin.label ?? 'Campus pin'}
                className="mb-3 h-44 w-full rounded-2xl object-cover"
              />
            )}
            <button
              type="button"
              onClick={() => setSelectedPhotoPin(null)}
              className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2.5 text-xs font-semibold text-slate-800"
            >
              Close
            </button>
          </div>
        </div>
      )}

      {/* Inspect Mapped Path Modal */}
      {selectedPath && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Mapped path details"
          className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/40"
          onClick={() => setSelectedPath(null)}
        >
          <div
            className="w-full max-w-lg rounded-t-3xl border-t border-slate-200 bg-white p-5 pb-[max(1.5rem,env(safe-area-inset-bottom))]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-start justify-between gap-2">
              <div>
                <span className="rounded-md border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-sky-700 tabular-nums">
                  {selectedPath.distance_m}m route
                </span>
                <h2 className="mt-1 text-base font-semibold text-balance">
                  {selectedPath.name || 'Campus footpath'}
                </h2>
                <p className="text-xs text-slate-500 tabular-nums">
                  Mapped by {selectedPath.scout_name} in {selectedPath.zone.split(':')[0]} ({selectedPath.coordinates.length} points)
                </p>
              </div>
              {confirmDeleteId === selectedPath.id ? (
                <button
                  type="button"
                  onClick={() => handleDeletePath(selectedPath.id)}
                  className="rounded-xl bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white"
                >
                  Confirm Delete
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmDeleteId(selectedPath.id)}
                  className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-medium text-rose-700"
                >
                  Delete Path
                </button>
              )}
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  const coords = selectedPath.coordinates;
                  if (coords.length < 2) return;
                  const startPt = coords[0];
                  const endPt = coords[coords.length - 1];
                  const target =
                    userCoord && haversineMeters(userCoord, startPt) < haversineMeters(userCoord, endPt)
                      ? startPt
                      : endPt;
                  const label = selectedPath.name || 'Campus footpath';
                  setSelectedPath(null);
                  if (userCoord && haversineMeters(userCoord, target) <= 6) {
                    handleStartPath(target);
                  } else {
                    setGuidePin(null);
                    setGuideFrontier({ coord: target, label });
                    setFocusCoord(target);
                    showToast('Follow the dashed guide line to continue from this end');
                  }
                }}
                className="flex-[2] rounded-xl bg-emerald-600 py-2.5 text-xs font-semibold text-white"
              >
                Continue from End
              </button>
              <button
                type="button"
                onClick={() => setSelectedPath(null)}
                className="flex-1 rounded-xl border border-slate-200 bg-slate-50 py-2.5 text-xs font-semibold text-slate-800"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Inspect Unfinished Path Endpoint (Frontier Ring) Modal */}
      {selectedFrontier && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Unfinished path endpoint"
          className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/40"
          onClick={() => setSelectedFrontier(null)}
        >
          <div
            className="w-full max-w-lg rounded-t-3xl border-t border-slate-200 bg-white p-5 pb-[max(1.5rem,env(safe-area-inset-bottom))]"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="mb-1 text-base font-semibold text-balance">Continue mapping from here</h2>
            <p className="mb-4 text-xs text-pretty text-slate-500 tabular-nums">
              Unfinished path endpoint (
              {userCoord
                ? `${Math.round(haversineMeters(userCoord, selectedFrontier.coord))}m away`
                : 'distance unknown'}
              ). Starting here connects seamlessly to the existing route.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  const target = selectedFrontier;
                  setSelectedFrontier(null);
                  setGuidePin(null);
                  setGuideFrontier({ coord: target.coord, label: 'Unfinished path end' });
                  setFocusCoord(target.coord);
                  showToast('Follow the dashed guide line to this endpoint');
                }}
                className="flex-1 rounded-xl border border-slate-200 bg-slate-50 py-3 text-xs font-semibold text-slate-900"
              >
                Guide Me Here
              </button>
              <button
                type="button"
                onClick={() => {
                  const target = selectedFrontier;
                  setSelectedFrontier(null);
                  handleStartPath(target.coord);
                }}
                className="flex-1 rounded-xl bg-emerald-600 py-3 text-xs font-semibold text-white"
              >
                Start Path Here
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Auto-Arrival at Guided Path Endpoint Modal */}
      {arrivedFrontier && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Arrived at path endpoint"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-5"
        >
          <div className="w-full max-w-sm rounded-3xl border border-slate-200 bg-white p-5 text-center shadow-xl">
            <h2 className="mb-1 text-base font-semibold text-balance text-emerald-600">Arrived at path end</h2>
            <p className="mb-4 text-xs text-pretty text-slate-700">
              Start recording seamlessly from the end of {arrivedFrontier.label}?
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setArrivedFrontier(null)}
                className="flex-1 rounded-2xl border border-slate-200 bg-slate-50 py-3 text-xs font-semibold text-slate-800"
              >
                Later
              </button>
              <button
                type="button"
                onClick={() => {
                  const target = arrivedFrontier;
                  setArrivedFrontier(null);
                  handleStartPath(target.coord);
                }}
                className="flex-[2] rounded-2xl bg-emerald-600 py-3 text-sm font-semibold text-white"
              >
                Start Path Here
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Crash / Tab-Reload Walk Recovery Modal */}
      {recoveredDraft && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Recover unsaved walk"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-5"
        >
          <div className="w-full max-w-sm rounded-3xl border border-slate-200 bg-white p-5 shadow-xl">
            <h2 className="mb-1 text-base font-semibold text-balance">Recover unsaved walk?</h2>
            <p className="mb-4 text-xs text-pretty text-slate-500 tabular-nums">
              Found an unsaved path ({calculatePathDistance(recoveredDraft.activePath)}m, {recoveredDraft.activePath.length} points) from before the page reloaded.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  clearWalkDraft();
                  setRecoveredDraft(null);
                  showToast('Discarded previous unsaved walk');
                }}
                className="flex-1 rounded-xl border border-slate-200 bg-slate-50 py-2.5 text-xs font-semibold text-slate-700"
              >
                Discard
              </button>
              <button
                type="button"
                onClick={() => {
                  const d = recoveredDraft;
                  setRecoveredDraft(null);
                  startSnapMetaRef.current = d.startSnapMeta ?? {};
                  anchorCoordRef.current = d.anchorCoord ?? d.activePath[d.activePath.length - 1];
                  activePathRef.current = d.activePath;
                  setActivePath(d.activePath);
                  setPathDistance(calculatePathDistance(d.activePath));
                  recStateRef.current = 'PAUSED';
                  setRecState('PAUSED');
                  setFocusCoord(d.activePath[d.activePath.length - 1]);
                  showToast('Walk recovered (paused) — tap Resume or Save');
                }}
                className="flex-[2] rounded-xl bg-emerald-600 py-2.5 text-xs font-semibold text-white"
              >
                Recover Walk
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Pause-Jump Guard Modal */}
      {pauseJumpPrompt && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Moved while paused"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-5"
        >
          <div className="w-full max-w-sm rounded-3xl border border-slate-200 bg-white p-5 shadow-xl">
            <h2 className="mb-1 text-base font-semibold text-balance tabular-nums">
              You moved {pauseJumpPrompt.distance}m while paused
            </h2>
            <p className="mb-4 text-xs text-pretty text-slate-500">
              Resuming here would draw a straight jump line across the gap. Save the previous segment first instead?
            </p>
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => {
                  setPauseJumpPrompt(null);
                  handleOpenSavePathSheet();
                }}
                className="w-full rounded-xl bg-emerald-600 py-2.5 text-xs font-semibold text-white"
              >
                Save Previous Segment First
              </button>
              <button
                type="button"
                onClick={() => {
                  setPauseJumpPrompt(null);
                  recStateRef.current = 'RECORDING';
                  setRecState('RECORDING');
                }}
                className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2.5 text-xs font-semibold text-slate-800"
              >
                Connect Across Gap Anyway
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Auto-Arrival Trigger Modal */}
      {arrivedPin && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Arrived at shortcut"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-5"
        >
          <div className="w-full max-w-sm rounded-3xl border border-slate-200 bg-white p-5 text-center shadow-xl">
            <h2 className="mb-1 text-base font-semibold text-balance text-emerald-600">Arrived at shortcut</h2>
            <p className="mb-4 text-xs text-pretty text-slate-700">
              {arrivedPin.note ? `"${arrivedPin.note}" — ` : ''}Start recording from this exact junction?
            </p>
            <button
              type="button"
              onClick={async () => {
                const pin = arrivedPin;
                setArrivedPin(null);
                if (simModeRef.current || pin.id.startsWith('sim-')) {
                  setJunctionPins((prev) => prev.map((p) => (p.id === pin.id ? { ...p, status: 'done' } : p)));
                } else {
                  await supabase.from('junction_pins').update({ status: 'done' }).eq('id', pin.id);
                }
                handleStartPath([pin.lng, pin.lat]);
              }}
              className="w-full rounded-2xl bg-emerald-600 py-3 text-sm font-semibold text-white"
            >
              Start Path Here
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function MapperPage() {
  return (
    <Suspense fallback={<div className="flex h-dvh items-center justify-center bg-white text-sm text-slate-600">Loading Mapper...</div>}>
      <MapperScreen />
    </Suspense>
  );
}

async function savePathRpc(payload: Extract<QueuedItem, { type: 'path' }>['payload']) {
  const { error } = await supabase.rpc('save_path_with_split', {
    p_scout_name: payload.scout_name,
    p_zone: payload.zone,
    p_coordinates: payload.coordinates,
    p_distance_m: payload.distance_m,
    p_split_path_id: payload.split_path_id ?? null,
    p_split_segment_idx: payload.split_segment_idx ?? null,
    p_split_coord: payload.split_coord ?? null,
    p_end_split_path_id: payload.end_split_path_id ?? null,
    p_end_split_segment_idx: payload.end_split_segment_idx ?? null,
    p_end_split_coord: payload.end_split_coord ?? null,
    p_name: payload.name ?? null,
  });
  if (!error) return;

  // Fallback to 7-arg RPC if database function hasn't been updated with new columns yet
  const { error: fallbackErr } = await supabase.rpc('save_path_with_split', {
    p_scout_name: payload.scout_name,
    p_zone: payload.zone,
    p_coordinates: payload.coordinates,
    p_distance_m: payload.distance_m,
    p_split_path_id: payload.split_path_id ?? null,
    p_split_segment_idx: payload.split_segment_idx ?? null,
    p_split_coord: payload.split_coord ?? null,
  });
  if (fallbackErr) throw fallbackErr;
}

async function uploadPhotoRecord(
  blob: Blob,
  payload: Extract<QueuedItem, { type: 'photo' }>['payload']
) {
  const safeZone = payload.zone.split(':')[0].replace(/\s+/g, '-').toLowerCase();
  const safeScout = payload.scout_name.replace(/[^a-zA-Z0-9_-]/g, '_') || 'scout';
  const path = `${safeZone}/${Date.now()}_${safeScout}.webp`;
  const { error: upErr } = await supabase.storage
    .from('campus-photos')
    .upload(path, blob, { contentType: 'image/webp', upsert: true });
  if (upErr) {
    console.warn('Supabase storage upload failed:', upErr.message);
    throw upErr;
  }

  const { data } = supabase.storage.from('campus-photos').getPublicUrl(path);
  const { error: dbErr } = await supabase.from('pins').insert({ ...payload, image_url: data.publicUrl });
  if (dbErr) throw dbErr;
}

async function processQueuedItem(item: QueuedItem) {
  if (item.type === 'path') {
    await savePathRpc(item.payload);
  } else if (item.type === 'pin') {
    const { error } = await supabase.from('junction_pins').insert(item.payload);
    if (error) throw error;
  } else if (item.type === 'photo') {
    await uploadPhotoRecord(item.blob, item.payload);
  }
}
