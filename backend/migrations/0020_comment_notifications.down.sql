-- Откат 0020: уведомления о замечаниях.
--
-- Убираем очередь и галочку согласия. Письма, которые уже ушли, не вернуть — это данные
-- вне базы; сами комментарии остаются на месте.
DROP TABLE IF EXISTS comment_notifications;
ALTER TABLE users DROP COLUMN IF EXISTS notify_comments;
