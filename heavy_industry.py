#!/usr/bin/env python3
"""
heavy_industry.py
"""

import sys
import re
from pathlib import Path
from datetime import datetime
from collections import defaultdict

# --- CONFIG ---
BASE_DIR = Path(__file__).parent
CONFIG_DIR = BASE_DIR / "config"
OUTPUT_DIR = BASE_DIR / "processed_output"

STRAT_FILE = CONFIG_DIR / "descr_strat.txt"
REGIONS_FILE = CONFIG_DIR / "descr_regions.txt"
EDB_FILE = CONFIG_DIR / "export_descr_buildings.txt"

EXCLUDE_SETTLEMENTS = set()

LEVEL_TO_TIER = {
    "village": 0, "town": 1, "large_town": 2, "minor_city": 3,
    "city": 3, "large_city": 4, "huge_city": 5
}

SETTLEMENT_LEVEL_ORDER = ["town", "large_town", "city", "large_city", "huge_city"]

# Per-building resource weights. A building's score = max over its resources of
# (resource_amount × weight); its input resources are simply the dict keys.
BUILDING_RESOURCE_WEIGHTS = {
    "smith":                {"iron": 7, "copper": 4, "coal": 6, "livestock": 3, "flax": 3, "timber": 1},
    "mines":                {"gold": 9, "silver": 8, "copper": 6, "lead": 4, "tin": 6, "iron": 5, "slave_trade": 2},
    "purple_dye_production": {"purple_dye": 8},
    "marble_production":     {"marble": 7, "slave_trade": 2},
    "jewelry":              {"gold": 8, "silver": 7, "gemstones": 8, "elephants": 3, "glass": 3, "amber": 4},
    "artisans":             {"copper": 6, "iron": 5, "tin": 6, "lead": 5, "timber": 1},
    "stone_quarry":         {"stone": 5, "slave_trade": 2},
    "sulphur_industry":     {"sulphur": 5, "slave_trade": 2, "grain": 1},
    "pitch_gathering":      {"pitch": 6, "hemp": 1, "timber": 1},
    "salt_production":      {"salt": 6, "slave_trade": 2, "fish": 2, "livestock": 1},
}
HEAVY_IND_BUILDINGS = set(BUILDING_RESOURCE_WEIGHTS)

# A building can only be BUILT if at least one of its enabling resources is
# present. Other weighted resources only contribute to the selection score.
ENABLING_RESOURCES = {
    "smith":                {"iron", "copper", "coal", "flax", "livestock"},
    "mines":                {"gold", "silver", "copper", "lead", "tin", "iron", "coal"},
    "purple_dye_production": {"purple_dye"},
    "marble_production":     {"marble"},
    "jewelry":              {"gold", "silver", "gemstones"},
    "artisans":             {"copper", "iron", "tin", "lead"},
    "stone_quarry":         {"stone"},
    "sulphur_industry":     {"sulphur"},
    "pitch_gathering":      {"pitch"},
    "salt_production":      {"salt"},
}

# Luxury rule: a settlement with glass/amber/elephants builds jewelry instead of
# raw mining (gold/silver otherwise make `mines` win the tie).
LUXURY_RESOURCES = ("glass", "amber", "elephants")
JEWELRY_OVER_MINING = {"mines"}

EXPLICIT_HEAVY_IND_TIE_BREAKER_ORDER = [
    "smith", "mines", "purple_dye_production", "marble_production",
    "artisans", "salt_production", "stone_quarry", "pitch_gathering",
]

