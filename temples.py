#!/usr/bin/env python3
"""
temples.py — Assigns each settlement's temple based on the region's CULTURE %.

For every settlement the script reads the region's culture percentages (line 9
of descr_regions.txt, e.g. "ionian 70, italic 30"), picks the dominant culture,
and places that culture's temple chain (temple_complex_<culture>) at a level
appropriate to the settlement's size.

TIE-BREAK RULE (per user request):
    When two or more cultures are tied for the highest %, the owning faction's
    own culture wins. The faction's culture is taken from descr_sm_factions.txt
    ("default religion", falling back to "culture") — the same field mics.py
    uses. If the owner's culture isn't among the tied cultures, the first-listed
    culture wins (deterministic) and the tie is logged.

Modelled on mics.py: same descr_regions / descr_sm_factions parsing, same
settlement/faction pre-scan, same .run(run_strat=, run_out=) contract so it
slots straight into run_all.py / master_processor.py.

Temple chains + their level→settlement_min gates are parsed from
export_descr_buildings.txt, so the script never emits an invalid temple level
and automatically supports whatever temple cultures the mod defines.

Reads:
    config/descr_strat.txt
    config/descr_regions.txt
    config/descr_sm_factions.txt
    config/export_descr_buildings.txt

Writes (into run_out):
    descr_strat.txt          <- updated file
    temples_summary.txt      <- all temples + the CHANGES MADE block
    changelog.txt            <- one line per changed settlement
    decisions.txt            <- per-settlement decision log
    ties.txt                 <- settlements where cultures tied
    debug_log.txt            <- parsing details and warnings
"""

import sys, re
sys.dont_write_bytecode = True
from pathlib import Path

# --- CONFIG ---
BASE_DIR = Path(__file__).parent
CONFIG_DIR = BASE_DIR / "config"
OUTPUT_DIR = BASE_DIR / "processed_output"
STRAT_FILE = CONFIG_DIR / "descr_strat.txt"
REGIONS_FILE = CONFIG_DIR / "descr_regions.txt"
FACTIONS_FILE = CONFIG_DIR / "descr_sm_factions.txt"
BUILDINGS_FILE = CONFIG_DIR / "export_descr_buildings.txt"

# Settlement level -> numeric tier (shared convention across the suite).
LEVEL_TO_TIER = {
    "village": 0, "town": 1, "large_town": 2,
    "minor_city": 3, "city": 3, "large_city": 4, "huge_city": 5,
}

# Cultures with no temple chain of their own fall back to a synonym chain.
# (descr_sm_factions stores roman factions as culture "roman"; their temple
#  chain is temple_complex_italic.)
CULTURE_SYNONYMS = {"roman": "italic", "italic": "roman"}

# Factions whose settlements should be left untouched (no temple changes).
SKIP_FACTIONS = {"slave"}

# Special, non-culture temple chains (temples_of_viking, temples_of_horse, …).
# A settlement that already has one of these keeps it and gets NO culture temple
# (RTW allows only one temple per settlement).
SPECIAL_TEMPLE_PREFIX = "temples_of"

# If True, keep an existing temple's LEVEL and only switch its culture to the
# region's dominant culture. If False (default), the temple level is chosen by
# settlement size, mirroring mics.py's tier-based assignment.
PRESERVE_EXISTING_LEVEL = False

# If True, add a temple to qualifying settlements that don't have one.
# If False, only re-culture settlements that already have a temple.
PLACE_IF_MISSING = True


# -----------------------------------------------------------------------------
# Balanced-brace block reader (same idea as the other suite modules)
# -----------------------------------------------------------------------------
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


