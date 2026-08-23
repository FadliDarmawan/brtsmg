"""
Terapin 9 keputusan manual dari review queue ke hasil merge, lalu validasi.
Setiap override diidentifikasi lewat (sheet_name, no_urut) -- unik per baris,
gak ambigu walau nama halte-nya sama persis (lihat kasus #9).
"""
import json
from merge_halte import parse_workbook, merge_halte, SRC

records, parse_warnings = parse_workbook(SRC)


def find(sheet_contains, no_urut):
    for r in records:
        if sheet_contains in r["sheet_name"] and r["no_urut"] == no_urut:
            return r
    raise ValueError(f"Gak ketemu: {sheet_contains} no_urut={no_urut}")


# ---------------------------------------------------------------------------
# Bantu cari no_urut dari nama, biar override list di bawah gampang dibaca
# dan gampang di-cross-check manual.
# ---------------------------------------------------------------------------
def find_by_name(sheet_contains, name_contains, nth=0):
    matches = [r for r in records
               if sheet_contains in r["sheet_name"]
               and name_contains.lower() in (r["nama_halte"] or "").lower()]
    if not matches:
        raise ValueError(f"Gak ketemu: {sheet_contains} / {name_contains}")
    return matches[nth]


def find_exact(sheet_contains, exact_name):
    """Match nama_halte PERSIS (bukan substring) -- buat kasus 2 entry di sheet
    yang sama sama-sama mengandung teks yang mirip (mis. 'Gramedia Pandanaran'
    vs 'Gramedia Pandanaran [Utara]' di sheet M yang sama)."""
    matches = [r for r in records
               if sheet_contains in r["sheet_name"]
               and (r["nama_halte"] or "").strip().lower() == exact_name.strip().lower()]
    if not matches:
        raise ValueError(f"Gak ketemu (exact): {sheet_contains} / {exact_name}")
    if len(matches) > 1:
        raise ValueError(f"Ambigu, {len(matches)} match: {sheet_contains} / {exact_name}")
    return matches[0]


overrides = []


def add(a_sheet, a_name, b_sheet, b_name, decision, note, a_nth=0, b_nth=0):
    a = find_by_name(a_sheet, a_name, a_nth)
    b = find_by_name(b_sheet, b_name, b_nth)
    overrides.append({
        "a": (a["sheet_name"], a["no_urut"]),
        "b": (b["sheet_name"], b["no_urut"]),
        "decision": decision,
        "note": note,
    })


# 1. Gramedia Pandanaran (M) -> merge ke Gramedia Pandanaran [Utara] (semua koridor)
#    CATATAN: koordinat mentah si "M, tanpa tag" ini kebetulan identik sama
#    [Selatan] (bukan [Utara]), jadi dia udah OTOMATIS ke-merge duluan ke
#    cluster [Selatan] (jarak 0m, lolos strict auto-merge) sebelum override
#    ini jalan. Makanya perlu force_split eksplisit dari [Selatan] JUGA, bukan
#    cuma force_merge ke [Utara] -- kalau nggak, union-find nyambungin dua
#    cluster itu jadi satu lewat titik M ini (union bersifat transitif).
gramedia_m_polos = find_exact("M Mangkang", "Gramedia Pandanaran")  # bukan yang [Utara]/[Selatan]
for sheet in ["1 Mangkang", "3B Pelabuhan-Elisabeth", "4 Cangkiran", "5 PRPP", "8 Cangkiran"]:
    utara = find_exact(sheet, "Gramedia Pandanaran [Utara]")
    overrides.append({
        "a": (gramedia_m_polos["sheet_name"], gramedia_m_polos["no_urut"]),
        "b": (utara["sheet_name"], utara["no_urut"]),
        "decision": "force_merge",
        "note": "Gramedia Pandanaran (M, tanpa tag) confirmed = sisi Utara",
    })
