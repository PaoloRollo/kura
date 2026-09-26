CREATE TABLE "app"."multibaas_deliveries" (
	"event_key" text PRIMARY KEY NOT NULL,
	"delivery_id" text NOT NULL,
	"event_name" text NOT NULL,
	"card_id" bigint,
	"status" text DEFAULT 'processing' NOT NULL,
	"outcome" text,
	"attempts" integer DEFAULT 1 NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
