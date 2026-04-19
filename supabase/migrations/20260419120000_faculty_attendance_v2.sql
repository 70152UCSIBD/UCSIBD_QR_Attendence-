-- Faculty Attendance System v2.0 — core schema, RLS, and profile bootstrap
-- Apply in Supabase SQL Editor or via supabase db push

-- ---------------------------------------------------------------------------
-- Extensions (optional: pgcrypto for column-level encryption in production)
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE public.user_role AS ENUM ('faculty', 'admin', 'super_admin');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE public.attendance_status AS ENUM (
    'verified',
    'flagged',
    'manual_override',
    'manual_entry'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE public.validation_method AS ENUM ('ip', 'gps', 'pin', 'manual');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  full_name TEXT,
  role public.user_role NOT NULL DEFAULT 'faculty',
  gps_consent_signed BOOLEAN NOT NULL DEFAULT false,
  gps_consent_date TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_profiles_email ON public.profiles (lower(email));

-- ---------------------------------------------------------------------------
-- buildings
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.buildings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  campus_wifi_subnets TEXT[] NOT NULL DEFAULT '{}',
  geofence_polygon JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- classrooms
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.classrooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_name TEXT NOT NULL,
  qr_token TEXT NOT NULL UNIQUE,
  building_id UUID NOT NULL REFERENCES public.buildings (id) ON DELETE RESTRICT,
  geofence_polygon JSONB,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_classrooms_qr_token ON public.classrooms (qr_token);
CREATE INDEX IF NOT EXISTS idx_classrooms_building ON public.classrooms (building_id);

-- ---------------------------------------------------------------------------
-- schedules
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  faculty_id UUID NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  classroom_id UUID NOT NULL REFERENCES public.classrooms (id) ON DELETE CASCADE,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  day_of_week SMALLINT NOT NULL CHECK (day_of_week >= 0 AND day_of_week <= 6),
  effective_from DATE NOT NULL,
  effective_until DATE,
  updated_by UUID REFERENCES public.profiles (id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT schedules_time_order CHECK (end_time > start_time)
);

CREATE INDEX IF NOT EXISTS idx_schedules_faculty_day ON public.schedules (faculty_id, day_of_week);
CREATE INDEX IF NOT EXISTS idx_schedules_classroom ON public.schedules (classroom_id);

-- ---------------------------------------------------------------------------
-- attendance_logs
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.attendance_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  faculty_id UUID NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  classroom_id UUID NOT NULL REFERENCES public.classrooms (id) ON DELETE RESTRICT,
  scanned_at TIMESTAMPTZ NOT NULL,
  session_closed_at TIMESTAMPTZ,
  status public.attendance_status NOT NULL,
  validation_method public.validation_method,
  ip_address TEXT,
  gps_lat TEXT,
  gps_lng TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_attendance_faculty_scanned ON public.attendance_logs (faculty_id, scanned_at DESC);
CREATE INDEX IF NOT EXISTS idx_attendance_session_open ON public.attendance_logs (faculty_id) WHERE session_closed_at IS NULL;

-- ---------------------------------------------------------------------------
-- override_pins
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.override_pins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  generated_by UUID NOT NULL REFERENCES public.profiles (id) ON DELETE RESTRICT,
  classroom_id UUID NOT NULL REFERENCES public.classrooms (id) ON DELETE CASCADE,
  pin_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  max_duration_minutes INTEGER NOT NULL DEFAULT 60,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- flagged_review_queue
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.flagged_review_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attendance_log_id UUID NOT NULL REFERENCES public.attendance_logs (id) ON DELETE CASCADE,
  assigned_to UUID REFERENCES public.profiles (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  resolution_note TEXT,
  sla_deadline TIMESTAMPTZ NOT NULL,
  UNIQUE (attendance_log_id)
);

CREATE INDEX IF NOT EXISTS idx_flagged_sla ON public.flagged_review_queue (sla_deadline) WHERE resolved_at IS NULL;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.buildings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.classrooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.override_pins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.flagged_review_queue ENABLE ROW LEVEL SECURITY;

-- profiles: own row
DROP POLICY IF EXISTS "profiles_select_own" ON public.profiles;
CREATE POLICY "profiles_select_own" ON public.profiles FOR SELECT USING (auth.uid() = id);

DROP POLICY IF EXISTS "profiles_update_own" ON public.profiles;
CREATE POLICY "profiles_update_own" ON public.profiles FOR UPDATE USING (auth.uid() = id);

-- Service role (Netlify functions) bypasses RLS — no extra policy needed for inserts from backend

-- Optional: faculty can read own attendance (for future "history" UI)
DROP POLICY IF EXISTS "attendance_select_own" ON public.attendance_logs;
CREATE POLICY "attendance_select_own" ON public.attendance_logs FOR SELECT USING (auth.uid() = faculty_id);

-- Deny direct client inserts on attendance_logs (only service role / functions)
-- No INSERT policy for anon/authenticated — inserts go through Netlify with service key

-- Buildings / classrooms / schedules: restrict direct reads for now (admins added later via policies)
-- Super-admin dashboard would use service role or elevated policies in a later phase

-- ---------------------------------------------------------------------------
-- New auth user → profile row
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, role, gps_consent_signed)
  VALUES (
    NEW.id,
    COALESCE(NEW.email, ''),
    COALESCE(NEW.raw_user_meta_data ->> 'full_name', split_part(COALESCE(NEW.email, 'user'), '@', 1)),
    'faculty',
    false
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();

COMMENT ON TABLE public.profiles IS 'Faculty Attendance v2 — links to Supabase Auth';
COMMENT ON TABLE public.attendance_logs IS 'GPS/IP stored as text; use Vault/pgcrypto in production for encryption at rest';
