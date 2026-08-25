-- ============================================================================
-- Migration: nambahin bagian-bagian schema yang ditambah/diubah belakangan,
-- TANPA nyentuh data yang udah keupload. Aman dijalanin berkali-kali
-- (semua pake IF NOT EXISTS / OR REPLACE / DROP ... IF EXISTS).
--
-- Jalanin ini kalau database kamu dibikin dari schema.sql versi AWAL
-- (sebelum halte_merge_override, sebelum fix constraint no_urut, sebelum
-- kolom koridor_halte_a_id/b_id ditambah ke view review).
-- ============================================================================

-- 1. Drop constraint lama yang salah asumsi (kolom "No" excel ternyata gak
--    unik per koridor -- lihat kasus koridor 7 Genuk-Pengapon)
ALTER TABLE koridor_halte
  DROP CONSTRAINT IF EXISTS koridor_halte_koridor_id_no_urut_key;

CREATE INDEX IF NOT EXISTS idx_koridor_halte_koridor_no_urut
  ON koridor_halte(koridor_id, no_urut);

-- 2. Tabel halte_merge_override (kemungkinan besar ini yang bikin 500)
CREATE TABLE IF NOT EXISTS halte_merge_override (
  id                  BIGSERIAL PRIMARY KEY,
  koridor_halte_a_id  BIGINT NOT NULL REFERENCES koridor_halte(id) ON DELETE CASCADE,
  koridor_halte_b_id  BIGINT NOT NULL REFERENCES koridor_halte(id) ON DELETE CASCADE,
  decision            TEXT NOT NULL CHECK (decision IN ('force_merge', 'force_split')),
  reason              TEXT,
  created_by          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CHECK (koridor_halte_a_id <> koridor_halte_b_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_halte_merge_override_pair
  ON halte_merge_override (LEAST(koridor_halte_a_id, koridor_halte_b_id),
                            GREATEST(koridor_halte_a_id, koridor_halte_b_id));

CREATE INDEX IF NOT EXISTS idx_halte_merge_override_a ON halte_merge_override(koridor_halte_a_id);
CREATE INDEX IF NOT EXISTS idx_halte_merge_override_b ON halte_merge_override(koridor_halte_b_id);

-- 3. View v_review_queue_pending -- versi terbaru expose koridor_halte_a_id/
--    b_id (dibutuhin review-admin.html buat manggil /api/review-resolve).
--    CREATE OR REPLACE aman, tapi Postgres nolak kalau urutan/nama kolom
--    yang UDAH ADA berubah posisinya -- makanya DROP dulu baru CREATE ulang.
DROP VIEW IF EXISTS v_review_queue_pending;

CREATE VIEW v_review_queue_pending AS
SELECT
  rq.id,
  rq.koridor_halte_a_id,
  rq.koridor_halte_b_id,
  rq.distance_m,
  rq.name_similarity,
  rq.reason,
  ka.nama_halte AS nama_a, ka.lat AS lat_a, ka.lng AS lng_a, kka.kode AS koridor_a,
  kb.nama_halte AS nama_b, kb.lat AS lat_b, kb.lng AS lng_b, kkb.kode AS koridor_b,
  rq.created_at
FROM review_queue rq
JOIN koridor_halte ka ON ka.id = rq.koridor_halte_a_id
JOIN koridor_halte kb ON kb.id = rq.koridor_halte_b_id
JOIN koridor kka ON kka.id = ka.koridor_id
JOIN koridor kkb ON kkb.id = kb.koridor_id
WHERE rq.status = 'pending'
ORDER BY rq.created_at;

-- 4. Cek cepat: harusnya balikin 3 baris (halte_merge_override + 2 index-nya)
SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'halte_merge_override';
