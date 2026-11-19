import { z } from 'zod';
import { isPastOrToday } from './portfolio-io.js';

/** Request shapes, validated with zod before anything reaches the store. */

export const periodSchema = z.enum(['1d', '1w', '1m', '3m', '1y']).default('1w');
export const rangeSchema = z.enum(['1m', '3m', '6m', '1y']).default('3m');

/** NSE/BSE tickers (INFY.NS), indices are not accepted; mutual funds are "MF:" plus their AMFI scheme code. */
export const symbolSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^(?:MF:\d{3,8}|[A-Z0-9&.-]{1,20})$/, 'invalid symbol');
export const positive = z.number().finite().positive().max(1e12);

// Optional purchase date: a real YYYY-MM-DD date that is not in the future. null clears it on update.
export const purchaseDateSchema = z
  .string()
  .refine(isPastOrToday, 'purchase date must be a valid date, not in the future')
  .nullable()
  .optional();

const portfolioIdSchema = z.number().int().positive().optional();

// On add, quantity or invested may be left out when a purchase date is given: the missing one is worked out from that day's close.
export const holdingSchema = z.object({
  symbol: symbolSchema,
  quantity: positive.optional(),
  invested: positive.optional(),
  purchaseDate: purchaseDateSchema,
  // Set once the user has agreed to add this purchase to a stock they already hold.
  merge: z.boolean().optional(),
  portfolioId: portfolioIdSchema,
});
export const holdingUpdateSchema = z.object({ quantity: positive, invested: positive, purchaseDate: purchaseDateSchema });
export const moveSchema = z.object({ portfolioId: z.number().int().positive() });
export const sellSchema = z.object({
  quantity: positive,
  salePrice: positive,
  // Brokerage, STT and other charges on the sale; reduces the profit.
  charges: z.number().finite().min(0).max(1e12).default(0),
  saleDate: z.string().refine(isPastOrToday, 'sale date must be a valid date, not in the future'),
});
const dropRuleSchema = z.object({
  kind: z.literal('drop').default('drop'),
  symbol: symbolSchema.nullable().optional(),
  window: z.enum(['1d', '1w', '1m', 'high52']),
  thresholdPct: z.number().finite().positive().lt(100),
});
// A price target needs a stock you hold, and a price to compare against.
const priceRuleSchema = z.object({
  kind: z.literal('price'),
  symbol: symbolSchema,
  direction: z.enum(['above', 'below']),
  targetPrice: z.number().finite().positive().max(1e9),
});
export const ruleSchema = z.union([priceRuleSchema, dropRuleSchema]);
export const ruleUpdateSchema = z.object({
  thresholdPct: z.number().finite().positive().lt(100).optional(),
  targetPrice: z.number().finite().positive().max(1e9).optional(),
  enabled: z.boolean(),
});
export const settingsSchema = z
  .object({ alertEmail: z.boolean().optional(), weeklyDigest: z.boolean().optional() })
  .refine((s) => s.alertEmail !== undefined || s.weeklyDigest !== undefined, 'nothing to change');
const noteSchema = z.string().trim().max(200, 'keep the note under 200 characters');
export const watchSchema = z.object({ symbol: symbolSchema, note: noteSchema.default('') });
export const watchUpdateSchema = z.object({ note: noteSchema });
// Every `denominator` shares became `numerator` (a 1:1 bonus is 2 for 1).
export const splitRatioSchema = z
  .object({
    numerator: z.number().finite().positive().max(1000),
    denominator: z.number().finite().positive().max(1000),
  })
  .refine((r) => r.numerator !== r.denominator, 'a split must change the number of shares');
export const portfolioNameSchema = z.object({
  name: z.string().trim().min(1, 'give the portfolio a name').max(40, 'keep the name under 40 characters'),
});
// Target share per sector. Together they may not exceed 100%.
export const targetsSchema = z.object({
  targets: z
    .array(z.object({ sector: z.string().trim().min(1).max(60), pct: z.number().finite().positive().max(100) }))
    .max(30)
    .refine((ts) => new Set(ts.map((t) => t.sector)).size === ts.length, 'each sector can have one target')
    .refine((ts) => ts.reduce((s, t) => s + t.pct, 0) <= 100.0001, 'targets add up to more than 100%'),
});
