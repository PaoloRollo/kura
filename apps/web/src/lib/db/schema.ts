import { bigint, index, integer, jsonb, numeric, pgSchema, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const app = pgSchema("app");

export type CandidateJson = {
  scryfallId: string;
  name: string;
  printedName: string | null;
  lang: string;
  set: string;
  setName: string;
  collectorNumber: string;
  rarity: string;
  image: string;
  imageSmall: string;
  prices: { usd: string | null; usdFoil: string | null; eur: string | null };
  finishes: string[];
  slug: string;
  setCode: string;
};

export const scanDrafts = app.table("scan_drafts", {
  id: text("id").primaryKey(),
  vendorWallet: text("vendor_wallet").notNull(),
  candidates: jsonb("candidates").$type<CandidateJson[]>().notNull(),
  chosenScryfallId: text("chosen_scryfall_id"),
  /** How the card was identified at the station. */
  method: text("method", { enum: ["embedding", "manual"] }).notNull().default("manual"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const scryfallCache = app.table("scryfall_cache", {
  scryfallId: text("scryfall_id").primaryKey(),
  name: text("name").notNull(),
  printedName: text("printed_name"),
  setCode: text("set_code").notNull(),
  setName: text("set_name").notNull(),
  collectorNumber: text("collector_number").notNull(),
  lang: text("lang").notNull(),
  rarity: text("rarity").notNull(),
  colors: text("colors").array().notNull().default([]),
  typeLine: text("type_line").notNull().default(""),
  manaValue: numeric("mana_value"),
  releasedAt: text("released_at"),
  imageNormal: text("image_normal").notNull().default(""),
  imageSmall: text("image_small").notNull().default(""),
  prices: jsonb("prices").$type<Record<string, string | null>>().notNull(),
  finishes: text("finishes").array().notNull().default([]),
  raw: jsonb("raw").notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).defaultNow().notNull(),
});

export const worldidVerifications = app.table(
  "worldid_verifications",
  {
    id: text("id").primaryKey(),
    nullifier: numeric("nullifier", { precision: 78, scale: 0 }).notNull(),
    action: text("action").notNull(),
    subject: text("subject").notNull(),
    environment: text("environment").notNull(),
    credential: text("credential"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("worldid_nullifier_action").on(t.nullifier, t.action)],
);

export const tickets = app.table("tickets", {
  id: text("id").primaryKey(),
  kind: integer("kind").notNull(),
  subject: text("subject").notNull(),
  nullifier: numeric("nullifier", { precision: 78, scale: 0 }).notNull(),
  expiresAt: bigint("expires_at", { mode: "bigint" }).notNull(),
  signature: text("signature").notNull(),
  domain: text("domain").notNull(), // "bidgate" | "vault"
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * A signed PASSPORT release ticket waiting for the vendor: the card's owner verified in their own session, and the vendor
 * station picks it up by card id. `status`: pending -> consumed (released, or refused on-chain) | cancelled | replaced.
 */
export const releaseTickets = app.table(
  "release_tickets",
  {
    id: text("id").primaryKey(),
    cardId: bigint("card_id", { mode: "bigint" }).notNull(),
    subject: text("subject").notNull(),
    nullifier: numeric("nullifier", { precision: 78, scale: 0 }).notNull(),
    expiresAt: bigint("expires_at", { mode: "bigint" }).notNull(),
    signature: text("signature").notNull(),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("release_tickets_card_status").on(t.cardId, t.status)],
);

export const appraisals = app.table("appraisals", {
  id: text("id").primaryKey(),
  cardId: bigint("card_id", { mode: "bigint" }).notNull(),
  shardToken: text("shard_token").notNull(),
  usdcPerShard: bigint("usdc_per_shard", { mode: "bigint" }).notNull(),
  marketUsd: numeric("market_usd"),
  /** Where the price came from ("Scryfall USD · foil · EN printing · NM ×1.00") and whether it was live or cached. */
  priceSource: text("price_source"),
  conditionMultiplier: numeric("condition_multiplier"),
  expiresAt: bigint("expires_at", { mode: "bigint" }).notNull(),
  signature: text("signature").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const marketPrices = app.table(
  "market_prices",
  {
    scryfallId: text("scryfall_id").notNull(),
    date: text("date").notNull(), // YYYY-MM-DD
    usd: numeric("usd"),
    usdFoil: numeric("usd_foil"),
    usdEtched: numeric("usd_etched"),
    eur: numeric("eur"),
  },
  (t) => [primaryKey({ columns: [t.scryfallId, t.date] })],
);

/**
 * The last ENS appraisal write per card, claimed under the card's advisory lock before the transaction is sent, so an
 * overlapping cron run, another instance or a buyout can't send a duplicate while the indexed record still lags.
 * `at` is unix seconds; `tx_hash` is null while the claimed write is being sent.
 */
export const ensAppraisalWrites = app.table("ens_appraisal_writes", {
  cardId: bigint("card_id", { mode: "bigint" }).primaryKey(),
  usd: numeric("usd").notNull(),
  at: bigint("at", { mode: "bigint" }).notNull(),
  txHash: text("tx_hash"),
});

/**
 * One row per MultiBaas-delivered log the webhook acts on (tx hash and log index), so a retried, duplicated or replayed
 * delivery is processed once. `status`: processing → done | failed; a failed row, or one stuck in processing past
 * DELIVERY_STALE_SEC, is claimed again by the next delivery (`attempts` counts claims).
 */
export const multibaasDeliveries = app.table("multibaas_deliveries", {
  eventKey: text("event_key").primaryKey(),
  deliveryId: text("delivery_id").notNull(),
  eventName: text("event_name").notNull(),
  cardId: bigint("card_id", { mode: "bigint" }),
  status: text("status").notNull().default("processing"),
  outcome: text("outcome"),
  attempts: integer("attempts").notNull().default(1),
  receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const collectorProfiles = app.table("collector_profiles", {
  privyDid: text("privy_did").primaryKey(),
  wallet: text("wallet").notNull(),
  label: text("label"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
