#!/usr/bin/env python3
"""Assess ROS PDF structure for SQLite FTS5 extraction."""

import fitz
import re
import json
from collections import Counter

PDF = "/Users/amm0/Downloads/ROS-260625-1140-2328.pdf"
doc = fitz.open(PDF)

print(f"Pages: {doc.page_count}")
print(f"Metadata: {doc.metadata}")
print()

# --- Step 1: Parse TOC from text of first 5 pages ---
toc_text = ""
for i in range(min(5, doc.page_count)):
    toc_text += doc[i].get_text("text")

toc_entries = []
for line in toc_text.split("\n"):
    m = re.match(r'^(\s*)([\d.]+)\s+(.+?)\s*\.[\s.]*(\d+)\s*$', line)
    if m:
        indent, num, title, page = m.groups()
        depth = len([x for x in num.split('.') if x])
        toc_entries.append({
            "section": num.rstrip('.'),
            "title": title.strip().rstrip('. '),
            "page": int(page),
            "depth": depth,
        })

print(f"TOC entries parsed: {len(toc_entries)}")

# Compute page ranges: each section runs from its page to the next section's page - 1
for i, entry in enumerate(toc_entries):
    if i + 1 < len(toc_entries):
        entry["page_end"] = toc_entries[i + 1]["page"] - 1
    else:
        entry["page_end"] = doc.page_count
    entry["page_count"] = entry["page_end"] - entry["page"] + 1

# --- Step 2: Font analysis on sample pages ---
print("\n=== FONT ANALYSIS (sample: pages 228-232, REST API section) ===")
font_stats = Counter()
font_sizes = Counter()
sample_spans = []

for pg_num in range(227, 232):  # 0-indexed
    page = doc[pg_num]
    blocks = page.get_text("dict")["blocks"]
    for block in blocks:
        if block["type"] == 0:  # text block
            for line in block["lines"]:
                for span in line["spans"]:
                    font_name = span["font"]
                    size = round(span["size"], 1)
                    text = span["text"].strip()
                    if text:
                        font_stats[font_name] += 1
                        font_sizes[f"{font_name}@{size}"] += 1
                        if len(sample_spans) < 30:
                            sample_spans.append({
                                "font": font_name,
                                "size": size,
                                "flags": span["flags"],
                                "text": text[:80],
                            })

print("Font usage (span count):")
for font, count in font_stats.most_common():
    print(f"  {font}: {count}")

print("\nFont+size combos:")
for combo, count in font_sizes.most_common(15):
    print(f"  {combo}: {count}")

print("\nSample spans (first 30):")
for s in sample_spans:
    bold = "BOLD" if s["flags"] & 16 else ""
    italic = "ITAL" if s["flags"] & 2 else ""
    flags = f" [{bold}{italic}]" if bold or italic else ""
    print(f"  {s['font']}@{s['size']}{flags}: {s['text']}")

# --- Step 3: Extract text for a few sections to assess quality ---
print("\n=== SECTION TEXT QUALITY (3 samples) ===")
samples = [
    ("REST API", 228, 232),
    ("Scripting", 1081, 1085),
    ("Container", None, None),  # find from TOC
]

# Find Container section
for e in toc_entries:
    if "Container" in e["title"] and e["depth"] <= 3:
        samples[2] = ("Container", e["page"], min(e["page"] + 3, e["page_end"]))
        break

for name, start, end in samples:
    if start is None:
        continue
    text = ""
    for pg in range(start - 1, end):  # 0-indexed
        text += doc[pg].get_text("text") + "\n"

    lines = text.strip().split("\n")
    words = text.split()
    code_lines = [l for l in lines if re.match(r'^\s*(\/\w|add |set |print |remove |#|:)', l)]

    print(f"\n--- {name} (pages {start}-{end}) ---")
    print(f"  Lines: {len(lines)}, Words: {len(words)}, Code-like lines: {len(code_lines)}")
    print(f"  First 5 lines:")
    for l in lines[:5]:
        print(f"    | {l}")
    if code_lines:
        print(f"  Sample code lines:")
        for l in code_lines[:5]:
            print(f"    | {l}")

# --- Step 4: Section size distribution ---
print("\n=== SECTION SIZE DISTRIBUTION ===")
sizes = [(e["section"], e["title"], e["page_count"]) for e in toc_entries]
sizes.sort(key=lambda x: -x[2])

print(f"Largest 10 sections:")
for sec, title, pcount in sizes[:10]:
    print(f"  {sec:12s} {pcount:4d} pages  {title}")

print(f"\nSmallest 10 sections:")
for sec, title, pcount in sizes[-10:]:
    print(f"  {sec:12s} {pcount:4d} pages  {title}")

one_pagers = sum(1 for s in sizes if s[2] <= 1)
small = sum(1 for s in sizes if s[2] <= 5)
medium = sum(1 for s in sizes if 5 < s[2] <= 20)
large = sum(1 for s in sizes if s[2] > 20)
print(f"\n1-page sections: {one_pagers}")
print(f"1-5 pages: {small}")
print(f"6-20 pages: {medium}")
print(f">20 pages: {large}")

# --- Step 5: Estimate total text volume ---
print("\n=== TEXT VOLUME ESTIMATE ===")
# Sample 20 evenly-spaced pages
sample_pages = [int(i * doc.page_count / 20) for i in range(20)]
total_chars = 0
for pg in sample_pages:
    total_chars += len(doc[pg].get_text("text"))
avg_chars = total_chars / len(sample_pages)
est_total = avg_chars * doc.page_count
print(f"Avg chars/page (20-page sample): {avg_chars:.0f}")
print(f"Estimated total text: {est_total/1e6:.1f} MB")
print(f"Estimated total text: {est_total/1e3:.0f} KB")

# --- Step 6: Dump TOC as JSON for later use ---
with open("/Users/amm0/Downloads/ros-toc.json", "w") as f:
    json.dump(toc_entries, f, indent=2)
print(f"\nTOC written to ros-toc.json ({len(toc_entries)} entries)")

doc.close()