class HeavyIndustryProcessor:
    def __init__(self):
        self.region_map = {}
        self.resources_by_region = {}
        self.building_chains = {}
        self.region_to_city = {}
        self.settlements_heavy = {}
        self.changelog = []
        self.tie_log = []
        self.debug_logs = []

    def get_block(self, text, start_offset):
        try:
            first_brace = text.index('{', start_offset)
        except ValueError: return None, -1
        brace_depth = 1
        for i in range(first_brace + 1, len(text)):
            if text[i] == '{': brace_depth += 1
            elif text[i] == '}': brace_depth -= 1
            if brace_depth == 0: return text[first_brace + 1: i], i + 1
        return None, -1

    def bump_settlement_level(self, level):
        if level not in SETTLEMENT_LEVEL_ORDER: return level
        idx = SETTLEMENT_LEVEL_ORDER.index(level)
        return SETTLEMENT_LEVEL_ORDER[min(idx + 1, len(SETTLEMENT_LEVEL_ORDER) - 1)]

    def parse_edb_levels_with_settlement_min(self):
        if not EDB_FILE.exists(): return {}
        with open(EDB_FILE, 'r', encoding='utf-8', errors='ignore') as f:
            full_content = f.read()
        chains = {}
        start_marker = ";================= EXPLOITATION BUILDINGS ==================="
        start_pos = full_content.find(start_marker)
        content_to_parse = full_content[start_pos:] if start_pos != -1 else full_content
        matches = re.finditer(r'^\s*building\s+(\w+)', content_to_parse, re.MULTILINE)
        for m in matches:
            b_name = m.group(1)
            txt, _ = self.get_block(content_to_parse, m.end())
            if not txt: continue
            levels_m = re.search(r'levels\s+([\w\s+]+)', txt)
            if not levels_m: continue
            l_names = levels_m.group(1).strip().split()
            l_block, _ = self.get_block(txt, levels_m.end())
            if not l_block: continue
            levels_info, last_min = [], None
            for l_name in l_names:
                chunk_m = re.search(r'(?m)^\s*' + re.escape(l_name) + r'\s+requires', l_block)
                if not chunk_m: continue
                s_match = re.search(r'settlement_min\s+(\w+)', l_block[chunk_m.start():])
                edb_min = s_match.group(1) if s_match else last_min
                if not edb_min: break
                last_min = edb_min
                s_min = self.bump_settlement_level(edb_min) if b_name in HEAVY_IND_BUILDINGS else edb_min
                levels_info.append({'level': l_name, 'settlement_min': s_min})
            if levels_info: chains[b_name] = levels_info
        return chains

    def load_regions_data(self):
        if not REGIONS_FILE.exists(): return
        content = REGIONS_FILE.read_text(encoding='utf-8')
        curr = None
        for line in content.splitlines():
            line = line.split(';')[0].strip()
            if not line: continue
            if not line.startswith(('\t', ' ')):
                curr = line
                self.region_map[curr] = {"capital": None}
            elif curr and "capital" not in self.region_map[curr]:
                self.region_map[curr]["capital"] = line
                self.region_to_city[curr] = line

    def parse_resources_by_region(self, strat_text):
        pat = re.compile(r'resource\s+([\w_-]+),\s*([\d.]+),\s*\d+,\s*\d+\s*;\s*([\w_&-]+)', re.IGNORECASE)
        for m in pat.finditer(strat_text):
            res, amt, reg = m.groups()
            if reg not in self.resources_by_region: self.resources_by_region[reg] = {}
            self.resources_by_region[reg][res.lower()] = self.resources_by_region[reg].get(res.lower(), 0) + float(amt)

    def select_building(self, res_dict, tier, chains):
        scores = {}
        for b, weights in BUILDING_RESOURCE_WEIGHTS.items():
            if not any(res_dict.get(r, 0) > 0 for r in ENABLING_RESOURCES.get(b, ())):
                continue  # no enabling resource -> building can't be built
            lvls = chains.get(b, [])
            if not lvls or tier < min(LEVEL_TO_TIER.get(l['settlement_min'], 99) for l in lvls): continue
            val = max([res_dict.get(r, 0) * w for r, w in weights.items()] + [0])
            if val >= 10: scores[b] = val
        if not scores: return None, None, [], {}
        m_val = max(scores.values())
        tied = [b for b, v in scores.items() if v == m_val]
        best_b = next((b for b in EXPLICIT_HEAVY_IND_TIE_BREAKER_ORDER if b in tied), tied[0])
        # Luxury override: a settlement with glass/amber/elephants builds jewelry
        # instead of raw mining (gold/silver otherwise make `mines` win the tie).
        if (best_b in JEWELRY_OVER_MINING and any(res_dict.get(r, 0) > 0 for r in LUXURY_RESOURCES)
                and any(res_dict.get(r, 0) > 0 for r in ENABLING_RESOURCES["jewelry"])):
            jl = chains.get("jewelry", [])
            if jl and tier >= min(LEVEL_TO_TIER.get(l['settlement_min'], 99) for l in jl):
                best_b = "jewelry"
        allowed = [l['level'] for l in chains[best_b] if tier >= LEVEL_TO_TIER.get(l['settlement_min'], 99)]
        # Never select a '...supply' level — drop to the highest non-supply level.
        non_supply = [lv for lv in allowed if 'supply' not in lv.lower()]
        chosen = non_supply[-1] if non_supply else None
        return best_b, chosen, tied, scores

    def run(self, run_strat=None, run_out=None):
        _strat = Path(run_strat) if run_strat else STRAT_FILE
        _out = Path(run_out) if run_out else OUTPUT_DIR
        if not _strat.exists():
            print(f"Error: {_strat} not found")
            return
        content = _strat.read_text(encoding='utf-8')
        self.load_regions_data()
        self.parse_resources_by_region(content)
        self.building_chains = self.parse_edb_levels_with_settlement_min()
        
        blocks, idx = [], 0
        while True:
            m = re.search(r'settlement\s*\{', content[idx:], re.IGNORECASE)
            if not m: break
            s_pos = idx + m.start()
            bc, found = 0, False
            for j in range(s_pos, len(content)):
                if content[j] == '{': bc += 1; found = True
                elif content[j] == '}': bc -= 1
                if found and bc == 0:
                    blocks.append((s_pos, j + 1))
                    idx = j + 1
                    break
            else: break

        rebuilt, last_end, decision_log = [], 0, []
        for start, end in blocks:
            rebuilt.append(content[last_end:start])
            lines = content[start:end].splitlines(keepends=True)
            reg, lvl = None, "town"
            for l in lines:
                if l.strip().startswith("region"): reg = re.match(r'region\s+([\w_&-]+)', l.strip()).group(1)
                if l.strip().startswith("level"): lvl = l.strip().split()[1]
            
            if reg:
                city = self.region_to_city.get(reg, reg)
                r_dict = self.resources_by_region.get(reg, {})
                tier = LEVEL_TO_TIER.get(lvl, 0)
                best_b, best_l, tied, scores = self.select_building(r_dict, tier, self.building_chains)
                
                log_entry = [f"--- Settlement: {city} ---", f"Level: {lvl}"]
                if best_b:
                    self.settlements_heavy[city] = f"{best_b} {best_l}"
                    log_entry.append(f"Assigned: {best_b} {best_l}")
                    self.changelog.append(f"{city}: Assigned {best_b} {best_l}")
                    if len(tied) > 1: self.tie_log.append(f"{city}: Tied {tied}, chose {best_b}")
                
                decision_log.append("\n".join(log_entry))
                
                clean_lines, in_b, buf = [], False, []
                for l in lines:
                    if l.strip().startswith("building"): in_b, buf = True, [l]
                    elif in_b:
                        buf.append(l)
                        if l.strip() == "}":
                            if not any(x.strip().startswith("type") and x.strip().split()[1] in HEAVY_IND_BUILDINGS.union({'mines'}) for x in buf):
                                clean_lines.extend(buf)
                            in_b = False
                    else: clean_lines.append(l)
                
                if best_b and best_l:
                    for i in range(len(clean_lines)-1, -1, -1):
                        if clean_lines[i].strip() == "}":
                            ind = re.match(r"^(\s*)", clean_lines[i-1]).group(1) if i > 0 else ""
                            clean_lines = clean_lines[:i] + [f"\n{ind}building\n{ind}{{\n{ind}\ttype {best_b} {best_l}\n{ind}}}\n"] + clean_lines[i:]
                            break
                rebuilt.append("".join(clean_lines))
            last_end = end
        
        rebuilt.append(content[last_end:])
        _out.mkdir(parents=True, exist_ok=True)
        (_out / "descr_strat.txt").write_text("".join(rebuilt), encoding='utf-8')

        # Only list buildings that are actually Heavy Industry types
        all_possible = [f"{b} {l['level']}" for b, lvls in self.building_chains.items() if b in HEAVY_IND_BUILDINGS for l in lvls]
        (_out / "heavy_industry_buildings.txt").write_text("\n".join(sorted(all_possible)), encoding='utf-8')

        (_out / "heavy_industry_settlements.txt").write_text("\n".join(f"{c}: {b}" for c, b in sorted(self.settlements_heavy.items())), encoding='utf-8')
        (_out / "heavy_industry_decisions.txt").write_text("\n\n".join(decision_log), encoding='utf-8')
        (_out / "heavy_industry_changelog.txt").write_text("\n".join(self.changelog), encoding='utf-8')
        (_out / "heavy_industry_debug.txt").write_text("\n".join(self.debug_logs), encoding='utf-8')
        if self.tie_log: (_out / "heavy_industry_ties.txt").write_text("\n".join(self.tie_log), encoding='utf-8')

        print(f"Success. {len(self.settlements_heavy)} settlements updated. Output in {_out}")

if __name__ == "__main__":
    HeavyIndustryProcessor().run()