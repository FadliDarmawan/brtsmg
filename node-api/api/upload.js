// api/upload.js
//
// POST multipart/form-data, field "file" = .xlsx
//
// Alur (semua dalam SATU transaction, biar gak ada state setengah-jadi kalau
// gagal di tengah jalan):
//   1. Parse workbook -> per koridor: daftar halte
//   2. Upsert koridor (by kode); replace TOTAL koridor_halte utk koridor itu
//   3. Catat upload_batch (audit trail)
//   4. Commit, baru jalanin mergeHalte() (full re-merge lintas koridor)
//   5. Bump publish_version -> /api/stops tau harus invalidate cache
//
// NOTE: Vercel default gak parse multipart body -- pake formidable di sini.
// Kalau nanti pindah ke Next.js App Router, ganti ke request.formData() bawaan.

const { formidable } = require("formidable");
const fs = require("fs");
const { withTransaction } = require("../lib/db");
const { parseWorkbook } = require("../lib/parseWorkbook");
const { mergeHalte } = require("../lib/mergeHalte");

module.exports.config = { api: { bodyParser: false } };

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const form = formidable({ maxFileSize: 20 * 1024 * 1024 }); // 20MB cukup buat excel ini
    form.parse(req, (err, fields, files) => {
      if (err) return reject(err);
      resolve({ fields, files });
    });
  });
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  let buffer;
  let filename;
  try {
    const { files } = await parseMultipart(req);
    const file = Array.isArray(files.file) ? files.file[0] : files.file;
    if (!file) {
      res.status(400).json({ error: "Field 'file' (xlsx) wajib diisi" });
      return;
    }
    filename = file.originalFilename || "upload.xlsx";
    buffer = fs.readFileSync(file.filepath);
  } catch (err) {
    res.status(400).json({ error: `Gagal baca file upload: ${err.message}` });
    return;
  }

  let parsed;
  try {
    parsed = parseWorkbook(buffer);
  } catch (err) {
    res.status(400).json({ error: `Gagal parse workbook: ${err.message}` });
    return;
  }

  const { koridorList, halteByKoridorKode, warnings } = parsed;
  if (!koridorList.length) {
    res.status(400).json({ error: "Tidak ada sheet koridor valid ditemukan di file ini", warnings });
    return;
  }

  try {
    const batchResult = await withTransaction(async (client) => {
      let nextDisplayOrder = await getNextDisplayOrder(client);
      const koridorKodesTerdampak = [];
      let totalRowsInserted = 0;

      for (const { kode, nama, sheetName } of koridorList) {
        const records = halteByKoridorKode[kode] || [];
        koridorKodesTerdampak.push(kode);

        // Upsert koridor. title/color/agency/schedule sengaja TIDAK ditimpa
        // kalau koridornya udah ada -- upload excel cuma buat data halte,
        // metadata tampilan diedit lewat endpoint /api/koridor terpisah.
        const { rows: koridorRows } = await client.query(
          `INSERT INTO koridor (kode, nama, sheet_name_asal, title, display_order)
           VALUES ($1, $2, $3, $2, $4)
           ON CONFLICT (kode) DO UPDATE
             SET nama = EXCLUDED.nama, sheet_name_asal = EXCLUDED.sheet_name_asal
           RETURNING id`,
          [kode, nama, sheetName, nextDisplayOrder++]
        );
        const koridorId = koridorRows[0].id;

        // Replace total: hapus semua halte lama koridor ini, insert ulang dari file
        await client.query(`DELETE FROM koridor_halte WHERE koridor_id = $1`, [koridorId]);

        for (const r of records) {
          await client.query(
            `INSERT INTO koridor_halte (
               koridor_id, no_urut, nama_halte, arah, fungsi_jalan,
               trotoar, rambu_halte, transit, direction_tag,
               lat_aplikasi, lng_aplikasi, lat_aktual, lng_aktual, lat_korlain, lng_korlain,
               lat, lng, coord_source, coord_confidence
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
            [
              koridorId, r.no_urut, r.nama_halte, r.arah, r.fungsi_jalan,
              r.trotoar, r.rambu_halte, r.transit, r.direction_tag,
              r.lat_aplikasi, r.lng_aplikasi, r.lat_aktual, r.lng_aktual, r.lat_korlain, r.lng_korlain,
              r.lat, r.lng, r.coord_source, r.coord_confidence,
            ]
          );
          totalRowsInserted++;
        }
      }

      const issueRows = Object.values(halteByKoridorKode).flat().filter((r) => r.issues.length);

      const { rows: batchRows } = await client.query(
        `INSERT INTO upload_batch (filename, status, koridor_kodes_terdampak, summary)
         VALUES ($1, 'completed', $2, $3) RETURNING id`,
        [
          filename,
          koridorKodesTerdampak,
          JSON.stringify({
            total_koridor: koridorList.length,
            total_rows_inserted: totalRowsInserted,
            rows_with_issues: issueRows.length,
            parse_warnings: warnings,
          }),
        ]
      );

      return { batchId: batchRows[0].id, koridorKodesTerdampak, totalRowsInserted, issueRows };
    });

    // Merge dijalanin di transaction TERPISAH setelah replace commit --
    // sengaja dipisah biar kalau merge gagal, data halte yang barusan
    // di-upload tetep tersimpan (gak ke-rollback gara-gara error di merge).
    const mergeResult = await withTransaction(async (client) => {
      const result = await mergeHalte(client);
      await client.query(
        `INSERT INTO publish_version (version, triggered_by_batch_id)
         VALUES (
           COALESCE((SELECT MAX(version) FROM publish_version), 0) + 1,
           $1
         )`,
        [batchResult.batchId]
      );
      return result;
    });

    res.status(200).json({
      ok: true,
      upload_batch_id: batchResult.batchId,
      koridor_terdampak: batchResult.koridorKodesTerdampak,
      total_halte_diupload: batchResult.totalRowsInserted,
      rows_dengan_issue: batchResult.issueRows.length,
      issues_sample: batchResult.issueRows.slice(0, 20),
      merge: mergeResult,
      warnings,
    });
  } catch (err) {
    res.status(500).json({ error: `Gagal proses upload: ${err.message}` });
  }
};

async function getNextDisplayOrder(client) {
  const { rows } = await client.query(`SELECT COALESCE(MAX(display_order), 0) AS max FROM koridor`);
  return Number(rows[0].max) + 1;
}
