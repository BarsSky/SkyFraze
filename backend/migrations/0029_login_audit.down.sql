-- 0029: откат аудита входов.
DROP INDEX IF EXISTS login_audit_created_idx;
DROP INDEX IF EXISTS login_audit_user_idx;
DROP TABLE IF EXISTS login_audit;
