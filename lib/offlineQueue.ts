import { Coord } from './geoPipeline';

export type QueuedItem =
  | {
      id: string;
      type: 'path';
      createdAt: number;
      payload: {
        scout_name: string;
        zone: string;
        name?: string | null;
        coordinates: Coord[];
        distance_m: number;
        split_path_id?: string | null;
        split_segment_idx?: number | null;
        split_coord?: Coord | null;
        end_split_path_id?: string | null;
        end_split_segment_idx?: number | null;
        end_split_coord?: Coord | null;
      };
    }
  | {
      id: string;
      type: 'pin';
      createdAt: number;
      payload: {
        lat: number;
        lng: number;
        created_by: string;
        note?: string;
      };
    }
  | {
      id: string;
      type: 'photo';
      createdAt: number;
      blob: Blob;
      payload: {
        lat: number;
        lng: number;
        accuracy: number | null;
        heading: number | null;
        category: string;
        label: string;
        scout_name: string;
        zone: string;
      };
    };

const DB_NAME = 'esut_mapper_offline_v2';
const STORE_NAME = 'queue';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function enqueueOffline(item: QueuedItem): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getQueuedItems(): Promise<QueuedItem[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () =>
      resolve((req.result as QueuedItem[]).sort((a, b) => a.createdAt - b.createdAt));
    req.onerror = () => reject(req.error);
  });
}

export async function removeQueuedItem(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
