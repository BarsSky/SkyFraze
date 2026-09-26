-- SkyFraze initial schema rollback

BEGIN;

DROP TRIGGER IF EXISTS trg_events_updated   ON events;
DROP TRIGGER IF EXISTS trg_projects_updated ON projects;
DROP TRIGGER IF EXISTS trg_users_updated    ON users;
DROP FUNCTION IF EXISTS set_updated_at();

DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS event_assets;
DROP TABLE IF EXISTS assets;
DROP TABLE IF EXISTS events;
DROP TABLE IF EXISTS invitations;
DROP TABLE IF EXISTS team_memberships;
DROP TABLE IF EXISTS projects;
DROP TABLE IF EXISTS users;

COMMIT;
