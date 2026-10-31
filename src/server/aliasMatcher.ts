import { Type } from '@google/genai';
import { generateJson } from './llm/index.ts';
import { db } from './storage.ts';
import { MasterProduct } from '../types/index.ts';
import { learnPackHierarchy } from './productUnits.ts';
import { buildUnitConversions, measureClassOf, measuresConflict } from './unitConversion.ts';

export interface MatchResult {
  masterProductId: string | null;
  masterProductName: string | null;
  confidence: number;
  matchTier: 'sku_exact' | 'rule_pack_match' | 'ai_semantic' | 'manual';
  needsMappingReview: boolean;
  reasoning: string;
  suggestedName?: string;
  suggestedCategory?: string;
  /** True for charges that are not products (delivery, fuel, tax, fees) - excluded from the catalog. */
  isNonProduct?: boolean;
  confidenceBreakdown: {
    skuMatch: boolean;
    packMatch: boolean;
    nameScore: number;
  };
}

export interface MatchInputItem {
  id: string;
  rawDescription: string;
  supplierSku?: string | null;
  brand?: string | null;
  packSize?: string | null;
  unit: string;
  unitPrice: number;
}

// Common wholesale & inventory abbreviation dictionary
const ABBREVIATIONS: Record<string, string> = {
  '#': ' lb ',
  '50#': ' 50 lb ',
  '35#': ' 35 lb ',
  '25#': ' 25 lb ',
  '10#': ' 10 lb ',
  'ap': ' all purpose ',
  'flr': ' flour ',
  'crm': ' cream ',
  'hvy': ' heavy ',
  'whip': ' whipping ',
  'whipping': ' whipping ',
  'qt': ' quart ',
  'cs': ' case ',
  'ea': ' each ',
  'gal': ' gallon ',
  '1gl': ' 1 gallon ',
  'gran': ' granulated ',
  'cane': ' cane ',
  'can': ' cane ',
  'sug': ' sugar ',
  'org': ' organic ',
  'dz': ' dozen ',
  'doz': ' dozen ',
  'ct': ' count ',
  'jib': ' jib box ',
  'deg': ' degreaser ',
  'wh': ' white ',
  'clr': ' clear ',
  'poly': ' polyethylene ',
  'bl': ' bleached ',
  'unbl': ' unbleached ',
};

