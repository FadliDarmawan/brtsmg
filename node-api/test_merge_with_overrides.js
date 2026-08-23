// Validasi mergeHalte.js pake mock "client" in-memory (query() manual di-intercept),
// biar bisa ditest tanpa Neon beneran. Datanya dari parseWorkbook() atas file excel asli
// + 24 override yang sama persis kayak yang divalidasi di Python (apply_review_decisions.py).

const fs = require("fs");
const { parseWorkbook } = require("./lib/parseWorkbook");
const { mergeHalte } = require("./lib/mergeHalte");

const buffer = fs.readFileSync("/mnt/user-data/uploads/Rekap_Halte_BRT_Ori.xlsx");
const { koridorList, halteByKoridorKode } = parseWorkbook(buffer);

// Bangun koridor_halte in-memory dengan id sekuensial, mirip struktur tabel DB
let nextId = 1;
const koridorHalteRows = [];
for (const { kode, sheetName } of koridorList) {
  for (const r of halteByKoridorKode[kode]) {
    koridorHalteRows.push({
      id: nextId++,
      koridor_id: kode, // pakai kode sbg id koridor, cukup buat test ini
      sheet_name: sheetName,
      no_urut: r.no_urut,
      nama_halte: r.nama_halte,
      direction_tag: r.direction_tag,
      lat: r.lat,
      lng: r.lng,
    });
  }
}

function findRow(sheetContains, noUrut) {
  const row = koridorHalteRows.find(
    (r) => r.sheet_name.includes(sheetContains) && r.no_urut === noUrut
  );
  if (!row) throw new Error(`Gak ketemu: ${sheetContains} no_urut=${noUrut}`);
  return row;
}
function findExact(sheetContains, exactName) {
  const matches = koridorHalteRows.filter(
    (r) => r.sheet_name.includes(sheetContains) &&
      (r.nama_halte || "").trim().toLowerCase() === exactName.trim().toLowerCase()
  );
  if (matches.length !== 1) throw new Error(`Ambigu/gak ketemu (${matches.length}): ${sheetContains} / ${exactName}`);
  return matches[0];
}
function findByName(sheetContains, nameContains) {
  const matches = koridorHalteRows.filter(
    (r) => r.sheet_name.includes(sheetContains) &&
      (r.nama_halte || "").toLowerCase().includes(nameContains.toLowerCase())
  );
  if (!matches.length) throw new Error(`Gak ketemu: ${sheetContains} / ${nameContains}`);
  return matches[0];
}

const overrideRows = [];
function ov(a, b, decision) {
  overrideRows.push({ koridor_halte_a_id: a.id, koridor_halte_b_id: b.id, decision });
}

// 1. Gramedia Pandanaran
const gramediaMPolos = findExact("M Mangkang", "Gramedia Pandanaran");
for (const sheet of ["1 Mangkang", "3B Pelabuhan-Elisabeth", "4 Cangkiran", "5 PRPP", "8 Cangkiran"]) {
  ov(gramediaMPolos, findExact(sheet, "Gramedia Pandanaran [Utara]"), "force_merge");
}
for (const sheet of ["1 Mangkang", "8 Cangkiran"]) {
  ov(gramediaMPolos, findExact(sheet, "Gramedia Pandanaran [Selatan]"), "force_split");
}

// 2-3, 8. merge pairs
ov(findExact("2 Terboyo-Ungaran", "RSI Sultan Agung [Utara]"), findExact("F2A Terboyo-Tlogosari", "RSI Sultan Agung [Utara]"), "force_merge");
ov(findExact("2 Terboyo-Ungaran", "Kampung Tenggang [Utara]"), findExact("F2A Terboyo-Tlogosari", "Kampung Tenggang [Utara]"), "force_merge");
ov(findExact("2 Terboyo-Ungaran", "LIK [Utara]"), findExact("F2A Terboyo-Tlogosari", "LIK [Utara]"), "force_merge");

// 4. split
ov(findByName("2 Terboyo-Ungaran", "Kaligawe [Selatan]"), findByName("F2A Terboyo-Tlogosari", "Pojok Kaligawe"), "force_split");