class TempleBuildingProcessor:
    def __init__(self):
        self.region_map = {}        # region -> {capital, cultures(OrderedDict), ...}
        self.factions_meta = {}     # faction_id -> {culture, default_religion}
        self.temple_chains = {}     # culture -> {"chain": str, "levels": [(level, min_tier)]}
        self.changelog = []
        self.decisions = []
        self.ties = []
        self.debug_logs = []
        self.all_temples = []       # "City (region): chain level"

    # -------------------------------------------------------------------------
    # Parse export_descr_buildings.txt for temple_complex_<culture> chains.
    # -------------------------------------------------------------------------
    def load_temple_chains(self):
        if not BUILDINGS_FILE.exists():
            self.debug_logs.append(f"WARNING: EDB not found: {BUILDINGS_FILE}")
            return
        text = BUILDINGS_FILE.read_text(encoding="utf-8", errors="ignore")

        for m in re.finditer(r"(?m)^building\s+(temple_complex_\w+)", text):
            chain = m.group(1)
            culture = chain[len("temple_complex_"):]
            block, _ = _get_block(text, m.end())
            if not block:
                continue
            levels_m = re.search(r"levels\s+([^\n{]+)", block)
            if not levels_m:
                continue
            level_names = levels_m.group(1).split()
            levels_block, _ = _get_block(block, levels_m.end())
            if not levels_block:
                continue

            levels = []
            last_min = None
            for lname in level_names:
                hdr = re.search(r"(?m)^\s*" + re.escape(lname) + r"\s+requires", levels_block)
                edb_min = None
                if hdr:
                    sm = re.search(r"settlement_min\s+(\w+)", levels_block[hdr.start():])
                    if sm:
                        edb_min = sm.group(1)
                edb_min = edb_min or last_min
                last_min = edb_min
                min_tier = LEVEL_TO_TIER.get(edb_min, 1) if edb_min else 1
                levels.append((lname, min_tier))
            if levels:
                self.temple_chains[culture] = {"chain": chain, "levels": levels}

        self.debug_logs.append(f"Loaded {len(self.temple_chains)} temple chains from EDB")

    def chain_for_culture(self, culture):
        """Return the temple chain key (a culture) for `culture`, honouring synonyms."""
        c = (culture or "").lower()
        if c in self.temple_chains:
            return c
        alt = CULTURE_SYNONYMS.get(c)
        if alt and alt in self.temple_chains:
            return alt
        return None

    def choose_level(self, chain_culture, tier):
        """Highest temple level whose settlement_min tier <= settlement tier."""
        levels = self.temple_chains[chain_culture]["levels"]
        allowed = [name for (name, min_tier) in levels if tier >= min_tier]
        return allowed[-1] if allowed else None

    def level_index(self, chain_culture, level_name):
        for idx, (name, _t) in enumerate(self.temple_chains[chain_culture]["levels"]):
            if name == level_name:
                return idx
        return None

    def level_at_index(self, chain_culture, idx):
        levels = self.temple_chains[chain_culture]["levels"]
        if idx is None:
            return None
        idx = max(0, min(idx, len(levels) - 1))
        return levels[idx][0]

    # -------------------------------------------------------------------------
    # descr_regions.txt — capital + culture percentages (identical layout to
    # mics.py: line 9 / the 8th indented non-empty line is the culture %).
    # -------------------------------------------------------------------------
    def load_regions_data(self):
        if not REGIONS_FILE.exists():
            self.debug_logs.append(f"WARNING: Regions file not found: {REGIONS_FILE}")
            return
        lines = REGIONS_FILE.read_text(encoding="utf-8").splitlines()

        current_region = None
        line_count = 0
        for line in lines:
            if ";" in line:
                line = line.split(";")[0]
            line = line.rstrip()
            if not line:
                continue

            if not line.startswith(("\t", " ")):
                current_region = line.strip()
                self.region_map[current_region] = {"capital": None, "cultures": {}}
                line_count = 0
            elif current_region:
                line_count += 1
                stripped = line.strip()
                if line_count == 1:
                    self.region_map[current_region]["capital"] = stripped
                elif line_count == 8:
                    cultures = {}  # insertion order = order listed in the file
                    cleaned = re.sub(r"[;,]", " ", stripped)
                    for cname, pct in re.findall(r"([A-Za-z0-9_\-]+)\s+(\d+)", cleaned):
                        cultures[cname.lower()] = int(pct)
                    self.region_map[current_region]["cultures"] = cultures
                    self.debug_logs.append(f"  Cultures for {current_region}: {cultures}")

    # -------------------------------------------------------------------------
    # descr_sm_factions.txt — faction culture + default religion (from mics.py).
    # -------------------------------------------------------------------------
    def load_factions_metadata(self):
        if not FACTIONS_FILE.exists():
            self.debug_logs.append(f"WARNING: Factions file not found: {FACTIONS_FILE}")
            return
        content = FACTIONS_FILE.read_text(encoding="utf-8")

        m = re.search(r'"factions"\s*:\s*\[', content)
        if not m:
            self.debug_logs.append("WARNING: Could not find 'factions' array in descr_sm_factions.txt")
            return

        start_idx = m.end()
        depth = 1
        i = start_idx
        area = content
        while i < len(content):
            if content[i] == "[":
                depth += 1
            elif content[i] == "]":
                depth -= 1
            if depth == 0:
                area = content[start_idx:i]
                break
            i += 1

        for fm in re.finditer(r'^\s*"([^"]+)"\s*:\s*', area, re.M):
            faction_id = fm.group(1)
            rel_start = fm.end()
            start_brace = area.find("{", rel_start)
            if start_brace == -1:
                continue
            depth = 0
            j = start_brace
            end_brace = -1
            while j < len(area):
                if area[j] == "{":
                    depth += 1
                elif area[j] == "}":
                    depth -= 1
                if depth == 0:
                    end_brace = j
                    break
                j += 1
            if end_brace == -1:
                continue

            block = area[start_brace + 1:end_brace]
            culture = None
            default_religion = None
            for ln in block.splitlines():
                s = ln.split(";;")[0].split(";")[0].strip()
                mkv = re.match(r'"\s*([^"]+)\s*"\s*:\s*"([^"]+)"', s)
                if mkv:
                    key, val = mkv.group(1).strip().lower(), mkv.group(2).strip()
                else:
                    mkv2 = re.match(r'"\s*([^"]+)\s*"\s*:\s*([A-Za-z0-9_]+)', s)
                    if not mkv2:
                        continue
                    key, val = mkv2.group(1).strip().lower(), mkv2.group(2).strip()
                if key == "culture":
                    culture = val
                elif key in ("default religion", "default_religion", "defaultreligion"):
                    default_religion = val

            self.factions_meta[faction_id] = {
                "culture": culture or "",
                "default_religion": default_religion or "",
            }

    def native_culture_of(self, faction_id):
        """Owner faction's 'local culture' for tie-breaking (religion preferred)."""
        meta = self.factions_meta.get(faction_id, {})
        return (meta.get("default_religion") or meta.get("culture") or "").strip().lower()

    # -------------------------------------------------------------------------
    # Dominant-culture selection with the owner-wins tie-break.
    # -------------------------------------------------------------------------
    def dominant_culture(self, cultures, native_culture):
        """Return (culture, tied_list, resolved_by_owner) or (None, [], False)."""
        if not cultures:
            return None, [], False
        max_pct = max(cultures.values())
        tied = [c for c, p in cultures.items() if p == max_pct]
        if len(tied) == 1:
            return tied[0], tied, False

        # Tie: the owner faction's own culture wins, if it's in the running.
        candidates = {native_culture}
        syn = CULTURE_SYNONYMS.get(native_culture)
        if syn:
            candidates.add(syn)
        for c in tied:
            if c in candidates:
                return c, tied, True
        # Owner's culture not represented — first-listed wins (deterministic).
        return tied[0], tied, False

    # -------------------------------------------------------------------------
    # Per-settlement processing.
    # -------------------------------------------------------------------------
    @staticmethod
    def _extract_meta(block):
        region, level = None, "town"
        for l in block:
            s = l.strip()
            if s.startswith("region"):
                mm = re.match(r"region\s+([\w_&-]+)", s)
                if mm:
                    region = mm.group(1)
            elif s.startswith("level"):
                parts = s.split()
                if len(parts) >= 2:
                    level = parts[1]
        return region, level

    def process_settlement_block(self, block, faction_id, is_capital=False):
        region, level = self._extract_meta(block)

        # Find existing temple (chain + level), and strip ALL temple blocks so we
        # can re-insert exactly one (RTW allows only one temple per settlement).
        existing_chain = None       # e.g. temple_complex_dorian
        existing_level = None       # e.g. temple_dorian_2
        special_temple = None       # e.g. temples_of_viking — leave the settlement alone
        new_block = []
        i, n = 0, len(block)
        while i < n:
            line = block[i]
            if line.strip().startswith("building"):
                bb = [line]
                i += 1
                while i < n and "}" not in block[i]:
                    bb.append(block[i])
                    i += 1
                if i < n:
                    bb.append(block[i])
                is_temple = False
                for l in bb:
                    t = l.strip()
                    if t.startswith("type"):
                        parts = t.split()
                        if len(parts) >= 2 and parts[1].startswith("temple_complex_"):
                            is_temple = True
                            existing_chain = parts[1]
                            existing_level = parts[2] if len(parts) >= 3 else None
                        elif len(parts) >= 2 and parts[1].startswith(SPECIAL_TEMPLE_PREFIX):
                            special_temple = parts[1]
                if not is_temple:
                    new_block += bb
                i += 1
            else:
                new_block.append(line)
                i += 1

        info = {
            "region": region, "level": level, "faction": faction_id,
            "prev": f"{existing_chain} {existing_level}" if existing_chain else None,
            "new": None, "tied": [], "resolved_by_owner": False, "reason": "",
        }

        if faction_id in SKIP_FACTIONS:
            info["reason"] = f"faction '{faction_id}' in SKIP_FACTIONS"
            return block, False, info  # leave block untouched

        if special_temple:
            info["reason"] = f"has special temple '{special_temple}' — left unchanged"
            return block, False, info  # special temple wins; no culture temple added

        region_info = self.region_map.get(region)
        if not region_info:
            info["reason"] = f"region '{region}' not in descr_regions"
            return block, False, info
        cultures = region_info.get("cultures", {})
        city = region_info.get("capital", region)
        info["city"] = city

        if not cultures:
            info["reason"] = "region has no culture percentages"
            return block, False, info

        # Capital keeps a temple sized to its level; every other settlement drops
        # one tier (the suite-wide -1 rule, as in mics.py).
        base = LEVEL_TO_TIER.get(level, 0)
        tier = base if is_capital else max(0, base - 1)
        info["is_capital"] = is_capital
        info["tier"] = tier
        native = self.native_culture_of(faction_id)
        dom, tied, by_owner = self.dominant_culture(cultures, native)
        info["tied"], info["resolved_by_owner"] = tied, by_owner

        chain_culture = self.chain_for_culture(dom)
        if not chain_culture:
            info["reason"] = f"no temple chain for dominant culture '{dom}'"
            return block, False, info
        chain_name = self.temple_chains[chain_culture]["chain"]

        # Decide the temple level.
        if PRESERVE_EXISTING_LEVEL and existing_level is not None:
            # Keep the same level index, just change culture.
            old_culture = existing_chain[len("temple_complex_"):] if existing_chain else None
            old_idx = self.level_index(old_culture, existing_level) if old_culture in self.temple_chains else None
            level_name = self.level_at_index(chain_culture, old_idx) if old_idx is not None else self.choose_level(chain_culture, tier)
        else:
            level_name = self.choose_level(chain_culture, tier)

        if not level_name:
            # Settlement too small for any temple level.
            if existing_chain:
                # It had a temple but no longer qualifies — leave it as-is to
                # avoid surprising removals.
                info["reason"] = f"tier {tier} below minimum temple level; kept existing"
                return block, False, info
            info["reason"] = f"tier {tier} below minimum temple level"
            return block, False, info

        if existing_chain is None and not PLACE_IF_MISSING:
            info["reason"] = "no existing temple and PLACE_IF_MISSING is False"
            return block, False, info

        target = f"{chain_name} {level_name}"
        info["new"] = target

        # Already correct? Preserve the original block ordering (no change).
        if existing_chain == chain_name and existing_level == level_name:
            self.all_temples.append(f"{city} ({region}): {target}")
            info["reason"] = "already correct"
            return block, False, info

        # Insert the new temple just before the settlement's closing brace.
        idx = -1
        for k in range(len(new_block) - 1, -1, -1):
            if new_block[k].strip() == "}":
                idx = k
                break
        nb = ["\tbuilding\n", "\t{\n", f"\t\ttype {target}\n", "\t}\n"]
        if idx != -1:
            while idx > 0 and new_block[idx - 1].strip() == "":
                idx -= 1
            new_block = new_block[:idx] + nb + new_block[idx:]

        self.all_temples.append(f"{city} ({region}): {target}")
        return new_block, True, info

    # -------------------------------------------------------------------------
    # Settlement blocks + faction pre-scan (same approach as mics.py).
    # -------------------------------------------------------------------------
    @staticmethod
    def _find_settlement_blocks(text):
        blocks = []
        idx = 0
        while True:
            m = re.search(r"settlement\s*\{", text[idx:], flags=re.IGNORECASE)
            if not m:
                break
            start = idx + m.start()
            brace_start = start + text[start:].find("{")
            depth = 0
            j = brace_start
            while j < len(text):
                if text[j] == "{":
                    depth += 1
                elif text[j] == "}":
                    depth -= 1
                    if depth == 0:
                        blocks.append((start, j + 1))
                        idx = j + 1
                        break
                j += 1
            else:
                break
        return blocks

    def run(self, run_strat=None, run_out=None):
        _strat = Path(run_strat) if run_strat else STRAT_FILE
        _out = Path(run_out) if run_out else OUTPUT_DIR
        if not _strat.exists():
            print(f"ERROR: Strategy file not found: {_strat}")
            return

        content = _strat.read_text(encoding="utf-8")

        self.load_temple_chains()
        self.load_regions_data()
        self.load_factions_metadata()

        print(f"Loaded {len(self.temple_chains)} temple chains, "
              f"{len(self.region_map)} regions, {len(self.factions_meta)} factions")

        blocks = self._find_settlement_blocks(content)
        print(f"Found {len(blocks)} settlement blocks")

        # Map each settlement's region -> owning faction (last `faction` decl
        # before the settlement).
        settlement_to_faction = {}
        faction_capital_region = {}   # faction -> its first settlement's region (its capital)
        for start, _end in blocks:
            fm = list(re.finditer(r"^faction\s+([^\s,]+)", content[:start], re.MULTILINE))
            fac = fm[-1].group(1) if fm else None
            region, _ = self._extract_meta(content[start:_end].splitlines(keepends=True))
            if region and fac:
                settlement_to_faction[region] = fac
                if fac not in faction_capital_region:
                    faction_capital_region[fac] = region

        rebuilt = []
        last_end = 0
        settlements_changed = 0

        for start, end in blocks:
            rebuilt.append(content[last_end:start])
            block_lines = content[start:end].splitlines(keepends=True)
            region, _ = self._extract_meta(block_lines)
            faction_id = settlement_to_faction.get(region)
            is_capital = (region is not None and region == faction_capital_region.get(faction_id))

            new_block, changed, info = self.process_settlement_block(block_lines, faction_id, is_capital)
            if changed:
                settlements_changed += 1

            self._log_decision(info)
            rebuilt.append("".join(new_block))
            last_end = end

        rebuilt.append(content[last_end:])

        # ---- write outputs ----
        _out.mkdir(parents=True, exist_ok=True)
        (_out / "descr_strat.txt").write_text("".join(rebuilt), encoding="utf-8")
        (_out / "changelog.txt").write_text(
            "\n".join(self.changelog) if self.changelog else "No changes were made.",
            encoding="utf-8")
        (_out / "decisions.txt").write_text("\n".join(self.decisions), encoding="utf-8")
        (_out / "ties.txt").write_text(
            "\n".join(self.ties) if self.ties else "No ties encountered.", encoding="utf-8")
        (_out / "debug_log.txt").write_text("\n".join(self.debug_logs), encoding="utf-8")
        self._write_summary(_out, len(blocks), settlements_changed)

        print(f"\nDone. Temples assigned: {len(self.all_temples)}, "
              f"settlements changed: {settlements_changed}")
        print(f"Output saved to: {_out}")

    # -------------------------------------------------------------------------
    # Logging helpers
    # -------------------------------------------------------------------------
    def _log_decision(self, info):
        city = info.get("city", info.get("region"))
        region = info.get("region")
        prev, new = info.get("prev"), info.get("new")

        if info["tied"] and len(info["tied"]) > 1:
            how = "owner culture" if info["resolved_by_owner"] else "first-listed (owner culture absent)"
            self.ties.append(f"{city} ({region}): tie {sorted(info['tied'])} -> won by {how} = {new}")

        if new and prev != new:
            if prev:
                self.changelog.append(f"[CHANGED] {city} ({region}): {prev} -> {new}")
            else:
                self.changelog.append(f"[CHANGED] {city} ({region}): Added {new}")

        self.decisions.append(
            f"--- {city} ({region}) ---\n"
            f"Faction: {info.get('faction')}  Level: {info.get('level')}  "
            f"(capital={info.get('is_capital')}, temple tier={info.get('tier')})\n"
            f"Dominant: {new or '(none)'}  Tied: {sorted(info['tied']) if info['tied'] else '-'}  "
            f"OwnerTieWin: {info['resolved_by_owner']}\n"
            f"Prev: {prev or '(none)'}  Reason: {info.get('reason')}\n"
        )

    def _write_summary(self, out_dir, total_settlements, changed):
        out = []
        out.append("=" * 80)
        out.append("TEMPLES SUMMARY")
        out.append("=" * 80)
        out.append("")
        out.append(f"Total settlements processed: {total_settlements}")
        out.append(f"Settlements with a temple:   {len(self.all_temples)}")
        out.append(f"Total changes made:          {changed}")
        out.append("")
        out.append("=" * 80)
        out.append("CHANGES MADE (Items marked with [CHANGED])")
        out.append("=" * 80)
        out.append("")
        changes = [c.replace("[CHANGED] ", "") for c in self.changelog if c.startswith("[CHANGED]")]
        out.extend(changes if changes else ["No changes were made."])
        out.append("")
        out.append("=" * 80)
        out.append("ALL TEMPLES (Complete List)")
        out.append("=" * 80)
        out.append("")
        out.extend(sorted(self.all_temples) if self.all_temples else ["No temples found."])
        (out_dir / "temples_summary.txt").write_text("\n".join(out), encoding="utf-8")


if __name__ == "__main__":
    TempleBuildingProcessor().run()
