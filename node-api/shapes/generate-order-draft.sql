-- shapes/generate-order-draft.sql
--
-- Bantu bikin draft order.txt per koridor -- PENTING dipakai ketimbang nyomot
-- nama_halte mentah dari excel, karena nama FINAL (setelah merge) kadang beda
-- (contoh nyata koridor 1: "RS Adhyatma [Utara]" di excel jadi
-- "RSUD Tugurejo [Utara]" di hasil akhir -- nama yang menang pas merge dari
-- koridor lain). build-route-shapes.js cocokin berdasarkan nama di stops.json
-- (yaitu halte_master.nama), BUKAN nama_halte per-koridor.
--
-- Ganti '1' di WHERE k.kode = '1' sesuai koridor yang mau dibikin order.txt-nya.

SELECT
  kh.no_urut,
  kh.nama_halte           AS nama_excel,
  hm.nama                 AS nama_final,       -- <- INI yang dipakai di order.txt
  CASE WHEN kh.nama_halte <> hm.nama THEN '<< BEDA, cek manual' ELSE '' END AS flag,
  kh.halte_master_id
FROM koridor_halte kh
JOIN koridor k       ON k.id = kh.koridor_id
LEFT JOIN halte_master hm ON hm.id = kh.halte_master_id
WHERE k.kode = '1'
ORDER BY kh.no_urut;

-- Cara pakai hasilnya:
-- 1. Copy kolom nama_final, urut sesuai no_urut, satu nama per baris,
--    ke file shapes/order/1.txt
-- 2. Kalau ini rute LOOP (pergi-pulang balik ke titik yang sama) dan baris
--    PALING BAWAH nama_final-nya sama persis dengan baris PALING ATAS --
--    hapus salah satu (spec-nya build-route-shapes.js: "shared start/end
--    terminus listed once, at the top only -- not repeated at the bottom")
-- 3. Kalau ada baris dengan halte_master_id NULL -> berarti koridor itu
--    belum pernah kena mergeHalte() (baru diupload, belum ada yang trigger
--    re-merge) -- jalanin dulu 1x upload/review-resolve apapun biar
--    ke-generate, baru query ini ulang.
-- 4. Baris dengan flag "BEDA" -- itu contoh nyata kayak "RS Adhyatma [Utara]"
--    -> "RSUD Tugurejo [Utara]" -- pastiin kamu pake nama_final, bukan
--    nama_excel, buat baris itu.
