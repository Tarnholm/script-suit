import sys, logging, re, io, argparse
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple, Any
from datetime import datetime

sys.dont_write_bytecode = True

BASE_DIR = Path(__file__).parent
CONFIG_DIR = BASE_DIR / "config"
OUTPUT_DIR = BASE_DIR / "processed_output"

EXCLUDE_SETTLEMENTS = set()

NO_DEFENSES_REGIONS = {"lakonia", "elis", "kappadokia", "lucensia_meridionalis"}  # Regions that get no defenses assigned

# Walls (the "defenses" chain) are capped at this tier for every region.
MAX_WALL_TIER = 3
# Per-region wall-tier exceptions (region name lowercased -> cap). These OVERRIDE
# both MAX_WALL_TIER and NO_DEFENSES_REGIONS.
WALL_TIER_EXCEPTIONS = {"trinakria": 4, "korinthia": 3}

# ── Roads (hinterland_roads) ─────────────────────────────────────────────
ROAD_LEVELS = {1: "roads", 2: "paved_roads", 3: "highways"}
# Terrains that cap roads at tier 1 (roads).
ROAD_TERRAIN_CAP = {"desert", "mountains", "alpine", "sub_artic",
                    "small_islands_and_rocky_coast", "karst_terrain"}
# Highways (tier 3) require the region's total resource amount to EXCEED this.
ROAD_HIGHWAY_MIN_TOTAL = 12
# Regions (lowercased; matched on region or capital name) that always get highways.
ROADS_ALWAYS_HIGHWAY = {"roma"}
ROAD_TIER_BY_LEVEL = {"roads": 1, "paved_roads": 2, "highways": 3}

# ── Defenses (walls): tier -> level, assigned directly (no size bump) ─────
DEFENSE_LEVELS = {1: "wooden_pallisade", 2: "wooden_wall", 3: "stone_wall",
                  4: "large_stone_wall", 5: "epic_stone_wall"}

# ── Treasury: tier -> level, capped at MAX_TREASURY_TIER (assigned directly) ─
TREASURY_LEVELS = {1: "treasury", 2: "large_treasury", 3: "great_treasury", 4: "imperial_treasury"}
MAX_TREASURY_TIER = 2

TRADER_OVERRIDE_QTY = 4  # Minimum resource quantity to trigger trader override in towns
TRADER_OVERRIDE_RESOURCES = set()  # Leave empty = ALL resources count. Add names to restrict.

LEVEL_TO_TIER = {
    "village": 0, "town": 1, "large_town": 2, "minor_city": 3,
    "city": 3, "large_city": 4, "huge_city": 5
}

# --- Inline helpers ---

def create_output_dir(name):
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    out_dir = OUTPUT_DIR / f"{name}_{ts}"
    out_dir.mkdir(parents=True, exist_ok=True)
    return out_dir, ts

def get_standard_output_files(out_dir, prefix):
    return {
        "processed":   out_dir / "descr_strat.txt",
        "buildings":   out_dir / f"{prefix}_buildings.txt",
        "settlements": out_dir / f"settlements_{prefix}.txt",
        "decision":    out_dir / f"{prefix}_decision.txt",
        "changelog":   out_dir / f"{prefix}_changelog.txt",
        "ties":        out_dir / f"{prefix}_ties.txt",
    }

def write_buildings_file(path, buildings):
    path.write_text("\n".join(sorted(buildings)), encoding="utf-8")

def write_settlements_file(path, settlements, regions_data):
    lines = [f"{name}: {b}" for name, b in sorted(settlements.items())]
    path.write_text("\n".join(lines), encoding="utf-8")

def write_decision_file(path, decisions):
    path.write_text("\n\n".join(decisions), encoding="utf-8")

def write_changelog_file(path, changelog):
    path.write_text("\n".join(changelog), encoding="utf-8")

def write_ties_file(path, ties):
    path.write_text("\n".join(ties), encoding="utf-8")

# --- Logger setup ---

logger = None

def setup_logger(p: Path):
    l = logging.getLogger("settlement_logger")
    l.setLevel(logging.INFO)
    for h in list(l.handlers):
        l.removeHandler(h)
    fh = logging.FileHandler(p, encoding='utf-8')
    fh.setLevel(logging.INFO)
    fh.setFormatter(logging.Formatter('%(asctime)s %(levelname)s %(message)s'))
    l.addHandler(fh)
    return l

