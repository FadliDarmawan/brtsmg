// api/stops.js
//
// GET /api/stops
// Shape response-nya SENGAJA dibuat identik dengan ./stops/stops.json yang
// lama, jadi loadStops() di index.html gak perlu diubah sama sekali -- cuma
// URL fetch-nya yang ganti.
//
// Caching: Vercel edge cache pake header Cache-Control (public + s-maxage).
// ETag dari nomor publish_version terbaru -- kalau belum ada koridor/upload
// baru sejak client terakhir fetch, browser/edge cukup dapet 304, gak perlu
// query ulang ke Neon (penting krn Neon serverless punya cold-start).

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
    const version = versionRows[0].version;
    const etag = `"stops-v${version}"`;

    if (req.headers["if-none-match"] === etag) {
      res.status(304).end();
      return;
    }

    const { rows } = await pool.query(`
      SELECT point, stop_name, services
      FROM v_stops_api
      ORDER BY stop_name
    `);

    res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
    res.setHeader("ETag", etag);
    res.status(200).json(rows);
  } catch (err) {
    res.status(500).json({ error: `Gagal ambil data stops: ${err.message}` });
  }
};
