package feed

// Мосты к внутренним функциям для внешних тестов (package feed_test):
// проверяем ровно то, что исполняется в проде, без дублирования логики.

var (
	ParseSortForTest = parseSort
	SlugifyForTest   = slugify
)
