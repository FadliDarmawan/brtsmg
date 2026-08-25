// api/routes-meta.js
//
// GET /api/routes-meta
// Pengganti ROUTE_META + ROUTE_IDS + ROUTE_DIRECTIONS yang tadinya hardcode
// di index.html. Response:
//   { routeMeta: {...}, routeIds: [...], routeDirections: {...} }
//
// `routeIds` diurutkan pakai `display_order` dari tabel koridor -- BUKAN
// Object.keys(routeMeta), karena (lihat komentar asli di index.html Jogja)
// JS auto-reorder object key yang keliatan seperti integer polos ("6","8","9"...)
// ke depan urutan numerik, ngerusak urutan tampil yang diinginkan.
//
// `routeDirections[kode]` cuma diisi kalau start_stop_name & wayback_stop_name
// keduanya udah diisi lewat koridor-admin.html -- kalau salah satu masih
// kosong, koridor itu SENGAJA gak dimasukin ke routeDirections sama sekali
// (bukan dikasih objek isinya null), biar index.html's getRouteLegVertices()
// fail closed dengan bersih (gak ada tombol "Show final destination" buat
// koridor itu) alih-alih nyoba lookup vertex pake nama kosong dan gagal
// diam-diam kayak yang diomelin di komentar asli index.html.

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
      SELECT kode, title, color, agency, schedule, start_stop_name, wayback_stop_name
      FROM koridor
      WHERE is_active = true
      ORDER BY display_order
    `);

    const routeMeta = {};
    const routeIds = [];
    const routeDirections = {};
    for (const r of rows) {
      routeMeta[r.kode] = {
        title: r.title,
        color: r.color,
        agency: r.agency,
        schedule: r.schedule, // udah JSONB, node-pg otomatis parse jadi object
      };
      routeIds.push(r.kode);

      if (r.start_stop_name && r.wayback_stop_name) {
        routeDirections[r.kode] = {
          start: r.start_stop_name,
          wayback: r.wayback_stop_name,
          end: r.start_stop_name, // invariant: selalu balik ke stop fisik yang sama (lihat komentar index.html)
        };
      }
    }

    res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
    res.setHeader("ETag", etag);
    res.status(200).json({ routeMeta, routeIds, routeDirections });
  } catch (err) {
    res.status(500).json({ error: `Gagal ambil route metadata: ${err.message}` });
  }
};