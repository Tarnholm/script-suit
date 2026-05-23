#!/usr/bin/env python3
"""
Port descr_mercenaries.txt from one campaign map to another.

Reads the source mercenary pools and compares region names against a target
descr_regions.txt. Pools with all regions present port cleanly; pools with
missing regions are flagged for manual work.

Inputs (in config/):
  descr_mercenaries.txt       — source mercenary pools to port
  descr_regions.txt           — source map region names (from imported campaign)
  descr_regions_target.txt    — target map region names (from world/maps/base)

Outputs (in processed_output/):
  descr_mercenaries.txt       — ported file (clean + partial pools)
  port_mercenaries/changelog.txt — full breakdown for the Changelog tab
"""

import re
import sys
from pathlib import Path
from datetime import datetime

# --- CONFIG ---
BASE_DIR = Path(__file__).parent
CONFIG_DIR = BASE_DIR / "config"
OUTPUT_DIR = BASE_DIR / "processed_output"

MERCS_FILE = CONFIG_DIR / "descr_mercenaries.txt"
SOURCE_REGIONS_FILE = CONFIG_DIR / "descr_regions_source.txt"
TARGET_REGIONS_FILE = CONFIG_DIR / "descr_regions_target.txt"


def parse_region_names(path: Path) -> set[str]:
    regions = set()
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if not line or line[0].isspace() or line.startswith(";"):
            continue
        name = line.strip()
        if name:
            regions.add(name)
    return regions


def parse_merc_pools(path: Path) -> list[dict]:
    text = path.read_text(encoding="utf-8", errors="replace")
    lines = text.splitlines()
    pools = []
    i = 0
    n = len(lines)

    while i < n:
        line = lines[i]
        stripped = line.strip()

        m = re.match(r"^pool\s+(\S+)", stripped)
        if not m:
            i += 1
            continue

        pool_name = m.group(1)
        pool_lines = [line]
        i += 1

        region_names = []
        unit_lines = []

        while i < n:
            cur = lines[i]
            cur_s = cur.strip()

            if re.match(r"^pool\s+", cur_s):
                break

            pool_lines.append(cur)

            if cur_s.startswith("regions "):
                region_names = cur_s[len("regions "):].split()
            elif cur_s.startswith("unit "):
                unit_lines.append(cur)

            i += 1

        pools.append({
            "name": pool_name,
            "regions": region_names,
            "unit_lines": unit_lines,
            "raw_lines": pool_lines,
        })

    return pools


