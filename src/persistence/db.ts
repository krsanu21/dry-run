/**
 * Local persistence. Solutions and test cases live in IndexedDB in this
 * browser profile only; preferences live in localStorage. Nothing is sent
 * anywhere. Every access is wrapped so private windows / blocked storage
 * degrade to an in-memory session instead of breaking the app.
 */
import type { Prefs, Workspace } from "../ui/store";

const DB_NAME = "dry-run";
const DB_VERSION = 1;
const STORE = "solutions";
const CURRENT_KEY = "dry-run:current";
const PREFS_KEY = "dry-run:prefs";

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) return resolve(null);
        try {
          const req = fn(db.transaction(STORE, mode).objectStore(STORE));
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      }),
  );
}

export async function listSolutions(): Promise<Workspace[]> {
  const all = await tx<Workspace[]>("readonly", (s) => s.getAll() as IDBRequest<Workspace[]>);
  return (all ?? []).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function saveSolution(ws: Workspace): Promise<boolean> {
  const r = await tx("readwrite", (s) => s.put(ws));
  return r !== null;
}

export async function deleteSolution(id: string): Promise<void> {
  await tx("readwrite", (s) => s.delete(id));
}

export async function clearAllLocalData(): Promise<void> {
  await tx("readwrite", (s) => s.clear());
  try {
    localStorage.removeItem(CURRENT_KEY);
    localStorage.removeItem(PREFS_KEY);
  } catch {
    /* storage unavailable */
  }
}

export function loadCurrent(): Workspace | null {
  try {
    const raw = localStorage.getItem(CURRENT_KEY);
    if (!raw) return null;
    const ws = JSON.parse(raw) as Workspace;
    return ws && typeof ws.source === "string" && Array.isArray(ws.tests) && ws.tests.length ? ws : null;
  } catch {
    return null;
  }
}

export function saveCurrent(ws: Workspace): void {
  try {
    localStorage.setItem(CURRENT_KEY, JSON.stringify(ws));
  } catch {
    /* storage unavailable or full */
  }
}

export function loadPrefs(): Partial<Prefs> | null {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return raw ? (JSON.parse(raw) as Partial<Prefs>) : null;
  } catch {
    return null;
  }
}

export function savePrefs(p: Prefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}