for sheet in ["1 Mangkang", "8 Cangkiran"]:  # sheet yang punya [Selatan] & koordinatnya nabrak si M-polos
    selatan = find_exact(sheet, "Gramedia Pandanaran [Selatan]")
    overrides.append({
        "a": (gramedia_m_polos["sheet_name"], gramedia_m_polos["no_urut"]),
        "b": (selatan["sheet_name"], selatan["no_urut"]),
        "decision": "force_split",
        "note": "koordinat M-polos kebetulan sama persis dgn [Selatan], tapi ini sebenarnya sisi Utara",
    })

# 2. RSI Sultan Agung -> merge (koridor 2 <-> F2A, [Utara])
add("2 Terboyo-Ungaran", "RSI Sultan Agung [Utara]", "F2A Terboyo-Tlogosari", "RSI Sultan Agung [Utara]",
    "force_merge", "RSI Sultan Agung [Utara] confirmed sama titik")

# 3. Kampung Tenggang -> merge (koridor 2 <-> F2A, [Utara])
add("2 Terboyo-Ungaran", "Kampung Tenggang [Utara]", "F2A Terboyo-Tlogosari", "Kampung Tenggang [Utara]",
    "force_merge", "Kampung Tenggang [Utara] confirmed sama titik")

# 4. Kaligawe [Selatan] vs Pojok Kaligawe -> BEDA
add("2 Terboyo-Ungaran", "Kaligawe [Selatan]", "F2A Terboyo-Tlogosari", "Pojok Kaligawe",
    "force_split", "confirmed 2 titik fisik berbeda")

# 5. Mandiri Pemuda vs BCA Pemuda -> BEDA (3 pasangan)
for sheet in ["5 PRPP", "3A Pelabuhan-Kagok", "3B Pelabuhan-Elisabeth"]:
    add("2 Terboyo-Ungaran", "Mandiri Pemuda", sheet, "BCA Pemuda",
        "force_split", "confirmed 2 titik fisik berbeda")

# 6. Pasar Jatingaleh, PDAM Jatingaleh [Barat], PDAM Jatingaleh [Timur] -> semua BEDA
add("2 Terboyo-Ungaran", "Pasar Jatingaleh", "3B Pelabuhan-Elisabeth", "PDAM Jatingaleh [Barat]",
    "force_split", "confirmed 3 titik fisik berbeda")
add("2 Terboyo-Ungaran", "Pasar Jatingaleh", "6 UNDIP-UNNES", "PDAM Jatingaleh [Timur]",
    "force_split", "confirmed 3 titik fisik berbeda", b_nth=0)
add("2 Terboyo-Ungaran", "Pasar Jatingaleh", "6 UNDIP-UNNES", "PDAM Jatingaleh [Timur]",
    "force_split", "confirmed 3 titik fisik berbeda", b_nth=1)
add("2 Terboyo-Ungaran", "Pasar Jatingaleh", "3A Pelabuhan-Kagok", "PDAM Jatingaleh [Timur]",
    "force_split", "confirmed 3 titik fisik berbeda")
add("3A Pelabuhan-Kagok", "Pasar Jatingaleh [Barat]", "3B Pelabuhan-Elisabeth", "PDAM Jatingaleh [Barat]",
    "force_split", "confirmed 3 titik fisik berbeda")
add("3B Pelabuhan-Elisabeth", "PDAM Jatingaleh [Barat]", "6 UNDIP-UNNES", "Pasar Jatingaleh [Barat]",
    "force_split", "confirmed 3 titik fisik berbeda")

# 7. Bukit Sari [Barat] vs Bukit Sari (k6) -> BEDA
#    (catatan: "Bukit Sari"(k6) SUDAH otomatis ke-merge dengan benar ke
#    "Bukit Sari [Timur]"(k2) karena koordinatnya identik -- gak butuh
#    force_merge tambahan, cuma perlu nolak kandidat yang salah ini)
add("2 Terboyo-Ungaran", "Bukit Sari [Barat]", "6 UNDIP-UNNES", "Bukit Sari",
    "force_split", "confirmed beda; Bukit Sari(k6) sudah otomatis benar ke [Timur]")

# 8. LIK [Utara] -> merge (koridor 2 <-> F2A)
add("2 Terboyo-Ungaran", "LIK [Utara]", "F2A Terboyo-Tlogosari", "LIK [Utara]",
    "force_merge", "LIK [Utara] confirmed sama titik")

