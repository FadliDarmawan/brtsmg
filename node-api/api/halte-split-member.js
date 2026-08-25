// api/halte-split-member.js
//
// POST /api/halte-split-member
// Body: { koridorHalteId, reason? }
//
// "Pisahkan dari grup ini" -- bukan cuma force_split TERHADAP SATU baris
// lain, tapi terhadap SEMUA anggota lain di halte_master yang SAMA saat ini.
// Ini perlu karena union-find bersifat transitif: kalau baris X ke-merge ke
// grup {A, B, C} lewat rantai jarak (X dekat A, A dekat B, dst), motong
// cuma satu hubungan (misal X-A) belum tentu ngelepas X dari grup itu kalau
// X kebetulan juga < STRICT_M dari B atau C secara langsung. Force_split ke
// SEMUA anggota lain di grup itu -- aman, gak ada ambiguitas union-find.
//
// Setelah override kesimpen, X bakal jadi halte_master baru sendirian (atau
// balik nyantol ke grup lain kalau emang deket ke grup lain juga -- itu
// keputusan algoritma normal, bukan override).

const { withTransaction } = require("../lib/db");
const { mergeHalte } = require("../lib/mergeHalte");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { koridorHalteId, reason } = req.body || {};
  if (!koridorHalteId) {
    res.status(400).json({ error: "koridorHalteId wajib diisi" });
    return;
  }

  try {
    const splitCount = await withTransaction(async (client) => {
      const { rows: selfRows } = await client.query(
        `SELECT halte_master_id FROM koridor_halte WHERE id = $1`,
        [koridorHalteId]
      );
      if (!selfRows.length) throw new Error(`koridor_halte id=${koridorHalteId} gak ketemu`);
      const masterId = selfRows[0].halte_master_id;
      if (!masterId) {
        // Belum pernah ke-merge sama sekali -- gak ada apa-apa buat dipisah.
        return 0;
      }

      const { rows: siblingRows } = await client.query(
        `SELECT id FROM koridor_halte WHERE halte_master_id = $1 AND id <> $2`,
        [masterId, koridorHalteId]
      );

      for (const sibling of siblingRows) {
        await client.query(
          `INSERT INTO halte_merge_override
             (koridor_halte_a_id, koridor_halte_b_id, decision, reason, created_by)
           VALUES ($1, $2, 'force_split', $3, 'halte-master-admin')
           ON CONFLICT (LEAST(koridor_halte_a_id, koridor_halte_b_id),
                         GREATEST(koridor_halte_a_id, koridor_halte_b_id))
           DO UPDATE SET decision = 'force_split', reason = EXCLUDED.reason, created_by = EXCLUDED.created_by, created_at = now()`,
          [koridorHalteId, sibling.id, reason || null]
        );
      }

      return siblingRows.length;
    });

    // Re-merge di transaction terpisah, pola sama kayak /api/review-resolve.
    const mergeResult = await withTransaction(async (client) => {
      const result = await mergeHalte(client);
      await client.query(
        `INSERT INTO publish_version (version) VALUES (COALESCE((SELECT MAX(version) FROM publish_version), 0) + 1)`
      );
      return result;
    });

    res.status(200).json({ ok: true, overridesCreated: splitCount, merge: mergeResult });
  } catch (err) {
    res.status(500).json({ error: `Gagal pisahkan halte: ${err.message}` });
  }
};