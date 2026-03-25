# MikroTik Product Matrix

Per-device hardware specs from mikrotik.com/products/matrix. Date-stamped snapshots.

## Source

The product matrix at `https://mikrotik.com/products/matrix` is a Laravel Livewire (PowerGrid) table.
The old `curl -X POST -d "ax=matrix"` endpoint is dead (returns HTML error page since late 2025).

**Current download method:** Manual browser export via the PowerGrid export button:
1. Open https://mikrotik.com/products/matrix
2. Click the export/download icon (top-left of table)
3. Choose "All" to export all products
4. Save CSV to `matrix/<ISODATE>/matrix.csv`

## CSV Schema (34 columns, 144 products as of March 2026)

| # | Column | Example |
|---|--------|---------|
| 1 | Product name | hAP ax³ |
| 2 | Product code | C53UiG+5HPaxD2HPaxD |
| 3 | Architecture | ARM 64bit, MIPSBE, MMIPS, SMIPS, ARM 32bit |
| 4 | CPU | IPQ-6010, QCA9531, MT7621A, 88F3720 |
| 5 | CPU core count | 1, 2, 4, 16 |
| 6 | CPU nominal frequency | 864 MHz, auto (864 - 1800) MHz |
| 7 | License level | 3, 4, 5, 6 |
| 8 | Operating system | RouterOS, RouterOS v7, RouterOS / SwitchOS |
| 9 | Size of RAM | 64 MB … 32 GB |
| 10 | Storage size | 16 MB … 1 GB |
| 11 | Dimensions | 443 x 224 x 44 mm (empty for some) |
| 12 | PoE in | 802.3af/at, Passive PoE, 802.3 bt |
| 13 | PoE out | 802.3af/at, Passive PoE |
| 14 | PoE out ports | Ether2-Ether5, etc. |
| 15 | PoE in input Voltage | 12-56 V, 18-57 V |
| 16 | Number of DC inputs | 1, 2, 3 |
| 17 | DC jack input Voltage | 12-28 V, 12-57 V |
| 18 | Max power consumption | 3.5 W … 800 W |
| 19 | Wireless 2.4 GHz number of chains | 1, 2, 3, 4 |
| 20 | Antenna gain dBi for 2.4 GHz | 1.2 … 24.5 |
| 21 | Wireless 5 GHz number of chains | 1, 2, 3, 4 |
| 22 | Antenna gain dBi for 5 GHz | 2 … 27 |
| 23 | 10/100 Ethernet ports | 1 … 5 |
| 24 | 10/100/1000 Ethernet ports | 1 … 48 |
| 25 | Number of 2.5G Ethernet ports | 1 … 8 |
| 26 | Number of USB ports | 1, 2, 3 |
| 27 | Ethernet Combo ports | 1, 4, 20 |
| 28 | SFP ports | 1 … 24 |
| 29 | SFP+ ports | 1 … 16 |
| 30 | Number of 1G/2.5G/5G/10G Ethernet ports | 2, 4, 8 |
| 31 | Number of SIM slots | 1, 2 |
| 32 | Memory cards | (empty for all current products) |
| 33 | USB slot type | USB type A, USB 3.0 type A, microUSB type AB |
| 34 | MSRP (USD) | 24.95 … 2795.00 |

**Note:** CSV has a UTF-8 BOM (`\ufeff`) on the first column name. Strip with `col.replace(/^\ufeff/, '')`.

## Architectures Found

- ARM 64bit (modern CCR, CRS500+, hAP ax², Chateau, RB5009, etc.)
- ARM 32bit (IPQ-4018/4019, IPQ-5010/5018, AL21400, 98DX series switches)
- MIPSBE (QCA9531/9533/9556/9557, AR9342/9344 — legacy boards)
- MMIPS (MT7621A — hEX, hEX S, RBM33G)
- SMIPS (QCA9533 — hAP lite, lowest-end)

## Relationship to inspect.json

The `Architecture` and `Operating system` columns help map devices to RouterOS capabilities:
- "RouterOS v7" devices only have v7 inspect data (covered by our 7.9–7.23beta2 range)
- "RouterOS" (without v7) devices may also run v6 (not covered)
- "RouterOS / SwitchOS" devices have dual-OS capability (SwOS commands not in inspect.json)