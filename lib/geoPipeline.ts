import * as turf from '@turf/turf';

export type Coord = [number, number]; // [lng, lat]

export interface ExistingPath {
  id: string;
  coordinates: Coord[];
}

export interface SnapResult {
  coord: Coord;
  snapped: boolean;
  splitTargetPathId?: string;
  splitSegmentIdx?: number;
}

export function haversineMeters(a: Coord, b: Coord): number {
  return turf.distance(turf.point(a), turf.point(b), { units: 'meters' });
}

export function bearingDeg(a: Coord, b: Coord): number {
  const brng = turf.bearing(turf.point(a), turf.point(b));
  return (brng + 360) % 360;
}

export function angularDiffDeg(b1: number, b2: number): number {
  const diff = Math.abs(b1 - b2) % 360;
  return diff > 180 ? 360 - diff : diff;
}

export function calculatePathDistance(coords: Coord[]): number {
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    total += haversineMeters(coords[i - 1], coords[i]);
  }
  return Math.round(total);
}

export function processGpsPoint(params: {
  incoming: Coord;
  accuracy: number;
  timestamp: number;
  lastTimestamp: number | null;
  activePath: Coord[];
}): {
  accepted: boolean;
  reason?: 'low_accuracy' | 'jitter' | 'teleport';
  nextPath: Coord[];
  deltaMeters: number;
} {
  const { incoming, accuracy, timestamp, lastTimestamp, activePath } = params;

  if (accuracy > 15) {
    return { accepted: false, reason: 'low_accuracy', nextPath: activePath, deltaMeters: 0 };
  }

  if (activePath.length === 0) {
    return { accepted: true, nextPath: [incoming], deltaMeters: 0 };
  }

  const last = activePath[activePath.length - 1];
  const d = haversineMeters(last, incoming);

  if (d < 2.5) {
    return { accepted: false, reason: 'jitter', nextPath: activePath, deltaMeters: 0 };
  }

  if (lastTimestamp !== null && timestamp - lastTimestamp < 2000 && d > 40) {
    return { accepted: false, reason: 'teleport', nextPath: activePath, deltaMeters: 0 };
  }

  if (activePath.length >= 2) {
    const prev = activePath[activePath.length - 2];
    const b1 = bearingDeg(prev, last);
    const b2 = bearingDeg(last, incoming);
    const totalSpan = haversineMeters(prev, incoming);

    if (angularDiffDeg(b1, b2) < 5 && totalSpan < 8) {
      const nextPath = [...activePath.slice(0, -1), incoming];
      return { accepted: true, nextPath, deltaMeters: d };
    }
  }

  return { accepted: true, nextPath: [...activePath, incoming], deltaMeters: d };
}

export function findTopologicalSnap(
  current: Coord,
  junctionPins: { id: string; lng: number; lat: number }[],
  paths: ExistingPath[],
  radiusMeters = 6
): SnapResult {
  const pt = turf.point(current);
  let bestDist = radiusMeters;
  let result: SnapResult = { coord: current, snapped: false };

  for (const pin of junctionPins) {
    const d = haversineMeters(current, [pin.lng, pin.lat]);
    if (d <= bestDist) {
      bestDist = d;
      result = { coord: [pin.lng, pin.lat], snapped: true };
    }
  }

  for (const p of paths) {
    if (p.coordinates.length < 2) continue;
    for (const endpoint of [p.coordinates[0], p.coordinates[p.coordinates.length - 1]]) {
      const d = haversineMeters(current, endpoint);
      if (d <= bestDist) {
        bestDist = d;
        result = { coord: endpoint, snapped: true };
      }
    }
  }

  for (const p of paths) {
    if (p.coordinates.length < 2) continue;
    const line = turf.lineString(p.coordinates);
    const snapped = turf.nearestPointOnLine(line, pt, { units: 'meters' });
    const d = snapped.properties.dist ?? Infinity;

    if (d <= bestDist) {
      bestDist = d;
      result = {
        coord: snapped.geometry.coordinates as Coord,
        snapped: true,
        splitTargetPathId: p.id,
        splitSegmentIdx: snapped.properties.index,
      };
    }
  }

  return result;
}

export function suggestTurnLabel(recentPath: Coord[]): string {
  if (recentPath.length < 3) return 'Junction';
  const a = recentPath[recentPath.length - 3];
  const b = recentPath[recentPath.length - 2];
  const c = recentPath[recentPath.length - 1];
  const delta = ((bearingDeg(b, c) - bearingDeg(a, b) + 540) % 360) - 180;
  if (delta > 25) return 'Right Turn';
  if (delta < -25) return 'Left Turn';
  return 'Junction';
}
