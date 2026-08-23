// lib/mergeHalte.js
//
// Port dari merge_halte.py (bagian merge_halte) + dukungan halte_merge_override
// (keputusan manual dari /api/review-resolve). Full-recompute tiap dipanggil:
// hapus semua halte_master, kelompokkan ulang SELURUH koridor_halte (bukan cuma
// yang baru di-upload), tulis ulang. Di skala ~1500 baris ini murah, jadi gak
// perlu incremental-merge yang lebih ribet & rawan bug drift.
//
// Aturan yang WAJIB dipertahankan (lihat diskusi sebelumnya):
//   - override manual (halte_merge_override) dibaca DULUAN, sebelum heuristik apapun
//       force_merge -> union paksa, walau jarak/nama/direction_tag apapun
//       force_split -> TIDAK PERNAH digabung, walau jarak < STRICT_M sekalipun
//   - halte dalam koridor yang SAMA gak pernah digabung satu sama lain
//   - direction_tag beda ([Utara] vs [Selatan] dst) = TIDAK PERNAH digabung,
//     walau jaraknya deket & namanya identik (itu 2 platform fisik beda sisi jalan)
//   - jarak < STRICT_M -> auto-merge
//   - STRICT_M <= jarak < REVIEW_M dan nama mirip -> masuk review_queue (pending)
//
// CATATAN PENTING soal override & union-find (nyata kejadian, lihat kasus
// "Gramedia Pandanaran" di chat sebelumnya): union bersifat TRANSITIF. Kalau
// titik A udah otomatis ke-cluster ke grup X (misal gara-gara koordinat
// kebetulan identik), terus di-force_merge ke grup Y, maka X dan Y IKUT
// KETULAR nyambung jadi satu lewat A -- kecuali ada force_split eksplisit
// yang motong hubungan A-X. Selalu cek hasil akhir clustering, jangan cuma
// percaya override yang diinput.

const STRICT_M = 20;
const REVIEW_M = 60;
const NAME_SIM_THRESHOLD = 0.55;
const BUCKET_DEG = 0.003; // ~300m, cuma buat batasin jumlah pasangan yang dibandingkan

function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dphi = toRad(lat2 - lat1);
  const dlmb = toRad(lng2 - lng1);
  const a =
    Math.sin(dphi / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dlmb / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function cleanNameForMatch(name) {
  if (!name) return "";
  return name.replace(/\[[^\]]*\]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

// Levenshtein ratio sederhana (aproksimasi difflib.SequenceMatcher.ratio()) --
// cukup buat threshold kasar 0.55, gak perlu identik persis ke versi Python.
function nameSimilarity(a, b) {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const dist = dp[m][n];
  const maxLen = Math.max(m, n);
  return maxLen === 0 ? 1 : 1 - dist / maxLen;
}

class UnionFind {
  constructor(n) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(x) {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]];
      x = this.parent[x];
    }
    return x;
  }
  union(a, b) {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.parent[ra] = rb;
  }
}

/**
 * Jalankan full re-merge. `client` harus pg client yang lagi di dalam transaction.
 * Return { halteMasterCount, reviewQueueInserted, autoMergedMultiKoridor }.
 */
