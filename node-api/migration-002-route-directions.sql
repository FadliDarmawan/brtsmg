-- migration-002-route-directions.sql
--
-- Nambahin kolom buat fitur "Show final destination" (ROUTE_DIRECTIONS di
-- index.html) -- ini SEBELUMNYA hardcoded kosong (belum pernah keisi buat
-- Semarang ataupun Jogja versi sumbernya). Aman dijalanin berkali-kali.

ALTER TABLE koridor ADD COLUMN IF NOT EXISTS start_stop_name TEXT;
ALTER TABLE koridor ADD COLUMN IF NOT EXISTS wayback_stop_name TEXT;

-- Cek cepat: kolom baru harus muncul di sini
SELECT column_name FROM information_schema.columns
WHERE table_name = 'koridor' AND column_name IN ('start_stop_name', 'wayback_stop_name');
