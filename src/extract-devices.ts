/**
 * extract-devices.ts — Load MikroTik product matrix CSV into the devices table.
 *
 * Idempotent: deletes all existing device rows, then inserts from CSV.
 * FTS5 index auto-populated via triggers defined in db.ts.
 *
 * Usage: bun run src/extract-devices.ts [path/to/matrix.csv]
 */

import { readFileSync } from "node:fs";
import { db, initDb } from "./db.ts";

/** Map of Unicode superscript/subscript digits → ASCII digits (e.g. ³→3, ²→2). */
const DIGIT_SUPER_SUB: Record<string, string> = {
  "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4",
  "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9",
  "₀": "0", "₁": "1", "₂": "2", "₃": "3", "₄": "4",
  "₅": "5", "₆": "6", "₇": "7", "₈": "8", "₉": "9",
};

/** Normalize Unicode superscript/subscript digits to ASCII in product names. */
function normalizeSuperscripts(s: string): string {
  return s.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉]/g, (c) => DIGIT_SUPER_SUB[c] ?? c);
}

const DEFAULT_CSV = "matrix/2026-03-25/matrix.csv";
const csvPath = process.argv[2] || DEFAULT_CSV;

/** Parse a CSV line respecting quoted fields. */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === '"') {
      // Quoted field — find closing quote (doubled quotes "" are escaped quotes)
      i++; // skip opening quote
      let value = "";
      while (i < line.length) {
        if (line[i] === '"') {
          if (i + 1 < line.length && line[i + 1] === '"') {
            value += '"';
            i += 2;
          } else {
            i++; // skip closing quote
            break;
          }
        } else {
          value += line[i];
          i++;
        }
      }
      fields.push(value);
      if (i < line.length && line[i] === ",") i++; // skip comma
    } else {
      // Unquoted field
      const nextComma = line.indexOf(",", i);
      if (nextComma === -1) {
        fields.push(line.slice(i));
        break;
      }
      fields.push(line.slice(i, nextComma));
      i = nextComma + 1;
    }
  }
  return fields;
}

/** Parse a size string like "512 MB" or "16 GB" into megabytes. */
function parseSizeMb(value: string): number | null {
  if (!value) return null;
  const match = value.match(/^([\d.]+)\s*(MB|GB)/i);
  if (!match) return null;
  const num = Number.parseFloat(match[1]);
  const unit = match[2].toUpperCase();
  return unit === "GB" ? Math.round(num * 1024) : Math.round(num);
}

/** Parse a power string like "8 W" or "800 W" to watts. */
function parseWatts(value: string): number | null {
  if (!value) return null;
  const match = value.match(/^([\d.]+)\s*W/i);
  return match ? Number.parseFloat(match[1]) : null;
}

/** Parse an integer, returning null for empty/non-numeric. */
function parseIntOrNull(value: string): number | null {
  if (!value) return null;
  const n = Number.parseInt(value, 10);
  return Number.isNaN(n) ? null : n;
}

/** Parse a float, returning null for empty/non-numeric. */
function parseFloatOrNull(value: string): number | null {
  if (!value) return null;
  const n = Number.parseFloat(value);
  return Number.isNaN(n) ? null : n;
}

/** Parse price like "2,795.00" or "89.00" to a float. */
function parsePrice(value: string): number | null {
  if (!value) return null;
  const cleaned = value.replace(/[,$]/g, "");
  return parseFloatOrNull(cleaned);
}

// ── Main ──

initDb();

const raw = readFileSync(csvPath, "utf-8");
// Strip UTF-8 BOM
const content = raw.replace(/^\ufeff/, "");
const lines = content.split(/\r?\n/).filter((l) => l.trim());

if (lines.length < 2) {
  console.error("CSV has no data rows");
  process.exit(1);
}

// Skip header row
const dataLines = lines.slice(1);

// Idempotent: clear existing data (FTS triggers handle cleanup)
db.run("DELETE FROM devices");

const insert = db.prepare(`INSERT INTO devices (
  product_name, product_code, architecture, cpu, cpu_cores, cpu_frequency,
  license_level, operating_system, ram, ram_mb, storage, storage_mb,
  dimensions, poe_in, poe_out, poe_out_ports, poe_in_voltage,
  dc_inputs, dc_jack_voltage, max_power_w,
  wireless_24_chains, antenna_24_dbi, wireless_5_chains, antenna_5_dbi,
  eth_fast, eth_gigabit, eth_2500, usb_ports, combo_ports,
  sfp_ports, sfp_plus_ports, eth_multigig, sim_slots,
  memory_cards, usb_type, msrp_usd
) VALUES (
  ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?,
  ?, ?, ?,
  ?, ?, ?, ?,
  ?, ?, ?, ?, ?,
  ?, ?, ?, ?,
  ?, ?, ?
)`);

let inserted = 0;
let skipped = 0;

const insertAll = db.transaction(() => {
  for (const line of dataLines) {
    const f = parseCsvLine(line);
    if (f.length < 34) {
      skipped++;
      continue;
    }

    const productName = normalizeSuperscripts(f[0].trim());
    if (!productName) {
      skipped++;
      continue;
    }

    insert.run(
      productName,
      f[1].trim() || null,    // product_code
      f[2].trim() || null,    // architecture
      f[3].trim() || null,    // cpu
      parseIntOrNull(f[4]),   // cpu_cores
      f[5].trim() || null,    // cpu_frequency
      parseIntOrNull(f[6]),   // license_level
      f[7].trim() || null,    // operating_system
      f[8].trim() || null,    // ram
      parseSizeMb(f[8]),      // ram_mb
      f[9].trim() || null,    // storage
      parseSizeMb(f[9]),      // storage_mb
      f[10].trim() || null,   // dimensions
      f[11].trim() || null,   // poe_in
      f[12].trim() || null,   // poe_out
      f[13].trim() || null,   // poe_out_ports
      f[14].trim() || null,   // poe_in_voltage
      parseIntOrNull(f[15]),  // dc_inputs
      f[16].trim() || null,   // dc_jack_voltage
      parseWatts(f[17]),      // max_power_w
      parseIntOrNull(f[18]),  // wireless_24_chains
      parseFloatOrNull(f[19]),// antenna_24_dbi
      parseIntOrNull(f[20]),  // wireless_5_chains
      parseFloatOrNull(f[21]),// antenna_5_dbi
      parseIntOrNull(f[22]),  // eth_fast
      parseIntOrNull(f[23]),  // eth_gigabit
      parseIntOrNull(f[24]),  // eth_2500
      parseIntOrNull(f[25]),  // usb_ports
      parseIntOrNull(f[26]),  // combo_ports
      parseIntOrNull(f[27]),  // sfp_ports
      parseIntOrNull(f[28]),  // sfp_plus_ports
      parseIntOrNull(f[29]),  // eth_multigig
      parseIntOrNull(f[30]),  // sim_slots
      f[31].trim() || null,   // memory_cards
      f[32].trim() || null,   // usb_type
      parsePrice(f[33]),      // msrp_usd
    );
    inserted++;
  }
});

insertAll();

console.log(`Devices: ${inserted} inserted, ${skipped} skipped from ${csvPath}`);
