import sys
import re
from pathlib import Path
from datetime import datetime
from collections import defaultdict

sys.dont_write_bytecode = True

BASE_DIR = Path(__file__).parent
CONFIG_DIR = BASE_DIR / "config"
OUTPUT_DIR = BASE_DIR / "processed_output"
MAP_REGIONS_FILE = CONFIG_DIR / "map_regions.tga"
REGIONS_FILE_PATH = CONFIG_DIR / "descr_regions.txt"

SETTLEMENT_LEVEL_ORDER = ["town", "large_town", "city", "large_city", "huge_city"]
LEVEL_TO_TIER = {level: i + 1 for i, level in enumerate(SETTLEMENT_LEVEL_ORDER)}
LEVEL_TO_TIER["minor_city"] = LEVEL_TO_TIER["city"]  # minor_city == city tier
TIER_TO_LEVEL = {v: k for k, v in LEVEL_TO_TIER.items()}
PORT_BUILDING_NAMES = ['port', 'shipwright', 'dockyard', 'river_port1', 'river_port2']

def normalize_region_name(name):
    return name.strip().lower()

def bump_settlement_level(level, port_type):
    if port_type in ("river_port1", "river_port2"):
        if level not in SETTLEMENT_LEVEL_ORDER:
            return level
        idx = SETTLEMENT_LEVEL_ORDER.index(level)
        return SETTLEMENT_LEVEL_ORDER[min(idx + 1, len(SETTLEMENT_LEVEL_ORDER) - 1)]
    else:
        return level

def get_block(text, start_offset):
    try:
        first_brace = text.index('{', start_offset)
    except ValueError:
        return None, -1
    brace_depth = 1
    for i in range(first_brace + 1, len(text)):
        if text[i] == '{':
            brace_depth += 1
        elif text[i] == '}':
            brace_depth -= 1
        if brace_depth == 0:
            return text[first_brace + 1 : i], i + 1
    return None, -1

def parse_edb_port_levels_with_settlement_min(filename, debug_log):
    with open(filename, 'r', encoding='utf-8', errors='ignore') as f:
        full_content = f.read()
    chains = {}
    building_matches = re.finditer(r'^\s*building\s+(\w+)', full_content, re.MULTILINE)
    for match in building_matches:
        building_name = match.group(1)
        full_building_text, _ = get_block(full_content, match.end())
        if not full_building_text: continue
        tag_port = re.search(r"^\s*tag\s+port\b", full_building_text, re.MULTILINE)
        if not tag_port: continue

        debug_log.append(f"  - Found building '{building_name}' with 'tag port'.")
        levels_match = re.search(r'levels\s+([\w\s+]+)', full_building_text)
        if not levels_match: continue
        level_names = levels_match.group(1).strip().split()
        levels_block_content, _ = get_block(full_building_text, levels_match.end())
        if not levels_block_content: continue

        levels_info = []
        last_known_min = None
        split_points = []
        for level_name in level_names:
            level_def_re = r'(?m)^\s*' + re.escape(level_name) + r'\s+requires'
            match_pos = re.search(level_def_re, levels_block_content)
            if match_pos:
                split_points.append({'name': level_name, 'start': match_pos.start()})
        split_points.sort(key=lambda x: x['start'])

        for i, point in enumerate(split_points):
            level_name = point['name']
            start = point['start']
            end = split_points[i+1]['start'] if i + 1 < len(split_points) else len(levels_block_content)
            chunk = levels_block_content[start:end]

            search_for_block_start = 0
            level_def_content = ""
            while True:
                block, next_pos = get_block(chunk, search_for_block_start)
                if block is None: break
                level_def_content = block
                search_for_block_start = next_pos

            if not level_def_content:
                debug_log.append(f"Building '{building_name}': Could not find main definition block for level '{level_name}'. Skipping.")
                continue

            s_match = re.search(r'settlement_min\s+(\w+)', level_def_content)
            edb_min = None
            if s_match:
                edb_min = s_match.group(1)
                last_known_min = edb_min
            elif last_known_min:
                edb_min = last_known_min

            if not edb_min:
                debug_log.append(f"Building '{building_name}': Base level '{level_name}' is MISSING 'settlement_min' requirement. Skipping.")
                continue

            bumped_min = bump_settlement_level(edb_min, level_name)
            debug_log.append(f"    - Found level '{level_name}' with min settlement: '{edb_min}', bumped to '{bumped_min}'")
            levels_info.append({'level': level_name, 'settlement_min': bumped_min})

        if levels_info:
            chains[building_name] = levels_info
    debug_log.append("--- End of EDB Parsing ---\n")
    return chains


