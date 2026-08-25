// api/stops.js
//
// GET /api/stops
// Shape response-nya SENGAJA dibuat identik dengan ./stops/stops.json yang
// lama, jadi loadStops() di index.html gak perlu diubah sama sekali -- cuma
// URL fetch-nya yang ganti.
//
// Caching -- DUA LAPIS, jangan disamain:
//   1. Browser cache (dikontrol max-age efektif + ETag/If-None-Match) --
//      request DARI BROWSER YANG SAMA yang udah pernah fetch URL ini bisa
//      di-skip jadi 304 kalau publish_version belum berubah.
//   2. Vercel EDGE CDN cache (dikontrol s-maxage) -- ini TERPISAH dari ETag.
//      Selama s-maxage belum lewat, edge langsung balikin response yang
//      di-cache TANPA nanya balik ke function ini sama sekali -- jadi walau
//      publish_version udah naik di DB, semua orang (bukan cuma browser
//      yang sama) masih bisa dapet data LAMA sampai cache edge itu expired.
//
// s-maxage sengaja dibikin PENDEK (bukan 3600 kayak awalnya) karena
// query-nya murah (~1500 baris, index kecil) dan proyek ini lagi banyak
// diedit iteratif lewat admin pages -- freshness lebih penting daripada
// ngirit query DB di tahap ini. Naikin lagi kalau proyeknya udah stabil.

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

    res.setHeader("Cache-Control", "public, s-maxage=5, stale-while-revalidate=30");
    res.setHeader("ETag", etag);
    res.status(200).json(rows);
  } catch (err) {
    res.status(500).json({ error: `Gagal ambil data stops: ${err.message}` });
  }
};