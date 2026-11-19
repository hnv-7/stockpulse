import { isFund } from './mf.js';

/**
 * What kind of instrument a symbol is, and how India taxes it.
 *
 * 'equity': listed shares, and ETFs and funds that are equity-oriented (at least 65% in Indian shares): short-term up to
 * 12 months, the long-term exemption, the rates in TAX_RULES.
 * 'other': debt, gold, silver and international ETFs and funds, fund-of-funds and the like. Bought since April 2023 a
 * debt fund's gains are taxed at your slab rate whatever the holding period; others have a 24-month long-term period.
 * Stock Beat lists their gains but leaves them out of its tax estimate.
 */

/** Names that say a fund or ETF is not equity-oriented. */
const NOT_EQUITY =
  /\b(gold|silver|commodit\w*|liquid|overnight|gilt|g-?sec|sdl|bonds?|debt|money market|treasury|t-?bill|income|credit risk|duration|floater|floating|banking (?:and|&) psu|corporate bond|psu bond|fund of funds?|fof|overseas|international|global|nasdaq|s&p|hang seng|nyse|u\.?s\.?|world|emerging|china|japan|taiwan|europe|fang|conservative hybrid|multi asset)\b/i;

/** AMFI categories taxed as equity. */
const EQUITY_CATEGORY =
  /^equity scheme|arbitrage|aggressive hybrid|equity savings|balanced advantage|dynamic asset allocation/i;

/** Names that say a fund is equity-oriented, for when its category isn't known yet. */
const EQUITY_NAME =
  /\b(equity|elss|tax ?saver|flexi ?cap|large ?cap|mid ?cap|small ?cap|multi ?cap|focused|value|contra|dividend yield|bluechip|nifty|sensex|index|arbitrage|aggressive hybrid)\b/i;

/** 'stock', 'etf' or 'mf' from what is known: the stored kind, else the symbol and name. */
export function kindOf({ symbol, kind = null, name = '' }) {
  if (kind) return kind;
  if (isFund(symbol)) return 'mf';
  return /\bETF\b|BEES\b/i.test(name ?? '') || /BEES\.(NS|BO)$/.test(symbol) ? 'etf' : 'stock';
}

/** 'equity' or 'other' (see above). info: {kind, industry} from stock_info, where a fund's industry is its category. */
export function taxClass({ symbol, name = '', info = null }) {
  const kind = kindOf({ symbol, kind: info?.kind, name });
  if (kind === 'stock') return 'equity';
  const text = `${name ?? ''} ${info?.industry ?? ''}`;
  if (kind === 'etf') return NOT_EQUITY.test(text) ? 'other' : 'equity';
  const category = info?.industry ?? '';
  if (category) {
    if (EQUITY_CATEGORY.test(category)) return 'equity';
    // Index funds and ETFs bought as funds: equity unless they track gold, bonds, foreign markets...
    if (/index fund|other etfs?/i.test(category)) return NOT_EQUITY.test(text) ? 'other' : 'equity';
    return 'other';
  }
  return EQUITY_NAME.test(name ?? '') && !NOT_EQUITY.test(name ?? '') ? 'equity' : 'other';
}

/** classOf(symbol) for capitalGains / openPositions, from stored details and names. */
export function classifier(infoBySymbol, nameBySymbol) {
  const cache = new Map();
  return (symbol) => {
    if (!cache.has(symbol)) cache.set(symbol, taxClass({ symbol, name: nameBySymbol.get(symbol) ?? '', info: infoBySymbol.get(symbol) ?? null }));
    return cache.get(symbol);
  };
}