def get_regions_with_port_pixel(debug_log):
    """Scan map_regions.tga for white (255,255,255) port pixels.
    Returns the set of region names that have at least one adjacent port pixel."""
    if not MAP_REGIONS_FILE.exists():
        debug_log.append(f"WARNING: {MAP_REGIONS_FILE} not found — skipping port pixel check.")
        return None  # None means "skip the check"

    try:
        from PIL import Image
    except ImportError:
        debug_log.append("WARNING: PIL/Pillow not installed — skipping port pixel check.")
        return None

    # Parse region colors from descr_regions.txt
    regions_by_color = {}
    with open(REGIONS_FILE_PATH, encoding='utf-8', errors='ignore') as f:
        region = None
        for line in f:
            s = line.strip()
            if not s or s.startswith(';'):
                continue
            if not line[0].isspace():
                region = s
                continue
            if region:
                m = re.match(r'^(\d+)\s+(\d+)\s+(\d+)$', s)
                if m:
                    rgb = tuple(map(int, m.groups()))
                    regions_by_color[rgb] = region
                    region = None

    img = Image.open(MAP_REGIONS_FILE).convert('RGB')
    w, h = img.size
    pixels = img.load()

    # White pixel adjacent to a region = that region can have a port
    port_regions = set()
    for y in range(h):
        for x in range(w):
            if pixels[x, y] == (255, 255, 255):
                for dx, dy in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < w and 0 <= ny < h:
                        c = pixels[nx, ny]
                        if c in regions_by_color:
                            port_regions.add(regions_by_color[c])

    # Find mismatches: regions with port resource in CSV but no port pixel on map
    mismatched = []
    with open(REGIONS_FILE_PATH, encoding='utf-8', errors='ignore') as f:
        rlines = [l.strip() for l in f if l.strip() and not l.strip().startswith(';')]
    ri = 0
    while ri < len(rlines):
        if not rlines[ri][0:1].isspace():
            rname = rlines[ri]
            if ri + 5 < len(rlines):
                res_line = rlines[ri + 5]
                has_port_res = any(f'base_port_level_{x}' in res_line for x in '123')
                if has_port_res and rname not in port_regions:
                    mismatched.append(rname)
                ri += 9
                continue
        ri += 1

    # Load manual port blocklist (regions where game rejects ports despite having a pixel)
    port_blocklist = set()
    blocklist_file = CONFIG_DIR / "port_blocklist.txt"
    if blocklist_file.exists():
        for line in blocklist_file.read_text(encoding='utf-8').splitlines():
            line = line.strip()
            if line and not line.startswith('#'):
                port_blocklist.add(line)
        port_regions -= port_blocklist
        if port_blocklist:
            debug_log.append(f"Port blocklist: removed {len(port_blocklist)} regions: {sorted(port_blocklist)}")

    debug_log.append(f"Port pixel check: {len(port_regions)} regions have port pixels on the map.")
    if mismatched:
        debug_log.append(f"PORT/MAP MISMATCHES ({len(mismatched)} regions have base_port_level in CSV but no port pixel):")
        for r in sorted(mismatched):
            debug_log.append(f"  - {r}")
        print(f"\nWARNING: {len(mismatched)} regions have port data in CSV but no port pixel on map:")
        for r in sorted(mismatched):
            print(f"  - {r}")
        print(f"Fix these in the spreadsheet or add port pixels to map_regions.tga.\n")

    return port_regions


