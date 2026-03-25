#!/bin/sh
# Download MikroTik product matrix CSV.
#
# The old POST endpoint (curl -X POST -d "ax=matrix") died when MikroTik
# moved to Laravel Livewire / PowerGrid. The CSV is now obtained via the
# browser: visit https://mikrotik.com/products/matrix, click the export
# button (top-left area), choose "All", and save the .csv file.
#
# After downloading manually, copy the file here:
#   cp ~/Downloads/products-*.csv <ISODATE>/matrix.csv

ISODATE=$(gdate -u --rfc-3339=date 2>/dev/null || date -u +%Y-%m-%d)
mkdir -p "$ISODATE"

echo "Manual download required:"
echo "  1. Open https://mikrotik.com/products/matrix in a browser"
echo "  2. Click the export/download button"
echo "  3. Choose 'All' to export all products"
echo "  4. Copy the downloaded CSV here:"
echo "     cp ~/Downloads/products-*.csv $ISODATE/matrix.csv"
