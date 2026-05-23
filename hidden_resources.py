#!/usr/bin/env python3
"""
hidden_resources.py — Updates descr_regions.txt with hidden resources from the spreadsheet CSV.

Reads the CSV export of the 'alt map - big map compare' tab and inserts the correct
hidden resources (Farm level, landscape, climate, port, irrigation) into each region's
resource line in descr_regions.txt. Also updates the fertility number to match.

Matching: CSV column E (Region Code Main) → region name in descr_regions.txt
Fallback: CSV column A (Settlement Main) → settlement name in descr_regions.txt

Output:
  descr_regions.txt              <- updated file
  changelog.txt                  <- only changed regions
  decisions.txt                  <- per-region decision log
  debug_log.txt                  <- parsing details and warnings
  unmatched.txt                  <- regions with no CSV match
"""

import sys
sys.dont_write_bytecode = True

import csv
import re
from pathlib import Path
from datetime import datetime

# --- CONFIG ---
BASE_DIR = Path(__file__).parent
CONFIG_DIR = BASE_DIR / "config"
OUTPUT_DIR = BASE_DIR / "processed_output"

REGIONS_FILE = CONFIG_DIR / "descr_regions.txt"
CSV_FILE = CONFIG_DIR / "hidden_resources.csv"

# All hidden resource tags that should be stripped from existing resource lines
HIDDEN_RESOURCE_TAGS = {
    # Landscape
    'hills', 'mountain_valley', 'grassland', 'river_valley', 'mountains',
    'desert', 'plateau', 'forest', 'floodplains_delta',
    'small_islands_and_rocky_coast', 'wetlands', 'steppe', 'karst_terrain',
    # Climate
    'mediterranean', 'continental', 'oceanic', 'arid', 'cold_semi_arid',
    'hot_semi_arid', 'dry_sub_tropical', 'humid_sub_tropical', 'temperate',
    'monsoon', 'alpine', 'sub_artic', 'tropical',
    # Port
    'base_port_level_0', 'base_port_level_1', 'base_port_level_2',
    'base_port_level_3',
    # Irrigation / river
    'rivertrade', 'irrigation_river', 'irrigation_springs',
    'irrigation_lake', 'irrigation_aquifer', 'irrigation_oasis',
    # Other
    'earthquakes',
}

FARM_RE = re.compile(r'^Farm\d+$', re.IGNORECASE)


