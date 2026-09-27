// Package migrations — embedded SQL-миграции схемы.
//
// Файлы лежат в этой же директории и вшиваются в бинарь: FS-корень — сама
// директория, поэтому platform.RunMigrations видит их как "0001_init.up.sql"
// (раньше embed был объявлен в cmd/server с паттерном migrations/*.sql, из-за
// чего fs.ReadDir(".") возвращал одну директорию и миграции не применялись).
package migrations

import "embed"

//go:embed *.up.sql *.down.sql
var FS embed.FS
