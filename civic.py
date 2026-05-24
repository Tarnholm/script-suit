#!/usr/bin/env python3
"""
civic.py — places civic buildings from an EDITABLE list into descr_strat.

The list lives at config/civic_buildings.txt, one entry per line:

    <settlement name> <civic>

e.g.  `Carthage magistrate_court`, `Rhodes centralized_mint`, `Syracuse academy`.
Settlement names may contain spaces; in descr_regions they're matched whether
written with spaces or underscores ("The Road to Methora" == "The_Road_to_Methora").
Lines may end with a `;comment`, and blank lines are ignored — so edit it freely
and re-run as new settlements are researched.

`<civic>` may be a civic building LEVEL (magistrate_court, centralized_mint,
autonomous_mint, academy, royal_mint, law_court, scriptorium, …) or a civic CHAIN
name (justice_court, academic, …). Civic chains are `no_other_civic`, so any
existing civic in a target settlement is REPLACED.

Chains/levels are read from export_descr_buildings.txt (every building tagged
`civic`), so the script adapts automatically if the mod changes.

Modelled on mics.py / temples.py: same .run(run_strat=, run_out=) contract, so it
slots straight into run_all.py / master_processor.py and the GUI pipeline.

Reads:   config/descr_strat.txt, config/descr_regions.txt,
         config/export_descr_buildings.txt, config/civic_buildings.txt
Writes (into run_out): descr_strat.txt, changelog.txt, decisions.txt,
         unmatched.txt, debug_log.txt
"""

import sys, re
sys.dont_write_bytecode = True
from pathlib import Path

BASE_DIR = Path(__file__).parent
CONFIG_DIR = BASE_DIR / "config"
OUTPUT_DIR = BASE_DIR / "processed_output"
STRAT_FILE = CONFIG_DIR / "descr_strat.txt"
REGIONS_FILE = CONFIG_DIR / "descr_regions.txt"
BUILDINGS_FILE = CONFIG_DIR / "export_descr_buildings.txt"
LIST_FILE = CONFIG_DIR / "civic_buildings.txt"


def _get_block(text, start_offset):
    """Return (inner_text, end_index) for the first {...} after start_offset."""
    try:
        first = text.index("{", start_offset)
    except ValueError:
        return None, -1
    depth = 1
    i = first + 1
    while i < len(text):
        c = text[i]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return text[first + 1:i], i + 1
        i += 1
    return None, -1