def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    changelog_dir = OUTPUT_DIR / "port_mercenaries"
    changelog_dir.mkdir(parents=True, exist_ok=True)

    # Validate inputs
    for p in (MERCS_FILE, SOURCE_REGIONS_FILE, TARGET_REGIONS_FILE):
        if not p.exists():
            print(f"ERROR: Missing file: {p}", file=sys.stderr)
            if p == TARGET_REGIONS_FILE:
                print("  The target map's descr_regions.txt was not found during import.", file=sys.stderr)
                print("  Make sure the mod has a world/maps/base/descr_regions.txt", file=sys.stderr)
            sys.exit(1)

    source_regions = parse_region_names(SOURCE_REGIONS_FILE)
    target_regions = parse_region_names(TARGET_REGIONS_FILE)
    pools = parse_merc_pools(MERCS_FILE)

    # Warn if source and target look identical
    if source_regions == target_regions:
        print("WARNING: Source and target region lists are identical!", file=sys.stderr)
        print("  Make sure you imported from the SOURCE campaign (e.g. alternate_campaign),", file=sys.stderr)
        print("  not the target campaign. The target regions come from world/maps/base/.", file=sys.stderr)

    # Classify
    full_port = []
    partial_port = []
    no_port = []

    for pool in pools:
        present = [r for r in pool["regions"] if r in target_regions]
        missing = [r for r in pool["regions"] if r not in target_regions]
        pool["present"] = present
        pool["missing"] = missing

        if not missing:
            full_port.append(pool)
        elif present:
            partial_port.append(pool)
        else:
            no_port.append(pool)

    # --- Write ported file ---
    out_lines = []
    out_lines.append(";-------------------------------------------------------------")
    out_lines.append("; Ported descr_mercenaries.txt")
    out_lines.append("; Pools marked PARTIAL had missing regions stripped — see changelog")
    out_lines.append(";-------------------------------------------------------------")
    out_lines.append("")

    for pool in full_port:
        for line in pool["raw_lines"]:
            out_lines.append(line)
        out_lines.append("")

    for pool in partial_port:
        out_lines.append(f";--- PARTIAL PORT: {pool['name']} (missing {len(pool['missing'])} regions) ---")
        out_lines.append(f"pool {pool['name']}")
        out_lines.append(f"regions {' '.join(pool['present'])}")
        for line in pool["unit_lines"]:
            out_lines.append(line)
        out_lines.append("")

    ported_path = OUTPUT_DIR / "descr_mercenaries.txt"
    ported_path.write_text("\n".join(out_lines) + "\n", encoding="utf-8")

    # --- Write changelogs ---
    # One file per category so the Changelog tab shows them as distinct groups.
    # Format: "Name: Action details" so the parser picks them up.
    all_missing = set()
    for pool in partial_port + no_port:
        all_missing.update(pool["missing"])

    # 1) Direct ports changelog
    cl_direct = []
    for pool in full_port:
        unit_names = []
        for u in pool["unit_lines"]:
            m = re.match(r"unit\s+merc\s+(.+?),", u.strip())
            if m:
                unit_names.append(m.group(1))
        units_str = ", ".join(unit_names) if unit_names else f"{len(pool['unit_lines'])} units"
        regions_str = ", ".join(pool["regions"])
        cl_direct.append(f"{pool['name']}: Added {len(pool['unit_lines'])} units across {len(pool['regions'])} regions ({regions_str})")
    (changelog_dir / "changelog_1_direct.txt").write_text(
        f"=== DIRECT PORTS ({len(full_port)} pools — all regions matched) ===\n" +
        "\n".join(cl_direct) + "\n", encoding="utf-8")

    # 2) Partial ports changelog
    cl_partial = []
    for pool in partial_port:
        missing_str = ", ".join(pool["missing"])
        kept_str = ", ".join(pool["present"])
        cl_partial.append(f"{pool['name']}: Changed from {len(pool['regions'])} to {len(pool['present'])} regions; Removed {len(pool['missing'])} missing: {missing_str}")
        # Also list each missing region individually under this pool
        for r in pool["missing"]:
            cl_partial.append(f"{pool['name']}: Removed region {r}")
    (changelog_dir / "changelog_2_partial.txt").write_text(
        f"=== PARTIAL PORTS ({len(partial_port)} pools — some regions missing) ===\n" +
        "\n".join(cl_partial) + "\n", encoding="utf-8")

    # 3) Failed ports changelog
    cl_failed = []
    for pool in no_port:
        regions_str = ", ".join(pool["regions"])
        cl_failed.append(f"{pool['name']}: Removed entirely — all {len(pool['regions'])} regions missing: {regions_str}")
        for u in pool["unit_lines"]:
            m = re.match(r"unit\s+merc\s+(.+?),", u.strip())
            unit_name = m.group(1) if m else u.strip()
            cl_failed.append(f"{pool['name']}: Removed unit {unit_name}")
    (changelog_dir / "changelog_3_failed.txt").write_text(
        f"=== FAILED PORTS ({len(no_port)} pools — all regions missing, NOT in output) ===\n" +
        "\n".join(cl_failed) + "\n", encoding="utf-8")

    # 4) Missing regions changelog
    cl_regions = []
    for r in sorted(all_missing):
        # List which pools this region belonged to
        pools_using = [p["name"] for p in partial_port + no_port if r in p["missing"]]
        cl_regions.append(f"{r}: Removed from {len(pools_using)} pools ({', '.join(pools_using)})")
    (changelog_dir / "changelog_4_missing_regions.txt").write_text(
        f"=== MISSING REGIONS ({len(all_missing)} provinces not in target map) ===\n" +
        "\n".join(cl_regions) + "\n", encoding="utf-8")

    # --- Console summary ---
    print(f"Source regions:   {len(source_regions)}")
    print(f"Target regions:   {len(target_regions)}")
    print(f"Pools parsed:     {len(pools)}")
    print()
    print(f"Direct port:      {len(full_port)} pools")
    print(f"Partial port:     {len(partial_port)} pools")
    print(f"Cannot port:      {len(no_port)} pools")
    print(f"Missing regions:  {len(all_missing)} unique")
    print()
    print(f"Output:    {ported_path}")
    print(f"Changelog: {changelog_dir}")


if __name__ == "__main__":
    main()