def parse_regions_file(regions_path, debug_log):
    regions_data = defaultdict(set)
    region_to_city_map = {}
    debug_log.append("--- Parsing descr_regions.txt for Resources & Cities ---")
    try:
        with open(regions_path, 'r', encoding='utf-8', errors='ignore') as f:
            lines = [line.strip() for line in f if line.strip() and not line.strip().startswith(';')]
        i = 0
        while i < len(lines):
            region_name = normalize_region_name(lines[i])
            if i + 5 < len(lines):
                city_name = lines[i+1]
                resource_line = lines[i+5]
                region_to_city_map[region_name] = city_name
                resources = {res.strip() for res in resource_line.split(',')}
                regions_data[region_name].update(resources)
                i += 9
            else:
                i += 1
        debug_log.append("--- Finished Region Parsing ---\n")
        return regions_data, region_to_city_map
    except FileNotFoundError:
        debug_log.append(f"  - ERROR: Regions file not found at '{regions_path}'.")
        return defaultdict(set), {}

def parse_resources_by_region(strat_path):
    """Trade-resource amounts per region from descr_strat (for the bump totals)."""
    out = defaultdict(dict)
    with open(strat_path, encoding='utf-8', errors='ignore') as f:
        for l in f:
            m = re.match(r'resource\s+([\w_-]+),\s*([\d.]+),\s*\d+,\s*\d+\s*;\s*([\w_&-]+)', l)
            if m:
                region = normalize_region_name(m.group(3))
                out[region][m.group(1)] = out[region].get(m.group(1), 0) + float(m.group(2))
    return out

def parse_region_resource_lines(regions_path):
    region_resource_lines = {}
    with open(regions_path, 'r', encoding='utf-8', errors='ignore') as f:
        lines = [line.strip() for line in f if line.strip() and not line.strip().startswith(';')]
    i = 0
    while i < len(lines):
        region_name = normalize_region_name(lines[i])
        if i + 5 < len(lines):
            resource_line = lines[i+5]
            region_resource_lines[region_name] = resource_line
            i += 9
        else:
            i += 1
    return region_resource_lines

def get_max_port_tier_from_resource_line(resource_line):
    match = re.search(r'base_port_level_(\d)', resource_line)
    if match:
        return int(match.group(1))
    return None

def get_port_level_for_tier(tier):
    levels = ['port', 'shipwright', 'dockyard']
    idx = min(max(tier-1, 0), 2)
    return levels[idx]

def downgrade_port_if_needed(region, chosen_level, region_resource_lines, debug_log=None):
    resource_line = region_resource_lines.get(region, "")
    max_tier = get_max_port_tier_from_resource_line(resource_line)
    if max_tier is not None:
        level_to_tier = {'port': 1, 'shipwright': 2, 'dockyard': 3}
        chosen_tier = level_to_tier.get(chosen_level, None)
        if chosen_tier is not None and chosen_tier > max_tier:
            downgraded_level = get_port_level_for_tier(max_tier)
            if debug_log is not None:
                debug_log.append(f"    - Downgraded port for region {region} from {chosen_level} (tier {chosen_tier}) to {downgraded_level} (max allowed tier {max_tier})")
            return downgraded_level
    return chosen_level

def extract_settlement_meta(block_lines):
    region = None
    level = "town"
    for line in block_lines:
        s = line.strip()
        if s.startswith("region"):
            region = s.split()[1]
        elif s.startswith("level"):
            level = s.split()[1]
    return region, level

# Coastal levels, highest tier first: (level, size_no_bump, size_bump, base_port_level_required)
COASTAL_LEVELS = (
    ("dockyard",   "large_city", "huge_city",  3),
    ("shipwright", "city",       "large_city", 2),
    ("port",       "town",       "large_town", 1),
)
# River levels, highest tier first: (level, size_no_bump, size_bump)
RIVER_LEVELS = (
    ("river_port2", "city",       "large_city"),
    ("river_port1", "large_town", "city"),
)
# Resources that exempt a river port from the bump (gets the bigger port sooner).
RIVER_NO_BUMP_RESOURCES = ("grain", "stone", "marble", "timber")

