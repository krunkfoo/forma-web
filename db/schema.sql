-- Forma Web Platform Schema
-- Run once against your PostgreSQL database

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users (homeowners AND designers)
CREATE TABLE IF NOT EXISTS users (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email       TEXT UNIQUE NOT NULL,
  password    TEXT NOT NULL,
  name        TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'homeowner',  -- 'homeowner' | 'designer'
  avatar_url  TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Designer profiles (one per designer user)
CREATE TABLE IF NOT EXISTS designer_profiles (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  bio         TEXT,
  specialties TEXT[],          -- e.g. {'interior', 'landscape', 'kitchen'}
  location    TEXT,
  rate_per_hr NUMERIC(10,2),
  portfolio   JSONB,           -- [{ title, image_url, description }]
  rating      NUMERIC(3,2) DEFAULT 0,
  review_count INT DEFAULT 0,
  available   BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Projects (synced from iOS app or created on web)
CREATE TABLE IF NOT EXISTS projects (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  address       TEXT,
  space_type    TEXT,   -- 'interior' | 'outdoor'
  area_m2       NUMERIC(10,2),
  thumbnail_url TEXT,
  scan_data     JSONB,  -- lightweight metadata from iOS sync
  design_data   JSONB,  -- selected design option
  status        TEXT DEFAULT 'draft',  -- 'draft' | 'active' | 'completed'
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Designer requests (homeowner hires designer)
CREATE TABLE IF NOT EXISTS hire_requests (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  homeowner_id UUID REFERENCES users(id) ON DELETE CASCADE,
  designer_id  UUID REFERENCES users(id) ON DELETE CASCADE,
  project_id   UUID REFERENCES projects(id) ON DELETE SET NULL,
  message      TEXT,
  budget       NUMERIC(10,2),
  status       TEXT DEFAULT 'pending',  -- 'pending' | 'accepted' | 'declined' | 'completed'
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Messages between homeowners and designers
CREATE TABLE IF NOT EXISTS messages (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  request_id  UUID REFERENCES hire_requests(id) ON DELETE CASCADE,
  sender_id   UUID REFERENCES users(id) ON DELETE CASCADE,
  body        TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Reviews (homeowner reviews designer)
CREATE TABLE IF NOT EXISTS reviews (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  request_id  UUID UNIQUE REFERENCES hire_requests(id) ON DELETE CASCADE,
  reviewer_id UUID REFERENCES users(id),
  designer_id UUID REFERENCES users(id),
  rating      INT CHECK (rating BETWEEN 1 AND 5),
  comment     TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Password reset tokens
CREATE TABLE IF NOT EXISTS password_resets (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
  token      TEXT UNIQUE NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used       BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Recalculate designer rating after review insert
CREATE OR REPLACE FUNCTION update_designer_rating() RETURNS TRIGGER AS $$
BEGIN
  UPDATE designer_profiles
  SET rating = (
    SELECT AVG(rating)::NUMERIC(3,2) FROM reviews WHERE designer_id = NEW.designer_id
  ),
  review_count = (
    SELECT COUNT(*) FROM reviews WHERE designer_id = NEW.designer_id
  )
  WHERE user_id = NEW.designer_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER after_review_insert
AFTER INSERT OR UPDATE ON reviews
FOR EACH ROW EXECUTE FUNCTION update_designer_rating();

-- Scans uploaded from iOS app
CREATE TABLE IF NOT EXISTS scans (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
  project_id      UUID REFERENCES projects(id) ON DELETE SET NULL,
  name            TEXT NOT NULL DEFAULT 'Scan',
  space_type      TEXT NOT NULL DEFAULT 'interior',  -- 'interior' | 'outdoor'
  area_m2         NUMERIC(10,2),
  room_snapshot   JSONB,   -- RoomSnapshot: walls, openings, furniture
  site_plan       JSONB,   -- SitePlan: boundary, dimensions, features, wallLines
  scan_metadata   JSONB,   -- classification, confidence, ceiling height etc
  thumbnail_url   TEXT,
  video_url       TEXT,    -- uploaded outdoor video for LingBot-Map
  status          TEXT DEFAULT 'pending',  -- 'pending' | 'processing' | 'ready' | 'failed'
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Processing jobs for LingBot-Map outdoor video processing
CREATE TABLE IF NOT EXISTS processing_jobs (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  scan_id     UUID REFERENCES scans(id) ON DELETE CASCADE,
  type        TEXT NOT NULL DEFAULT 'lingbot_map',
  status      TEXT DEFAULT 'queued',  -- 'queued' | 'running' | 'completed' | 'failed'
  result      JSONB,
  error       TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Apple Sign In: stable per-user identifier returned in the JWT `sub` claim
ALTER TABLE users ADD COLUMN IF NOT EXISTS apple_sub TEXT UNIQUE;
CREATE INDEX IF NOT EXISTS users_apple_sub_idx ON users (apple_sub) WHERE apple_sub IS NOT NULL;
