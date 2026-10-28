-- 0037_mention_images.up.sql — картинка у упоминания карточки в кадре (0.93.0, docs/entity-links.md §3.4.1).
--
-- Зачем. Карточка упоминания уже знает «карточка + кадр + глава», и в ней не хватало одного:
-- «как это выглядит» — портрет персонажа, вид места, обложка темы. Фича просила привязку картинки
-- именно здесь: не общая картинка проекта и не картинка кадра, а «этот персонаж в этом кадре».
--
-- Картинка берётся из вложений проекта (assets), а не загружается отдельно: вложения уже
-- проходят квоту, пережатие и дедупликацию, их видно в списке файлов, и они входят в архив
-- переноса. Новая таблица хранит только СВЯЗЬ «какая картинка у какой пары».
--
-- Одна картинка на пару «карточка × кадр» — уникальный индекс: список из нескольких картинок на
-- одно упоминание превратил бы карточку в галерею и распух бы, а «сколько их» никто не просил.
-- Каскады: удаление проекта, карточки, кадра или файла убирает связь — висячая ссылка на
-- несуществующий файл хуже, чем отсутствие картинки.
CREATE TABLE IF NOT EXISTS mention_images (
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  entity_id   uuid NOT NULL REFERENCES project_entities(id) ON DELETE CASCADE,
  event_id    uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  asset_id    uuid NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_id, event_id)
);

-- Список картинок проекта читается одной выборкой по проекту: панель «Связи» открывается на
-- вкладке и не должна ходить в базу за каждой парой отдельно.
CREATE INDEX IF NOT EXISTS mention_images_project_idx ON mention_images (project_id);