// 5. split x3
for (const sheet of ["5 PRPP", "3A Pelabuhan-Kagok", "3B Pelabuhan-Elisabeth"]) {
  ov(findByName("2 Terboyo-Ungaran", "Mandiri Pemuda"), findByName(sheet, "BCA Pemuda"), "force_split");
}

// 6. split x6
const pasarJatingalehK2 = findByName("2 Terboyo-Ungaran", "Pasar Jatingaleh");
const pdamK6All = koridorHalteRows.filter(r => r.sheet_name.includes("6 UNDIP-UNNES") && r.nama_halte.includes("PDAM Jatingaleh [Timur]"));
ov(pasarJatingalehK2, findByName("3B Pelabuhan-Elisabeth", "PDAM Jatingaleh [Barat]"), "force_split");
ov(pasarJatingalehK2, pdamK6All[0], "force_split");
ov(pasarJatingalehK2, pdamK6All[1], "force_split");
ov(pasarJatingalehK2, findByName("3A Pelabuhan-Kagok", "PDAM Jatingaleh [Timur]"), "force_split");
ov(findByName("3A Pelabuhan-Kagok", "Pasar Jatingaleh [Barat]"), findByName("3B Pelabuhan-Elisabeth", "PDAM Jatingaleh [Barat]"), "force_split");
ov(findByName("3B Pelabuhan-Elisabeth", "PDAM Jatingaleh [Barat]"), findByName("6 UNDIP-UNNES", "Pasar Jatingaleh [Barat]"), "force_split");

// 7. split
ov(findByName("2 Terboyo-Ungaran", "Bukit Sari [Barat]"), findByName("6 UNDIP-UNNES", "Bukit Sari"), "force_split");

// 9. Pertigaan Cangkiran (4 override)
const k8SpLima = findRow("8 Cangkiran-Simpang Lima", 2);
const k8Cangkiran = findRow("8 Cangkiran-Simpang Lima", 112);
const k4Barat = findRow("4 Cangkiran-Tantular", 2);
const k4Timur = findRow("4 Cangkiran-Tantular", 114);
ov(k8SpLima, k4Barat, "force_merge");
ov(k8Cangkiran, k4Barat, "force_split");
ov(k8Cangkiran, k4Timur, "force_merge");
ov(k8SpLima, k4Timur, "force_split");

console.log(`Total override: ${overrideRows.length}`);

// Mock pg client -- cukup implementasikan query() yang dipanggil mergeHalte()
function makeMockClient() {
  const halteMasterRows = [];
  let nextHmId = 1;
  const updates = [];
  let reviewInserted = 0;
  const insertedReviewPairs = new Set();

  return {
    async query(sql, params) {
      const s = sql.trim();
      if (s.startsWith("SELECT id, koridor_id, nama_halte, direction_tag, lat, lng")) {
        return { rows: koridorHalteRows.map(r => ({ ...r })) };
      }
      if (s.startsWith("SELECT koridor_halte_a_id, koridor_halte_b_id, decision FROM halte_merge_override")) {
        return { rows: overrideRows };
      }
      if (s.startsWith("DELETE FROM halte_master")) {
        halteMasterRows.length = 0;
        return { rows: [] };
      }
      if (s.startsWith("INSERT INTO halte_master")) {
        const [nama, lat, lng, member_count] = params;
        const id = nextHmId++;
        halteMasterRows.push({ id, nama, lat, lng, member_count });
        return { rows: [{ id }] };
      }
      if (s.startsWith("UPDATE koridor_halte")) {
        const [khIds, hmIds] = params;
        khIds.forEach((khid, i) => updates.push({ khid, hmid: hmIds[i] }));
        return { rows: [] };
      }
      if (s.startsWith("INSERT INTO review_queue")) {
        const [a, b] = params;
        const key = [a, b].sort((x, y) => x - y).join("-");
        if (insertedReviewPairs.has(key)) return { rowCount: 0 };
        insertedReviewPairs.add(key);
        reviewInserted++;
        return { rowCount: 1 };
      }
      throw new Error("Unmocked query: " + s.slice(0, 80));
    },
    _debug: { halteMasterRows, updates, get reviewInserted() { return reviewInserted; } },
  };
}

(async () => {
  const client = makeMockClient();
  const result = await mergeHalte(client);
  console.log("Result:", result);
  console.log("Expected (dari Python): halteMasterCount=1102, reviewQueueInserted=0");
})();