def choose_port(settlement_level, combined_resources, strat_resources, base_port_level, has_rivertrade, log=None):
    """Coastal always wins when base_port_level 1-3 is present; otherwise a river
    port if rivertrade. Coastal bump keys off the region's total resource amount
    (>5 = no bump); river bump keys off grain/stone/marble/timber presence."""
    tier = LEVEL_TO_TIER.get(settlement_level, 0)
    total = sum(strat_resources.values())
    details = []

    if base_port_level and base_port_level >= 1:
        bump = total <= 5
        details.append(f"  - Coastal: resource_total={total:g}, bump={'yes' if bump else 'no'}, base_port_level={base_port_level}, tier={tier}")
        for lvl, size_nobump, size_bump, bpl_req in COASTAL_LEVELS:
            size_req = size_bump if bump else size_nobump
            if tier >= LEVEL_TO_TIER[size_req] and base_port_level >= bpl_req:
                if log is not None: log.append(f"  - Coastal -> {lvl} (needs {size_req}+ and base_port_level {bpl_req}+).")
                return "port_buildings", lvl, details
        details.append("  - Coastal: no level qualifies at this size/base_port_level.")
        return None, None, details

    if has_rivertrade:
        no_bump = any(r in strat_resources for r in RIVER_NO_BUMP_RESOURCES)
        details.append(f"  - River: no_bump={'yes' if no_bump else 'no'} (grain/stone/marble/timber present), tier={tier}")
        for lvl, size_nobump, size_bump in RIVER_LEVELS:
            size_req = size_nobump if no_bump else size_bump
            if tier >= LEVEL_TO_TIER[size_req]:
                if log is not None: log.append(f"  - River -> {lvl} (needs {size_req}+).")
                return "river_port", lvl, details
        details.append("  - River: no level qualifies at this size.")
        return None, None, details

    details.append("  - No base_port_level 1-3 and no rivertrade.")
    return None, None, details

def explain_no_port_reason(region_name_raw, region_name, level, resources, port_chains, candidate_details):
    lines = []
    has_port_resource = any(res in resources for res in ['base_port_level_1', 'base_port_level_2', 'base_port_level_3'])
    has_rivertrade = 'rivertrade' in resources
    if not has_port_resource and not has_rivertrade:
        lines.append("    - Reason: Region has neither port resource (base_port_level_X) nor rivertrade.")
        return lines
    for building, levels in port_chains.items():
        for lvl in levels:
            min_tier = LEVEL_TO_TIER.get(lvl['settlement_min'], 99)
            if lvl['level'] in ['dockyard', 'shipwright', 'port']:
                if not has_port_resource:
                    lines.append(f"    - Not eligible for {lvl['level']} ({building}): region lacks base_port_level_X resource.")
                elif LEVEL_TO_TIER.get(level, 0) < min_tier:
                    lines.append(f"    - Not eligible for {lvl['level']} ({building}): settlement level '{level}' is below minimum '{lvl['settlement_min']}'.")
            elif lvl['level'] == 'river_port1':
                if not has_rivertrade:
                    lines.append(f"    - Not eligible for river_port1 ({building}): region lacks rivertrade resource.")
                elif LEVEL_TO_TIER.get(level, 0) < min_tier:
                    lines.append(f"    - Not eligible for river_port1 ({building}): settlement level '{level}' is below minimum '{lvl['settlement_min']}'.")
    if candidate_details:
        lines.extend(candidate_details)
    if not lines:
        lines.append("    - Reason: Unknown, no candidates matched.")
    return lines

def process_settlement_block(block_lines, new_building, new_level, port_building_names):
    output_block = []
    in_building_block = False
    building_buffer = []
    port_found = None
    settlement_level = None
    region_name = None
    for line in block_lines:
        stripped = line.strip()
        if stripped.startswith("region"):
            region_name = stripped.split()[1]
        if stripped.startswith("level"):
            settlement_level = stripped.split()[1]
        if stripped.startswith("building"):
            in_building_block = True
            building_buffer = [line]
            continue
        if in_building_block:
            building_buffer.append(line)
            if "}" in stripped:
                is_port_building = False
                for b_line in building_buffer:
                    if b_line.strip().startswith("type"):
                        parts = b_line.strip().split()
                        building_level = parts[2] if len(parts) > 2 else ""
                        if building_level in port_building_names:
                            is_port_building = True
                            port_found = building_level
                            break
                if not is_port_building:
                    output_block.extend(building_buffer)
                in_building_block = False
        else:
            output_block.append(line)
    if new_building and new_level:
        closing_brace_index = -1
        for i in range(len(output_block) - 1, -1, -1):
            if output_block[i].strip() == "}":
                closing_brace_index = i
                break
        if closing_brace_index != -1:
            indent_match = re.match(r"^(\s*)", output_block[closing_brace_index - 1])
            indent = indent_match.group(1) if indent_match else "\t"
            new_building_text = f"{indent}building\n{indent}{{\n{indent}\ttype {new_building} {new_level}\n{indent}}}\n"
            output_block.insert(closing_brace_index, new_building_text)
            port_found = new_level
    return output_block, region_name, settlement_level, port_found