# 9. Pertigaan Cangkiran, koridor 8:
#    - no_urut=2  (arah "Sp. Lima")  -> ke [Barat] koridor 4 (koordinat sudah benar,
#      tapi tetep didaftarin eksplisit biar gak balik ke ambigu di re-merge nanti)
#    - no_urut=112 (arah "Cangkiran") -> HARUS ke [Timur] koridor 4, TAPI koordinatnya
#      salah rekam (identik dgn arah Sp.Lima) sehingga auto ke-merge ke [Barat] --
#      perlu force_split dari Barat DAN force_merge ke Timur sekaligus.
k8_sp_lima = find("8 Cangkiran-Simpang Lima", 2)
k8_cangkiran = find("8 Cangkiran-Simpang Lima", 112)
k4_barat = find("4 Cangkiran-Tantular", 2)
k4_timur = find("4 Cangkiran-Tantular", 114)

overrides.append({"a": (k8_sp_lima["sheet_name"], k8_sp_lima["no_urut"]),
                   "b": (k4_barat["sheet_name"], k4_barat["no_urut"]),
                   "decision": "force_merge",
                   "note": "arah Sp.Lima = sisi Barat (koordinat sudah cocok)"})
overrides.append({"a": (k8_cangkiran["sheet_name"], k8_cangkiran["no_urut"]),
                   "b": (k4_barat["sheet_name"], k4_barat["no_urut"]),
                   "decision": "force_split",
                   "note": "arah Cangkiran BUKAN sisi Barat, walau koordinat kebetulan sama (bug data)"})
overrides.append({"a": (k8_cangkiran["sheet_name"], k8_cangkiran["no_urut"]),
                   "b": (k4_timur["sheet_name"], k4_timur["no_urut"]),
                   "decision": "force_merge",
                   "note": "arah Cangkiran = sisi Timur (override manual, koordinat mentahnya salah)"})

overrides.append({"a": (k8_sp_lima["sheet_name"], k8_sp_lima["no_urut"]),
                   "b": (k4_timur["sheet_name"], k4_timur["no_urut"]),
                   "decision": "force_split",
                   "note": "arah Sp.Lima sudah dipastikan sisi Barat, bukan Timur"})

print(f"Total override diterapkan: {len(overrides)}")
for ov in overrides:
    print(f"  [{ov['decision']:12}] {ov['a']} <-> {ov['b']}  -- {ov['note']}")

halte_master, review_queue, override_warnings = merge_halte(records, overrides)

if override_warnings:
    print("\n⚠️  WARNING (override gak match record):")
    for w in override_warnings:
        print(" ", w)

print(f"\nHasil setelah override:")
print(f"  halte_master : {len(halte_master)}  (sebelumnya 1105)")
print(f"  review_queue : {len(review_queue)}  (sebelumnya 21)")

print("\nSisa review_queue (harusnya cuma yang belum diputusin user):")
for r in review_queue:
    a, b = r["record_a"], r["record_b"]
    print(f"  {r['distance_m']:>5}m sim={r['name_similarity']} | {a['koridor'].strip():<28} '{a['nama']}' <-> {b['koridor'].strip():<28} '{b['nama']}'")

# Validasi spesifik: cek cluster Pertigaan Cangkiran & Gramedia Pandanaran
print("\n--- Validasi kasus #9 (Pertigaan Cangkiran) ---")
for h in halte_master:
    if "pertigaan cangkiran" in h["nama"].lower():
        print(" ", h)

print("\n--- Validasi kasus #1 (Gramedia Pandanaran) ---")
for h in halte_master:
    if "gramedia pandanaran" in h["nama"].lower():
        print(" ", h)

with open("halte_master_resolved.json", "w", encoding="utf-8") as f:
    json.dump(halte_master, f, ensure_ascii=False, indent=2)
with open("review_queue_remaining.json", "w", encoding="utf-8") as f:
    json.dump(review_queue, f, ensure_ascii=False, indent=2)
with open("overrides_applied.json", "w", encoding="utf-8") as f:
    json.dump(overrides, f, ensure_ascii=False, indent=2)
