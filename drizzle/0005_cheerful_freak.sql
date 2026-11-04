CREATE TABLE "strava_activities" (
	"user_id" text NOT NULL,
	"activity_id" bigint NOT NULL,
	"name" text NOT NULL,
	"sport_type" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"local_date" text NOT NULL,
	"elapsed_seconds" integer NOT NULL,
	"device_name" text,
	"device_watts" boolean DEFAULT false NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "strava_activities_user_id_activity_id_pk" PRIMARY KEY("user_id","activity_id")
);
--> statement-breakpoint
CREATE TABLE "strava_connections" (
	"user_id" text PRIMARY KEY NOT NULL,
	"athlete_id" bigint NOT NULL,
	"access_token" text NOT NULL,
	"refresh_token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"scope" text NOT NULL,
	"list_page" integer DEFAULT 1 NOT NULL,
	"list_complete" boolean DEFAULT false NOT NULL,
	"paused_until" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "strava_connections_athlete_id_unique" UNIQUE("athlete_id")
);
--> statement-breakpoint
ALTER TABLE "rides" ADD COLUMN "source" text DEFAULT 'file' NOT NULL;--> statement-breakpoint
ALTER TABLE "rides" ADD COLUMN "strava_activity_id" bigint;--> statement-breakpoint
ALTER TABLE "strava_activities" ADD CONSTRAINT "strava_activities_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strava_connections" ADD CONSTRAINT "strava_connections_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "strava_activities_queue_idx" ON "strava_activities" USING btree ("user_id","state","priority","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "rides_user_strava_idx" ON "rides" USING btree ("user_id","strava_activity_id");