def write_port_settlements_report(port_settlements, region_to_city_map, out_dir):
    path = Path(out_dir) / "port_settlements_report.txt"
    lines = ["Region,Settlement,SettlementLevel,PortBuilding\n"]
    for region, settlement, tier, port_building in port_settlements:
        level_str = TIER_TO_LEVEL.get(tier, str(tier))
        lines.append(f"{region},{settlement},{level_str},{port_building}\n")
    with open(path, "w", encoding="utf-8") as f:
        f.writelines(lines)
    print(f"Port settlements report saved to: {path}")

def get_existing_ports(strat_lines, port_building_names):
    existing_ports = {}
    i = 0
    while i < len(strat_lines):
        line = strat_lines[i]
        if line.strip().lower() == "settlement":
            brace_count, end_index = 0, i
            found_first_brace = False
            block_lines = []
            for j in range(i, len(strat_lines)):
                block_lines.append(strat_lines[j])
                if '{' in strat_lines[j]: found_first_brace = True
                if found_first_brace:
                    brace_count += strat_lines[j].count('{') - strat_lines[j].count('}')
                if found_first_brace and brace_count == 0:
                    end_index = j
                    break
            region = None
            found_port = None
            for bl in block_lines:
                s = bl.strip()
                if s.startswith("region"):
                    region = s.split()[1]
                if s.startswith("type"):
                    parts = s.split()
                    if len(parts) >= 3 and parts[2] in port_building_names:
                        found_port = parts[2]
            if region and found_port:
                existing_ports[region] = found_port
            i = end_index + 1
        else:
            i += 1
    return existing_ports

