/**
 * One copy of the catalogue, shared by every screen.
 *
 * The alert feed and the line detail panel used to be handed their own slices of data, and a
 * correction made in one place had no way to reach the other - a line whose unit was fixed in
 * the editor kept being reported with the old label by the alert that named it. Each screen
 * now reads the same snapshot, and any change to an item republishes it so both redraw together.
 *
 * Deliberately small: a snapshot, a subscriber list, and one write path. It holds no fetching
 * logic and knows nothing about React - `useSyncExternalStore` supplies the binding.
 */

import type {
  DashboardStats,
  Invoice,
  MasterProduct,
  PriceAlert,
  VendorSummary,
} from '../types/index.ts';

export interface CatalogSnapshot {
  invoices: Invoice[];
  products: MasterProduct[];
  alerts: PriceAlert[];
  vendors: VendorSummary[];
  stats: DashboardStats | null;
  alignmentConflicts: number;
  loading: boolean;
  /** Changes on every publish. Derived figures use it to know when to recompute. */
  revision: number;
}

const EMPTY: CatalogSnapshot = {
  invoices: [],
  products: [],
  alerts: [],
  vendors: [],
  stats: null,
  alignmentConflicts: 0,
  loading: true,
  revision: 0,
};

let snapshot: CatalogSnapshot = EMPTY;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of Array.from(listeners)) listener();
}

export function subscribeToCatalog(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getCatalogSnapshot(): CatalogSnapshot {
  return snapshot;
}

/**
 * The single write path.
 *
 * Replaces the whole object on every call, so a snapshot always describes one consistent
 * moment: a view never sees new invoices next to stale alerts.
 */
export function publishCatalog(next: Partial<CatalogSnapshot>): void {
  snapshot = { ...snapshot, ...next, revision: snapshot.revision + 1 };
  emit();
}

/** Fetches everything the app shows and republishes it as one snapshot. */
export async function refreshCatalog(
  fetcher: () => Promise<{
    invoices: Invoice[];
    products: MasterProduct[];
    alerts: PriceAlert[];
    vendors: VendorSummary[];
    stats: DashboardStats | null;
    alignmentConflicts: number;
  }>
): Promise<CatalogSnapshot> {
  const next = await fetcher();
  publishCatalog({ ...next, loading: false });
  return getCatalogSnapshot();
}
