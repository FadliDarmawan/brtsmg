// api/halte-search.js
//
// GET /api/halte-search?q=<search>
//
// Cari LANGSUNG di level koridor_halte (bukan halte_master) -- dipakai buat
// combobox "gabungkan 2 halte manual" di halte-master-admin.html, jadi
// admin bisa milih dua baris apapun (dari koridor manapun, udah ke-merge
// atau belum) buat di-force_merge.

const { getPool } = require("../lib/db");

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const q = (req.query?.q || "").trim();
  if (q.length < 2) {
    res.status(200).json([]);
    return;
  }

  try {
    const { rows } = await getPool().query(
      `SELECT kh.id AS koridor_halte_id, kh.nama_halte, kh.lat, kh.lng,
              kh.halte_master_id, k.kode AS koridor_kode, hm.nama AS master_nama, hm.member_count
       FROM koridor_halte kh
       JOIN koridor k ON k.id = kh.koridor_id
       LEFT JOIN halte_master hm ON hm.id = kh.halte_master_id
       WHERE kh.nama_halte ILIKE $1
       ORDER BY kh.nama_halte
       LIMIT 30`,
      [`%${q}%`]
    );
    res.status(200).json(rows);
  } catch (err) {
    res.status(500).json({ error: `Gagal cari halte: ${err.message}` });
  }
};