# --- Shared parsing helpers ---

def get_block(text: str, start_offset: int):
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

def parse_region_owners(p: Path) -> Dict[str, str]:
    out, cur = {}, None
    with open(p, encoding="utf-8", errors="ignore") as f:
        lines = f.readlines()
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        if (m := re.match(r"^faction\s+([a-zA-Z0-9_]+)", line)):
            cur = m.group(1).lower()
        if line.startswith("settlement"):
            r, j = None, i + 1
            while j < len(lines) and not lines[j].strip().startswith(("settlement", "faction ")):
                if (rm := re.match(r"region\s+([a-zA-Z0-9_]+)", lines[j].strip())):
                    r = rm.group(1)
                if lines[j].strip() == "}":
                    break
                j += 1
            if r and cur:
                out[r] = cur
        i += 1
    return out

def parse_edb_building_levels_with_settlement_min(filename: Path, managed_chains: Set[str]):
    with open(filename, 'r', encoding='utf-8', errors='ignore') as f:
        full_content = f.read()

    buildings = {}
    building_matches = re.finditer(r'^\s*building\s+(\w+)', full_content, re.MULTILINE)

    for match in building_matches:
        building_name = match.group(1)
        if building_name not in managed_chains:
            continue

        full_building_text, _ = get_block(full_content, match.end())
        if not full_building_text:
            continue

        levels_match = re.search(r'levels\s+([^\n{]+)', full_building_text)
        if not levels_match:
            continue

        level_names = levels_match.group(1).strip().split()
        levels_block_content, _ = get_block(full_building_text, levels_match.end())
        if not levels_block_content:
            continue

        levels_info = []
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
                if block is None:
                    break
                level_def_content = block
                search_for_block_start = next_pos

            settlement_min = None
            s_match = re.search(r'settlement_min\s+(\w+)', level_def_content)
            if s_match:
                settlement_min = s_match.group(1)

            levels_info.append({'level': level_name, 'settlement_min': settlement_min})

        if levels_info:
            buildings[building_name] = levels_info

    return buildings

def parse_region_resource_quantities(p: Path) -> Tuple[Dict[str, int], Dict[str, List[Tuple[str, int]]]]:
    max_qty_by_region: Dict[str, int] = {}
    details_by_region: Dict[str, List[Tuple[str, int]]] = {}
    resource_re = re.compile(
        r'^\s*resource\s+([A-Za-z0-9_]+)\s*,\s*([0-9]+)\s*,\s*-?[0-9]+\s*,\s*-?[0-9]+\s*;\s*([^\r\n]+)\s*$'
    )
    try:
        with open(p, encoding='utf-8', errors='ignore') as f:
            for line in f:
                m = resource_re.match(line)
                if not m:
                    continue
                res_name = m.group(1)
                qty = int(m.group(2))
                region = m.group(3).strip()
                details_by_region.setdefault(region, []).append((res_name, qty))
                prev = max_qty_by_region.get(region, 0)
                if qty > prev:
                    max_qty_by_region[region] = qty
    except Exception as e:
        logging.getLogger("settlement_logger").error(f"Failed to parse resources from {p}: {e}")
    return max_qty_by_region, details_by_region

# --- Encoding/newline helpers ---

def detect_encoding_and_newlines(path: Path) -> Tuple[str, bool, str, bytes]:
    raw = path.read_bytes()
    has_bom = False
    enc = 'cp1252'

    if raw.startswith(b'\xef\xbb\xbf'):
        enc = 'utf-8-sig'
        has_bom = True
    elif raw.startswith(b'\xff\xfe'):
        enc = 'utf-16-le'
        has_bom = True
    elif raw.startswith(b'\xfe\xff'):
        enc = 'utf-16-be'
        has_bom = True
    else:
        try:
            raw.decode('utf-8')
            enc = 'utf-8'
        except UnicodeDecodeError:
            enc = 'cp1252'

    if b'\r\n' in raw:
        nl = '\r\n'
    elif b'\r' in raw and b'\n' not in raw:
        nl = '\r'
    else:
        nl = '\n'

    return enc, has_bom, nl, raw

def decode_text(raw: bytes, enc: str) -> str:
    if enc in ('utf-16-le', 'utf-16-be'):
        try:
            return raw.decode('utf-16')
        except UnicodeDecodeError:
            return raw.decode(enc, errors='ignore')
    return raw.decode(enc, errors='ignore')

