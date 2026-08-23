-- ============================================================================
-- Semarang BRT — Halte & Koridor Schema (Neon / Postgres)
-- ============================================================================
-- Prinsip:
--   1. koridor_halte  = SOURCE OF TRUTH, diedit lewat re-upload excel per koridor
--   2. halte_master   = DERIVED (hasil merge lintas-koridor), read-only dari sisi user
--   3. review_queue   = kandidat merge ambigu, butuh approve/reject manual
--   4. koridor        = pengganti ROUTE_META yang tadinya hardcode di JS
--   5. upload_batch   = audit trail tiap kali ada excel di-upload
--   6. v_stops_api    = view siap-pakai buat endpoint /api/stops (shape stops.json)
-- ============================================================================

-- Kalau nanti volume data gede & butuh spatial index beneran (bukan sekadar
-- filter jarak sekuensial), tinggal aktifkan cube+earthdistance atau PostGIS.
-- Untuk ~1500 baris halte, index biasa + haversine di application layer masih cukup.
-- CREATE EXTENSION IF NOT EXISTS cube;
-- CREATE EXTENSION IF NOT EXISTS earthdistance;

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- ============================================================================
-- 1. KORIDOR — pengganti ROUTE_META hardcode. Satu baris = satu sheet excel.
-- ============================================================================
CREATE TABLE koridor (
  id              BIGSERIAL PRIMARY KEY,
  kode            TEXT NOT NULL UNIQUE,        -- '1', '3A', 'F2C', 'M', 'PC', dst (dari nama sheet)
  nama            TEXT NOT NULL,               -- 'Mangkang-Penggaron' (tanpa suffix "(H)")
  sheet_name_asal TEXT,                        -- nama sheet excel asli, buat audit/debug parsing

  title           TEXT NOT NULL,               -- judul yang tampil di peta (bisa beda dari `nama`)
  color           TEXT NOT NULL DEFAULT '#888888',  -- hex color garis rute
  agency          TEXT,                        -- 'Trans Semarang', dst
  schedule        JSONB NOT NULL DEFAULT '{"type":"daily","hours":["05:00-21:00"]}',

  display_order   INT NOT NULL,                -- urutan tampil di rail (JANGAN andalkan sort key alami,
                                                 -- lihat catatan ROUTE_IDS di index.html Jogja soal ini)
  is_active       BOOLEAN NOT NULL DEFAULT true,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_koridor_updated_at
  BEFORE UPDATE ON koridor
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================================
-- 2. UPLOAD_BATCH — audit trail tiap kali excel di-upload & diproses
-- ============================================================================
CREATE TABLE upload_batch (
  id              BIGSERIAL PRIMARY KEY,
  filename        TEXT NOT NULL,
  uploaded_by     TEXT,
  uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  status          TEXT NOT NULL DEFAULT 'processing'
                    CHECK (status IN ('processing', 'completed', 'failed')),
  koridor_kodes_terdampak TEXT[],              -- kode koridor yang di-replace oleh batch ini
  summary         JSONB,                       -- stats hasil parse (mirip stats.json POC)
  error_message   TEXT
);


-- ============================================================================
-- 3. KORIDOR_HALTE — SOURCE OF TRUTH. Diganti total per koridor tiap re-upload.
-- ============================================================================
CREATE TABLE koridor_halte (
  id                BIGSERIAL PRIMARY KEY,
  koridor_id        BIGINT NOT NULL REFERENCES koridor(id) ON DELETE CASCADE,
  upload_batch_id   BIGINT REFERENCES upload_batch(id) ON DELETE SET NULL,

  no_urut           INT NOT NULL,              -- kolom "No" di excel, urutan sepanjang rute
  nama_halte        TEXT NOT NULL,
  arah              TEXT,                      -- label arah dari excel (start/finish/nama destinasi)

  fungsi_jalan      TEXT,
  trotoar           BOOLEAN,                   -- null = tidak diisi / tidak dikenali
  rambu_halte       TEXT CHECK (rambu_halte IN ('halte', 'rambu', 'tidak_ada')),
  transit           BOOLEAN,

  -- Tiga sumber koordinat mentah, disimpan apa adanya buat audit
  lat_aplikasi      NUMERIC(10,7),
  lng_aplikasi      NUMERIC(10,7),
  lat_aktual        NUMERIC(10,7),
  lng_aktual        NUMERIC(10,7),
  lat_korlain       NUMERIC(10,7),
  lng_korlain       NUMERIC(10,7),

  -- Koordinat final hasil resolusi (Aktual -> Kor Lain -> Aplikasi)
  lat               NUMERIC(10,7) NOT NULL,
  lng               NUMERIC(10,7) NOT NULL,
  coord_source      TEXT NOT NULL CHECK (coord_source IN ('aktual', 'kor_lain', 'aplikasi')),
  coord_confidence  TEXT NOT NULL DEFAULT 'high'
                      CHECK (coord_confidence IN ('high', 'medium', 'low', 'invalid', 'missing')),

  -- Tag arah [Utara]/[Selatan]/[Barat]/[Timur] diekstrak dari nama_halte saat parsing,
  -- dipakai sebagai hard-exclusion rule di proses merge (lihat AUDIT catatan sebelumnya:
  -- dua halte dgn tag arah beda TIDAK BOLEH pernah digabung walau namanya identik & dekat)
  direction_tag     TEXT CHECK (direction_tag IN ('utara', 'selatan', 'barat', 'timur') OR direction_tag IS NULL),

  -- Diisi oleh job merge, bukan oleh user.
  -- FK ke halte_master ditambahkan belakangan lewat ALTER TABLE (lihat bawah),
  -- karena tabel halte_master baru dibuat setelah koridor_halte.
  halte_master_id   BIGINT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (koridor_id, no_urut)
);

CREATE INDEX idx_koridor_halte_koridor_id ON koridor_halte(koridor_id);
CREATE INDEX idx_koridor_halte_halte_master_id ON koridor_halte(halte_master_id);
CREATE INDEX idx_koridor_halte_latlng ON koridor_halte(lat, lng);  -- bantu query bounding-box saat merge

CREATE TRIGGER trg_koridor_halte_updated_at
  BEFORE UPDATE ON koridor_halte
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================================
-- 4. HALTE_MASTER — DERIVED. Direcompute tiap kali koridor_halte berubah.
--    Jangan pernah di-edit langsung dari CRUD; ini hasil job merge.
-- ============================================================================
CREATE TABLE halte_master (
  id              BIGSERIAL PRIMARY KEY,
  nama            TEXT NOT NULL,               -- nama kanonik (dipilih dari member terpanjang)
  lat             NUMERIC(10,7) NOT NULL,       -- rata-rata dari koridor_halte anggota
  lng             NUMERIC(10,7) NOT NULL,
  member_count    INT NOT NULL DEFAULT 1,
  last_merged_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- FK dari koridor_halte dibuat setelah halte_master ada (hindari forward-reference error)
ALTER TABLE koridor_halte
  ADD CONSTRAINT fk_koridor_halte_halte_master
  FOREIGN KEY (halte_master_id) REFERENCES halte_master(id) ON DELETE SET NULL;


-- ============================================================================
-- 5. REVIEW_QUEUE — kandidat merge ambigu, butuh approve/reject manual
-- ============================================================================
CREATE TABLE review_queue (
  id                  BIGSERIAL PRIMARY KEY,
  koridor_halte_a_id  BIGINT NOT NULL REFERENCES koridor_halte(id) ON DELETE CASCADE,
  koridor_halte_b_id  BIGINT NOT NULL REFERENCES koridor_halte(id) ON DELETE CASCADE,

  distance_m          NUMERIC(6,1) NOT NULL,
  name_similarity     NUMERIC(3,2) NOT NULL,
  reason              TEXT,

  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'approved', 'rejected')),
  resolved_by         TEXT,
  resolved_at         TIMESTAMPTZ,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CHECK (koridor_halte_a_id <> koridor_halte_b_id)
);

