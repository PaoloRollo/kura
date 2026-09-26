CREATE TABLE "app"."ens_appraisal_writes" (
	"card_id" bigint PRIMARY KEY NOT NULL,
	"usd" numeric NOT NULL,
	"at" bigint NOT NULL,
	"tx_hash" text
);
