// api/routes-meta.js
//
// GET /api/routes-meta
// Pengganti ROUTE_META + ROUTE_IDS yang tadinya hardcode di index.html.
// Response: { routeMeta: { [kode]: {title,color,agency,schedule} }, routeIds: [kode, ...] }
//
// `routeIds` diurutkan pakai `display_order` dari tabel koridor -- BUKAN
// Object.keys(routeMeta), karena (lihat komentar asli di index.html Jogja)
// JS auto-reorder object key yang keliatan seperti integer polos ("6","8","9"...)
// ke depan urutan numerik, ngerusak urutan tampil yang diinginkan.

const { getPool } = require("../lib/db");

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const pool = getPool();

  try {
    const { rows: versionRows } = await pool.query(
      `SELECT COALESCE(MAX(version), 0) AS version FROM publish_version`
    );
    const etag = `"routes-meta-v${versionRows[0].version}"`;

    if (req.headers["if-none-match"] === etag) {
      res.status(304).end();
      return;
    }

    const { rows } = await pool.query(`
      SELECT kode, title, color, agency, schedule
      FROM koridor
      WHERE is_active = true
      ORDER BY display_order
    `);

    const routeMeta = {};
    const routeIds = [];
    for (const r of rows) {
      routeMeta[r.kode] = {
        title: r.title,
        color: r.color,
        agency: r.agency,
        schedule: r.schedule, // udah JSONB, node-pg otomatis parse jadi object
      };
      routeIds.push(r.kode);
    }

    res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
    res.setHeader("ETag", etag);
    res.status(200).json({ routeMeta, routeIds });
  } catch (err) {
    res.status(500).json({ error: `Gagal ambil route metadata: ${err.message}` });
  }
};