class HiddenResourceProcessor:
    def __init__(self):
        self.region_lookup = {}      # region code -> hidden resources string
        self.settlement_lookup = {}  # settlement name -> hidden resources string
        self.changelog = []
        self.decisions = []
        self.debug_logs = []
        self.unmatched = []

    def is_hidden_resource(self, tag):
        tag = tag.strip()
        if tag in HIDDEN_RESOURCE_TAGS:
            return True
        if FARM_RE.match(tag):
            return True
        return False

    def parse_csv(self, csv_path):
        """Parse CSV and build lookup dicts.
        Columns: A=Settlement Main, B=Settlement Alt, E=Region Code Main, F=Region Code Alt, T=Hidden resources
        """
        with open(csv_path, 'r', encoding='utf-8-sig') as f:
            reader = csv.reader(f)
            header = next(reader)

            row_count = 0
            skip_count = 0
            for row in reader:
                if len(row) <= 19:
                    continue

                settlement = row[0].strip()       # A: Settlement Main
                settlement_alt = row[1].strip()    # B: Settlement Alt
                region_code = row[4].strip()       # E: Region Code Main
                region_alt = row[5].strip()        # F: Region Code Alt
                hidden_res = row[19].strip()       # T: Hidden resources

                if not hidden_res or hidden_res == '#N/A':
                    skip_count += 1
                    continue

                if hidden_res.startswith('"') and hidden_res.endswith('"'):
                    hidden_res = hidden_res[1:-1]

                row_count += 1
                if region_code:
                    self.region_lookup[region_code] = hidden_res
                if region_alt and region_alt not in self.region_lookup:
                    self.region_lookup[region_alt] = hidden_res
                if settlement:
                    self.settlement_lookup[settlement] = hidden_res
                if settlement_alt and settlement_alt not in self.settlement_lookup:
                    self.settlement_lookup[settlement_alt] = hidden_res

        self.debug_logs.append(f"CSV loaded: {csv_path.name}")
        self.debug_logs.append(f"  {row_count} valid rows, {skip_count} skipped (empty/N/A)")
        self.debug_logs.append(f"  {len(self.region_lookup)} region codes, {len(self.settlement_lookup)} settlement names")
        self.debug_logs.append("")

    def extract_farm_number(self, hidden_res):
        m = re.search(r'Farm(\d+)', hidden_res, re.IGNORECASE)
        return int(m.group(1)) if m else None

    def update_resources_line(self, existing_line, new_hidden):
        """Strip old hidden resource tags, append new ones from CSV."""
        existing_tags = [t.strip() for t in existing_line.split(',')]
        cultural_tags = [t for t in existing_tags if t and not self.is_hidden_resource(t)]
        new_tags = [t.strip() for t in new_hidden.split(',')]
        return ', '.join(cultural_tags + new_tags)

    def process(self, regions_path, out_dir):
        """Parse descr_regions.txt, match with CSV, write updated file."""
        with open(regions_path, 'r', encoding='utf-8') as f:
            lines = f.readlines()

        matched = 0
        unchanged = 0
        total_regions = 0

        i = 0
        while i < len(lines):
            stripped = lines[i].rstrip('\n\r')

            # Region block start: non-empty, no leading whitespace, not a comment
            if (stripped and
                not stripped.startswith('\t') and
                not stripped.startswith(';') and
                not stripped.startswith(' ')):

                region_name = stripped.strip()

                # Verify block structure: next lines should be tab-indented
                if i + 7 < len(lines) and lines[i + 1].startswith('\t') and lines[i + 5].startswith('\t'):
                    total_regions += 1
                    settlement_name = lines[i + 1].strip()
                    old_resources = lines[i + 5].lstrip('\t').rstrip('\n\r')
                    old_fertility = lines[i + 7].strip()

                    # Match against CSV
                    new_hidden = None
                    match_source = None

                    if region_name in self.region_lookup:
                        new_hidden = self.region_lookup[region_name]
                        match_source = f"region code '{region_name}'"
                    elif settlement_name in self.settlement_lookup:
                        new_hidden = self.settlement_lookup[settlement_name]
                        match_source = f"settlement name '{settlement_name}'"

                    if new_hidden:
                        new_resources = self.update_resources_line(old_resources, new_hidden)
                        new_farm = self.extract_farm_number(new_hidden)

                        # Check if anything actually changed
                        resources_changed = (new_resources != old_resources)
                        fertility_changed = (new_farm is not None and str(new_farm) != old_fertility)

                        if resources_changed or fertility_changed:
                            # Apply changes
                            lines[i + 5] = '\t' + new_resources + '\n'
                            if new_farm is not None:
                                lines[i + 7] = '\t' + str(new_farm) + '\n'

                            matched += 1

                            # Build detailed changelog: show what hidden resources changed
                            old_hidden = set(t.strip() for t in old_resources.split(',') if self.is_hidden_resource(t.strip()))
                            new_hidden_set = set(t.strip() for t in new_hidden.split(','))
                            added = new_hidden_set - old_hidden
                            removed = old_hidden - new_hidden_set

                            parts = []
                            if fertility_changed:
                                parts.append(f"fertility {old_fertility} → {new_farm}")
                            if added:
                                parts.append(f"added {', '.join(sorted(added))}")
                            if removed:
                                parts.append(f"removed {', '.join(sorted(removed))}")
                            if not parts:
                                parts.append("resources reordered")

                            self.changelog.append(
                                f"{settlement_name} ({region_name}): {'; '.join(parts)}"
                            )

                            # Decision log
                            self.decisions.append(f"--- Settlement: {settlement_name} ({region_name}) ---")
                            self.decisions.append(f"Matched via: {match_source}")
                            self.decisions.append(f"Old resources: {old_resources}")
                            self.decisions.append(f"New resources: {new_resources}")
                            if fertility_changed:
                                self.decisions.append(f"Fertility: {old_fertility} -> {new_farm}")
                            self.decisions.append("")
                        else:
                            unchanged += 1
                            self.debug_logs.append(f"{settlement_name} ({region_name}): No change needed (already correct)")
                    else:
                        self.unmatched.append(f"{region_name} / {settlement_name}")
                        self.changelog.append(f"{settlement_name} ({region_name}): unmatched — no CSV entry found")
                        self.debug_logs.append(f"WARNING: No CSV match for {region_name} / {settlement_name}")

            i += 1

        # Write outputs
        out_dir.mkdir(parents=True, exist_ok=True)

        (out_dir / "descr_regions.txt").write_text("".join(lines), encoding='utf-8')

        if self.changelog:
            (out_dir / "changelog.txt").write_text("\n".join(sorted(self.changelog)), encoding='utf-8')
        else:
            (out_dir / "changelog.txt").write_text("No changes were made.\n", encoding='utf-8')

        (out_dir / "decisions.txt").write_text("\n".join(self.decisions), encoding='utf-8')

        summary = [
            f"Total regions: {total_regions}",
            f"Updated: {matched}",
            f"Unchanged: {unchanged}",
            f"Unmatched: {len(self.unmatched)}",
        ]
        self.debug_logs = summary + [""] + self.debug_logs

        (out_dir / "debug_log.txt").write_text("\n".join(self.debug_logs), encoding='utf-8')

        if self.unmatched:
            (out_dir / "unmatched.txt").write_text("\n".join(sorted(self.unmatched)), encoding='utf-8')

        return matched, unchanged, len(self.unmatched), total_regions

    def run(self, run_regions=None, run_csv=None, run_out=None):
        _regions = Path(run_regions) if run_regions else REGIONS_FILE
        _csv = Path(run_csv) if run_csv else CSV_FILE
        _out = Path(run_out) if run_out else OUTPUT_DIR

        if not _regions.exists():
            print(f"Error: {_regions} not found")
            return
        if not _csv.exists():
            print(f"Error: {_csv} not found")
            print(f"  Place your CSV export in: {CSV_FILE}")
            return

        self.parse_csv(_csv)
        matched, unchanged, unmatched, total = self.process(_regions, _out)

        print(f"Hidden Resources: {total} regions processed")
        print(f"  Updated:   {matched}")
        print(f"  Unchanged: {unchanged}")
        print(f"  Unmatched: {unmatched}")
        if self.unmatched:
            for u in sorted(self.unmatched):
                print(f"    - {u}")
        print(f"  Output:    {_out}")


if __name__ == "__main__":
    HiddenResourceProcessor().run()
