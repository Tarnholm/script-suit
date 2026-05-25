"""
run_all.py — Runs all settlement processors in sequence.

Each script reads the descr_strat.txt output from the previous step,
so changes chain through the full pipeline.

Step 00 (hidden_resources) runs first and updates config/descr_regions.txt
so that all subsequent steps see the correct hidden resources.

Output structure:
  processed_output/full_run_<timestamp>/
    descr_strat.txt          <- final output to copy into your mod
    descr_regions.txt        <- updated regions file
    00_hidden_resources/
    01_farms/
    02_heavy_industry/
    03_sanitation_healers/
    04_mics/
    05_homelands/
    06_rural_exploits/
    07_urban_exploits/
    08_port_authority/
    09_settlement_processor/
    10_temples/
    11_slave_placer/
    12_civic/
    13_grain_exports/
    14_starting_treasury/
"""

import sys
sys.dont_write_bytecode = True
import shutil
from pathlib import Path
from datetime import datetime

BASE_DIR = Path(__file__).parent
CONFIG_DIR = BASE_DIR / "config"
OUTPUT_DIR = BASE_DIR / "processed_output"

# --- Import all scripts ---
import hidden_resources
import farms
import heavy_industry
import sanitation_healers
import mics
import homelands
import rural_exploits
import urban_exploits
import port_authority
import settlement_processor
import temples
import slave_placer
import civic
import grain_exports
import starting_treasury


def write_unified_changelog(run_dir):
    sections = []

    # Simple changelog files — just read all lines
    simple = [
        ("00_hidden_resources",   "changelog.txt",               "Hidden Resources"),
        ("01_farms",              "changelog.txt",               "Farms"),
        ("02_heavy_industry",     "heavy_industry_changelog.txt","Heavy Industry"),
        ("03_sanitation_healers", "changelog.txt",               "Sanitation & Healers"),
        ("06_rural_exploits",     "rural_exploits_changelog.txt","Rural Exploits"),
        ("07_urban_exploits",     "urban_exploit_changelog.txt", "Urban Exploits"),
        ("09_settlement_processor","settlement_changelog.txt",   "Settlement Processor"),
        ("10_temples",            "changelog.txt",              "Temples"),
        ("11_slave_placer",       "changelog.txt",              "Slave Placer"),
        ("12_civic",              "changelog.txt",              "Civic Buildings"),
        ("13_grain_exports",      "changelog.txt",              "Grain Exports"),
        ("14_starting_treasury",  "changelog.txt",              "Starting Treasury"),
    ]
    for folder, fname, label in simple:
        f = run_dir / folder / fname
        if f.exists():
            lines = [l for l in f.read_text(encoding="utf-8").splitlines() if l.strip()]
            if lines:
                sections.append((label, lines))

    # Port authority — skip "Unchanged" lines
    port_f = run_dir / "08_port_authority" / "changelog.txt"
    if port_f.exists():
        lines = [l for l in port_f.read_text(encoding="utf-8").splitlines()
                 if l.strip() and "Unchanged" not in l]
        if lines:
            sections.append(("Port Authority", lines))

    # MICS — extract the CHANGES MADE block from the summary
    mics_f = run_dir / "04_mics" / "military_buildings_summary.txt"
    if mics_f.exists():
        content = mics_f.read_text(encoding="utf-8")
        in_changes = False
        lines = []
        for line in content.splitlines():
            if "CHANGES MADE" in line:
                in_changes = True
                continue
            if in_changes and line.startswith("="):
                break
            if in_changes and line.strip() and "marked with [CHANGED]" not in line:
                lines.append(line.strip())
        if lines and lines != ["No changes were made."]:
            sections.append(("Military (MICS)", lines))

    # Homelands — extract added/removed from report
    home_f = run_dir / "05_homelands" / "report.txt"
    if home_f.exists():
        lines = []
        for line in home_f.read_text(encoding="utf-8").splitlines():
            s = line.strip()
            if not s or s.startswith("=") or s.startswith("-") or s == "None":
                continue
            if "UNCHANGED" in s.upper():
                continue
            if s.startswith("HOMELAND") or s.startswith("REMOVED forbidden") or \
               s.startswith("DOWNGRADED") or s.startswith("REMOVED colonies"):
                continue
            lines.append(s)
        if lines:
            sections.append(("Homelands", lines))

    # Build output
    out = []
    total = 0
    for label, lines in sections:
        out.append(f"{'='*60}")
        out.append(f"  {label}  ({len(lines)} changes)")
        out.append(f"{'='*60}")
        out.extend(lines)
        out.append("")
        total += len(lines)

    header = [
        f"UNIFIED CHANGELOG",
        f"Run: {run_dir.name}",
        f"Total changes: {total}",
        "",
    ]

    (run_dir / "changelog.txt").write_text("\n".join(header + out), encoding="utf-8")


