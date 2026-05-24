#!/usr/bin/env python3
"""
grain_exports.py — places a grain-export building (the food_storage / granary chain).

Rule: a region with grain amount >= 2 AND a sea/river outlet (a base_port_level_1/2/3
hidden resource OR the rivertrade hidden resource) gets a food_storage building,
sized by settlement level:
    town        -> none
    large_town  -> granary      (export 1)
    city        -> granary+1     (export 2)
    large_city  -> granary+1     (export 2)
    huge_city   -> granary+1     (export 2)
Exception: region Gynaikopolites_Nomos -> granary+2 (export 3).

Existing food_storage is replaced; settlements that no longer qualify have it
removed (so the result matches the rule exactly). `…grain_supply` is never used.
.run(run_strat=, run_out=) pipeline contract — slots into run_all / master / GUI.
"""

import sys, re
sys.dont_write_bytecode = True
from pathlib import Path

BASE_DIR = Path(__file__).parent
CONFIG_DIR = BASE_DIR / "config"
OUTPUT_DIR = BASE_DIR / "processed_output"
STRAT_FILE = CONFIG_DIR / "descr_strat.txt"
REGIONS_FILE = CONFIG_DIR / "descr_regions.txt"

BUILDING = "food_storage"
GRAIN_MIN = 2
PORT_HR = {"base_port_level_1", "base_port_level_2", "base_port_level_3"}

# Settlement level -> grain-export level (town/village -> none).
SIZE_LEVEL = {
    "large_town": "granary",
    "minor_city": "granary+1",
    "city": "granary+1",
    "large_city": "granary+1",
    "huge_city": "granary+1",
}
# Region (lowercased) -> forced level (overrides the size table).
EXCEPTION_REGIONS = {"gynaikopolites_nomos": "granary+2"}
# All food_storage level names (for detecting/stripping an existing one).
FOOD_STORAGE_LEVELS = {"granary", "granary+1", "granary+2", "grain_supply"}


class GrainExportProcessor:
    def __init__(self):
        self.region_hidden = {}    # region(lower) -> hidden-resource set
        self.region_capital = {}   # region(lower) -> capital name
        self.grain_by_region = {}  # region(lower) -> grain amount
        self.changelog = []
        self.decisions = []
        self.placed = []

    def load_regions(self):
        if not REGIONS_FILE.exists():
            return
        cur, lc = None, 0
        for line in REGIONS_FILE.read_text(encoding="utf-8", errors="ignore").splitlines():
            if ";" in line:
                line = line.split(";")[0]
            line = line.rstrip()
            if not line:
                continue
            if not line.startswith(("\t", " ")):
                cur, lc = line.strip(), 0
            elif cur:
                lc += 1
                if lc == 1:
                    self.region_capital[cur.lower()] = line.strip()
                elif lc == 5:
                    self.region_hidden[cur.lower()] = {r.strip().lower() for r in line.split(",") if r.strip()}

    def load_grain(self, strat_text):
        for m in re.finditer(r'resource\s+grain,\s*([\d.]+),\s*\d+,\s*\d+\s*;\s*([\w_&-]+)', strat_text, re.I):
            region = m.group(2).strip().lower()
            self.grain_by_region[region] = self.grain_by_region.get(region, 0) + float(m.group(1))

    @staticmethod
    def _meta(block):
        region, level = None, "town"
        for l in block:
            s = l.strip()
            if s.startswith("region"):
                mm = re.match(r'region\s+([\w_&-]+)', s)
                if mm:
                    region = mm.group(1)
            elif s.startswith("level"):
                p = s.split()
                if len(p) >= 2:
                    level = p[1]
        return region, level

    def run(self, run_strat=None, run_out=None):
        _strat = Path(run_strat) if run_strat else STRAT_FILE
        _out = Path(run_out) if run_out else OUTPUT_DIR
        if not _strat.exists():
            print(f"ERROR: strat not found: {_strat}")
            return
        content = _strat.read_text(encoding="utf-8")
        self.load_regions()
        self.load_grain(content)

        lines = content.splitlines(keepends=True)
        out, i, n = [], 0, len(lines)
        while i < n:
            line = lines[i]
            if line.strip().startswith("settlement"):
                start, depth, j, seen = i, 0, i, False
                while j < n:
                    depth += lines[j].count("{") - lines[j].count("}")
                    if "{" in lines[j]:
                        seen = True
                    j += 1
                    if seen and depth == 0:
                        break
                out += self._process(lines[start:j])
                i = j
            else:
                out.append(line)
                i += 1

        _out.mkdir(parents=True, exist_ok=True)
        (_out / "descr_strat.txt").write_text("".join(out), encoding="utf-8")
        (_out / "changelog.txt").write_text("\n".join(self.changelog) if self.changelog else "No changes were made.", encoding="utf-8")
        (_out / "decisions.txt").write_text("\n".join(self.decisions), encoding="utf-8")
        print(f"Grain exports placed in {len(self.placed)} settlements. Output: {_out}")

    def _process(self, block):
        region, level = self._meta(block)
        rkey = (region or "").lower()

        # Strip any existing food_storage building; remember it.
        prev = None
        nb, k = [], 0
        while k < len(block):
            bl = block[k]
            if bl.strip().startswith("building"):
                grp = [bl]; k += 1
                while k < len(block) and "}" not in block[k]:
                    grp.append(block[k]); k += 1
                if k < len(block):
                    grp.append(block[k])
                is_fs = any(
                    g.strip().startswith("type") and len(g.split()) >= 2 and g.split()[1] == BUILDING
                    for g in grp
                )
                if is_fs:
                    for g in grp:
                        t = g.strip().split()
                        if len(t) >= 2 and t[0] == "type" and t[1] == BUILDING:
                            prev = f"{t[1]} {t[2] if len(t) >= 3 else ''}".strip()
                else:
                    nb += grp
                k += 1
            else:
                nb.append(bl)
                k += 1

        grain = self.grain_by_region.get(rkey, 0)
        hidden = self.region_hidden.get(rkey, set())
        has_outlet = bool(hidden & PORT_HR) or ("rivertrade" in hidden)
        city = self.region_capital.get(rkey, region)

        chosen = None
        if grain >= GRAIN_MIN and has_outlet:
            chosen = EXCEPTION_REGIONS.get(rkey) or SIZE_LEVEL.get(level)

        if not chosen:
            if prev:
                self.changelog.append(f"{city} ({region}): Removed {prev}")
                self.decisions.append(f"{city} ({region}): grain={grain:g} outlet={has_outlet} level={level} -> none (removed {prev})")
                return nb  # stripped, nothing added
            return block  # unchanged

        target = f"{BUILDING} {chosen}"
        if prev == target:
            self.placed.append(f"{city} ({region}): {target}")
            return block  # already correct

        idx = max(p for p in range(len(nb)) if nb[p].strip() == "}")
        nb = nb[:idx] + ["\tbuilding\n", "\t{\n", f"\t\ttype {target}\n", "\t}\n"] + nb[idx:]
        self.placed.append(f"{city} ({region}): {target}")
        self.changelog.append(f"{city} ({region}): {('Changed ' + prev + ' -> ' + target) if prev else 'Added ' + target}")
        self.decisions.append(f"{city} ({region}): grain={grain:g} outlet={has_outlet} level={level} -> {target}")
        return nb


if __name__ == "__main__":
    GrainExportProcessor().run()
