// api/koridor.js
//
// GET  /api/koridor       -> list semua koridor (termasuk yang nonaktif), urut display_order
// POST /api/koridor       -> bikin koridor baru (buat rute yang gak lewat excel upload,
//                             misal rute baru yang halte-nya belum ada / gak lewat sistem CRUD halte)
//     body: { kode, nama, title, color, agency, schedule, displayOrder }
// PUT  /api/koridor       -> update koridor yang ada (title/color/agency/schedule/displayOrder/isActive)
//     body: { id, title?, color?, agency?, schedule?, displayOrder?, isActive? }
//
// PENTING: endpoint upload.js SENGAJA gak nimpa title/color/agency/schedule
// pas re-upload excel (biar edit manual di sini gak keilangan tiap kali ada
// upload halte baru) -- lihat komentar di upload.js bagian upsert koridor.
//
// Abis create/update, bump publish_version -- /api/routes-meta pake ETag
// dari situ, jadi perubahan warna/jam operasional langsung kepake di peta
// tanpa nunggu cache lama expire.

const { withTransaction } = require("../lib/db");

module.exports = async (req, res) => {
  if (req.method === "GET") return handleList(req, res);
  if (req.method === "POST") return handleCreate(req, res);
  if (req.method === "PUT") return handleUpdate(req, res);
  res.status(405).json({ error: "Method not allowed" });
};

async function handleList(req, res) {
  try {
    const { getPool } = require("../lib/db");
    const { rows } = await getPool().query(
      `SELECT id, kode, nama, sheet_name_asal, title, color, agency, schedule,
              start_stop_name, wayback_stop_name, display_order, is_active
       FROM koridor ORDER BY display_order`
    );
    res.status(200).json(rows);
  } catch (err) {
    res.status(500).json({ error: `Gagal ambil daftar koridor: ${err.message}` });
  }
}

async function handleCreate(req, res) {
  const { kode, nama, title, color, agency, schedule, displayOrder, startStopName, waybackStopName } = req.body || {};
  if (!kode || !nama) {
    res.status(400).json({ error: "kode dan nama wajib diisi" });
    return;
  }
  try {
    const result = await withTransaction(async (client) => {
      const { rows: maxRows } = await client.query(`SELECT COALESCE(MAX(display_order), 0) AS max FROM koridor`);
      const nextOrder = displayOrder ?? Number(maxRows[0].max) + 1;

      const { rows } = await client.query(
        `INSERT INTO koridor (kode, nama, title, color, agency, schedule, start_stop_name, wayback_stop_name, display_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id`,
        [
          kode, nama, title || nama, color || "#888888", agency || null,
          JSON.stringify(schedule || { type: "daily", hours: ["05:00-21:00"] }),
          startStopName || null, waybackStopName || null, nextOrder,
        ]
      );

      await client.query(
        `INSERT INTO publish_version (version) VALUES (COALESCE((SELECT MAX(version) FROM publish_version), 0) + 1)`
      );

      return rows[0].id;
    });

    res.status(200).json({ ok: true, id: result });
  } catch (err) {
    if (err.message.includes("koridor_kode_key") || err.message.includes("duplicate key")) {
      res.status(409).json({ error: `Kode koridor "${kode}" udah dipakai` });
      return;
    }
    res.status(500).json({ error: `Gagal bikin koridor: ${err.message}` });
  }
}

async function handleUpdate(req, res) {
  const { id, title, color, agency, schedule, displayOrder, isActive, startStopName, waybackStopName } = req.body || {};
  if (!id) {
    res.status(400).json({ error: "id wajib diisi" });
    return;
  }

  // Bangun SET clause dinamis -- cuma field yang dikirim yang diupdate,
  // biar admin UI bisa PATCH-style (kirim cuma field yang berubah).
  const sets = [];
  const values = [];
  let i = 1;

  if (title !== undefined) { sets.push(`title = $${i++}`); values.push(title); }
  if (color !== undefined) { sets.push(`color = $${i++}`); values.push(color); }
  if (agency !== undefined) { sets.push(`agency = $${i++}`); values.push(agency); }
  if (schedule !== undefined) { sets.push(`schedule = $${i++}`); values.push(JSON.stringify(schedule)); }
  if (displayOrder !== undefined) { sets.push(`display_order = $${i++}`); values.push(displayOrder); }
  if (isActive !== undefined) { sets.push(`is_active = $${i++}`); values.push(isActive); }
  if (startStopName !== undefined) { sets.push(`start_stop_name = $${i++}`); values.push(startStopName || null); }
  if (waybackStopName !== undefined) { sets.push(`wayback_stop_name = $${i++}`); values.push(waybackStopName || null); }

  if (!sets.length) {
    res.status(400).json({ error: "Gak ada field yang diupdate" });
    return;
  }
  values.push(id);

  try {
    await withTransaction(async (client) => {
      const { rowCount } = await client.query(
        `UPDATE koridor SET ${sets.join(", ")} WHERE id = $${i}`,
        values
      );
      if (rowCount === 0) throw new Error(`Koridor id=${id} gak ketemu`);

      await client.query(
        `INSERT INTO publish_version (version) VALUES (COALESCE((SELECT MAX(version) FROM publish_version), 0) + 1)`
      );
    });

    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: `Gagal update koridor: ${err.message}` });
  }
}