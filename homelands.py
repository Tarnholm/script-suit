#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path
import re
import sys
import traceback
from typing import Dict, List, Set, Optional

# -----------------------------------------------------------------------------
# Configuration
# -----------------------------------------------------------------------------
BASE_DIR = Path(__file__).parent
CONFIG_DIR = BASE_DIR / "config"
OUTPUT_DIR = BASE_DIR / "processed_output"

# Base filenames
REGIONS_FILE_NAME = "descr_regions.txt"
BUILDINGS_FILE_NAME = "export_descr_buildings.txt"
STRAT_FILE_NAME = "descr_strat.txt"

IGNORED_OWNERS = {"slave"}
COLONY_LEVELS = ["colony_1", "colony_2"]  # Order matters! Higher = higher tier

# -----------------------------------------------------------------------------
# Debug logger
# -----------------------------------------------------------------------------
class DebugLogger:
    def __init__(self):
        self.lines: List[str] = []

    def log(self, *parts):
        s = " ".join(str(p) for p in parts)
        self.lines.append(s)

    def write(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("\n".join(self.lines) + "\n", encoding="utf-8")

# -----------------------------------------------------------------------------
# File IO helpers
# -----------------------------------------------------------------------------
def read_text(p: Path) -> str:
    return p.read_text(encoding="utf-8", errors="replace")

def write_text(p: Path, txt: str) -> None:
    p.write_text(txt, encoding="utf-8")

# -----------------------------------------------------------------------------
# Parse descr_regions.txt to get hidden resources for each region
# -----------------------------------------------------------------------------
def parse_regions(path: Path, dbg: DebugLogger) -> Dict[str, Set[str]]:
    s = read_text(path)
    lines = s.splitlines()
    region_resources: Dict[str, Set[str]] = {}
    i = 0
    n = len(lines)
    dbg.log("Parsing descr_regions:", str(path), "lines:", str(n))
    
    while i < n:
        raw = lines[i]
        stripped = raw.strip()
        
        if not stripped or stripped.startswith(";"):
            i += 1
            continue
        
        if raw and not raw[0].isspace():
            region_name = stripped
            j = i + 1
            block_lines: List[str] = []
            
            while j < n:
                line = lines[j]
                line_stripped = line.strip()
                
                if not line_stripped or line_stripped.startswith(";"):
                    j += 1
                    continue
                
                if not line[0].isspace():
                    break
                
                block_lines.append(line_stripped)
                j += 1
            
            if len(block_lines) > 4:
                resources_line = block_lines[4]
                resources = {r.strip() for r in resources_line.split(",") if r.strip()}
                region_resources[region_name] = resources
            else:
                region_resources[region_name] = set()
            
            i = j
        else:
            i += 1
    
    dbg.log(f"Total regions: {len(region_resources)}")
    return region_resources

# -----------------------------------------------------------------------------
# Parse export_descr_buildings.txt for homeland aliases
# -----------------------------------------------------------------------------
def parse_edb_for_homelands(path: Path, dbg: DebugLogger) -> Dict[str, Set[str]]:
    text = read_text(path)
    dbg.log("Parsing export_descr_buildings:", str(path), "size:", str(len(text)))
    
    faction_to_resources: Dict[str, Set[str]] = {}
    
    pattern = re.compile(
        r'alias\s+(\w*homeland\w*)\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}',
        re.IGNORECASE | re.DOTALL
    )
    
    for match in pattern.finditer(text):
        alias_name = match.group(1)
        body = match.group(2)
        
        factions_match = re.search(r'factions\s*\{\s*([^}]+)\}', body)
        if not factions_match:
            continue
        
        factions_raw = factions_match.group(1)
        factions = []
        for f in re.split(r'[,\s]+', factions_raw):
            f = f.strip().rstrip(',')
            if f and f != ',':
                factions.append(f)
        
        hidden_resources = set(re.findall(r'hidden_resource\s+(\w+)', body))
        
        if not factions or not hidden_resources:
            continue
        
        dbg.log(f"  {alias_name}: factions={factions} resources={sorted(hidden_resources)}")
        
        for faction in factions:
            faction_to_resources.setdefault(faction, set()).update(hidden_resources)
    
    dbg.log(f"Total factions with homelands: {len(faction_to_resources)}")
    return faction_to_resources

# -----------------------------------------------------------------------------
# Parse and modify descr_strat.txt
# -----------------------------------------------------------------------------
def process_strat(
    path: Path, 
    region_resources: Dict[str, Set[str]],
    faction_homelands: Dict[str, Set[str]],
    dbg: DebugLogger
) -> tuple[str, List[dict], List[dict], List[dict], List[dict], List[dict]]:
    text = read_text(path)
    lines = text.splitlines()
    n = len(lines)
    
    added: List[dict] = []
    removed: List[dict] = []
    unchanged: List[dict] = []
    colony_removed: List[dict] = []
    illegal_colony_removals: List[dict] = []
    downgraded_colonies: List[dict] = []
    
    current_faction: Optional[str] = None
    i = 0

    colony_regex = re.compile(
        r'type\s+colony\s+(' + "|".join(re.escape(lvl) for lvl in COLONY_LEVELS) + r')\b'
    )

    while i < n:
        line = lines[i]
        
        faction_match = re.match(r'^\s*faction\s+(\w+)', line)
        if faction_match:
            current_faction = faction_match.group(1)
            dbg.log(f"Faction: {current_faction}")
            i += 1
            continue
        
        if line.strip().startswith("settlement"):
            settlement_start = i
            j = i
            
            while j < n and "{" not in lines[j]:
                j += 1
            if j >= n:
                i += 1
                continue
            
            brace_start = j
            depth = lines[j].count("{") - lines[j].count("}")
            j += 1
            
            while j < n and depth > 0:
                depth += lines[j].count("{") - lines[j].count("}")
                j += 1
            
            settlement_end = j
            settlement_text = "\n".join(lines[brace_start:settlement_end])

            # Get settlement level (e.g. 'village', 'town', 'large_town', etc.)
            settlement_level_match = re.search(r'^\s*level\s+(\w+)', settlement_text, re.M)
            settlement_level = settlement_level_match.group(1) if settlement_level_match else ""
            
            region_match = re.search(r'^\s*region\s+(\S+)', settlement_text, re.M)
            if not region_match:
                i = settlement_end
                continue
            
            region_name = region_match.group(1)
            region_res = region_resources.get(region_name, set())
            faction_homeland_res = faction_homelands.get(current_faction, set())
            
            matching_resources = region_res & faction_homeland_res
            is_homeland = bool(matching_resources)
            has_gov4 = bool(re.search(r'type\s+governmentD\s+gov4', settlement_text))

            info = {
                "region": region_name,
                "owner": current_faction,
                "matching": sorted(matching_resources),
                "level": settlement_level,
            }
            
            dbg.log(f"  {region_name}: owner={current_faction}, homeland={is_homeland}, gov4={has_gov4}, level={settlement_level}")
            
            if current_faction in IGNORED_OWNERS:
                i = settlement_end
                continue

            # --- BEGIN: REMOVE forbidden COLONY buildings for settlement size or DOWNGRADE colony_2 in towns ---
            removed_illegal_colonies = []
            k = brace_start
            while k < settlement_end:
                line_k = lines[k]
                building_header = re.match(r'^\s*building\s*$', line_k)
                if building_header:
                    block_start = k
                    found_brace = False
                    m = k + 1
                    while m < settlement_end:
                        if "{" in lines[m]:
                            found_brace = True
                            break
                        m += 1
                    if not found_brace:
                        k += 1
                        continue
                    block_brace = m
                    depth_b = lines[m].count("{") - lines[m].count("}")
                    m += 1
                    while m < settlement_end and depth_b > 0:
                        depth_b += lines[m].count("{") - lines[m].count("}")
                        m += 1
                    block_end = m
                    block_lines = lines[block_start:block_end]
                    block_text = "\n".join(block_lines)
                    colony_match = re.search(r'type\s+colony\s+(\w+)', block_text)
                    colony_tier = colony_match.group(1) if colony_match else None
                    illegal = False
                    reason = ""
                    downgraded = False
                    downgrade_from = None

                    if settlement_level == "village":
                        # Villages cannot have any colony
                        if colony_tier in COLONY_LEVELS:
                            illegal = True
                            reason = f"village can't have colony building {colony_tier}"
                            removed_illegal_colonies.append({
                                "region": region_name,
                                "owner": current_faction,
                                "block": block_text,
                                "level": settlement_level,
                                "colony_tier": colony_tier,
                                "reason": reason
                            })
                            del lines[block_start:block_end]
                            removed_count = block_end - block_start
                            settlement_end -= removed_count
                            n -= removed_count
                            continue  # don't increment k
                    elif settlement_level == "town":
                        # Town cannot have colony_2 or above; downgrade colony_2 to colony_1
                        if colony_tier == "colony_2":
                            # Replace with colony_1
                            new_block_lines = [
                                re.sub(r'(type\s+colony\s+)colony_2', r'\1colony_1', ln)
                                for ln in block_lines
                            ]
                            lines[block_start:block_end] = new_block_lines
                            downgraded_colonies.append({
                                "region": region_name,
                                "owner": current_faction,
                                "from": "colony_2",
                                "to": "colony_1",
                                "level": settlement_level,
                                "block_before": block_text,
                                "block_after": "\n".join(new_block_lines)
                            })
                            k += len(new_block_lines)
                            continue
                    # Large towns and above: all colonies allowed.
                    k += 1
                else:
                    k += 1
            if removed_illegal_colonies:
                illegal_colony_removals.extend(removed_illegal_colonies)
            # --- END: remove forbidden colonies for settlement types ---
            # --- BEGIN: collect downgraded colonies for reporting ---
            # (not mixing with illegal_colony_removals, report as a separate section)
            # --- END
            # --- BEGIN: COLONY REMOVAL for gov4/homeland ---
            removed_colonies = []
            if has_gov4:
                k = brace_start
                while k < settlement_end:
                    line_k = lines[k]
                    building_header = re.match(r'^\s*building\s*$', line_k)
                    if building_header:
                        block_start = k
                        found_brace = False
                        m = k + 1
                        while m < settlement_end:
                            if "{" in lines[m]:
                                found_brace = True
                                break
                            m += 1
                        if not found_brace:
                            k += 1
                            continue
                        block_brace = m
                        depth_b = lines[m].count("{") - lines[m].count("}")
                        m += 1
                        while m < settlement_end and depth_b > 0:
                            depth_b += lines[m].count("{") - lines[m].count("}")
                            m += 1
                        block_end = m
                        block_lines = lines[block_start:block_end]
                        block_text = "\n".join(block_lines)
                        if colony_regex.search(block_text):
                            removed_colonies.append({
                                "region": region_name,
                                "owner": current_faction,
                                "block": block_text
                            })
                            del lines[block_start:block_end]
                            removed_count = block_end - block_start
                            settlement_end -= removed_count
                            n -= removed_count
                            continue  # do not increment k, lines shift up
                        else:
                            k += 1
                    else:
                        k += 1
            if removed_colonies:
                colony_removed.extend(removed_colonies)
            # --- END: COLONY REMOVAL for gov4/homeland ---
            
            if is_homeland and not has_gov4:
                dbg.log(f"    -> ADD gov4")
                found_gov = False
                for k in range(brace_start, settlement_end):
                    if re.search(r'type\s+government[ABC]\s+\w+', lines[k]):
                        lines[k] = re.sub(r'type\s+government[ABC]\s+\w+', 'type governmentD gov4', lines[k])
                        found_gov = True
                        break
                if not found_gov:
                    for k in range(settlement_end - 1, brace_start, -1):
                        if lines[k].strip() == "}":
                            new_building = "\tbuilding\n\t{\n\t\ttype governmentD gov4\n\t}"
                            lines.insert(k, new_building)
                            settlement_end += 1
                            n += 1
                            break
                added.append(info)
            elif not is_homeland and has_gov4:
                dbg.log(f"    -> REMOVE gov4")
                k = brace_start
                while k < settlement_end:
                    if "governmentD" in lines[k] and "gov4" in lines[k]:
                        block_start = k
                        while block_start > brace_start and "building" not in lines[block_start]:
                            block_start -= 1
                        block_end = k + 1
                        inner_depth = 1
                        while block_end < settlement_end and inner_depth > 0:
                            inner_depth += lines[block_end].count("{") - lines[block_end].count("}")
                            block_end += 1
                        del lines[block_start:block_end]
                        removed_count = block_end - block_start
                        settlement_end -= removed_count
                        n -= removed_count
                        break
                    k += 1
                removed.append(info)
            else:
                unchanged.append(info)
            
            i = settlement_end
            continue
        i += 1
    
    return "\n".join(lines), added, removed, unchanged, colony_removed, illegal_colony_removals, downgraded_colonies

# -----------------------------------------------------------------------------
# Write report
# -----------------------------------------------------------------------------
def write_report(path: Path, added: List[dict], removed: List[dict], unchanged: List[dict], colony_removed: List[dict], illegal_colony_removals: List[dict], downgraded_colonies: List[dict]):
    out = ["HOMELAND BUILDINGS REPORT", "=" * 50, ""]

    out.append(f"ADDED gov4 ({len(added)} settlements):")
    out.append("-" * 40)
    if not added:
        out.append("  None")
    else:
        for item in added:
            out.append(f"  {item['region']} (owner: {item['owner']})")
            out.append(f"    Matching: {item['matching']}")
    out.append("")

    out.append(f"REMOVED gov4 ({len(removed)} settlements):")
    out.append("-" * 40)
    if not removed:
        out.append("  None")
    else:
        for item in removed:
            out.append(f"  {item['region']} (owner: {item['owner']})")
    out.append("")

    out.append(f"REMOVED colonies (levels {', '.join(COLONY_LEVELS)}) in gov4 cities: {len(colony_removed)} buildings")
    out.append("-" * 40)
    if not colony_removed:
        out.append("  None")
    else:
        for item in colony_removed:
            out.append(f"  {item['region']} (owner: {item['owner']})")
            block = item.get('block', None)
            if block:
                out.append("    Removed colony block:")
                out.append("      " + "\n      ".join(block.splitlines()))
    out.append("")

    out.append(f"REMOVED forbidden colonies due to settlement size: {len(illegal_colony_removals)} buildings")
    out.append("-" * 40)
    if not illegal_colony_removals:
        out.append("  None")
    else:
        for item in illegal_colony_removals:
            out.append(f"  {item['region']} (owner: {item['owner']}) [level: {item['level']}]")
            out.append(f"    Colony: {item['colony_tier']}  Reason: {item['reason']}")
            block = item.get('block', None)
            if block:
                out.append("    Removed block:")
                out.append("      " + "\n      ".join(block.splitlines()))
    out.append("")

    out.append(f"DOWNGRADED colony_2 blocks to colony_1 in towns: {len(downgraded_colonies)}")
    out.append("-" * 40)
    if not downgraded_colonies:
        out.append("  None")
    else:
        for item in downgraded_colonies:
            out.append(f"  {item['region']} (owner: {item['owner']}) [level: {item['level']}]")
            out.append("    Downgraded colony_2 → colony_1")
            out.append("    Before:")
            out.append("      " + "\n      ".join(item['block_before'].splitlines()))
            out.append("    After:")
            out.append("      " + "\n      ".join(item['block_after'].splitlines()))
    out.append("")

    out.append(f"UNCHANGED: {len(unchanged)} settlements")

    write_text(path, "\n".join(out) + "\n")

# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------
def main(run_strat=None, run_out=None):
    _strat = Path(run_strat) if run_strat else CONFIG_DIR / STRAT_FILE_NAME
    _out = Path(run_out) if run_out else Path(OUTPUT_DIR)
    outdir = _out
    outdir.mkdir(parents=True, exist_ok=True)
    dbg = DebugLogger()

    dbg.log("check_homelands starting")

    try:
        # Construct paths to look in the /config subfolder
        rpath = CONFIG_DIR / REGIONS_FILE_NAME
        bpath = CONFIG_DIR / BUILDINGS_FILE_NAME
        spath = _strat
        
        # Validate existence of files in the config folder
        for p in (rpath, bpath, spath):
            if not p.exists():
                raise FileNotFoundError(f"File not found in config directory: {p}")

        region_resources = parse_regions(rpath, dbg)
        faction_homelands = parse_edb_for_homelands(bpath, dbg)
        
        if not faction_homelands:
            raise RuntimeError("No homeland aliases found in export_descr_buildings.txt")
        
        modified_text, added, removed, unchanged, colony_removed, illegal_colony_removals, downgraded_colonies = process_strat(
            spath, region_resources, faction_homelands, dbg
        )
        
        write_text(outdir / "descr_strat.txt", modified_text)
        write_report(outdir / "report.txt", added, removed, unchanged, colony_removed, illegal_colony_removals, downgraded_colonies)
        dbg.write(outdir / "debug.txt")

        print(f"Done! Output in '{outdir}/'")
        print(f"  Added gov4:   {len(added)}")
        print(f"  Removed gov4: {len(removed)}")
        print(f"  Removed colonies in gov4: {len(colony_removed)}")
        print(f"  Removed illegal colonies by settlement size: {len(illegal_colony_removals)}")
        print(f"  Downgraded colony_2 to colony_1: {len(downgraded_colonies)}")
        print(f"  Unchanged:    {len(unchanged)}")

    except Exception as e:
        tb = traceback.format_exc()
        write_text(outdir / "errors.log", f"Exception: {e}\n\n{tb}")
        print(f"Error! See {outdir}/errors.log", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()