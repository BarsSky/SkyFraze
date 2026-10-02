DROP TABLE IF EXISTS project_ai_settings;
-- Системного пользователя агента убираем вместе с проектами, где он участник:
-- его участие ссылается на projects через team_memberships (каскад сработает сам),
-- но строку users удаляем только если она больше никому не нужна как автор правок.
DELETE FROM team_memberships WHERE user_id = '00000000-0000-0000-0000-0000000000a1';
DELETE FROM users WHERE id = '00000000-0000-0000-0000-0000000000a1';