class CivicBuildingProcessor:
    def __init__(self):
        self.by_capital = {}        # capital name (lower) -> region
        self.by_region = {}         # region name (lower) -> region
        self.level_to_chain = {}    # civic level -> chain
        self.chain_first_level = {} # civic chain -> its first level
        self.civic_chains = set()
        self.changelog = []
        self.decisions = []
        self.unmatched = []
        self.conflicts = []
        self.placed = []
        self.debug = []

    # ── EDB: discover civic chains + their levels (tag civic) ────────────
    def load_civic_chains(self):
        if not BUILDINGS_FILE.exists():
            self.debug.append(f"WARNING: EDB not found: {BUILDINGS_FILE}")
            return
        text = BUILDINGS_FILE.read_text(encoding="utf-8", errors="ignore")
        for m in re.finditer(r"(?m)^building\s+(\w+)", text):
            name = m.group(1)
            block, _ = _get_block(text, m.end())
            if not block or not re.search(r"(?m)^\s*tag\s+civic\b", block):
                continue
            lm = re.search(r"levels\s+([^\n{]+)", block)
            if not lm:
                continue
            levels = lm.group(1).split()
            if not levels:
                continue
            self.civic_chains.add(name)
            self.chain_first_level[name] = levels[0]
            for lvl in levels:
                self.level_to_chain[lvl] = name
        self.debug.append(f"Civic chains: {sorted(self.civic_chains)}")

    def resolve(self, token):
        """A list token -> (chain, level), or None if not a civic building."""
        if token in self.level_to_chain:
            return self.level_to_chain[token], token
        if token in self.civic_chains:
            return token, self.chain_first_level[token]
        return None

    # ── descr_regions: region header + capital ──────────────────────────
    def load_regions(self):
        if not REGIONS_FILE.exists():
            self.debug.append(f"WARNING: Regions file not found: {REGIONS_FILE}")
            return
        cur = None
        lc = 0
        for line in REGIONS_FILE.read_text(encoding="utf-8", errors="ignore").splitlines():
            if ";" in line:
                line = line.split(";")[0]
            line = line.rstrip()
            if not line:
                continue
            if not line.startswith(("\t", " ")):
                cur = line.strip()
                self.by_region[cur.lower()] = cur
                lc = 0
            elif cur:
                lc += 1
                if lc == 1:
                    self.by_capital[line.strip().lower()] = cur

    def find_region(self, name):
        for k in (name.lower(), name.lower().replace(" ", "_"), name.lower().replace("_", " ")):
            r = self.by_capital.get(k) or self.by_region.get(k)
            if r:
                return r
        return None

    # ── parse the editable list ─────────────────────────────────────────
    def parse_line(self, raw):
        line = raw.split(";")[0].replace("\t", " ").strip()
        if not line:
            return None, None
        words = line.split()
        cl = self.resolve(words[-1].lower())
        if not cl:
            return line, None
        drop = 2 if len(words) >= 2 and words[-2].lower() == "minor" else 1
        return " ".join(words[:-drop]).strip(), cl

    def load_wishlist(self):
        """Return {region: (chain, level, name)} from civic_buildings.txt."""
        want = {}
        if not LIST_FILE.exists():
            self.debug.append(f"WARNING: list not found: {LIST_FILE} (nothing to place)")
            return want
        for raw in LIST_FILE.read_text(encoding="utf-8", errors="ignore").splitlines():
            name, cl = self.parse_line(raw)
            if not cl:
                if name:
                    self.unmatched.append(f"{name}  (unknown civic building)")
                continue
            region = self.find_region(name)
            if not region:
                self.unmatched.append(f"{name}  ({cl[1]})")
                continue
            chain, level = cl
            if region in want and want[region][:2] != (chain, level):
                self.conflicts.append(f"{name} ({region}): {want[region][1]} -> {level} (last wins)")
            want[region] = (chain, level, name)
        return want

    # ── place into descr_strat ──────────────────────────────────────────
    def run(self, run_strat=None, run_out=None):
        _strat = Path(run_strat) if run_strat else STRAT_FILE
        _out = Path(run_out) if run_out else OUTPUT_DIR
        if not _strat.exists():
            print(f"ERROR: Strategy file not found: {_strat}")
            return

        self.load_civic_chains()
        self.load_regions()
        want = self.load_wishlist()
        print(f"Civic list: {len(want)} target settlements, "
              f"{len(self.unmatched)} unmatched, {len(self.conflicts)} conflicts")

        text = _strat.read_text(encoding="utf-8", errors="ignore")
        lines = text.splitlines(keepends=True)
        out = []
        i, n = 0, len(lines)
        while i < n:
            line = lines[i]
            if line.strip().startswith("settlement"):
                start = i
                depth = 0
                j = i
                seen = False
                while j < n:
                    depth += lines[j].count("{") - lines[j].count("}")
                    if "{" in lines[j]:
                        seen = True
                    j += 1
                    if seen and depth == 0:
                        break
                block = lines[start:j]
                region = None
                for bl in block:
                    mm = re.match(r"\s*region\s+([\w_&-]+)", bl)
                    if mm:
                        region = mm.group(1)
                        break
                if region in want:
                    out += self._place(block, *want[region])
                else:
                    out += block
                i = j
            else:
                out.append(line)
                i += 1

        _out.mkdir(parents=True, exist_ok=True)
        (_out / "descr_strat.txt").write_text("".join(out), encoding="utf-8")
        (_out / "changelog.txt").write_text(
            "\n".join(self.changelog) if self.changelog else "No changes were made.", encoding="utf-8")
        (_out / "decisions.txt").write_text("\n".join(self.decisions), encoding="utf-8")
        (_out / "unmatched.txt").write_text(
            "\n".join(self.unmatched) if self.unmatched else "All list entries matched.", encoding="utf-8")
        self.debug.append(f"\nConflicts:\n" + ("\n".join(self.conflicts) if self.conflicts else "none"))
        (_out / "debug_log.txt").write_text("\n".join(self.debug), encoding="utf-8")

        print(f"Placed civic buildings in {len(self.placed)} settlements. Output: {_out}")
        if self.unmatched:
            print(f"  {len(self.unmatched)} unmatched (see unmatched.txt)")
        if self.conflicts:
            print(f"  {len(self.conflicts)} conflicts (last wins; see debug_log.txt)")

    def _place(self, block, chain, level, name):
        """Strip existing civic buildings, insert `chain level` before the close."""
        nb = []
        k = 0
        prev = None
        while k < len(block):
            bl = block[k]
            if bl.strip().startswith("building"):
                grp = [bl]
                k += 1
                while k < len(block) and "}" not in block[k]:
                    grp.append(block[k])
                    k += 1
                if k < len(block):
                    grp.append(block[k])
                is_civic = any(
                    g.strip().startswith("type") and len(g.split()) >= 2 and g.split()[1] in self.civic_chains
                    for g in grp
                )
                if is_civic:
                    for g in grp:
                        gt = g.strip().split()
                        if len(gt) >= 2 and gt[0] == "type" and gt[1] in self.civic_chains:
                            prev = f"{gt[1]} {gt[2] if len(gt) >= 3 else ''}".strip()
                else:
                    nb += grp
                k += 1
            else:
                nb.append(bl)
                k += 1
        idx = max(p for p in range(len(nb)) if nb[p].strip() == "}")
        nb = nb[:idx] + ["\tbuilding\n", "\t{\n", f"\t\ttype {chain} {level}\n", "\t}\n"] + nb[idx:]

        target = f"{chain} {level}"
        self.placed.append(f"{name}: {target}")
        if prev != target:
            self.changelog.append(
                f"{name}: {('Changed ' + prev + ' -> ' + target) if prev else 'Added ' + target}")
        self.decisions.append(f"{name}: {target}" + (f"  (was {prev})" if prev else ""))
        return nb


if __name__ == "__main__":
    CivicBuildingProcessor().run()
