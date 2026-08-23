# Semarang BRT — API upload & merge

Port dari `merge_halte.py` (POC Python) ke Node, buat jalan sebagai Vercel
serverless function di atas Neon.

## Setup

```
npm install
```

Env var yang dibutuhkan di Vercel project settings:

```
DATABASE_URL=postgresql://...neon.tech/...?sslmode=require
```

Pakai connection string **pooled** dari Neon (host-nya ada `-pooler` di
tengahnya) -- bukan yang direct, biar aman kalau ada beberapa request nyerempet
bersamaan.

Jalanin `schema.sql` (dari chat sebelumnya) di database Neon-nya dulu sebelum
endpoint ini dipakai.

## Endpoint

### `POST /api/upload`

`multipart/form-data`, field `file` = file `.xlsx` dengan struktur sheet per
koridor yang sama kayak `Rekap_Halte_BRT_Ori.xlsx`.

Response:
```json
{
  "ok": true,
  "upload_batch_id": 12,
  "koridor_terdampak": ["1", "2", "3A", ...],
  "total_halte_diupload": 1512,
  "rows_dengan_issue": 0,
  "issues_sample": [],
  "merge": {
    "halteMasterCount": 1105,
    "autoMergedMultiKoridor": 215,
    "reviewQueueInserted": 21
  },
  "warnings": []
}
```

### `GET /api/stops`

`SELECT * FROM v_stops_api`, shape-nya identik `stops.json` lama. ETag dari
`publish_version` -- kalau belum ada upload/merge baru, response 304 tanpa
nge-query Neon lagi.

### `GET /api/routes-meta`

Query tabel `koridor` (`ORDER BY display_order`), balikin
`{ routeMeta: {...}, routeIds: [...] }` -- pengganti `ROUTE_META`/`ROUTE_IDS`
yang tadinya hardcode di `index.html`.

## index.html -- perubahan yang dibutuhkan (sudah dipatch, lihat index.html di folder ini)

1. `<script>` → `<script type="module">` -- biar top-level `await` di bawah
   bisa dipakai tanpa bungkus seluruh file jadi satu fungsi async raksasa.
   Aman dilakukan karena semua yang dibutuhkan `cartography.html` sudah
   di-assign eksplisit ke `window.*` (bukan implicit global scope) --
   pattern itu udah ada dari sononya di file Jogja kamu.
2. Blok hardcode `const ROUTE_META = {...}` + `const ROUTE_IDS = [...]`
   diganti fetch ke `/api/routes-meta` pakai top-level `await`. Karena nama
   variabel & bentuknya tetap `ROUTE_META`/`ROUTE_IDS`, ~40 tempat lain di
   file ini yang baca `ROUTE_META[id]` TIDAK perlu diubah.
3. `fetch("./stops/stops.json")` → `fetch("/api/stops")` di `loadStops()`.

Geometri rute (`/routes/<kode>.json`) TETAP file statis, gak ikut pindah ke
DB -- sesuai keputusan sebelumnya (jarang berubah).

Sudah divalidasi: script hasil patch lolos `node --check` termasuk
penggunaan top-level await-nya.

### `GET /api/review`

List kandidat merge yang masih pending (`v_review_queue_pending`). Tiap
kandidat kasih `id`, `distance_m`, `name_similarity`, plus nama+koridor+lat/lng
dua sisi -- cukup buat render UI "confirm merge" side-by-side.

### `POST /api/review-resolve`

```json
{
  "koridorHalteAId": 123,
  "koridorHalteBId": 456,
  "decision": "force_merge",
  "reason": "opsional, buat audit trail",
  "resolvedBy": "opsional, nama/email admin"
}
```

Nyimpen keputusan ke `halte_merge_override` (permanen, dibaca ulang tiap
re-merge -- gak akan balik ambigu walau ada upload excel baru), nutup entry
`review_queue` yang cocok kalau ada, lalu trigger `mergeHalte()` + bump
`publish_version`.

**PENTING**: endpoint ini TIDAK mensyaratkan pasangannya harus ada di
`review_queue` dulu -- based on kasus nyata pas nyelesaiin 9 keputusan
Semarang (chat sebelumnya), kadang butuh `force_split` buat pasangan yang
gak pernah otomatis kedeteksi ambigu (union bersifat transitif, jadi satu
`force_merge` bisa nyeret cluster lain ikut nyambung lewat titik yang sama
-- lihat komentar panjang di `lib/mergeHalte.js`). Jadi admin UI kamu perlu
bisa manggil endpoint ini langsung dari halaman detail halte manapun, bukan
cuma dari daftar `/api/review`.

## Sudah divalidasi

9 keputusan review manual dari Semarang (chat sebelumnya) udah dites
end-to-end lewat `test_merge_with_overrides.js`: `mergeHalte.js` + override
menghasilkan **1102 halte_master, 0 sisa review_queue** -- cocok persis sama
hasil versi Python (`apply_review_decisions.py`). 9 keputusan user ternyata
butuh 25 baris override (bukan 9), karena beberapa kasus nyentuh banyak
koridor sekaligus + 2 kasus butuh `force_split` tambahan buat motong union
transitif dari auto-merge lama (lihat komentar di `lib/mergeHalte.js`).

## `scripts/seed-review-overrides.js`

Jalanin SEKALI setelah upload excel pertama ke Neon:

```
DATABASE_URL=postgresql://...neon.tech/...  node scripts/seed-review-overrides.js
```

Baca `overrides_applied.json` (25 keputusan yang udah divalidasi di atas,
masih pakai `(sheet_name, no_urut)` sebagai identitas baris), resolve jadi
`koridor_halte.id` beneran lewat JOIN ke `koridor.sheet_name_asal`, seed ke
`halte_merge_override`, lalu jalanin ulang `mergeHalte()`. Idempotent --
aman dijalanin berkali-kali kalau ada revisi.

## `review-admin.html`

Halaman admin standalone buat approve/reject kandidat merge -- fetch
`/api/review`, render tiap kandidat sebagai kartu perbandingan 2 sisi
(nama, koridor, koordinat, jarak, kemiripan nama), tombol **Gabungkan** /
**Pisahkan** manggil `/api/review-resolve`. Taruh di root static folder
Vercel-mu (atau `/admin/review.html`, terserah routing kamu) -- gak
dependency ke framework apapun, vanilla JS + fetch.

## Catatan implementasi

- `mergeHalte()` full-recompute tiap dipanggil (hapus semua `halte_master`,
  kelompokkan ulang SELURUH `koridor_halte`). Di skala ~1500 baris ini murah;
  kalau datanya nanti jauh lebih besar, pertimbangkan incremental merge
  (cuma re-cluster koridor yang baru diubah + tetangga spasialnya).
- `nameSimilarity()` pakai Levenshtein ratio biasa, BUKAN port 1:1 dari
  `difflib.SequenceMatcher` Python -- nilainya bisa sedikit beda buat kasus
  tertentu. Threshold `0.55` mungkin perlu di-tune ulang kalau kandidat
  review kerasa kebanyakan/kekurangan dibanding hasil POC Python.
- Upload dan merge sengaja dipisah jadi 2 transaction: kalau merge gagal,
  data halte yang barusan di-upload TETAP tersimpan (gak perlu upload ulang).