def main(run_strat=None, run_out=None):
    strat_file = Path(run_strat) if run_strat else CONFIG_DIR / "descr_strat.txt"
    regions_file = CONFIG_DIR / "descr_regions.txt"
    edb_file = CONFIG_DIR / "export_descr_buildings.txt"

    if run_out:
        out_dir = Path(run_out)
    else:
        ts = datetime.now().strftime('%Y%m%d_%H%M%S')
        out_dir = OUTPUT_DIR / f"port_authority_run_{ts}"
    out_dir.mkdir(parents=True, exist_ok=True)

    processed_strat_path = out_dir / "descr_strat.txt"
    changelog_path = out_dir / "changelog.txt"
    decision_log_path = out_dir / "decision_log.txt"
    debug_log_path = out_dir / "debug_log.txt"

    print(f"--- Port Authority ---")
    print(f"Output will be in: {out_dir.resolve()}")

    debug_log = []
    port_chains = parse_edb_port_levels_with_settlement_min(edb_file, debug_log)
    region_resources, region_to_city_map = parse_regions_file(regions_file, debug_log)
    region_resource_lines = parse_region_resource_lines(regions_file)
    resources_by_region = parse_resources_by_region(strat_file)
    port_pixel_regions = get_regions_with_port_pixel(debug_log)

    with open(strat_file, encoding="utf-8", errors="ignore") as f:
        all_lines = f.readlines()
    existing_ports = get_existing_ports(all_lines, PORT_BUILDING_NAMES)

    final_output_lines = []
    changelog, decision_log = [], []
    port_settlements = []

    print("\n--- Processing Settlements for Ports ---")
    i = 0
    while i < len(all_lines):
        line = all_lines[i]
        if line.strip().lower() == "settlement":
            brace_count, end_index = 0, i
            found_first_brace = False
            for j in range(i, len(all_lines)):
                if '{' in all_lines[j]: found_first_brace = True
                if found_first_brace:
                    brace_count += all_lines[j].count('{') - all_lines[j].count('}')
                if found_first_brace and brace_count == 0:
                    end_index = j
                    break
            block_lines = all_lines[i:end_index + 1]
            region_name_raw, level = extract_settlement_meta(block_lines)
            region_name = normalize_region_name(region_name_raw or "")
            decision_log_entry = [f"--- Settlement: {region_name_raw} ---"]
            combined_resources = region_resources.get(region_name, set())
            debug_log.append(f"Processing settlement: '{region_name_raw}' (normalized: '{region_name}'), resources: {combined_resources}")

            # Skip port assignment for regions with no_port tags or no port pixel on map
            no_port_tags = {'no_port', 'merc_center_no_port'}
            has_no_port = bool(combined_resources & no_port_tags)
            has_no_port_pixel = (port_pixel_regions is not None and
                                 region_name_raw and
                                 region_name_raw not in port_pixel_regions)
            old_port = existing_ports.get(region_name_raw, None)

            if has_no_port:
                decision_log_entry.append(f"  - BLOCKED: Region has {no_port_tags & combined_resources} tag(s). Skipping port.")
                chosen_building, chosen_level, candidate_details = None, None, []
            elif has_no_port_pixel:
                decision_log_entry.append(f"  - BLOCKED: No port pixel on map_regions.tga for '{region_name_raw}'. Skipping port.")
                chosen_building, chosen_level, candidate_details = None, None, []
            else:
                base_port_level = get_max_port_tier_from_resource_line(region_resource_lines.get(region_name, "")) or 0
                has_rivertrade = 'rivertrade' in combined_resources
                strat_resources = resources_by_region.get(region_name, {})
                chosen_building, chosen_level, candidate_details = choose_port(
                    level, combined_resources, strat_resources, base_port_level, has_rivertrade, decision_log_entry
                )

            rebuilt_block_lines, meta_region, meta_level, port_found = process_settlement_block(block_lines, chosen_building, chosen_level, PORT_BUILDING_NAMES)
            if chosen_building and chosen_level:
                decision_log_entry.append(f"  - FINAL DECISION: Added '{chosen_building} {chosen_level}'.")
                region = meta_region or region_name_raw
                settlement = region_to_city_map.get(region_name, region)
                tier = LEVEL_TO_TIER.get(meta_level or level, "?")
                port_settlements.append((region, settlement, tier, chosen_level))
                if old_port and old_port != chosen_level:
                    changelog.append(f"Settlement '{region_name_raw}': Changed from '{old_port}' to '{chosen_level}'.")
                elif not old_port and chosen_level:
                    changelog.append(f"Settlement '{region_name_raw}': Added '{chosen_level}'.")
                elif old_port and old_port == chosen_level:
                    changelog.append(f"Settlement '{region_name_raw}': Unchanged ('{chosen_level}').")
            else:
                # No port qualifies. process_settlement_block has already STRIPPED
                # any existing port from the block, so this is a removal (not a
                # "port already present" — that was the old bug that left towns
                # looking like they kept ports in the report).
                reasons = explain_no_port_reason(region_name_raw, region_name, level, combined_resources, port_chains, candidate_details)
                removed = old_port or port_found
                if removed:
                    decision_log_entry.append(f"  - FINAL DECISION: No port qualifies — removed existing '{removed}'.")
                    changelog.append(f"Settlement '{region_name_raw}': Removed '{removed}'.")
                else:
                    decision_log_entry.append("  - FINAL DECISION: No suitable port building found.")
                decision_log_entry.extend(reasons)
            final_output_lines.extend(rebuilt_block_lines)
            decision_log.append("\n".join(decision_log_entry))
            i = end_index + 1
        else:
            final_output_lines.append(line)
            i += 1

    print("\n--- Writing Output Files ---")
    with open(processed_strat_path, "w", encoding="utf-8") as f:
        f.writelines(final_output_lines)
    print(f"Processed file saved to: {processed_strat_path}")
    if changelog:
        with open(changelog_path, "w", encoding="utf-8") as f:
            f.write("\n".join(sorted(changelog)))
        print(f"Changelog saved to: {changelog_path}")
    with open(decision_log_path, "w", encoding="utf-8") as f:
        f.write("\n\n".join(decision_log))
    print(f"Decision log saved to: {decision_log_path}")
    with open(debug_log_path, "w", encoding="utf-8") as f:
        f.write("\n".join(debug_log))
    print(f"Debug log saved to: {debug_log_path}")
    write_port_settlements_report(port_settlements, region_to_city_map, out_dir)
    print("\n--- Script Finished ---")

if __name__ == "__main__":
    main()
