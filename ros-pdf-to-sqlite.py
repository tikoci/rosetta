#!/usr/bin/env python3
"""
Extract RouterOS PDF help into SQLite with FTS5.

Reads the MikroTik help.mikrotik.com PDF export, splits by TOC sections,
and loads into SQLite with full-text search.
"""

import fitz
import sqlite3
import json
import re
import sys

PDF = "/Users/amm0/Downloads/ROS-260625-1140-2328.pdf"
DB = "/Users/amm0/Downloads/ros-help.db"

doc = fitz.open(PDF)
print(f"Opened: {doc.page_count} pages")

# --- Get TOC from PDF bookmarks ---
raw_toc = doc.get_toc(simple=False)
# Skip "Table of contents" entry (depth=1, page=1)
toc = []
for entry in raw_toc:
    depth, title, page = entry[0], entry[1], entry[2]
    if title == "Table of contents":
        continue
    toc.append({"depth": depth, "title": title, "page": page})

print(f"TOC entries: {len(toc)}")

# Compute page ranges
for i, entry in enumerate(toc):
    if i + 1 < len(toc):
        entry["page_end"] = toc[i + 1]["page"] - 1
    else:
        entry["page_end"] = doc.page_count
    entry["page_count"] = entry["page_end"] - entry["page"] + 1

# Find parent chain for each entry (for chapter/path context)
def build_path(toc, index):
    """Build breadcrumb path like 'RouterOS > Firewall > Filter'."""
    target_depth = toc[index]["depth"]
    parts = [toc[index]["title"]]
    for j in range(index - 1, -1, -1):
        if toc[j]["depth"] < target_depth:
            parts.insert(0, toc[j]["title"])
            target_depth = toc[j]["depth"]
            if target_depth <= 1:
                break
    return " > ".join(parts)

# --- Extract text per section ---
print("Extracting text per section...")

sections = []
for i, entry in enumerate(toc):
    start_pg = entry["page"] - 1  # 0-indexed
    end_pg = entry["page_end"]    # exclusive for range

    text_parts = []
    code_parts = []

    for pg_idx in range(start_pg, min(end_pg, doc.page_count)):
        page = doc[pg_idx]

        # Get structured text with font info
        blocks = page.get_text("dict", sort=True)["blocks"]
        for block in blocks:
            if block["type"] != 0:  # skip images
                continue
            for line in block["lines"]:
                line_text = ""
                is_code = False
                for span in line["spans"]:
                    line_text += span["text"]
                    if "Courier" in span["font"]:
                        is_code = True
                line_text = line_text.strip()
                if line_text:
                    text_parts.append(line_text)
                    if is_code:
                        code_parts.append(line_text)

    full_text = "\n".join(text_parts)
    code_text = "\n".join(code_parts)
    path = build_path(toc, i)

    sections.append({
        "title": entry["title"],
        "path": path,
        "depth": entry["depth"],
        "page_start": entry["page"],
        "page_end": entry["page_end"],
        "page_count": entry["page_count"],
        "text": full_text,
        "code": code_text,
        "word_count": len(full_text.split()),
        "code_line_count": len(code_parts),
    })

    if (i + 1) % 50 == 0:
        print(f"  {i + 1}/{len(toc)} sections extracted...")

doc.close()
print(f"Extracted {len(sections)} sections")

# --- Stats ---
total_words = sum(s["word_count"] for s in sections)
total_code_lines = sum(s["code_line_count"] for s in sections)
total_chars = sum(len(s["text"]) for s in sections)
print(f"Total: {total_chars:,} chars, {total_words:,} words, {total_code_lines:,} code lines")

# --- Load into SQLite ---
print(f"\nCreating {DB}...")
db = sqlite3.connect(DB)
db.execute("PRAGMA journal_mode=DELETE")

db.executescript("""
    DROP TABLE IF EXISTS sections;
    DROP TABLE IF EXISTS sections_fts;

    CREATE TABLE sections (
        id         INTEGER PRIMARY KEY,
        title      TEXT NOT NULL,
        path       TEXT NOT NULL,    -- breadcrumb: 'RouterOS > Firewall > Filter'
        depth      INTEGER NOT NULL, -- TOC depth (1=root, 2=chapter, 3=section, etc)
        page_start INTEGER NOT NULL,
        page_end   INTEGER NOT NULL,
        page_count INTEGER NOT NULL,
        text       TEXT NOT NULL,    -- full extracted text
        code       TEXT NOT NULL,    -- just the Courier/code spans
        word_count INTEGER NOT NULL,
        code_lines INTEGER NOT NULL
    );

    -- FTS5 index on title, path, and text
    CREATE VIRTUAL TABLE sections_fts USING fts5(
        title,
        path,
        text,
        code,
        content=sections,
        content_rowid=id,
        tokenize='porter unicode61'
    );
""")

for i, s in enumerate(sections):
    db.execute(
        "INSERT INTO sections VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        (i + 1, s["title"], s["path"], s["depth"],
         s["page_start"], s["page_end"], s["page_count"],
         s["text"], s["code"], s["word_count"], s["code_line_count"])
    )

# Populate FTS index
db.execute("""
    INSERT INTO sections_fts(rowid, title, path, text, code)
    SELECT id, title, path, text, code FROM sections
""")

db.commit()

# --- Verify ---
row = db.execute("SELECT count(*), sum(word_count), sum(code_lines) FROM sections").fetchone()
print(f"DB: {row[0]} sections, {row[1]:,} words, {row[2]:,} code lines")

# Test FTS search
print("\n=== Sample FTS queries ===")
queries = ["firewall filter", "REST API", "OSPF neighbor", "container", "scripting array", "DHCP lease"]
for q in queries:
    results = db.execute("""
        SELECT s.title, s.path, s.word_count, s.depth
        FROM sections_fts fts
        JOIN sections s ON s.id = fts.rowid
        WHERE sections_fts MATCH ?
        ORDER BY rank
        LIMIT 3
    """, (q,)).fetchall()
    print(f'\n  "{q}":')
    for title, path, wc, depth in results:
        print(f"    [{depth}] {path} ({wc} words)")

db_size = db.execute("SELECT page_count * page_size FROM pragma_page_count, pragma_page_size").fetchone()[0]
print(f"\nDB file size: {db_size / 1e6:.1f} MB")

db.close()
print("Done.")
