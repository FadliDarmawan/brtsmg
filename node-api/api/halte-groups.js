// api/halte-groups.js
//
// GET /api/halte-groups?q=<search>
//
// Beda dari /api/review -- itu cuma nampilin kandidat yang masih PENDING
// (belum diputusin). Ini nampilin grup yang UDAH ke-merge (auto, distance
// < STRICT_M) biar bisa di-audit ulang & dipisah kalau ternyata salah --
// kasus yang gak pernah masuk review_queue sama sekali karena auto-merge
// dianggap "pasti benar" oleh heuristik jarak.
//
// q kosong -> semua grup dengan member_count > 1 (dibatasi 200 biar gak berat)
// q diisi  -> filter grup yang nama masternya ATAU salah satu nama anggotanya
//             mengandung q (case-insensitive)

const { getPool } = require("../lib/db");

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const q = (req.query?.q || "").trim();

  try {
    const pool = getPool();
    let masterRows;

    if (q) {
      const { rows } = await pool.query(
        `SELECT DISTINCT hm.id, hm.nama, hm.member_count
         FROM halte_master hm
         JOIN koridor_halte kh ON kh.halte_master_id = hm.id
         WHERE hm.member_count > 1
           AND (hm.nama ILIKE $1 OR kh.nama_halte ILIKE $1)
         ORDER BY hm.nama
         LIMIT 200`,
        [`%${q}%`]
      );
      masterRows = rows;
    } else {
      const { rows } = await pool.query(
        `SELECT id, nama, member_count FROM halte_master
         WHERE member_count > 1
         ORDER BY nama
         LIMIT 200`
      );
      masterRows = rows;
    }

    if (!masterRows.length) {
      res.status(200).json([]);
      return;
    }

    const masterIds = masterRows.map((m) => m.id);
    const { rows: memberRows } = await pool.query(
      `SELECT kh.halte_master_id, kh.id AS koridor_halte_id, kh.nama_halte,
              kh.lat, kh.lng, kh.direction_tag, k.kode AS koridor_kode
       FROM koridor_halte kh
       JOIN koridor k ON k.id = kh.koridor_id
       WHERE kh.halte_master_id = ANY($1::bigint[])
       ORDER BY k.kode`,
      [masterIds]
    );

    const membersByMaster = new Map();
    for (const m of memberRows) {
      if (!membersByMaster.has(m.halte_master_id)) membersByMaster.set(m.halte_master_id, []);
      membersByMaster.get(m.halte_master_id).push(m);
    }

    const result = masterRows.map((m) => ({
      halte_master_id: m.id,
      nama: m.nama,
      member_count: m.member_count,
      members: membersByMaster.get(m.id) || [],
    }));

    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ error: `Gagal ambil daftar grup: ${err.message}` });
  }
};