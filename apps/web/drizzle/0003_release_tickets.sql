CREATE TABLE "app"."release_tickets" (
	"id" text PRIMARY KEY NOT NULL,
	"card_id" bigint NOT NULL,
	"subject" text NOT NULL,
	"nullifier" numeric(78, 0) NOT NULL,
	"expires_at" bigint NOT NULL,
	"signature" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "release_tickets_card_status" ON "app"."release_tickets" USING btree ("card_id","status");