CREATE INDEX idx_review_queue_status ON review_queue(status);

-- Cegah pasangan (a,b) yang sama masuk dobel ke antrian (arah manapun)
CREATE UNIQUE INDEX uq_review_queue_pair
  ON review_queue (LEAST(koridor_halte_a_id, koridor_halte_b_id),
                    GREATEST(koridor_halte_a_id, koridor_halte_b_id))
  WHERE status = 'pending';


-- ============================================================================
-- 5b. HALTE_MERGE_OVERRIDE — keputusan manual yang PERMANEN, dibaca job merge
--     setiap kali jalan (termasuk re-merge otomatis abis upload baru). Tanpa
--     tabel ini, review yang udah diputusin bakal balik lagi ke antrian tiap
--     kali ada upload baru yang nge-trigger re-merge.
--
--     decision = 'force_merge' -> dua koridor_halte ini SELALU disatukan ke
--                halte_master yang sama, walau jaraknya jauh / direction_tag
--                beda / dsb (override total, bukan tambahan syarat).
--     decision = 'force_split' -> dua koridor_halte ini TIDAK PERNAH digabung,
--                walau jaraknya < STRICT_M sekalipun (kebalikan dari auto-merge).
--
--     Kasus nyata yang butuh 'force_split' + 'force_merge' BARENGAN dalam satu
--     resolusi: baris koridor_halte yang koordinatnya salah rekam (identik
--     dengan platform lain yang salah), sehingga otomatis ke-auto-merge ke
--     tempat yang salah -- perlu dipisah dari situ SEKALIGUS disatukan paksa
--     ke tempat yang benar (lihat kasus "Pertigaan Cangkiran" arah Cangkiran
--     di koridor 8, yang koordinatnya kebetulan sama persis dengan arah
--     Sp. Lima, padahal harusnya di sisi jalan yang beda).
-- ============================================================================
CREATE TABLE halte_merge_override (
  id                  BIGSERIAL PRIMARY KEY,
  koridor_halte_a_id  BIGINT NOT NULL REFERENCES koridor_halte(id) ON DELETE CASCADE,
  koridor_halte_b_id  BIGINT NOT NULL REFERENCES koridor_halte(id) ON DELETE CASCADE,
  decision            TEXT NOT NULL CHECK (decision IN ('force_merge', 'force_split')),
  reason              TEXT,
  created_by          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CHECK (koridor_halte_a_id <> koridor_halte_b_id)
);

