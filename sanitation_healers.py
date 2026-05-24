import sys, re, os
from pathlib import Path

# --- CONFIG ---
BASE_DIR = Path(__file__).parent
CONFIG_DIR = BASE_DIR / "config"
OUTPUT_DIR = BASE_DIR / "processed_output"
STRAT_FILE = CONFIG_DIR / "descr_strat.txt"
REGIONS_FILE = CONFIG_DIR / "descr_regions.txt"

NAME_MAP = {
    "health": {1: "cisterns", 2: "sewers", 3: "baths", 4: "aqueduct", 5: "city_plumbing"},
    "hospitals": {1: "hospital_1", 2: "hospital_2", 3: "hospital_3", 4: "hospital_3", 5: "hospital_3"}
}

SCRUB = ["health", "cisterns", "sewers", "baths", "aqueduct", "city_plumbing", "hospitals", "hospital_1", "hospital_2", "hospital_3"]

class PrioritySanitationProcessorV90:
    def __init__(self):
        self.region_map = {}
        self.changelog = []
        self.decisions = []

    @staticmethod
    def _first_group(pattern, text, default=""):
        m = re.search(pattern, text, flags=re.IGNORECASE)
        return m.group(1) if m and m.lastindex else default

    def load_resources(self, strat_text):
        if not REGIONS_FILE.exists(): return
        content = REGIONS_FILE.read_text(encoding='utf-8')
        current_region = None
        for line in content.splitlines():
            if ';' in line: line = line.split(';')[0]
            line = line.rstrip()
            if not line: continue
            if not line.startswith(('\t', ' ')):
                current_region = line.strip()
                self.region_map[current_region] = set()
            elif current_region:
                resources = [r.strip().lower() for r in line.strip().split(',')]
                self.region_map[current_region].update(resources)
        
        for res, reg in re.findall(r"resource\s+([\w_-]+),\s*[\d\s,]+;\s*([\w_&-]+)", strat_text, flags=re.IGNORECASE):
            reg = reg.strip()
            if reg in self.region_map: self.region_map[reg].add(res.lower().strip())

    def _find_settlement_blocks(self, text):
        blocks = []
        idx = 0
        while True:
            m = re.search(r'settlement\s*\{', text[idx:], flags=re.IGNORECASE)
            if not m: break
            start = idx + m.start()
            brace_count, j = 0, start + text[start:].find('{')
            while j < len(text):
                if text[j] == '{': brace_count += 1
                elif text[j] == '}':
                    brace_count -= 1
                    if brace_count == 0:
                        blocks.append((start, j + 1)); idx = j + 1; break
                j += 1
            else: break
        return blocks

    def _reconstruct_settlement(self, block_text):
        inner = block_text[block_text.find('{')+1 : block_text.rfind('}')]
        reg = self._first_group(r'region\s+([\w_&-]+)', inner, "Unknown")
        lvl_str = self._first_group(r'level\s+([\w_]+)', inner, "village").lower()
        
        # CORRECTED TIER MAPPING logic
        lvl_val = {"village": 0, "town": 1, "large_town": 2, "minor_city": 3, "city": 3, "large_city": 4, "huge_city": 5}.get(lvl_str, 0)
        
        # Logic: Tier is level - 1, but Large Town (2) also stays at Tier 1
        if lvl_val <= 1:
            target_tier = lvl_val
        else:
            target_tier = lvl_val - 1

        existing_buildings, original_sanitation, good_headers = [], [], []
        for line in inner.splitlines():
            clean = line.strip()
            if not clean or clean.lower() in ["building", "{", "}"]: continue
            if clean.startswith(";"): continue  # skip commented-out lines
            if any(s in clean.lower() for s in SCRUB):
                san_match = re.search(r'type\s+([\w\s_]+)', clean, re.I)
                if san_match: original_sanitation.append(san_match.group(1).strip().lower())
                continue
            if "type " in clean.lower():
                existing_buildings.append(clean.replace("type ", "").replace("type", "").strip())
            else:
                good_headers.append(line)

        # --- SELECTION ---
        res = self.region_map.get(reg, set())
        has_trader = any("trader" in b.lower() for b in existing_buildings)
        med_boosters = {"pitch", "sulphur", "fruits", "honey"}
        water_res = {"lead", "irrigation_river"}  # irrigation_lake/springs removed — fewer pre-built cisterns/wells
        
        chain, reason = None, "No valid resources found"
        if ("perfumes" in res) and (res & med_boosters):
            chain, reason = "hospitals", f"Perfumes + Medicinal ({', '.join(res & med_boosters)})"
        elif res & water_res:
            chain, reason = "health", f"Water/Infrastructure ({', '.join(res & water_res)})"
        elif "perfumes" in res:
            chain, reason = "hospitals", "Basic Perfumes"

        # --- DECISION ---
        new_sanitation_type = ""
        if target_tier > 0 and chain:
            if lvl_str == "town" and not has_trader:
                reason = "Town missing trader"
            else:
                b_name = NAME_MAP[chain].get(target_tier, "cisterns")
                new_sanitation_type = f"{chain} {b_name}".lower()
        elif target_tier == 0:
            reason = "Village level (Tier 0)"

        # --- CHANGELOG ---
        orig = original_sanitation[0] if original_sanitation else None
        if orig and not new_sanitation_type:
            self.changelog.append(f"{reg:25} | REMOVED : {orig:25} | REASON: {reason}")
        elif orig and new_sanitation_type and orig != new_sanitation_type:
            self.changelog.append(f"{reg:25} | REPLACED: {orig:25} -> {new_sanitation_type:15} | REASON: {reason}")
        elif not orig and new_sanitation_type:
            self.changelog.append(f"{reg:25} | ADDED    : {new_sanitation_type:25} | REASON: {reason}")

        # --- BUILD ---
        output = "\n\t".join(h.strip() for h in good_headers)
        for b in existing_buildings: output += f"\n\tbuilding\n\t{{\n\t\ttype {b}\n\t}}"
        if new_sanitation_type: output += f"\n\tbuilding\n\t{{\n\t\ttype {new_sanitation_type}\n\t}}"

        self.decisions.append(f"REGION: {reg:20} | LVL: {lvl_str:12} | RESULT: {new_sanitation_type if new_sanitation_type else 'NONE':15} | WHY: {reason}")
        return f"settlement\n{{\n\t{output.strip()}\n}}"

    def run(self, run_strat=None, run_out=None):
        _strat = Path(run_strat) if run_strat else STRAT_FILE
        _out = Path(run_out) if run_out else OUTPUT_DIR
        if not _strat.exists(): return
        content = _strat.read_text(encoding='utf-8')
        self.load_resources(content)
        blocks = self._find_settlement_blocks(content)
        rebuilt, last_end = [], 0
        for start, end in blocks:
            rebuilt.append(content[last_end:start]); rebuilt.append(self._reconstruct_settlement(content[start:end]))
            last_end = end
        rebuilt.append(content[last_end:])
        _out.mkdir(parents=True, exist_ok=True)
        (_out / "descr_strat.txt").write_text("".join(rebuilt), encoding='utf-8')
        (_out / "changelog.txt").write_text("\n".join(self.changelog), encoding='utf-8')
        (_out / "decisions.txt").write_text("\n".join(self.decisions), encoding='utf-8')
        print(f"DONE. {len(self.changelog)} changes.")

if __name__ == "__main__":
    PrioritySanitationProcessorV90().run()