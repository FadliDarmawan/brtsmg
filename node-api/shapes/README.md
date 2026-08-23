# Route shapes tooling

Adaptasi dari `build-route-shapes.js` (project Jogja) buat Semarang. File
`build-route-shapes.js` **TIDAK DIMODIFIKASI** -- dipakai apa adanya, cuma
dibungkus `build-all-shapes.js` biar bisa jalan buat semua koridor sekaligus,
narik data halte dari `/api/stops` alih-alih file lokal statis.

## Kenapa ini gak auto-run dari /api/upload atau /api/review-resolve

1. **Teknis**: Vercel serverless function gak bisa nulis balik ke
   `routes/<kode>.json` di repo -- filesystem-nya read-only buat static asset,
   cuma keupdate lewat redeploy dari git.
2. **Desain**: `build-route-shapes.js` sengaja **fail loudly** kalau ada
   masalah geometri yang butuh mata manusia (loop gak nutup, arah line
   kebalik dari arah kendaraan, halte meleset >300m dari garis). Itu bukan
   bug, itu safety net -- kalau di-auto-jalanin tanpa direview, justru bikin
   error tipe ini lolos ke production diam-diam (baru ketauan pas user coba
   klik "rute A ke B" dan hasilnya salah arah).

## Kapan REALISTIS untuk dijalanin

Geometri jalan itu sendiri (raw trace rutenya) udah kamu putuskan statis &
jarang berubah. Yang BISA berubah dan butuh shape di-generate ulang:
- koordinat suatu halte diedit (lewat re-upload / review-resolve)
- halte baru ditambah/dihapus dari suatu koridor
- urutan/arah koridor ternyata salah dari awal, ketauan belakangan

Jadi jalanin ini **setelah edit halte yang signifikan**, bukan tiap detik.

## Cara pakai

### Opsi A -- manual, lokal (paling gampang, direkomendasikan buat mulai)

```bash
node shapes/build-all-shapes.js --api=https://semarang-brt.vercel.app
# atau subset aja:
node shapes/build-all-shapes.js --api=https://semarang-brt.vercel.app --only=1,3A,F2C
```

Baca ringkasan di akhir run. Kalau ada yang GAGAL, file itu TIDAK ditulis
(aman, gak ninggalin data setengah-jadi) -- perbaiki dulu (biasanya butuh
`--patch` buat geometri yang genuinely hilang, atau `--order` buat
disambiguasi stop). Kalau ada WARNING, file TETAP ditulis tapi cek manual
dulu sebelum commit (biasanya halte yang jauh dari garis).

Abis itu `git diff routes/`, review perubahannya, commit & push kalau oke.

### Opsi B -- GitHub Action (`.github/workflows/rebuild-shapes.yml`)

Trigger manual (`workflow_dispatch`) atau jadwal mingguan. Jalanin
`build-all-shapes.js`, terus **buka Pull Request** kalau ada perubahan --
BUKAN auto-commit ke main. Kamu tetep review diff-nya kayak PR biasa
sebelum di-merge & redeploy.

## `shapes.config.json`

Satu entry per koridor, isi flag yang dulu kamu ketik manual di CLI (Jogja):

```json
{
  "1": { "start": "Terminal Mangkang", "order": null, "patch": null, "reverse": false }
}
```

- `start`: nama halte (harus PERSIS sama kayak di `stop_name` hasil
  `/api/stops`) yang jadi vertex 0 -- lihat NOTE ON DIRECTION di
  `build-route-shapes.js`.
- `order`: path relatif ke file `.txt` (satu nama halte per baris, urutan
  perjalanan yang benar) -- taruh di `shapes/order/<kode>.txt`. Cuma perlu
  kalau ada halte yang dilayani 2 arah dan salah nyantol ke pole yang salah.
- `patch`: path relatif ke file `.txt` (satu koordinat "lon lat" per baris)
  buat nambal ruas jalan yang KELEWAT gak ke-trace sama sekali -- taruh di
  `shapes/patch/<kode>.txt`.
- `reverse`: `true` kalau seluruh urutan vertex kebalik dari arah kendaraan
  (jarang, tapi lihat NOTE di `build-route-shapes.js` gimana ngeceknya).

**File ini masih kosong buat 18 koridor Semarang kamu** -- perlu diisi
manual sekali per koridor pas pertama kali nyiapin `routes/<kode>.json`,
sama kayak dulu prosesnya di Jogja. Gak ada cara nebak `start`/`order` dari
data halte doang, itu butuh tau geometri jalannya.

## Sudah divalidasi

`build-all-shapes.js` udah dites end-to-end pake fake local HTTP server +
route/stops sintetis: jalur sukses (fetch stops → jalanin per koridor →
ringkasan OK, exit 0) dan jalur gagal (satu koridor loop gak nutup → gagal
terisolasi, koridor lain tetap sukses, exit 1, summary akurat).