-- Satu pasang (a,b) cuma boleh punya SATU keputusan aktif (gak boleh sekaligus
-- force_merge dan force_split -- itu kontradiksi)
CREATE UNIQUE INDEX uq_halte_merge_override_pair
  ON halte_merge_override (LEAST(koridor_halte_a_id, koridor_halte_b_id),
                            GREATEST(koridor_halte_a_id, koridor_halte_b_id));

CREATE INDEX idx_halte_merge_override_a ON halte_merge_override(koridor_halte_a_id);
CREATE INDEX idx_halte_merge_override_b ON halte_merge_override(koridor_halte_b_id);


-- ============================================================================
-- 6. PUBLISH_VERSION — buat cache invalidation di /api/stops (lihat catatan
--    stale-while-revalidate sebelumnya). Bump tiap kali merge selesai & di-approve.
-- ============================================================================
CREATE TABLE publish_version (
  id                  BIGSERIAL PRIMARY KEY,
  version             INT NOT NULL,
  published_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  triggered_by_batch_id BIGINT REFERENCES upload_batch(id) ON DELETE SET NULL
);

CREATE INDEX idx_publish_version_version ON publish_version(version DESC);


-- ============================================================================
-- 7. VIEW — bentuk siap-pakai buat /api/stops, ngikutin shape stops.json:
--    { point: "lon lat", stop_name, services: [{route, is_departure_hub, destinations}] }
--
--    CATATAN: `is_departure_hub` di sini masih heuristik (no_urut = 1 di koridornya).
--    `destinations` diisi dari kolom `arah` — sesuaikan lagi kalau semantiknya
--    di Semarang ternyata beda dari asumsi ini.
-- ============================================================================
CREATE OR REPLACE VIEW v_stops_api AS
SELECT
  hm.id                                    AS halte_master_id,
  hm.nama                                  AS stop_name,
  hm.lng || ' ' || hm.lat                  AS point,
  hm.lat,
  hm.lng,
  COALESCE(
    json_agg(
      json_build_object(
        'route', k.kode,
        'is_departure_hub', (kh.no_urut = 1),
        'destinations', ARRAY[kh.arah]
      ) ORDER BY k.display_order
    ) FILTER (WHERE kh.id IS NOT NULL),
    '[]'::json
  ) AS services
FROM halte_master hm
LEFT JOIN koridor_halte kh ON kh.halte_master_id = hm.id
LEFT JOIN koridor k        ON k.id = kh.koridor_id
GROUP BY hm.id, hm.nama, hm.lat, hm.lng;


-- ============================================================================
-- 8. VIEW tambahan — daftar review yang masih pending, siap dipakai admin UI
-- ============================================================================
CREATE OR REPLACE VIEW v_review_queue_pending AS
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
