/**
 * Dry run: what tag would every live product get under the new rule?
 *
 * Run with:  npx tsx scripts/simulate-labelling.ts
 *
 * Read-only. Fetches the catalogue and the invoices from the live API and prints the tag
 * each product would carry, grouped so a mass mislabelling would be obvious.
 */
import { labelForSpec } from '../src/lib/packUnitLabel.ts';

const BASE = 'https://api.malayacorner.com';

async function jget<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { 'Accept-Encoding': 'identity' } });
  return (await res.json()) as T;
}

type Product = {
  id: string;
  name: string;
  standardUnit?: string | null;
  standardPackSize?: string | null;
  category?: string | null;
};

type Line = {
  masterProductId?: string | null;
  rawDescription?: string | null;
  packSize?: string | null;
  unit?: string | null;
};

type Invoice = { id: string; items?: Line[] };

const products = await jget<Product[]>(BASE + '/api/catalog');
const list = Array.isArray(products) ? products : [];

const invoicesRes = await fetch(BASE + '/api/invoices', {
  headers: { 'Accept-Encoding': 'identity' },
});
const raw = await invoicesRes.text();
const ids = [...new Set(Array.from(raw.matchAll(/"id":"(inv-[^"]+)"/g), (m) => m[1]))];

// The most recent pack size each product was invoiced with.
const packByProduct = new Map<string, string>();
for (const id of ids) {
  const inv = await jget<Invoice>(`${BASE}/api/invoices/${id}`);
  for (const it of inv.items || []) {
    if (!it.masterProductId) continue;
    const spec = [it.packSize, it.rawDescription].filter(Boolean).join(' ').trim();
    if (spec) packByProduct.set(it.masterProductId, spec);
  }
}

const tally = new Map<string, string[]>();
for (const p of list) {
  const spec = p.standardPackSize || packByProduct.get(p.id) || '';
  const label = labelForSpec(spec);
  const bucket = `${label.unit} (${label.reason})`;
  if (!tally.has(bucket)) tally.set(bucket, []);
  tally.get(bucket)!.push(`${p.name}  [spec: ${spec || '(none)'}]`);
}

const total = list.length;
console.log(`Live catalogue: ${total} products\n`);
for (const [bucket, names] of [...tally.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${bucket} - ${names.length} product(s)`);
  const limit = bucket.startsWith('ea') ? names.length : 6;
  for (const n of names.slice(0, limit)) console.log(`      ${n}`);
  if (names.length > limit) console.log(`      ... and ${names.length - limit} more`);
  console.log('');
}
console.log(`total accounted for: ${[...tally.values()].reduce((s, a) => s + a.length, 0)} / ${total}`);
