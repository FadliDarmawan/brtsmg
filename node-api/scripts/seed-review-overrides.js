// scripts/seed-review-overrides.js
//
// Jalanin SEKALI setelah upload excel pertama ke Neon, buat mindahin 9
// keputusan review manual Semarang (chat sebelumnya) dari
// overrides_applied.json ke tabel halte_merge_override yang beneran.
//
// overrides_applied.json isinya masih pakai (sheet_name, no_urut) sebagai
// identitas baris -- BUKAN id asli dari DB (belum ada waktu file itu
// dibikin, masih di POC Python). Script ini yang nge-resolve keduanya jadi
// koridor_halte.id lewat JOIN ke koridor.sheet_name_asal.
//
// Usage:
//   DATABASE_URL=postgresql://...neon.tech/...  node scripts/seed-review-overrides.js
//
// Aman dijalanin berkali-kali (idempotent) -- pakai ON CONFLICT DO UPDATE,
// jadi kalau ada typo & kamu perbaiki overrides_applied.json, tinggal jalanin lagi.

const fs = require("fs");
const path = require("path");
const { withTransaction, getPool } = require("../lib/db");
const { mergeHalte } = require("../lib/mergeHalte");

const OVERRIDES_FILE = path.join(__dirname, "..", "overrides_applied.json");

async function resolveId(client, sheetName, noUrut) {
  const { rows } = await client.query(
    `SELECT kh.id
     FROM koridor_halte kh
     JOIN koridor k ON k.id = kh.koridor_id
     WHERE k.sheet_name_asal = $1 AND kh.no_urut = $2`,
    [sheetName, noUrut]
  );
  return rows[0]?.id ?? null;
}

async function main() {
  if (!fs.existsSync(OVERRIDES_FILE)) {
    console.error(`File tidak ketemu: ${OVERRIDES_FILE}`);
    process.exit(1);
  }
  const overrides = JSON.parse(fs.readFileSync(OVERRIDES_FILE, "utf-8"));
  console.log(`Memuat ${overrides.length} override dari overrides_applied.json`);

  let inserted = 0;
  const unresolved = [];

  await withTransaction(async (client) => {
    for (const ov of overrides) {
      const [sheetA, noUrutA] = ov.a;
      const [sheetB, noUrutB] = ov.b;

      const idA = await resolveId(client, sheetA, noUrutA);
      const idB = await resolveId(client, sheetB, noUrutB);

      if (idA == null || idB == null) {
        unresolved.push({ ...ov, resolved: { idA, idB } });
        continue;
      }

      await client.query(
        `INSERT INTO halte_merge_override
           (koridor_halte_a_id, koridor_halte_b_id, decision, reason, created_by)
         VALUES ($1, $2, $3, $4, 'seed-script')
         ON CONFLICT (LEAST(koridor_halte_a_id, koridor_halte_b_id),
                       GREATEST(koridor_halte_a_id, koridor_halte_b_id))
         DO UPDATE SET decision = EXCLUDED.decision,
                        reason = EXCLUDED.reason,
                        created_by = EXCLUDED.created_by,
                        created_at = now()`,
        [idA, idB, ov.decision, ov.note || null]
      );
      inserted++;
    }
  });

  console.log(`Berhasil di-seed: ${inserted}/${overrides.length}`);
  if (unresolved.length) {
    console.log(`\n⚠️  ${unresolved.length} override GAK ketemu row-nya di DB (mungkin belum diupload / nama sheet beda):`);
    for (const u of unresolved) {
      console.log(`   ${JSON.stringify(u.a)} <-> ${JSON.stringify(u.b)} [${u.decision}] -> resolved=${JSON.stringify(u.resolved)}`);
    }
  }

  console.log("\nMenjalankan ulang mergeHalte() dengan override yang baru di-seed...");
  const mergeResult = await withTransaction(async (client) => {
    const result = await mergeHalte(client);
    await client.query(
      `INSERT INTO publish_version (version)
       VALUES (COALESCE((SELECT MAX(version) FROM publish_version), 0) + 1)`
    );
    return result;
  });
  console.log("Hasil merge:", mergeResult);

  await getPool().end();
}

main().catch((err) => {
  console.error("Gagal seed override:", err);
  process.exit(1);
});
