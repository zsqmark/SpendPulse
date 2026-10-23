/**
 * Units a wholesaler prints on an invoice, grouped by the level of the pack hierarchy they
 * sit at. A carton holds packs, a pack holds bags - the editor groups them so the user can
 * pick the right level instead of typing a spelling the matcher has never seen.
 */

export interface UnitOption {
  value: string;
  label: string;
  level: 'pack' | 'weight' | 'volume' | 'each';
}

export const UNIT_OPTIONS: UnitOption[] = [
  { value: 'ctn', label: 'ctn — carton / case', level: 'pack' },
  { value: 'case', label: 'case', level: 'pack' },
  { value: 'box', label: 'box', level: 'pack' },
  { value: 'pack', label: 'pack', level: 'pack' },
  { value: 'bag', label: 'bag', level: 'pack' },
  { value: 'tray', label: 'tray', level: 'pack' },
  { value: 'tin', label: 'tin / can', level: 'pack' },
  { value: 'tub', label: 'tub / pail', level: 'pack' },
  { value: 'bottle', label: 'bottle / jar', level: 'pack' },
  { value: 'roll', label: 'roll', level: 'pack' },
  { value: 'kg', label: 'kg — kilogram', level: 'weight' },
  { value: 'g', label: 'g — gram', level: 'weight' },
  { value: 'lb', label: 'lb — pound', level: 'weight' },
  { value: 'L', label: 'L — litre', level: 'volume' },
  { value: 'ml', label: 'mL — millilitre', level: 'volume' },
  { value: 'each', label: 'each / ea', level: 'each' },
];

/** How a base measure is written on screen. */
export function formatBaseUnit(baseUnit?: string | null): string {
  if (!baseUnit) return '';
  if (baseUnit === 'l') return 'L';
  if (baseUnit === 'ml') return 'mL';
  if (baseUnit === 'each') return 'ea';
  return baseUnit;
}

const WEIGHT_IN_KG: Record<string, number> = { kg: 1, g: 0.001, lb: 0.453592 };
const VOLUME_IN_L: Record<string, number> = { l: 1, ml: 0.001 };
const CARTON_WORDS = new Set(['case', 'carton', 'ctn', 'cs', 'box', 'tray', 'tin', 'tub', 'bottle', 'roll']);
const INNER_WORDS = new Set(['pack', 'bag', 'each', 'ea', 'unit', 'pc', 'pcs', 'pkt', 'pk']);

function canonical(unit?: string | null): string {
  return (unit || '').trim().toLowerCase().replace(/[.]+$/, '');
}

/** Mirrors the server parser: "10*1KG" / "3 x 4LT" / "700G" -> count, size, unit. */
function parsePack(packSize?: string | null): { count: number; size: number; unit: string } | null {
  const s = (packSize || '').toLowerCase().replace(/\s+/g, '').replace(/,/g, '');
  if (!s) return null;
  const compound = s.match(/^(\d+)\s*[*x/]\s*(\d+(?:\.\d+)?)([a-z]+)$/);
  if (compound) return { count: Number(compound[1]), size: Number(compound[2]), unit: compound[3] };
  const simple = s.match(/^(\d+(?:\.\d+)?)([a-z]+)$/);
  if (simple) return { count: 1, size: Number(simple[1]), unit: simple[2] };
  return null;
}

/**
 * Client-side mirror of the pack conversion, so the editor can show what a line works out
 * to per kilo or per litre BEFORE it is saved. Returns null when the numbers say nothing,
 * which is exactly the case where the price must not be compared.
 */
export function previewBasePrice(
  packSize?: string | null,
  unit?: string | null,
  unitPrice?: number | null
): number | null {
  if (unitPrice == null || !Number.isFinite(unitPrice) || unitPrice <= 0) return null;
  const parsed = parsePack(packSize);
  if (!parsed) return null;

  const u = canonical(parsed.unit);
  const weight = WEIGHT_IN_KG[u];
  const volume = VOLUME_IN_L[u];
  if (weight == null && volume == null) return null;

  const sizeInBase = weight != null ? weight : (volume as number);
  const onePack = parsed.size * sizeInBase;
  const perCarton = parsed.count * onePack;
  if (!(perCarton > 0)) return null;

  const target = canonical(unit);
  if (target in WEIGHT_IN_KG) {
    if (weight == null) return null;
    return unitPrice / WEIGHT_IN_KG[target];
  }
  if (target in VOLUME_IN_L) {
    if (volume == null) return null;
    return unitPrice / VOLUME_IN_L[target];
  }
  if (INNER_WORDS.has(target)) return unitPrice / onePack;
  if (CARTON_WORDS.has(target)) {
    // A single pack size says nothing about how many packs the carton holds.
    return parsed.count > 1 ? unitPrice / perCarton : null;
  }
  return null;
}

export function previewBaseUnit(packSize?: string | null): string | null {
  const parsed = parsePack(packSize);
  if (!parsed) return null;
  const u = canonical(parsed.unit);
  if (u in WEIGHT_IN_KG) return 'kg';
  if (u in VOLUME_IN_L) return 'l';
  return null;
}

/**
 * One-line description of the pack hierarchy a product compares on:
 * "1 ctn = 10 packs · 1 pack = 1 kg", or null when nothing is known.
 */
export function describePackHierarchy(
  conversions?: Record<string, number> | null,
  baseUnit?: string | null
): string | null {
  if (!conversions || !baseUnit) return null;
  const perCarton = conversions['case'] ?? conversions['carton'] ?? conversions['ctn'];
  const perPack = conversions['pack'] ?? conversions['bag'] ?? conversions['each'];
  const unit = formatBaseUnit(baseUnit);

  const trim = (n: number) => String(+n.toFixed(2));
  if (perCarton && perPack && perCarton > perPack) {
    return `1 ctn = ${trim(perCarton / perPack)} packs · 1 pack = ${trim(perPack)}${unit}`;
  }
  if (perPack) return `1 pack = ${trim(perPack)}${unit}`;
  return null;
}

/** "$1.20/kg" - the price every comparison is actually made on. */
export function formatBasePrice(baseUnitPrice?: number | null, baseUnit?: string | null): string {
  if (baseUnitPrice == null || !Number.isFinite(baseUnitPrice) || !baseUnit) return '';
  const unit = formatBaseUnit(baseUnit);
  const value =
    baseUnitPrice >= 1
      ? baseUnitPrice.toFixed(2)
      : baseUnitPrice >= 0.1
        ? baseUnitPrice.toFixed(3)
        : baseUnitPrice.toFixed(4);
  return `$${value}/${unit}`;
}
