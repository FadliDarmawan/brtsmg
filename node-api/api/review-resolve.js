// api/review-resolve.js
//
// POST /api/review-resolve
// Body JSON: {
//   koridorHalteAId: number,
//   koridorHalteBId: number,
//   decision: "force_merge" | "force_split",
//   reason?: string,
//   resolvedBy?: string
// }
//
// PENTING: endpoint ini SENGAJA gak mensyaratkan pasangan itu harus ada di
// review_queue dulu. Kasus nyata (lihat diskusi "Gramedia Pandanaran" &
// "Pertigaan Cangkiran"): keputusan manual kadang perlu nutup pasangan yang
// gak pernah otomatis kedeteksi sebagai kandidat ambigu -- misalnya
// force_split dari cluster yang KEBETULAN ke-auto-merge gara-gara koordinat
// identik. Jadi endpoint ini nerima id pasangan apa aja langsung dari admin
// UI (mis. tombol "pisahkan dari sini" di detail halte), bukan cuma dari
// daftar /api/review.
//
// Override disimpan PERMANEN di halte_merge_override -- kalau nanti ada
// upload excel baru yang trigger re-merge, keputusan ini tetap dipegang,
// gak balik ambigu lagi. Baca catatan panjang soal union transitif di
// lib/mergeHalte.js kalau mau ngerti kenapa satu keputusan kadang perlu
// lebih dari satu override (co: approve 1 merge bisa butuh 1-2 force_split
// tambahan buat motong cluster lama yang gak seharusnya ikut nyambung).

const { withTransaction } = require("../lib/db");
const { mergeHalte } = require("../lib/mergeHalte");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { koridorHalteAId, koridorHalteBId, decision, reason, resolvedBy } = req.body || {};

  if (!koridorHalteAId || !koridorHalteBId) {
    res.status(400).json({ error: "koridorHalteAId dan koridorHalteBId wajib diisi" });
    return;
  }
  if (!["force_merge", "force_split"].includes(decision)) {
    res.status(400).json({ error: "decision harus 'force_merge' atau 'force_split'" });
    return;
  }
  if (koridorHalteAId === koridorHalteBId) {
    res.status(400).json({ error: "koridorHalteAId dan koridorHalteBId gak boleh sama" });
    return;
  }

  try {
    await withTransaction(async (client) => {
      // Upsert override -- kalau admin berubah pikiran (force_merge -> force_split
      // atau sebaliknya) buat pasangan yang sama, keputusan terbaru yang menang.
      await client.query(
        `INSERT INTO halte_merge_override
           (koridor_halte_a_id, koridor_halte_b_id, decision, reason, created_by)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (LEAST(koridor_halte_a_id, koridor_halte_b_id),
                       GREATEST(koridor_halte_a_id, koridor_halte_b_id))
         DO UPDATE SET decision = EXCLUDED.decision,
                        reason = EXCLUDED.reason,
                        created_by = EXCLUDED.created_by,
                        created_at = now()`,
        [koridorHalteAId, koridorHalteBId, decision, reason || null, resolvedBy || null]
      );

      // Kalau pasangan ini kebetulan lagi nangkring di review_queue (status pending),
      // tandai selesai -- biar gak nongol lagi di UI review.
      // CATATAN: $3/$4 di-cast eksplisit ke ::bigint karena dipakai DI DALAM
      // LEAST()/GREATEST() (bukan dibandingin langsung ke kolom) -- Postgres
      // gak bisa nebak tipe parameter dari konteks itu, defaultnya "text",
      // bentrok sama kolom bigint ("operator does not exist: bigint = text").
      const reviewStatus = decision === "force_merge" ? "approved" : "rejected";
      await client.query(
        `UPDATE review_queue
         SET status = $1, resolved_by = $2, resolved_at = now()
         WHERE LEAST(koridor_halte_a_id, koridor_halte_b_id) = LEAST($3::bigint, $4::bigint)
           AND GREATEST(koridor_halte_a_id, koridor_halte_b_id) = GREATEST($3::bigint, $4::bigint)
           AND status = 'pending'`,
        [reviewStatus, resolvedBy || null, koridorHalteAId, koridorHalteBId]
      );
    });

    // Re-merge di transaction terpisah, sama seperti /api/upload -- kalau
    // gagal, keputusan override yang barusan disimpan tetap gak hilang.
    const mergeResult = await withTransaction(async (client) => {
      const result = await mergeHalte(client);
      await client.query(
        `INSERT INTO publish_version (version)
         VALUES (COALESCE((SELECT MAX(version) FROM publish_version), 0) + 1)`
      );
      return result;
    });

    res.status(200).json({ ok: true, decision, merge: mergeResult });
  } catch (err) {
    res.status(500).json({ error: `Gagal simpan keputusan review: ${err.message}` });
  }
};