export function normalizePackSize(str?: string | null): string {
  if (!str) return '';
  return str
    .toLowerCase()
    .replace(/#/g, ' lb')
    .replace(/lbs\b/g, 'lb')
    .replace(/gallons\b|gals\b/g, 'gal')
    .replace(/quarts\b|qts\b/g, 'qt')
    .replace(/\s+/g, ' ')
    .trim();
}

export function arePackSizesCompatible(packA?: string | null, packB?: string | null): boolean {
  const normA = normalizePackSize(packA);
  const normB = normalizePackSize(packB);
  if (!normA || !normB) return true; // not enough info to disqualify
  if (normA === normB) return true;

  // Extract primary digits and units (also handles split packs like "4/1 gal", "12/32 oz")
  const matchA = normA.match(/(\d+)(?:\s*\/\s*\d+)?\s*([a-z]+)/);
  const matchB = normB.match(/(\d+)(?:\s*\/\s*\d+)?\s*([a-z]+)/);
  if (matchA && matchB) {
    if (matchA[2] === matchB[2] && matchA[1] !== matchB[1]) {
      // Same unit but different quantity (e.g. 50 lb vs 25 lb, 4/1 gal vs 2/1 gal) -> Conflict!
      return false;
    }
  }
  return true;
}

export function normalizeTokens(str: string): Set<string> {
  let s = str.toLowerCase();
  for (const [abbr, expanded] of Object.entries(ABBREVIATIONS)) {
    s = s.replace(new RegExp(`\\b${abbr}\\b`, 'g'), expanded);
  }
  s = s.replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const tokens = s.split(' ').filter((w) => w.length > 1);
  return new Set(tokens);
}

/**
 * Collapses the many spellings of the same unit that OCR picks up across invoice pages
 * ("CTN", "carton", "cs", "case" all mean a case).
 */
export function canonicalUnit(unit?: string | null): string {
  const u = (unit || '').trim().toLowerCase().replace(/[.]+$/, '');
  if (!u) return '';
  if (['ctn', 'ctns', 'carton', 'cartons', 'cs', 'case', 'cases', 'ctn '].includes(u)) return 'case';
  if (['ea', 'each', 'unit', 'units', 'pc', 'pcs', 'piece', 'pieces', 'item', 'items'].includes(u))
    return 'each';
  if (['kg', 'kgs', 'kilo', 'kilos', 'kilogram', 'kilograms'].includes(u)) return 'kg';
  if (['g', 'gr', 'gm', 'gram', 'grams'].includes(u)) return 'g';
  if (['lb', 'lbs', 'pound', 'pounds', '#'].includes(u)) return 'lb';
  if (['l', 'lt', 'ltr', 'litre', 'liter', 'litres', 'liters'].includes(u)) return 'l';
  if (['ml', 'mls', 'millilitre', 'milliliter'].includes(u)) return 'ml';
  if (['bag', 'bags'].includes(u)) return 'bag';
  if (['box', 'boxes', 'bx'].includes(u)) return 'box';
  if (['pack', 'packs', 'pkt', 'pk', 'packet', 'packets'].includes(u)) return 'pack';
  if (['tray', 'trays'].includes(u)) return 'tray';
  if (['roll', 'rolls'].includes(u)) return 'roll';
  if (['tin', 'tins', 'can', 'cans'].includes(u)) return 'tin';
  if (['tub', 'tubs', 'pail', 'pails', 'bucket', 'buckets', 'drum', 'drums'].includes(u)) return 'tub';
  if (['btl', 'bottle', 'bottles', 'jar', 'jars'].includes(u)) return 'bottle';
  return u;
}

/** Coarse measure basis - used to know whether two prices are comparable at all. */
export function unitMeasureClass(unit?: string | null): string {
  const c = canonicalUnit(unit);
  if (['kg', 'g', 'lb'].includes(c)) return 'weight';
  if (['l', 'ml', 'gal', 'qt'].includes(c)) return 'volume';
  if (c === 'each') return 'each';
  if (['case', 'bag', 'box', 'pack', 'tray', 'roll', 'tin', 'tub', 'bottle'].includes(c)) return 'case';
  return c || 'unknown';
}

/**
 * Scale weights such as "57.640" or "61.080kg" are per-delivery measurements the OCR
 * sometimes reads into the pack column - they are not pack configurations and must not
 * split otherwise identical products apart.
 */
export function normalizePackForIdentity(pack?: string | null): string {
  const p = normalizePackSize(pack);
  if (!p) return '';
  if (/^\d+\.\d{2,}/.test(p)) return '';
  return p;
}

/**
 * Stable identity key for "the same product": vendor-agnostic (deliberately ignores SKU,
 * because the same product carries different codes at each distributor).
 *
 * The invoicing unit is NOT part of the identity: OCR reads it inconsistently page to
 * page (ctn / ea / kg / cs for one and the same item), and including it used to scatter a
 * single product across several master products.
 */
export function itemGroupKey(item: {
  rawDescription: string;
  packSize?: string | null;
  unit?: string;
}): string {
  const tokens = Array.from(normalizeTokens(item.rawDescription)).sort().join(' ');
  return `${tokens}|pack:${normalizePackForIdentity(item.packSize)}`;
}

/**
 * Key for collapsing repeated rows *inside* one invoice. Unlike the catalog identity this
 * keeps the unit (canonicalised), because summing "3 kg" and "2 cartons" into one line
 * would produce a meaningless quantity and price.
 */
export function lineMergeKey(item: {
  rawDescription: string;
  packSize?: string | null;
  unit?: string;
}): string {
  const tokens = Array.from(normalizeTokens(item.rawDescription)).sort().join(' ');
  return `${tokens}|pack:${normalizePackForIdentity(item.packSize)}|unit:${canonicalUnit(item.unit)}`;
}

/** Charges that are not inventory items and should never become catalog products. */
const NON_PRODUCT_PATTERN =
  /^(?:.*\b(?:delivery|freight|fuel|surcharge|service\s*fee|late\s*fee|deposit|container|rebate|discount|credit|tax|gst|vat|rounding|admin\s*fee|handling|lease|rental|restocking)\b.*)$/i;

export function isNonProductLine(rawDescription: string): boolean {
  return NON_PRODUCT_PATTERN.test((rawDescription || '').trim());
}

/**
 * Products whose price only makes sense per kilogram. Kept as a constant because the
 * pricing layer keys off it - a rename here without a matching change there would
 * silently disable weight-based pricing.
 */
// Meat detection lives in src/lib/meatPricing.ts so the browser can use the very same
// rule - two copies of the keyword list would drift apart.
export { MEAT_CATEGORY } from '../lib/meatPricing.ts';
import { isMeatDescription, MEAT_CATEGORY } from '../lib/meatPricing.ts';
import { DEFAULT_CATEGORY } from '../lib/categories.ts';

/**
 * Words that place a line in a category, tried in this order.
 *
 * Meat is not in the list: it is decided by `isMeatDescription`, which vetoes the butchery
 * words when the line also names a plant or a spice. Filing `LEMON GRASS MINCE` and
 * `MEAT CURRY POWDER` as meat was the whole reason for that rule, so the meat test has to
 * be able to say "no" before the hints below get their turn.
 */
const CATEGORY_HINTS: Array<[RegExp, string]> = [
  [/\b(fish|salmon|prawn|shrimp|seafood|squid|crab|tuna|oyster|mussel|scallop)\b/i, 'Seafood'],
  [/\b(milk|cream|butter|cheese|yoghurt|yogurt|egg|dairy)\b/i, 'Dairy & Eggs'],
  [
    /\b(flour|sugar|rice|pasta|noodle|oil|salt|spice|curry|powder|seasoning|paste|stock|sauce|vinegar|baking|yeast|herb|cereal|bean|lentil|gelatine|gelatin|colouring|flavouring)\b/i,
    'Dry Goods',
  ],
  [
    /\b(tomato|lettuce|onion|potato|carrot|salad|fruit|vegetable|veg|apple|lemon\s*grass|lemongrass|lemon|garlic|ginger|chilli|chili|shallot|spring\s*onion|cabbage|broccoli|cauliflower|mushroom|cucumber|pumpkin|spinach|bean\s*sprout|avocado|mango|banana|pineapple)\b/i,
    'Produce',
  ],
  [/\b(frozen|ice\s*cream)\b/i, 'Frozen'],
  [/\b(detergent|cleaner|sanitiser|sanitizer|soap|bleach|degreaser|towel|napkin|glove|bag|wrap|foil|container)\b/i, 'Cleaning & Disposables'],
  [/\b(beer|wine|spirit|soft\s*drink|juice|coffee|tea|beverage|syrup)\b/i, 'Beverages'],
];

export function guessCategory(rawDescription: string): string {
  if (isMeatDescription(rawDescription)) return MEAT_CATEGORY;
  for (const [pattern, category] of CATEGORY_HINTS) {
    if (pattern.test(rawDescription)) return category;
  }
  return DEFAULT_CATEGORY;
}

export function calculateTokenSimilarity(setA: Set<string>, setB: Set<string>): number {
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  return (2 * intersection) / (setA.size + setB.size);
}

/**
 * Multi-Tier Deterministic Matcher (Tiers 1 & 2)
 * Tier 1: Deterministic Vendor SKU / Item Code Lookup
 * Tier 2: Pack-Size & Token Stem Normalizer
 */
export function matchItemMultiTierLocal(
  item: MatchInputItem,
  vendorName: string,
  masterProducts: MasterProduct[]
): {
  product: MasterProduct | null;
  confidence: number;
  matchTier: 'sku_exact' | 'rule_pack_match' | 'ai_semantic' | 'manual';
  reason: string;
  confidenceBreakdown: {
    skuMatch: boolean;
    packMatch: boolean;
    nameScore: number;
  };
} {
  const cleanRaw = item.rawDescription.trim().toLowerCase();
  const rawTokenSet = normalizeTokens(cleanRaw);
  const cleanSku = item.supplierSku?.trim().toLowerCase();
  const cleanPack = normalizePackSize(item.packSize);

  // -------------------------------------------------------------------------
  // TIER 1: DETERMINISTIC VENDOR SKU / ITEM CODE LOOKUP (100% Match)
  // -------------------------------------------------------------------------
  if (cleanSku) {
    for (const prod of masterProducts) {
      // 1. Direct Master Product SKU match
      if (prod.sku.toLowerCase() === cleanSku) {
        return {
          product: prod,
          confidence: 1.0,
          matchTier: 'sku_exact',
          reason: `Exact match on Master SKU #${prod.sku}`,
          confidenceBreakdown: { skuMatch: true, packMatch: true, nameScore: 1.0 },
        };
      }
      // 2. Supplier SKU in registered aliases
      const aliasSkuMatch = prod.vendorAliases.find(
        (a) =>
          a.supplierSku &&
          a.supplierSku.toLowerCase() === cleanSku &&
          (!a.vendorName || a.vendorName.toLowerCase() === vendorName.toLowerCase())
      );
      if (aliasSkuMatch) {
        return {
          product: prod,
          confidence: 1.0,
          matchTier: 'sku_exact',
          reason: `Matched registered ${vendorName} supplier SKU #${aliasSkuMatch.supplierSku}`,
          confidenceBreakdown: { skuMatch: true, packMatch: true, nameScore: 1.0 },
        };
      }
    }
  }

  // Exact Name or Exact Alias match
  for (const prod of masterProducts) {
    if (prod.name.toLowerCase() === cleanRaw) {
      return {
        product: prod,
        confidence: 1.0,
        matchTier: 'rule_pack_match',
        reason: 'Exact product name match',
        confidenceBreakdown: { skuMatch: false, packMatch: true, nameScore: 1.0 },
      };
    }
    const hasAlias = prod.vendorAliases.some(
      (a) => a.aliasName.trim().toLowerCase() === cleanRaw
    );
    if (hasAlias) {
      return {
        product: prod,
        confidence: 1.0,
        matchTier: 'rule_pack_match',
        reason: `Matched registered alias "${cleanRaw}" for vendor "${vendorName}"`,
        confidenceBreakdown: { skuMatch: false, packMatch: true, nameScore: 1.0 },
      };
    }
  }

  // What this line is priced by. Two products measured differently are different products
  // whatever the names say - see measureClassOf. Tier 1 matches below are the exception:
  // an exact vendor SKU or a name a human has already accepted is a fact, not a guess.
  const incomingMeasure = measureClassOf(item.packSize, item.unit);

  // -------------------------------------------------------------------------
  // TIER 2: PACK-SIZE & TOKEN STEM NORMALIZATION ENGINE
  // -------------------------------------------------------------------------
  let bestProduct: MasterProduct | null = null;
  let highestScore = 0;
  let bestReason = '';
  let bestPackCompatible = true;
  let bestRawNameScore = 0;

  for (const prod of masterProducts) {
    // Salt priced per kg must never absorb bleach priced per litre, however close their
    // descriptions sit. Skipped rather than penalised: no name score can justify it.
    const prodMeasure = measureClassOf(prod.standardPackSize, prod.standardUnit);
    if (measuresConflict(incomingMeasure, prodMeasure)) continue;

    const prodTokenSet = normalizeTokens(prod.name);
    let nameScore = calculateTokenSimilarity(rawTokenSet, prodTokenSet);

    // Also check token similarity with known aliases
    for (const alias of prod.vendorAliases) {
      const aliasTokenSet = normalizeTokens(alias.aliasName);
      const aliasScore = calculateTokenSimilarity(rawTokenSet, aliasTokenSet);
      if (aliasScore > nameScore) {
        nameScore = aliasScore;
      }
    }

    const packCompatible = arePackSizesCompatible(cleanPack, prod.standardPackSize);
    let finalScore = nameScore;

    if (!packCompatible) {
      // Strict penalty if pack sizes directly conflict (e.g. 50 lb vs 25 lb)
      finalScore = Math.max(0, finalScore - 0.40);
    } else if (cleanPack && prod.standardPackSize && normalizePackSize(prod.standardPackSize) === cleanPack) {
      // Pack size bonus for exact weight match
      finalScore = Math.min(0.99, finalScore + 0.12);
    }

    if (finalScore > highestScore) {
      highestScore = finalScore;
      bestProduct = prod;
      bestPackCompatible = packCompatible;
      bestRawNameScore = nameScore;
      bestReason = `Token similarity (${Math.round(nameScore * 100)}%)${
        cleanPack ? ` · Pack ${cleanPack} ${packCompatible ? 'verified' : 'mismatch'}` : ''
      }`;
    }
  }

  const roundedConfidence = Math.round(highestScore * 100) / 100;

  return {
    product: bestProduct,
    confidence: roundedConfidence,
    matchTier: 'rule_pack_match',
    reason: bestReason || 'Rule & token analysis',
    confidenceBreakdown: {
      skuMatch: false,
      packMatch: bestPackCompatible,
      nameScore: Math.round(bestRawNameScore * 100) / 100,
    },
  };
}

/**
 * Batch match all items from an invoice using the 3-Tier Waterfall:
 * Tier 1: Deterministic SKU Lookup (100%)
 * Tier 2: Pack-Size & Token Stem Normalizer (60-95%)
 * Tier 3: Batch AI Semantic Matcher (Single call for novel/ambiguous items)
 */
export async function batchMatchItems(
  items: MatchInputItem[],
  vendorName: string
): Promise<Record<string, MatchResult>> {
  const masterProducts = db.getMasterProducts();
  const results: Record<string, MatchResult> = {};
  const itemsNeedingAi: MatchInputItem[] = [];

  // Pass 1: Run Tier 1 & Tier 2 locally (0 API calls, <5ms)
  for (const it of items) {
    const local = matchItemMultiTierLocal(it, vendorName, masterProducts);

    if (local.confidence >= 0.85 && local.product) {
      // Auto-link high-confidence matches and record alias
      const exists = local.product.vendorAliases.some(
        (a) =>
          a.aliasName.toLowerCase() === it.rawDescription.toLowerCase() ||
          (it.supplierSku && a.supplierSku === it.supplierSku)
      );
      if (!exists) {
        local.product.vendorAliases.push({
          vendorName,
          aliasName: it.rawDescription.trim(),
          supplierSku: it.supplierSku || undefined,
          packSize: it.packSize || undefined,
          lastSeen: new Date().toISOString().split('T')[0],
        });
        db.saveMasterProduct(local.product);
      }

      results[it.id] = {
        masterProductId: local.product.id,
        masterProductName: local.product.name,
        confidence: local.confidence,
        matchTier: local.matchTier,
        needsMappingReview: false,
        reasoning: local.reason,
        confidenceBreakdown: local.confidenceBreakdown,
      };
    } else {
      // Probable (0.60 - 0.84) or Novel (< 0.60): Keep local best match ready, queue for AI verification
      results[it.id] = {
        masterProductId: local.product ? local.product.id : null,
        masterProductName: local.product ? local.product.name : null,
        confidence: local.confidence,
        matchTier: local.matchTier,
        needsMappingReview: true,
        reasoning: local.reason,
        suggestedName: local.product ? local.product.name : it.rawDescription,
        suggestedCategory: local.product ? local.product.category : 'General Supplies',
        confidenceBreakdown: local.confidenceBreakdown,
      };
      itemsNeedingAi.push(it);
    }
  }

  // Tier 3 needs both unresolved items and an existing catalog to compare against.
  if (itemsNeedingAi.length === 0 || masterProducts.length === 0) {
    autoGroupIdenticalItems(items, vendorName, results);
    return results;
  }

  // -------------------------------------------------------------------------
  // TIER 3: BATCH AI SEMANTIC MATCHING (Single DeepSeek Vision Call)
  // -------------------------------------------------------------------------
  try {
    const catalogSummary = masterProducts.map((p) => ({
      id: p.id,
      sku: p.sku,
      name: p.name,
      category: p.category,
      unit: p.standardUnit,
      standardPackSize: p.standardPackSize || 'standard',
      knownAliases: p.vendorAliases.map((a) => `${a.aliasName}${a.supplierSku ? ` (SKU: ${a.supplierSku})` : ''}`),
    }));

    const prompt = `
You are a wholesale master product catalog matching engine.
Supplier/Vendor: "${vendorName}"

Master Catalog:
${JSON.stringify(catalogSummary, null, 2)}

Line Items to Match:
${JSON.stringify(
  itemsNeedingAi.map((it) => ({
    id: it.id,
    rawDescription: it.rawDescription,
    supplierSku: it.supplierSku,
    brand: it.brand,
    packSize: it.packSize,
    unit: it.unit,
    unitPrice: it.unitPrice,
  })),
  null,
  2
)}

Task:
Reconcile each invoiced item to a master product in the catalog.
Consider SKU codes, pack weights/sizes (e.g. 50 lb vs 25 lb must not be merged), and culinary/wholesale synonyms.

HARD RULE - the measure must match:
An item priced BY WEIGHT (kg / g / lb) can only ever match a catalog product priced by weight.
An item priced BY VOLUME (L / mL / gal) can only ever match a product priced by volume.
An item priced BY THE CONTAINER (each / carton / ctn / bottle / tin) can only match a product priced the same way.
Judge the measure from the PACK SIZE first (20L is volume, 14KG is weight) and only fall back to the unit column when there is no pack size. If the measures differ, set matchedProductId to null even if the names look identical - bleach sold per 20 L is not salt sold per 14 kg.
Confidence Guidelines:
- >= 0.85: Confident match (identical goods, equivalent packaging)
- 0.60 - 0.84: Probable match (likely same ingredient or pack size requires human approval)
- < 0.60: Novel item not in catalog

Return JSON array with:
- id: item id
- matchedProductId: ID from master catalog or null
- confidence: 0.0 to 1.0
- skuMatch: boolean
- packMatch: boolean
- reasoning: concise explanation
- suggestedStandardName: cleaned canonical title if novel or unmatched
- suggestedCategory: recommended product category
`;

    const matchesArray = await generateJson<any[]>({
      messages: [{ role: 'user', parts: [{ type: 'text', text: prompt }] }],
      modelKind: 'text',
      maxOutputTokens: 8192,
      json: {
        name: 'catalog_matches',
        schema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              id: { type: Type.STRING },
              matchedProductId: { type: Type.STRING },
              confidence: { type: Type.NUMBER },
              skuMatch: { type: Type.BOOLEAN },
              packMatch: { type: Type.BOOLEAN },
              reasoning: { type: Type.STRING },
              suggestedStandardName: { type: Type.STRING },
              suggestedCategory: { type: Type.STRING },
            },
            required: ['id', 'confidence', 'reasoning'],
          },
        },
      },
    }).then((arr) => (Array.isArray(arr) ? arr : []));

    for (const match of matchesArray) {
      const it = itemsNeedingAi.find((x) => x.id === match.id);
      if (!it) continue;

      const conf = typeof match.confidence === 'number' ? match.confidence : 0.5;
      let matchedProd = match.matchedProductId
        ? masterProducts.find((p) => p.id === match.matchedProductId)
        : null;

      // The same guard as Tier 2, applied to the AI's suggestion: a candidate priced by a
      // different measure cannot be this product, whatever confidence the model reports.
      if (
        matchedProd &&
        measuresConflict(
          measureClassOf(it.packSize, it.unit),
          measureClassOf(matchedProd.standardPackSize, matchedProd.standardUnit)
        )
      ) {
        matchedProd = null;
      }

      const isAuto = conf >= 0.85 && !!matchedProd;

      if (isAuto && matchedProd) {
        // Auto-link Tier 3 high-confidence
        const exists = matchedProd.vendorAliases.some(
          (a) =>
            a.aliasName.toLowerCase() === it.rawDescription.toLowerCase() ||
            (it.supplierSku && a.supplierSku === it.supplierSku)
        );
        if (!exists) {
          matchedProd.vendorAliases.push({
            vendorName,
            aliasName: it.rawDescription.trim(),
            supplierSku: it.supplierSku || undefined,
            packSize: it.packSize || undefined,
            lastSeen: new Date().toISOString().split('T')[0],
          });
          db.saveMasterProduct(matchedProd);
        }

        results[it.id] = {
          masterProductId: matchedProd.id,
          masterProductName: matchedProd.name,
          confidence: conf,
          matchTier: 'ai_semantic',
          needsMappingReview: false,
          reasoning: match.reasoning || 'High-confidence AI semantic match',
          confidenceBreakdown: {
            skuMatch: Boolean(match.skuMatch),
            packMatch: Boolean(match.packMatch),
            nameScore: conf,
          },
        };
      } else {
        // Probable or novel item, route to review queue with detailed breakdown
        results[it.id] = {
          masterProductId: matchedProd ? matchedProd.id : null,
          masterProductName: matchedProd ? matchedProd.name : null,
          confidence: conf,
          matchTier: 'ai_semantic',
          needsMappingReview: true,
          reasoning: match.reasoning || (matchedProd ? 'Probable match awaiting 1-click verification' : 'Novel item detected'),
          suggestedName: match.suggestedStandardName || it.rawDescription,
          suggestedCategory: match.suggestedCategory || 'General Supplies',
          confidenceBreakdown: {
            skuMatch: Boolean(match.skuMatch),
            packMatch: Boolean(match.packMatch),
            nameScore: conf,
          },
        };
      }
    }
  } catch (err: any) {
    console.warn('[Tier3-BatchMatch] AI matching unavailable or quota reached. Gracefully keeping Tier 1 & 2 results:', err.message);
    // Tier 1 & 2 results are already safely in results[it.id]!
  }

  autoGroupIdenticalItems(items, vendorName, results);

  return results;
}

