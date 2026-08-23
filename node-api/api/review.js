// api/review.js
//
// GET /api/review
// List semua kandidat merge yang masih pending, lewat view v_review_queue_pending
// (dari schema.sql). Gak pake cache header -- ini data kerja admin, harus selalu fresh.

const { getPool } = require("../lib/db");

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const { rows } = await getPool().query(`SELECT * FROM v_review_queue_pending`);
    res.status(200).json(rows);
  } catch (err) {
    res.status(500).json({ error: `Gagal ambil review queue: ${err.message}` });
  }
};