def run_all():
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    run_dir = OUTPUT_DIR / f"full_run_{ts}"
    run_dir.mkdir(parents=True, exist_ok=True)

    regions_file = CONFIG_DIR / "descr_regions.txt"
    regions_csv = CONFIG_DIR / "hidden_resources.csv"
    regions_backup = None

    print(f"========================================")
    print(f"Full run output: {run_dir}")
    print(f"========================================\n")

    # --- Step 00: Hidden Resources (updates descr_regions.txt before the strat pipeline) ---
    hr_dir = run_dir / "00_hidden_resources"
    hr_dir.mkdir(parents=True, exist_ok=True)

    if regions_csv.exists() and regions_file.exists():
        print(f"\n[00_hidden_resources] Running...")
        try:
            # Back up original descr_regions.txt
            regions_backup = regions_file.read_bytes()

            # Run processor — output to step dir
            hidden_resources.HiddenResourceProcessor().run(
                run_regions=regions_file, run_csv=regions_csv, run_out=hr_dir
            )

            # Copy updated descr_regions.txt into config so all subsequent steps see it
            updated_regions = hr_dir / "descr_regions.txt"
            if updated_regions.exists():
                shutil.copy2(updated_regions, regions_file)

            print(f"[00_hidden_resources] Done. Config descr_regions.txt updated.")
        except Exception as e:
            print(f"ERROR in 00_hidden_resources: {e}")
            import traceback
            traceback.print_exc()
            # Restore backup on failure
            if regions_backup is not None:
                regions_file.write_bytes(regions_backup)
            sys.exit(1)
    else:
        print(f"\n[00_hidden_resources] Skipped — CSV not found: {regions_csv}")
        (hr_dir / "changelog.txt").write_text("Skipped — no hidden_resources.csv in config/\n", encoding="utf-8")

    # --- Steps 01–10: descr_strat.txt pipeline ---
    steps = [
        ("01_farms",              lambda strat, out: farms.FarmExploitProcessor().run(run_strat=strat, run_out=out)),
        ("02_heavy_industry",     lambda strat, out: heavy_industry.HeavyIndustryProcessor().run(run_strat=strat, run_out=out)),
        ("03_sanitation_healers", lambda strat, out: sanitation_healers.PrioritySanitationProcessorV90().run(run_strat=strat, run_out=out)),
        ("04_mics",               lambda strat, out: mics.MilitaryBuildingProcessor().run(run_strat=strat, run_out=out)),
        ("05_homelands",          lambda strat, out: homelands.main(run_strat=strat, run_out=out)),
        ("06_rural_exploits",     lambda strat, out: rural_exploits.main(run_strat=strat, run_out=out)),
        ("07_urban_exploits",     lambda strat, out: urban_exploits.main(run_strat=strat, run_out=out)),
        ("08_port_authority",     lambda strat, out: port_authority.main(run_strat=strat, run_out=out)),
        ("09_settlement_processor", lambda strat, out: settlement_processor.SettlementProcessor(run_out=out).process_file(str(strat))),
        ("10_temples",             lambda strat, out: temples.TempleBuildingProcessor().run(run_strat=strat, run_out=out)),
        ("11_slave_placer",        lambda strat, out: slave_placer.run(run_strat=strat, run_out=out)),
        ("12_civic",               lambda strat, out: civic.CivicBuildingProcessor().run(run_strat=strat, run_out=out)),
        ("13_grain_exports",       lambda strat, out: grain_exports.GrainExportProcessor().run(run_strat=strat, run_out=out)),
        ("14_starting_treasury",   lambda strat, out: starting_treasury.StartingTreasuryProcessor().run(run_strat=strat, run_out=out)),
    ]

    current_strat = CONFIG_DIR / "descr_strat.txt"

    if not current_strat.exists():
        print(f"ERROR: Source file not found: {current_strat}")
        if regions_backup is not None:
            regions_file.write_bytes(regions_backup)
        sys.exit(1)

    for name, func in steps:
        step_dir = run_dir / name
        step_dir.mkdir(parents=True, exist_ok=True)

        print(f"\n[{name}] Running...")
        try:
            func(current_strat, step_dir)
        except Exception as e:
            print(f"ERROR in {name}: {e}")
            import traceback
            traceback.print_exc()
            # Restore original descr_regions.txt on failure
            if regions_backup is not None:
                regions_file.write_bytes(regions_backup)
            sys.exit(1)

        next_strat = step_dir / "descr_strat.txt"
        if not next_strat.exists():
            print(f"ERROR: {name} did not produce descr_strat.txt in {step_dir}")
            if regions_backup is not None:
                regions_file.write_bytes(regions_backup)
            sys.exit(1)

        current_strat = next_strat
        print(f"[{name}] Done. Output: {step_dir}")

    # Restore original descr_regions.txt in config (the updated copy is in the run dir)
    if regions_backup is not None:
        regions_file.write_bytes(regions_backup)

    # Copy final outputs to the run root AND flat processed_output for easy access
    final_strat = run_dir / "descr_strat.txt"
    final_strat.write_bytes(current_strat.read_bytes())
    # Also copy to flat processed_output/ so Save to Mod can find it
    (OUTPUT_DIR / "descr_strat.txt").write_bytes(current_strat.read_bytes())

    updated_regions = hr_dir / "descr_regions.txt"
    if updated_regions.exists():
        shutil.copy2(updated_regions, run_dir / "descr_regions.txt")
        shutil.copy2(updated_regions, OUTPUT_DIR / "descr_regions.txt")

    # Write unified changelog
    write_unified_changelog(run_dir)

    print(f"\n========================================")
    print(f"All done!")
    print(f"Final descr_strat.txt:    {final_strat}")
    print(f"Final descr_regions.txt:  {run_dir / 'descr_regions.txt'}")
    print(f"Unified changelog:        {run_dir / 'changelog.txt'}")
    print(f"All logs in:              {run_dir}")
    print(f"========================================")


if __name__ == "__main__":
    run_all()