/**
 * Auto-grouping: every line item that is "the same product" collapses onto ONE master
 * product - the same item repeated inside an invoice, and the same item re-ordered from
 * a later invoice, without asking the user to approve a mapping.
 */
function autoGroupIdenticalItems(
  items: MatchInputItem[],
  vendorName: string,
  results: Record<string, MatchResult>
): void {
  const groups = new Map<string, MatchInputItem[]>();
  for (const it of items) {
    const key = itemGroupKey(it);
    const existing = groups.get(key);
    if (existing) existing.push(it);
    else groups.set(key, [it]);
  }

  for (const group of groups.values()) {
    // 1) Something in this group already resolved confidently -> apply it to every row.
    const resolved = group
      .map((it) => results[it.id])
      .find((r) => r && r.masterProductId && !r.needsMappingReview);

    if (resolved?.masterProductId) {
      const product = db.getMasterProduct(resolved.masterProductId);
      if (product) {
        for (const it of group) {
          results[it.id] = linkToProduct(product, it, vendorName, {
            confidence: resolved.confidence,
            matchTier: resolved.matchTier,
            reasoning: `Auto-grouped with identical item "${it.rawDescription}"`,
          });
        }
        continue;
      }
    }

    // 2) Charges that are not products stay out of the catalog entirely.
    if (isNonProductLine(group[0].rawDescription)) {
      for (const it of group) {
        results[it.id] = {
          masterProductId: null,
          masterProductName: null,
          confidence: 0,
          matchTier: 'manual',
          needsMappingReview: false,
          isNonProduct: true,
          reasoning: 'Non-product charge (fee / surcharge / tax) - excluded from catalog',
          confidenceBreakdown: { skuMatch: false, packMatch: false, nameScore: 0 },
        };
      }
      continue;
    }

    // 3) Nothing matched -> canonicalise into a new master product and link every row to it.
    const created = autoCreateMasterProduct(group, vendorName);
    for (const it of group) {
      results[it.id] = linkToProduct(created, it, vendorName, {
        confidence: 1,
        matchTier: 'rule_pack_match',
        reasoning: `Auto-grouped: ${group.length} identical line(s) canonicalised as "${created.name}"`,
      });
    }
    console.log(
      `[AutoGroup] Created master product "${created.name}" (${created.category}) from ${group.length} line(s) for ${vendorName}`
    );
  }
}