async function mergeHalte(client) {
  const { rows } = await client.query(`
    SELECT id, koridor_id, nama_halte, direction_tag, lat, lng
    FROM koridor_halte
    WHERE lat IS NOT NULL AND lng IS NOT NULL
  `);

  const { rows: overrideRows } = await client.query(`
    SELECT koridor_halte_a_id, koridor_halte_b_id, decision FROM halte_merge_override
  `);

  const records = rows.map((r) => ({
    ...r,
    name_key: cleanNameForMatch(r.nama_halte),
  }));

  const idToIdx = new Map(records.map((r, i) => [r.id, i]));

  // Grid bucket
  const buckets = new Map();
  const bucketKey = (lat, lng) =>
    `${Math.round(lat / BUCKET_DEG)}:${Math.round(lng / BUCKET_DEG)}`;
  records.forEach((r, idx) => {
    const key = bucketKey(r.lat, r.lng);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(idx);
  });

  const uf = new UnionFind(records.length);

  // ---- Terapin override manual DULUAN, sebelum heuristik jarak/nama ----
  // (lihat catatan panjang di atas file soal union bersifat transitif --
  // force_split HARUS ditulis eksplisit kalau ada auto-merge lama yang perlu
  // dibatalkan, gak otomatis kebatal cuma gara-gara ada force_merge lain)
  const forceSplitPairs = new Set();
  const resolvedPairs = new Set(); // force_merge ATAU force_split -- keduanya
                                     // gak boleh nongol lagi di review_queue
  for (const ov of overrideRows) {
    const idxA = idToIdx.get(ov.koridor_halte_a_id);
    const idxB = idToIdx.get(ov.koridor_halte_b_id);
    if (idxA == null || idxB == null) continue; // row-nya udah kehapus (excel di-upload ulang tanpa halte itu)
    const pairKey = [idxA, idxB].sort((a, b) => a - b).join("-");
    resolvedPairs.add(pairKey);
    if (ov.decision === "force_merge") {
      uf.union(idxA, idxB);
    } else if (ov.decision === "force_split") {
      forceSplitPairs.add(pairKey);
    }
  }

  const reviewCandidates = [];
  const checkedPairs = new Set();

  for (const [key, idxs] of buckets.entries()) {
    const [bx, by] = key.split(":").map(Number);
    const neighborIdxs = new Set();
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const nk = `${bx + dx}:${by + dy}`;
        (buckets.get(nk) || []).forEach((i) => neighborIdxs.add(i));
      }
    }

    for (const a of idxs) {
      for (const b of neighborIdxs) {
        if (a >= b) continue;
        const pairKey = `${a}-${b}`;
        if (checkedPairs.has(pairKey)) continue;
        checkedPairs.add(pairKey);

        if (forceSplitPairs.has(pairKey)) continue; // keputusan manual: JANGAN PERNAH digabung

        const ra = records[a], rb = records[b];
        if (ra.koridor_id === rb.koridor_id) continue;
        if (ra.direction_tag && rb.direction_tag && ra.direction_tag !== rb.direction_tag) continue;

        const dist = haversineM(ra.lat, ra.lng, rb.lat, rb.lng);
        if (dist >= REVIEW_M) continue;

        const sim = nameSimilarity(ra.name_key, rb.name_key);
        if (dist < STRICT_M) {
          uf.union(a, b);
        } else if (sim >= NAME_SIM_THRESHOLD && !resolvedPairs.has(pairKey)) {
          reviewCandidates.push({
            koridor_halte_a_id: ra.id,
            koridor_halte_b_id: rb.id,
            distance_m: Math.round(dist * 10) / 10,
            name_similarity: Math.round(sim * 100) / 100,
            reason: "jarak dekat & nama mirip, tapi di atas ambang auto-merge",
          });
        }
      }
    }
  }

  // Kelompokkan hasil union-find
  const groups = new Map();
  records.forEach((r, idx) => {
    const root = uf.find(idx);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(r);
  });

  // Tulis ulang halte_master (full replace). ON DELETE SET NULL di FK otomatis
  // nge-null-in koridor_halte.halte_master_id yang lama.
  await client.query("DELETE FROM halte_master");

  let autoMergedMultiKoridor = 0;
  const updates = []; // [{ koridor_halte_id, halte_master_id }]

  for (const members of groups.values()) {
    const lat = members.reduce((s, m) => s + Number(m.lat), 0) / members.length;
    const lng = members.reduce((s, m) => s + Number(m.lng), 0) / members.length;
    const nama = members.reduce((best, m) =>
      (m.nama_halte || "").length > (best.nama_halte || "").length ? m : best
    ).nama_halte;
    const distinctKoridor = new Set(members.map((m) => m.koridor_id));
    if (distinctKoridor.size > 1) autoMergedMultiKoridor++;

    const { rows: inserted } = await client.query(
      `INSERT INTO halte_master (nama, lat, lng, member_count, last_merged_at)
       VALUES ($1, $2, $3, $4, now()) RETURNING id`,
      [nama, lat, lng, members.length]
    );
    const halteMasterId = inserted[0].id;
    members.forEach((m) => updates.push({ koridor_halte_id: m.id, halte_master_id: halteMasterId }));
  }

  // Bulk update koridor_halte.halte_master_id lewat satu statement (UNNEST)
  if (updates.length) {
    await client.query(
      `UPDATE koridor_halte AS kh
       SET halte_master_id = u.hmid
       FROM (
         SELECT UNNEST($1::bigint[]) AS khid, UNNEST($2::bigint[]) AS hmid
       ) AS u
       WHERE kh.id = u.khid`,
      [updates.map((u) => u.koridor_halte_id), updates.map((u) => u.halte_master_id)]
    );
  }

  // Masukin kandidat review baru, skip yang udah ada & masih pending
  let reviewInserted = 0;
  for (const rc of reviewCandidates) {
    const { rowCount } = await client.query(
      `INSERT INTO review_queue (koridor_halte_a_id, koridor_halte_b_id, distance_m, name_similarity, reason)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (LEAST(koridor_halte_a_id, koridor_halte_b_id), GREATEST(koridor_halte_a_id, koridor_halte_b_id))
       WHERE status = 'pending'
       DO NOTHING`,
      [rc.koridor_halte_a_id, rc.koridor_halte_b_id, rc.distance_m, rc.name_similarity, rc.reason]
    );
    reviewInserted += rowCount;
  }

  return {
    halteMasterCount: groups.size,
    autoMergedMultiKoridor,
    reviewQueueInserted: reviewInserted,
  };
}

module.exports = { mergeHalte, haversineM, nameSimilarity };
