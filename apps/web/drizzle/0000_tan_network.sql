CREATE SCHEMA "app";
--> statement-breakpoint
CREATE TABLE "app"."appraisals" (
	"id" text PRIMARY KEY NOT NULL,
	"card_id" bigint NOT NULL,
	"shard_token" text NOT NULL,
	"usdc_per_shard" bigint NOT NULL,
	"market_usd" numeric,
	"expires_at" bigint NOT NULL,
	"signature" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."collector_profiles" (
	"privy_did" text PRIMARY KEY NOT NULL,
	"wallet" text NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."market_prices" (
	"scryfall_id" text NOT NULL,
	"date" text NOT NULL,
	"usd" numeric,
	"usd_foil" numeric,
	"eur" numeric,
	CONSTRAINT "market_prices_scryfall_id_date_pk" PRIMARY KEY("scryfall_id","date")
);
--> statement-breakpoint
CREATE TABLE "app"."scan_drafts" (
	"id" text PRIMARY KEY NOT NULL,
	"vendor_wallet" text NOT NULL,
	"candidates" jsonb NOT NULL,
	"chosen_scryfall_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."scryfall_cache" (
	"scryfall_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"printed_name" text,
	"set_code" text NOT NULL,
	"set_name" text NOT NULL,
	"collector_number" text NOT NULL,
	"lang" text NOT NULL,
	"rarity" text NOT NULL,
	"colors" text[] DEFAULT '{}' NOT NULL,
	"type_line" text DEFAULT '' NOT NULL,
	"mana_value" numeric,
	"released_at" text,
	"image_normal" text DEFAULT '' NOT NULL,
	"image_small" text DEFAULT '' NOT NULL,
	"prices" jsonb NOT NULL,
	"finishes" text[] DEFAULT '{}' NOT NULL,
	"raw" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."tickets" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" integer NOT NULL,
	"subject" text NOT NULL,
	"nullifier" numeric(78, 0) NOT NULL,
	"expires_at" bigint NOT NULL,
	"signature" text NOT NULL,
	"domain" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."worldid_verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"nullifier" numeric(78, 0) NOT NULL,
	"action" text NOT NULL,
	"subject" text NOT NULL,
	"environment" text NOT NULL,
	"credential" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "worldid_nullifier_action" ON "app"."worldid_verifications" USING btree ("nullifier","action");