function linkToProduct(
  product: MasterProduct,
  item: MatchInputItem,
  vendorName: string,
  meta: { confidence: number; matchTier: MatchResult['matchTier']; reasoning: string }
): MatchResult {
  const aliasName = item.rawDescription.trim();

  // Every line is a chance to learn how many packs the carton holds.
  if (item.packSize) learnPackHierarchy(product, item.packSize);

  const exists = product.vendorAliases.some(
    (a) =>
      a.aliasName.toLowerCase() === aliasName.toLowerCase() ||
      (item.supplierSku && a.supplierSku === item.supplierSku)
  );
  if (!exists) {
    product.vendorAliases.push({
      vendorName,
      aliasName,
      supplierSku: item.supplierSku || undefined,
      packSize: item.packSize || undefined,
      lastSeen: new Date().toISOString().split('T')[0],
    });
    db.saveMasterProduct(product);
  }

  return {
    masterProductId: product.id,
    masterProductName: product.name,
    confidence: meta.confidence,
    matchTier: meta.matchTier,
    needsMappingReview: false,
    reasoning: meta.reasoning,
    confidenceBreakdown: { skuMatch: false, packMatch: true, nameScore: meta.confidence },
  };
}

function autoCreateMasterProduct(group: MatchInputItem[], vendorName: string): MasterProduct {
  const first = group[0];
  const name = first.rawDescription.replace(/\s+/g, ' ').trim() || 'Unnamed Product';
  const prices = group.map((g) => Number(g.unitPrice)).filter((p) => Number.isFinite(p) && p > 0);
  const unitPrice = prices.length ? prices[prices.length - 1] : 0;
  const today = new Date().toISOString().split('T')[0];

  const canonicalPack =
    group.map((g) => g.packSize).find((p) => buildUnitConversions(p) !== null) || first.packSize;

  const product: MasterProduct = {
    id: `mp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    sku: first.supplierSku?.trim() || `AUTO-${name.slice(0, 14).replace(/[^a-z0-9]+/gi, '-').toUpperCase()}`,
    name,
    category: guessCategory(name),
    categorySource: 'guessed',
    standardUnit: first.unit || 'ea',
    standardPackSize: canonicalPack || undefined,
    currentPrice: unitPrice,
    previousPrice: unitPrice,
    minPrice: prices.length ? Math.min(...prices) : unitPrice,
    maxPrice: prices.length ? Math.max(...prices) : unitPrice,
    lastPurchaseDate: today,
    primaryVendor: vendorName,
    vendorAliases: [],
    priceHistory: [],
  };

  // Teach it the pack hierarchy before any price is recorded, so the very first invoice
  // already stores a base-unit price that later invoices can be compared against.
  for (const g of group) learnPackHierarchy(product, g.packSize);

  db.saveMasterProduct(product);
  return product;
}

// Single-item wrapper
export async function matchOrCanonicalizeItem(
  rawDescription: string,
  vendorName: string,
  unit: string,
  supplierSku?: string | null,
  packSize?: string | null
): Promise<MatchResult> {
  const dummyId = 'single-item';
  const batchRes = await batchMatchItems(
    [{ id: dummyId, rawDescription, unit, unitPrice: 0, supplierSku, packSize }],
    vendorName
  );
  return batchRes[dummyId];
}