def encode_text(s: str, enc: str, ensure_bom: bool) -> bytes:
    if enc == 'utf-8-sig':
        return s.encode('utf-8-sig')
    if enc == 'utf-8':
        return (('\ufeff' if ensure_bom else '') + s).encode('utf-8') if ensure_bom else s.encode('utf-8')
    if enc in ('utf-16-le', 'utf-16-be'):
        return s.encode('utf-16')
    return s.encode(enc, errors='replace')

def normalize_to_unix_newlines(text: str) -> str:
    return text.replace('\r\n', '\n').replace('\r', '\n')

def restore_newlines(text_with_unix_newlines: str, newline_style: str) -> str:
    if newline_style == '\n':
        return text_with_unix_newlines
    return text_with_unix_newlines.replace('\n', newline_style)

# --- Main processor ---

class SettlementProcessor:
    def __init__(self, run_out=None):
        if run_out:
            self.out_dir = Path(run_out)
            self.out_dir.mkdir(parents=True, exist_ok=True)
            self.ts = ""
        else:
            self.out_dir, self.ts = create_output_dir("settlement_processor")

        logfile_path = self.out_dir / "debug_log.txt"
        global logger
        logger = setup_logger(logfile_path)

        print(f"=== Settlement Processor ===")
        print(f"Output: {self.out_dir}")

        self.MANAGED_CHAINS = {"defenses", "hinterland_roads", "market", "capital_treasury"}

        self.changelog: List[str] = []
        self.early_errors: List[str] = []
        self.error_log_func = self._buffer_log
        self.decision_log: List[str] = []
        self.debug_logs: List[str] = []
        self.per_line_log: List[str] = []
        self.building_assignments: Dict[str, List[str]] = {}
        self.settlements_changed: Dict[str, List[str]] = {}
        self.towns_forced_trader: List[str] = []

        regions_fp = CONFIG_DIR / "descr_regions.txt"
        edb_fp = CONFIG_DIR / "export_descr_buildings.txt"
        self.descr_strat_fp = CONFIG_DIR / "descr_strat.txt"

        logger.info("--- Starting Data Loading ---")
        logger.info(f"Managing building chains: {self.MANAGED_CHAINS}")

        self.regions_data = self._load_regions_data(regions_fp)
        self.building_levels_with_mins = parse_edb_building_levels_with_settlement_min(edb_fp, self.MANAGED_CHAINS)
        if not self.building_levels_with_mins:
            logger.critical(f"FATAL: Could not parse any managed building data from {edb_fp}. Exiting.")
            sys.exit(1)

        self.region_owners = parse_region_owners(self.descr_strat_fp)
        self.max_qty_by_region, self.resource_details_by_region = parse_region_resource_quantities(self.descr_strat_fp)
        logger.info(f"[RESOURCES] Regions with parsed resources: {len(self.resource_details_by_region)}")
        logger.info("--- Data Loading Complete ---")

    def _buffer_log(self, msg: str):
        self.early_errors.append(msg)
        logger.warning(msg)

    def _flush_early_errors_to(self, p: Path):
        if self.early_errors:
            try:
                with open(p, "a", encoding="utf-8") as f:
                    for m in self.early_errors:
                        f.write(m + "\n")
            except Exception as e:
                logger.error(f"Error writing early errors: {e}")
            self.early_errors.clear()

    def _load_regions_data(self, p: Path) -> Dict[str, Dict[str, Any]]:
        if not p.is_file():
            self._buffer_log(f"ERROR: Regions file not found at {p}")
            return {}

        logger.info("--- Loading Regions Data ---")
        with open(p, "r", encoding="utf-8", errors="ignore") as f:
            content = f.read()

        regions: Dict[str, Dict[str, Any]] = {}
        for block in re.split(r'\n\s*\n', content):
            lines = [l.strip() for l in block.split('\n') if l.strip()]
            if lines and not lines[0].startswith(";") and len(lines) >= 6:
                region_name = lines[0]
                capital = lines[1]
                hidden_resources = {r.strip() for r in lines[5].split(',') if r.strip()}
                regions[region_name] = {"capital": capital, "hidden_resources": hidden_resources}
                logger.info(f"[REGIONS] Loaded region: {region_name}, capital: {capital}, HR count: {len(hidden_resources)}")

        logger.info(f"[REGIONS] Total regions loaded: {len(regions)}")
        logger.info("--- Regions Data Loading Complete ---")
        return regions

    def _extract_from_block(self, lines: List[str], keyword: str) -> Optional[str]:
        return next((p[1].replace(',', '') for l in lines if l.strip().startswith(keyword) and len(p := l.strip().split()) > 1), None)

    def choose_building_level_for_settlement(self, building_levels, settlement_tier, debug_log):
        allowed = []
        for lvl in building_levels:
            min_size = lvl.get('settlement_min', None)
            if min_size is None:
                continue
            min_tier = LEVEL_TO_TIER.get(min_size, 1)
            if settlement_tier >= (min_tier + 1):
                allowed.append(lvl['level'])
                debug_log.append(f"      - Level '{lvl['level']}' (min: {min_size}, tier {min_tier}) ALLOWED for tier {settlement_tier} (bump)")
            else:
                debug_log.append(f"      - Level '{lvl['level']}' (min: {min_size}, tier {min_tier}) BLOCKED for tier {settlement_tier} (bump)")

        if not allowed:
            debug_log.append(f"      - No allowed levels for settlement tier {settlement_tier} under bump rule")
            return None

        selected = allowed[-1]
        debug_log.append(f"      - Selected highest allowed level (bump): '{selected}'")
        return selected

    def _assign_chain(self, building_map: Dict[str, str], assigned_chains: Set[str], chain_name: str, tier: int, debug_log: List[str]):
        if chain_name not in self.building_levels_with_mins:
            debug_log.append(f"    - Chain '{chain_name}' not found in building database")
            return False

        building_levels = self.building_levels_with_mins[chain_name]
        debug_log.append(f"    - Chain '{chain_name}': Available levels: {[lvl['level'] for lvl in building_levels]}")

        selected_level = self.choose_building_level_for_settlement(building_levels, tier, debug_log)
        if not selected_level:
            debug_log.append(f"    - Chain '{chain_name}': No valid level for tier {tier} under bump rule")
            return False

        building_map[chain_name] = selected_level
        assigned_chains.add(chain_name)
        debug_log.append(f"    - Chain '{chain_name}': Assigned level '{selected_level}' for tier {tier}")
        return True

    def _dedupe_by_chain_preserve_last(self, buildings: List[str], debug_log: List[str]) -> List[str]:
        if not buildings:
            return buildings
        last_idx: Dict[str, int] = {}
        for i, b in enumerate(buildings):
            chain = b.split()[0] if b else ""
            last_idx[chain] = i
        out: List[str] = []
        seen: Set[str] = set()
        for i, b in enumerate(buildings):
            chain = b.split()[0] if b else ""
            if chain in seen:
                continue
            if i == last_idx[chain]:
                out.append(b)
                seen.add(chain)
            else:
                debug_log.append(f"    - DEDUPE: Dropping earlier '{b}' in favor of later '{buildings[last_idx[chain]]}'")
        return out

    def _apply_building_rules(self, orig_buildings: List[str], level: str, name: str, hidden_resources: Set[str], owner_faction: str) -> Tuple[List[str], List[str]]:
        tier = LEVEL_TO_TIER.get(level, 1)
        region = next((r for r, info in self.regions_data.items() if info.get("capital", "") == name), name)
        region_resources = self.resource_details_by_region.get(region, [])
        region_max_qty = self.max_qty_by_region.get(region, 0)

        debug_log = [
            f"--- Building Rules for {name} ({region}) ---",
            f"Settlement Level: {level} (Tier: {tier})",
            f"Hidden Resources (descr_regions): {hidden_resources}",
            f"Owner Faction: {owner_faction}",
            f"Region Resources (descr_strat): {region_resources} | max_qty={region_max_qty}"
        ]

        result_buildings: List[str] = []
        assigned_chains: Set[str] = set()

        debug_log.append("\n  Processing Original Buildings:")
        for building in orig_buildings:
            building_chain = building.split()[0] if building else ""
            if building_chain and building_chain not in self.MANAGED_CHAINS and not building_chain.startswith("temple_complex_"):
                result_buildings.append(building)
                debug_log.append(f"    - Keeping: {building}")

        building_map: Dict[str, str] = {}
        debug_log.append("\n  Assigning Managed Building Chains (bump logic each run):")

        # Defenses (walls): assigned directly by tier (no size bump). Regular cap
        # is MAX_WALL_TIER (stone_wall); per-region exceptions override that and
        # the no-defenses list. A wall never exceeds the settlement's own tier.
        region_key = region.lower()
        if region_key in WALL_TIER_EXCEPTIONS:
            wall_tier = min(tier, WALL_TIER_EXCEPTIONS[region_key])
            if wall_tier >= 1:
                building_map["defenses"] = DEFENSE_LEVELS[wall_tier]; assigned_chains.add("defenses")
            debug_log.append(f"    - Defenses: {region} exception cap {WALL_TIER_EXCEPTIONS[region_key]} -> {DEFENSE_LEVELS.get(wall_tier)}")
        elif region_key in NO_DEFENSES_REGIONS:
            debug_log.append(f"    - Defenses: Skipped for {region} (in NO_DEFENSES_REGIONS)")
        else:
            # Regular walls get the size bump: one tier below settlement size,
            # capped at MAX_WALL_TIER. So town -> none, large_town -> wooden_pallisade,
            # city -> wooden_wall, large_city/huge_city -> stone_wall (tier 3).
            wall_tier = min(tier - 1, MAX_WALL_TIER)
            if wall_tier >= 1:
                building_map["defenses"] = DEFENSE_LEVELS[wall_tier]; assigned_chains.add("defenses")
                debug_log.append(f"    - Defenses: bump tier {tier}->{wall_tier} -> {DEFENSE_LEVELS[wall_tier]} (cap {MAX_WALL_TIER})")
            else:
                debug_log.append(f"    - Defenses: tier {tier} too small after bump -> none")

        # Roads — keep the size-based bump as the BASE level, then modify it:
        #   Roma always -> highways; listed terrains cap at tier 1 (roads);
        #   highways (tier 3) ALSO requires the region's total resource amount to
        #   exceed ROAD_HIGHWAY_MIN_TOTAL (settlement size still gates it via the
        #   bump), else it drops to paved_roads.
        self._assign_chain(building_map, assigned_chains, "hinterland_roads", tier, debug_log)
        base_road = building_map.get("hinterland_roads")
        base_rt = ROAD_TIER_BY_LEVEL.get(base_road, 0)
        road_total = sum(q for (_r, q) in region_resources)
        if region_key in ROADS_ALWAYS_HIGHWAY or name.strip().lower() in ROADS_ALWAYS_HIGHWAY:
            building_map["hinterland_roads"] = ROAD_LEVELS[3]; assigned_chains.add("hinterland_roads")
            debug_log.append(f"    - Roads: {region} exception -> highways")
        elif base_rt == 0:
            debug_log.append("    - Roads: settlement too small for a road (bump)")
        elif (hidden_resources & ROAD_TERRAIN_CAP) and base_rt > 1:
            building_map["hinterland_roads"] = ROAD_LEVELS[1]
            debug_log.append(f"    - Roads: terrain {hidden_resources & ROAD_TERRAIN_CAP} caps {base_road} -> roads")
        elif base_rt >= 3 and road_total <= ROAD_HIGHWAY_MIN_TOTAL:
            building_map["hinterland_roads"] = ROAD_LEVELS[2]
            debug_log.append(f"    - Roads: highways needs resource_total>{ROAD_HIGHWAY_MIN_TOTAL} (have {road_total:g}) -> paved_roads")
        else:
            debug_log.append(f"    - Roads: {base_road} (bump; resource_total={road_total:g})")

        self._assign_chain(building_map, assigned_chains, "market", tier, debug_log)

        try:
            # Filter resources for trader override
            if TRADER_OVERRIDE_RESOURCES:
                qualifying_resources = [(r, q) for (r, q) in region_resources if r in TRADER_OVERRIDE_RESOURCES and q >= TRADER_OVERRIDE_QTY]
            else:
                qualifying_resources = [(r, q) for (r, q) in region_resources if q >= TRADER_OVERRIDE_QTY]

            if level.lower() == "town" and qualifying_resources:
                market_levels = self.building_levels_with_mins.get("market", [])
                market_level_names = [lvl["level"] for lvl in market_levels]
                if "trader" in market_level_names:
                    prev = building_map.get("market")
                    building_map["market"] = "trader"
                    high_q = qualifying_resources
                    if name not in self.towns_forced_trader:
                        self.towns_forced_trader.append(name)
                    if prev and prev != "trader":
                        debug_log.append(f"    - OVERRIDE: Town with high-qty resources {high_q} -> forcing market 'trader' (was '{prev}')")
                    else:
                        debug_log.append(f"    - OVERRIDE: Town with high-qty resources {high_q} -> forcing market 'trader'")
        except Exception as e:
            debug_log.append(f"    - WARNING: Exception while applying market override rule: {e}")

        existing_temple_chain = next((c for b in orig_buildings if (c := (b.split()[0] if b else "")).startswith("temple_complex_")), None)
        if existing_temple_chain:
            debug_log.append(f"    - Found existing temple: {existing_temple_chain}")
            for building in orig_buildings:
                if building and building.split()[0] == existing_temple_chain:
                    result_buildings.append(building)
                    debug_log.append(f"    - Keeping original temple: {building}")
                    break
        else:
            debug_log.append("    - No existing temple found")

        if "capital_treasury" in [b.split()[0] for b in orig_buildings if b]:
            # Assigned directly (no bump) and capped at MAX_TREASURY_TIER so it's
            # actually built rather than dropped by the bump rule.
            t_tier = min(tier, MAX_TREASURY_TIER)
            if t_tier >= 1:
                building_map["capital_treasury"] = TREASURY_LEVELS[t_tier]
                assigned_chains.add("capital_treasury")
                debug_log.append(f"    - Treasury: tier {t_tier} -> {TREASURY_LEVELS[t_tier]} (cap {MAX_TREASURY_TIER})")
        else:
            debug_log.append("    - No existing capital_treasury found")

        debug_log.append("\n  Final Managed Building Assignments:")
        for chain, level_name in building_map.items():
            if chain and level_name:
                result_buildings.append(f"{chain} {level_name}")
                debug_log.append(f"    + Added: {chain} {level_name}")

        before = len(result_buildings)
        result_buildings = self._dedupe_by_chain_preserve_last(result_buildings, debug_log)
        after = len(result_buildings)
        if after != before:
            debug_log.append(f"    - DEDUPE: Reduced buildings from {before} to {after} (one per chain)")

        debug_log.append(f"\n  Final Building Count: {len(result_buildings)}")
        return sorted(result_buildings), debug_log

    def _log_changelog(self, name: str, region: str, level: str, orig: List[str], new: List[str]):
        orig_set, new_set = set(orig), set(new)
        if orig_set == new_set:
            return False

        rm, ad = sorted(list(orig_set - new_set)), sorted(list(new_set - orig_set))
        if rm and ad:
            self.changelog.append(f"{name} ({region}): Changed from {', '.join(rm)} to {', '.join(ad)}")
        elif rm:
            self.changelog.append(f"{name} ({region}): Removed {', '.join(rm)}")
        elif ad:
            self.changelog.append(f"{name} ({region}): Added {', '.join(ad)}")
        return True

    def process_settlement_block(self, block: List[str]) -> Tuple[List[str], bool]:
        region_name = self._extract_from_block(block, 'region')
        level = self._extract_from_block(block, 'level') or 'town'

        debug_entry = [f"--- Processing Settlement Block ---"]
        debug_entry.append(f"Region: {region_name}, Level: {level}")

        region_info = self.regions_data.get(region_name)
        if not region_info:
            error_msg = f"ERROR: Region '{region_name}' not found in regions data."
            self._buffer_log(error_msg)
            debug_entry.append(error_msg)
            self.debug_logs.append("\n".join(debug_entry))
            return block, False

        name = region_info.get("capital")
        hidden_resources = region_info.get("hidden_resources", set())
        owner_faction = self.region_owners.get(region_name, "")

        debug_entry.append(f"Capital: {name}")
        debug_entry.append(f"Hidden Resources: {hidden_resources}")
        debug_entry.append(f"Owner Faction: {owner_faction}")

        if name in EXCLUDE_SETTLEMENTS:
            debug_entry.append(f"SKIPPED: {name} is in excluded settlements")
            self.debug_logs.append("\n".join(debug_entry))
            return block, False

        ob: List[str] = []
        non_building_lines: List[str] = []
        in_building_block = False
        for line in block:
            s = line.strip()
            if s.startswith("building"):
                in_building_block = True
            elif in_building_block and s.startswith("type"):
                ob.append(" ".join(s.split()[1:]))
            elif not in_building_block:
                non_building_lines.append(line)
            if in_building_block and '}' in s:
                in_building_block = False

        debug_entry.append(f"Original Buildings: {ob}")

        try:
            new_buildings, building_debug = self._apply_building_rules(ob, level, name, hidden_resources, owner_faction)
            debug_entry.extend(building_debug)
        except Exception as e:
            error_msg = f"ERROR: Exception in applying building rules for settlement '{name}' ({region_name}): {e}"
            self._buffer_log(error_msg)
            debug_entry.append(error_msg)
            self.debug_logs.append("\n".join(debug_entry))
            return block, False

        changed = self._log_changelog(name, region_name, level, ob, new_buildings)

        debug_entry.append(f"New Buildings: {new_buildings}")
        debug_entry.append(f"Buildings Changed: {changed}")

        tier = LEVEL_TO_TIER.get(level, 1)
        decision_entry = [
            f"--- Settlement: {name} ({region_name}) ---",
            f"Level: {level} (tier {tier})"
        ]

        assigned_buildings = []
        for building in new_buildings:
            chain = building.split()[0]
            if chain in self.MANAGED_CHAINS:
                assigned_buildings.append(building)

        if assigned_buildings:
            self.building_assignments[name] = assigned_buildings
            decision_entry.append(f"Assigned buildings: {', '.join(assigned_buildings)}")
            if changed:
                self.settlements_changed[name] = assigned_buildings
        else:
            decision_entry.append("No managed buildings assigned.")

        self.decision_log.append("\n".join(decision_entry))

        if not changed:
            # Preserve original ordering when nothing was added or removed.
            self.debug_logs.append("\n".join(debug_entry))
            return block, False

        rebuilt = [l for l in non_building_lines if '}' not in l.strip()]

        for b_str in new_buildings:
            rebuilt.extend([
                "\tbuilding\n",
                "\t{\n",
                f"\t\ttype {b_str}\n",
                "\t}\n"
            ])

        rebuilt.append("}\n")

        debug_entry.append("Block successfully rebuilt")
        self.debug_logs.append("\n".join(debug_entry))

        return rebuilt, changed

    def process_file(self, input_file: str, in_place: bool = False):
        logger.info(f"--- Starting File Processing: {input_file} ---")

        output_files = get_standard_output_files(self.out_dir, "settlement")

        error_log_filepath = self.out_dir / "error_log.txt"
        self._flush_early_errors_to(error_log_filepath)
        self.error_log_func = lambda msg: Path(error_log_filepath).open("a", encoding="utf-8").write(msg + "\n")

        enc, had_bom, newline_style, raw = detect_encoding_and_newlines(Path(input_file))
        logger.info(f"[I/O] Detected encoding: {enc}, BOM: {had_bom}, newline: {repr(newline_style)}")
        original_text = decode_text(raw, enc)
        original_text_unix = normalize_to_unix_newlines(original_text)
        original_lines = original_text_unix.split('\n')

        output_lines: List[str] = []
        settlements_processed = 0
        settlements_changed = 0

        logger.info(f"Processing {len(original_lines)} lines from input file (normalized)")

        i = 0
        while i < len(original_lines):
            current_line_content = original_lines[i].strip()

            if current_line_content.startswith("settlement"):
                settlements_processed += 1
                logger.info(f"[SETTLEMENT_{settlements_processed}] Processing settlement starting at normalized line {i}")

                start_index, brace_count, found_first_brace, j = i, 0, False, i
                matched_block_ok = False
                while j < len(original_lines):
                    line = original_lines[j]
                    if '{' in line:
                        found_first_brace = True
                        brace_count += line.count('{')
                    if '}' in line:
                        brace_count -= line.count('}')
                    if found_first_brace and brace_count == 0:
                        orig_block = [l + '\n' for l in original_lines[start_index:j+1]]
                        try:
                            processed_block, was_changed = self.process_settlement_block(orig_block)
                            matched_block_ok = True
                        except Exception as e:
                            logger.error(f"Exception during settlement block processing at normalized lines {start_index}-{j}: {e}")
                            processed_block, was_changed = (orig_block, False)
                            matched_block_ok = True

                        if was_changed:
                            settlements_changed += 1
                            logger.info(f"[SETTLEMENT_{settlements_processed}] CHANGED - Applied new building rules")
                        else:
                            logger.info(f"[SETTLEMENT_{settlements_processed}] UNCHANGED - No modifications needed")

                        output_lines.extend([l.rstrip('\n') for l in processed_block])
                        i = j + 1
                        break
                    j += 1
                if not matched_block_ok:
                    logger.error(f"Unclosed settlement block start at normalized line {start_index}. Copying remainder unchanged.")
                    output_lines.extend(original_lines[i:])
                    i = len(original_lines)
            else:
                output_lines.append(original_lines[i])
                i += 1

        output_text_unix = "\n".join(output_lines)
        final_text = restore_newlines(output_text_unix, newline_style)
        final_bytes = encode_text(final_text, enc, ensure_bom=(enc in ('utf-8',) and had_bom))

        input_path = Path(input_file)
        processed_out_path = self.out_dir / input_path.name

        logger.info("--- Writing Output Files ---")
        processed_out_path.write_bytes(final_bytes)
        logger.info(f"[I/O] Wrote processed file: {processed_out_path}")

        in_place_done = False
        backup_path = None
        if in_place:
            try:
                ts = datetime.now().strftime("%Y%m%d_%H%M%S")
                backup_path = input_path.with_name(f"{input_path.name}.bak.{ts}")
                backup_path.write_bytes(raw)
                input_path.write_bytes(final_bytes)
                in_place_done = True
                logger.info(f"[IN-PLACE] Backed up original to: {backup_path}")
                logger.info(f"[IN-PLACE] Overwrote input file: {input_path}")
            except Exception as e:
                logger.error(f"[IN-PLACE] Failed to overwrite input file: {e}")

        all_buildings = set()
        for buildings in self.building_assignments.values():
            all_buildings.update(buildings)
        write_buildings_file(output_files["buildings"], all_buildings)

        settlements_with_buildings = {s: ", ".join(b) for s, b in self.building_assignments.items()}
        write_settlements_file(output_files["settlements"], settlements_with_buildings, self.regions_data)
        write_decision_file(output_files["decision"], self.decision_log)
        write_changelog_file(output_files["changelog"], self.changelog)
        write_ties_file(output_files["ties"], [])

        try:
            detailed_debug_path = self.out_dir / "detailed_debug.txt"
            with open(detailed_debug_path, "w", encoding="utf-8") as f:
                f.write("\n\n".join(self.debug_logs))
                f.write("\n\n--- Summary ---\n")
                f.write(f"Towns forced to trader ({len(self.towns_forced_trader)}): {', '.join(sorted(self.towns_forced_trader))}\n")
            logger.info(f"Wrote detailed debug to: {detailed_debug_path}")
        except Exception as e:
            logger.error(f"Failed to write detailed debug: {e}")

        print(f"\n--- Processing Summary ---")
        print(f"Settlements Processed:  {settlements_processed}")
        print(f"Settlements Changed:    {settlements_changed}")
        print(f"Settlements Unchanged:  {settlements_processed - settlements_changed}")
        print(f"Processed file:         {processed_out_path}")
        if in_place_done:
            print(f"In-place overwrite complete. Backup: {backup_path}")
        print(f"Buildings output:       {output_files['buildings']}")
        print(f"Settlements output:     {output_files['settlements']}")
        print(f"Decision log:           {output_files['decision']}")
        if self.changelog:
            print(f"Changelog:              {output_files['changelog']}")
        print(f"Towns forced to 'trader': {len(self.towns_forced_trader)} -> {', '.join(sorted(self.towns_forced_trader))}")

        logger.info(f"--- File Processing Complete ---")
        logger.info(f"Total settlements processed: {settlements_processed}")
        logger.info(f"Total settlements changed: {settlements_changed}")
        logger.info(f"Towns forced to trader: {len(self.towns_forced_trader)}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Process descr_strat settlements and assign buildings.")
    parser.add_argument("descr_strat", nargs="?", default=None, help="Path to descr_strat.txt (default: config/descr_strat.txt)")
    parser.add_argument("-i", "--in-place", action="store_true", help="Overwrite the input descr_strat.txt in place (creates a timestamped .bak)")
    args = parser.parse_args()

    strat_file = Path(args.descr_strat) if args.descr_strat else CONFIG_DIR / "descr_strat.txt"
    if not strat_file.is_file():
        print(f"ERROR: Input file not found at {strat_file}")
        sys.exit(1)

    sp = SettlementProcessor()
    sp.process_file(str(strat_file), in_place=args.in_place)
