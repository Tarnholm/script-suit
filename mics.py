#!/usr/bin/env python3
"""
place_buildings.py

Parses descr_regions.txt, descr_strat.txt and descr_sm_factions.txt and applies
building placement rules for military-family buildings (military_industrial_complex
or garrison) according to settlement level, capital status and culture presence.

Updated to match the structure and style of farms.py and sanitation_healers.py

RULES:
- Capitals (first settlement for each faction) always get MIC (high branch)
- Non-capitals use high branch (MIC) if native culture >= 30%, otherwise low branch (garrison)
- Handles factions without starting land gracefully (no SKIP_FACTIONS needed)
- Enhanced debug logging to track all settlements
- FIXED: Preserves existing military buildings when they match the target
- NEW: Slave faction gets no military buildings (all removed)
- NEW: Outputs comprehensive summary with all military buildings and separate changes log
- FIXED: buildings.txt now shows ALL unique building types (not just changed ones)
- FIXED: Proper faction tracking - only detects faction changes in immediate pre_content
- FIXED: decisions.txt logs ALL military building assignments (not just changes)
- FIXED: Removed fertility from decisions output (not used in logic)
"""

import sys, re
from pathlib import Path
from datetime import datetime

# --- CONFIG ---
BASE_DIR = Path(__file__).parent
CONFIG_DIR = BASE_DIR / "config"
OUTPUT_DIR = BASE_DIR / "processed_output"
STRAT_FILE = CONFIG_DIR / "descr_strat.txt"
REGIONS_FILE = CONFIG_DIR / "descr_regions.txt"
FACTIONS_FILE = CONFIG_DIR / "descr_sm_factions.txt"

THRESHOLD = 30.0  # culture pct threshold for high-branch preference / MIC preference

# Cap both branches at their tier-2 building: full homeland recruitment while
# leaving higher tiers for the player to build. mic -> mic_2, garrison -> garrison+1.
MAX_MILITARY_TIER = 2

# Low-branch mapping: tier -> garrison id (tier 1 is plain garrison)
BUILDINGS_LOW = {1: "garrison", 2: "garrison+1", 3: "garrison+2"}
# High-branch mapping: tier -> mic id (tier N -> mic_N)
BUILDINGS_HIGH = {1: "mic_1", 2: "mic_2", 3: "mic_3", 4: "mic_4"}

# Textual mapping: base tiers for settlement_text; non-capitals use base-1
LEVEL_TO_TIER = {
    "village": 0,
    "town": 1,
    "large_town": 2,
    "minor_city": 3,
    "city": 3,
    "large_city": 4,
    "huge_city": 5
}

MAX_TIER = max(max(BUILDINGS_LOW.keys()), max(BUILDINGS_HIGH.keys()))

MILITARY_CHAINS = ["military_industrial_complex", "garrison"]

# Factions that should never get military buildings
NO_MILITARY_FACTIONS = {"slave"}


class MilitaryBuildingProcessor:
    def __init__(self):
        self.region_map = {}
        self.factions_meta = {}
        self.region_to_city = {}
        self.changelog = []
        self.all_military_buildings = []  # Track ALL military buildings
        self.decisions = []
        self.debug_logs = []
        self.settlements_military = {}
        self.building_set = set()
        self.previous_assignments = {}
        self.factions_without_land = set()
        self.factions_processed = {}

    def load_regions_data(self):
        """
        Load region data from descr_regions.txt
        
        Format:
        Line 1: Region name
        Line 2: Settlement name
        Line 3: Founding faction
        Line 4: Plural name
        Line 5: RGB code
        Line 6: Hidden resources (comma-separated)
        Line 7: Unknown number
        Line 8: Fertility
        Line 9: Culture percentages (can be multiple: "culture1 pct1, culture2 pct2")
        """
        if not REGIONS_FILE.exists():
            self.debug_logs.append(f"WARNING: Regions file not found: {REGIONS_FILE}")
            return
        
        content = REGIONS_FILE.read_text(encoding='utf-8')
        lines = content.splitlines()
        
        current_region = None
        line_count = 0
        
        for line in lines:
            # Remove comments
            if ';' in line:
                line = line.split(';')[0]
            line = line.rstrip()
            
            if not line:
                continue
            
            # Check if this is a region name (not indented)
            if not line.startswith(('\t', ' ')):
                current_region = line.strip()
                self.region_map[current_region] = {
                    "capital": None,
                    "founding_faction": None,
                    "fertility": 0,
                    "cultures": {},
                    "hidden_resources": set()
                }
                line_count = 0
                self.debug_logs.append(f"Found region: {current_region}")
            elif current_region:
                line_count += 1
                stripped = line.strip()
                
                # Line 2: Settlement/capital name
                if line_count == 1:
                    self.region_map[current_region]["capital"] = stripped
                    self.region_to_city[current_region] = stripped
                
                # Line 3: Founding faction
                elif line_count == 2:
                    self.region_map[current_region]["founding_faction"] = stripped
                
                # Line 6: Hidden resources (comma-separated)
                elif line_count == 5:
                    parts = [p.strip().lower() for p in stripped.split(',')]
                    self.region_map[current_region]["hidden_resources"] = set(parts)
                    self.debug_logs.append(f"  Hidden resources for {current_region}: {set(parts)}")
                
                # Line 8: Fertility
                elif line_count == 7:
                    try:
                        fertility = int(stripped)
                        self.region_map[current_region]["fertility"] = fertility
                    except ValueError:
                        self.debug_logs.append(f"  WARNING: Could not parse fertility for {current_region}: '{stripped}'")
                
                # Line 9: Culture percentages
                elif line_count == 8:
                    # Parse culture percentages - can be multiple like "ionian 70, italic 30"
                    cultures = {}
                    cleaned = re.sub(r"[;,]", " ", stripped)
                    pairs = re.findall(r"([A-Za-z0-9_\-]+)\s+(\d+)", cleaned)
                    for culture_name, pct in pairs:
                        cultures[culture_name.lower()] = int(pct)
                    
                    self.region_map[current_region]["cultures"] = cultures
                    self.debug_logs.append(f"  Cultures for {current_region}: {cultures}")

    def load_factions_metadata(self):
        """Load faction metadata from descr_sm_factions.txt"""
        if not FACTIONS_FILE.exists():
            self.debug_logs.append(f"WARNING: Factions file not found: {FACTIONS_FILE}")
            return
        
        content = FACTIONS_FILE.read_text(encoding='utf-8')
        
        # Parse factions text for culture and default religion
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
        
        # Extract each faction block
        for m in re.finditer(r'^\s*"([^"]+)"\s*:\s*', area, re.M):
            faction_id = m.group(1)
            rel_start = m.end()
            start_brace = area.find("{", rel_start)
            if start_brace == -1:
                continue
            
            depth = 0
            i = start_brace
            end_brace = -1
            while i < len(area):
                if area[i] == "{":
                    depth += 1
                elif area[i] == "}":
                    depth -= 1
                if depth == 0:
                    end_brace = i
                    break
                i += 1
            
            if end_brace == -1:
                continue
            
            block = area[start_brace + 1:end_brace]
            culture = None
            default_religion = None
            
            for ln in block.splitlines():
                no_comment = ln.split(";;")[0].split(";")[0]
                s = no_comment.strip()
                
                # Match "key": "value"
                mkv = re.match(r'"\s*([^"]+)\s*"\s*:\s*"([^"]+)"', s)
                if mkv:
                    key = mkv.group(1).strip().lower()
                    val = mkv.group(2).strip()
                    if key == "culture":
                        culture = val
                    elif key in ("default religion", "default_religion", "defaultreligion"):
                        default_religion = val
                else:
                    # Match "key": value (without quotes)
                    mkv2 = re.match(r'"\s*([^"]+)\s*"\s*:\s*([A-Za-z0-9_]+)', s)
                    if mkv2:
                        key = mkv2.group(1).strip().lower()
                        val = mkv2.group(2).strip()
                        if key == "culture":
                            culture = val
                        elif key in ("default religion", "default_religion", "defaultreligion"):
                            default_religion = val
            
            self.factions_meta[faction_id] = {
                "culture": culture or "",
                "default_religion": default_religion or ""
            }
            self.debug_logs.append(f"Loaded faction {faction_id}: culture={culture}, religion={default_religion}")

    def extract_settlement_meta(self, block):
        """Extract settlement metadata - handles hyphens and ampersands"""
        region, level = None, "town"
        
        for l in block:
            s = l.strip()
            # FIXED: Added hyphen and ampersand to character class for region names
            if s.startswith("region"):
                m = re.match(r'region\s+([\w_&-]+)', s)
                if m:
                    region = m.group(1)
            elif s.startswith("level"):
                parts = s.split()
                if len(parts) >= 2:
                    level = parts[1]
        
        return region, level

    def choose_branch(self, is_capital: bool, culture_pct: int) -> str:
        """
        Choose between high (MIC) and low (garrison) branch
        
        RULE: Capitals always use high branch (MIC)
        Non-capitals use high if culture >= threshold, otherwise low
        """
        if is_capital:
            return "high"
        
        return "high" if culture_pct >= THRESHOLD else "low"

    def lookup_building(self, branch: str, tier: int) -> str:
        """Look up building ID for given branch and tier"""
        if branch == "low":
            mapping = BUILDINGS_LOW
            if tier in mapping:
                return mapping[tier]
            # Fallback to highest available tier below requested
            for t in range(tier, 0, -1):
                if t in mapping:
                    return mapping[t]
            return None
        
        # High branch
        if tier == 0:
            return None
        mapping = BUILDINGS_HIGH
        if tier in mapping:
            return mapping[tier]
        # Fallback to highest available tier below requested
        for t in range(tier, 0, -1):
            if t in mapping:
                return mapping[t]
        return None

    def determine_building_tier(self, level_text: str, is_capital: bool) -> int:
        """Determine building tier from settlement level text in descr_strat"""
        tier = None
        
        # Use the textual level from descr_strat.txt
        if level_text:
            key = level_text.strip().lower()
            if key in LEVEL_TO_TIER:
                base = LEVEL_TO_TIER[key]
                tier = base if is_capital else max(0, base - 1)
            else:
                # Unknown level text - log warning and default to 0
                self.debug_logs.append(f"WARNING: Unknown settlement level '{level_text}', defaulting to tier 0")
                tier = 0
        else:
            # No level text found - default to 0
            self.debug_logs.append(f"WARNING: No settlement level found in descr_strat, defaulting to tier 0")
            tier = 0
        
        tier = max(0, min(tier, MAX_TIER))
        return tier

    def building_id_to_category(self, building_id: str) -> str:
        """Convert building ID to category"""
        if not building_id:
            return None
        if building_id.startswith("mic_"):
            return "military_industrial_complex"
        if building_id.startswith("garrison"):
            return "garrison"
        return None

    def process_settlement_block(self, block, faction_id, capital_region, native_culture):
        """Process settlement block for military buildings"""
        new_block = []
        i = 0
        n = len(block)
        
        region, level = self.extract_settlement_meta(block)
        
        # NEW: Always log what we're evaluating
        self.debug_logs.append(f"=== Processing: region={region}, level={level}, faction={faction_id} ===")
        
        if not region or region not in self.region_map:
            # Return block unchanged
            self.debug_logs.append(f"  SKIPPED: Region '{region}' not found in region map")
            return block, False
        
        region_info = self.region_map[region]
        city = region_info.get("capital", region)
        cultures = region_info.get("cultures", {})
        fertility = region_info.get("fertility", 0)
        
        # Capital is determined by being the first settlement for the faction
        is_capital = (region == capital_region)
        
        self.debug_logs.append(f"  City: {city}, Capital: {is_capital}")
        
        # Store variables for decision logging
        tier = 0
        branch = "none"
        nation_pct = 0
        
        # NEW: Check if this is a faction that should never get military buildings
        if faction_id in NO_MILITARY_FACTIONS:
            self.debug_logs.append(f"  Faction {faction_id} is in NO_MILITARY_FACTIONS - will remove all military buildings")
            chosen_building_id = None
            target_category = None
        else:
            # Calculate native culture percentage
            native_culture_norm = native_culture.lower()
            cultures_norm = {k.lower(): v for k, v in cultures.items()}
            nation_pct = 0
            
            if native_culture_norm in cultures_norm:
                nation_pct = int(cultures_norm[native_culture_norm])
            else:
                # Synonym fallback
                synonyms = {"roman": "italic", "italic": "roman"}
                alt = synonyms.get(native_culture_norm)
                if alt and alt in cultures_norm:
                    nation_pct = int(cultures_norm[alt])
                else:
                    if is_capital:
                        nation_pct = 100
                    else:
                        nation_pct = 0
            
            self.debug_logs.append(f"  Native culture: {native_culture_norm}, Culture %: {nation_pct}")
            
            # Determine tier and branch (using level from descr_strat, NOT fertility!)
            tier = self.determine_building_tier(level, is_capital)
            branch = self.choose_branch(is_capital, nation_pct)
            
            self.debug_logs.append(f"  Tier: {tier}, Branch: {branch}")
            
            # Choose building (capped at tier 2 for both branches)
            if tier == 0 and not is_capital:
                chosen_building_id = None
            else:
                chosen_building_id = self.lookup_building(branch, min(tier, MAX_MILITARY_TIER))
            
            self.debug_logs.append(f"  Chosen building ID: {chosen_building_id}")
            
            target_category = self.building_id_to_category(chosen_building_id) if chosen_building_id else None
        
        # Extract existing military buildings and rebuild the block
        existing_military = []
        existing_military_block = None  # Store the existing military building block if it matches
        
        while i < n:
            line = block[i]
            s = line.strip()
            
            if s.startswith("building"):
                bb = [line]
                i += 1
                
                while i < n and "}" not in block[i]:
                    bb.append(block[i])
                    if block[i].strip().startswith("type"):
                        type_parts = block[i].strip().split()
                        if len(type_parts) >= 2 and type_parts[1] in MILITARY_CHAINS:
                            if len(type_parts) >= 3:
                                existing_military.append((type_parts[1], type_parts[2]))
                    i += 1
                
                if i < n:
                    bb.append(block[i])
                
                # Check if this is a military building
                is_military = any(l.strip().startswith("type") and len(l.strip().split()) >= 2 
                                 and l.strip().split()[1] in MILITARY_CHAINS for l in bb)
                
                # If it's a military building, store it for potential reuse
                if is_military and existing_military and chosen_building_id:
                    cat, id_ = existing_military[-1]  # Get the last one we just found
                    # Check if it matches what we want
                    if id_ == chosen_building_id and cat == target_category:
                        existing_military_block = bb  # Keep this block to reuse
                
                # Only add non-military buildings to new_block for now
                if not is_military:
                    new_block += bb
                
                i += 1
            else:
                new_block.append(line)
                i += 1
        
        self.debug_logs.append(f"  Existing military buildings: {existing_military}")
        
        # Check if change is needed
        changed = False
        
        if chosen_building_id is None:
            # Should remove military building (already not added to new_block)
            if existing_military:
                changed = True
                prev = f"{existing_military[0][0]} {existing_military[0][1]}"
                if faction_id in NO_MILITARY_FACTIONS:
                    self.changelog.append(f"[CHANGED] {city} ({region}): Removed {prev} (slave faction)")
                else:
                    self.changelog.append(f"[CHANGED] {city} ({region}): Removed {prev} (tier 0 non-capital)")
                self.debug_logs.append(f"  CHANGE: Removing {prev}")
            # No military building in final result
        else:
            # Check if existing matches chosen
            matched = False
            
            self.debug_logs.append(f"  Target: {target_category} {chosen_building_id}")
            
            for cat, id_ in existing_military:
                self.debug_logs.append(f"    Comparing with existing: {cat} {id_}")
                if id_ == chosen_building_id and cat == target_category:
                    matched = True
                    self.debug_logs.append(f"    MATCH FOUND - keeping existing building")
                    break
            
            if matched and existing_military_block:
                # Existing building already matches — record bookkeeping and
                # preserve the original block so we don't reorder buildings.
                self.all_military_buildings.append(f"{city} ({region}): {target_category} {chosen_building_id}")
                self.building_set.add(f"{target_category} {chosen_building_id}")

                if faction_id not in NO_MILITARY_FACTIONS:
                    decision_entry = [
                        f"--- Settlement: {city} ({region}) ---",
                        f"Faction: {faction_id}",
                        f"Level: {level} (tier {tier})",
                        f"Is capital: {is_capital}",
                        f"Native culture %: {nation_pct}",
                        f"Branch: {branch}",
                        f"Chosen building: {target_category} {chosen_building_id}",
                        f"Status: No change (already correct)",
                        ""
                    ]
                    self.decisions.extend(decision_entry)

                return block, False
                
            elif not matched:
                self.debug_logs.append(f"  NO MATCH - will make change")
                changed = True
                
                # Add the new building
                idx = -1
                for j in reversed(range(len(new_block))):
                    if new_block[j].strip() == "}":
                        idx = j
                        break
                
                nb = ["\tbuilding\n", "\t{\n", f"\t\ttype {target_category} {chosen_building_id}\n", "\t}\n"]
                
                if idx != -1:
                    while idx > 0 and new_block[idx - 1].strip() == "":
                        idx -= 1
                    new_block = new_block[:idx] + nb + new_block[idx:]
                
                # Log change
                prev = f"{existing_military[0][0]} {existing_military[0][1]}" if existing_military else "none"
                new = f"{target_category} {chosen_building_id}"
                
                if existing_military:
                    self.changelog.append(f"[CHANGED] {city} ({region}): Changed from {prev} to {new}")
                    status_msg = f"Changed from {prev}"
                else:
                    self.changelog.append(f"[CHANGED] {city} ({region}): Added {new}")
                    status_msg = "Added (was none)"
                
                # Also record in all_military_buildings list
                self.all_military_buildings.append(f"{city} ({region}): {target_category} {chosen_building_id}")
                
                self.settlements_military[city] = f"{target_category} {chosen_building_id}"
                self.building_set.add(f"{target_category} {chosen_building_id}")
                
                # Decision log for changed buildings
                if faction_id not in NO_MILITARY_FACTIONS:
                    decision_entry = [
                        f"--- Settlement: {city} ({region}) ---",
                        f"Faction: {faction_id}",
                        f"Level: {level} (tier {tier})",
                        f"Is capital: {is_capital}",
                        f"Native culture %: {nation_pct}",
                        f"Branch: {branch}",
                        f"Chosen building: {target_category} {chosen_building_id}",
                        f"Status: {status_msg}"
                    ]
                    
                    decision_entry.append("")
                    self.decisions.extend(decision_entry)
        
        return new_block, changed

    def _find_settlement_blocks(self, text):
        """Find settlement blocks in text"""
        blocks = []
        idx = 0
        while True:
            m = re.search(r'settlement\s*\{', text[idx:], flags=re.IGNORECASE)
            if not m:
                break
            start = idx + m.start()
            brace_start = start + text[start:].find('{')
            brace_count = 0
            j = brace_start
            while j < len(text):
                if text[j] == '{':
                    brace_count += 1
                elif text[j] == '}':
                    brace_count -= 1
                    if brace_count == 0:
                        end = j + 1
                        blocks.append((start, end))
                        idx = end
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

        content = _strat.read_text(encoding='utf-8')
        
        # Load data
        self.load_regions_data()
        self.load_factions_metadata()
        
        print(f"Loaded {len(self.region_map)} regions from descr_regions.txt")
        print(f"Loaded {len(self.factions_meta)} factions from descr_sm_factions.txt")
        
        # Find settlement blocks
        blocks = self._find_settlement_blocks(content)
        print(f"Found {len(blocks)} settlement blocks")
        
        # FIXED: Pre-scan to find faction ownership for each settlement
        settlement_to_faction = {}
        current_scan_faction = None
        
        for start, end in blocks:
            # Look backwards from this settlement to find the faction declaration
            # Search only in content before this settlement
            search_text = content[:start]
            
            # Find the LAST faction declaration before this settlement
            faction_matches = list(re.finditer(r'^faction\s+([^\s,]+)', search_text, re.MULTILINE))
            if faction_matches:
                current_scan_faction = faction_matches[-1].group(1)
            
            # Extract region from this settlement block
            block_text = content[start:end]
            block_lines = block_text.splitlines(keepends=True)
            region, _ = self.extract_settlement_meta(block_lines)
            
            if region and current_scan_faction:
                settlement_to_faction[region] = current_scan_faction
                self.debug_logs.append(f"Pre-scan: {region} belongs to {current_scan_faction}")
        
        # Process settlements
        rebuilt = []
        last_end = 0
        current_faction = None
        capital_region = None
        native_culture = None
        settlements_changed = 0
        
        for start, end in blocks:
            # Add content before this settlement
            pre_content = content[last_end:start]
            rebuilt.append(pre_content)
            
            block_text = content[start:end]
            block_lines = block_text.splitlines(keepends=True)
            
            # Determine which faction this settlement belongs to
            region, _ = self.extract_settlement_meta(block_lines)
            
            if region and region in settlement_to_faction:
                new_faction = settlement_to_faction[region]
                
                if new_faction != current_faction:
                    current_faction = new_faction
                    
                    # Initialize faction tracking
                    if current_faction not in self.factions_processed:
                        self.factions_processed[current_faction] = {
                            'settlements_count': 0,
                            'has_valid_capital': False,
                            'has_native_culture': False
                        }
                    
                    # Find capital for this faction (first settlement for this faction)
                    capital_region = None
                    for s_start, s_end in blocks:
                        s_block_text = content[s_start:s_end]
                        s_block_lines = s_block_text.splitlines(keepends=True)
                        s_region, _ = self.extract_settlement_meta(s_block_lines)
                        
                        if s_region and settlement_to_faction.get(s_region) == current_faction:
                            # This is the first settlement for this faction
                            if s_region in self.region_map:
                                capital_region = s_region
                                self.factions_processed[current_faction]['has_valid_capital'] = True
                                self.debug_logs.append(f"Faction {current_faction}: Capital region is {capital_region}")
                            else:
                                self.debug_logs.append(f"WARNING: Faction {current_faction} has no valid capital region (region='{s_region}')")
                                self.factions_without_land.add(current_faction)
                            break
                    
                    if not capital_region:
                        self.debug_logs.append(f"WARNING: Faction {current_faction} has no settlements")
                        self.factions_without_land.add(current_faction)
                    
                    # Get native culture (but slave faction doesn't need it)
                    if current_faction in NO_MILITARY_FACTIONS:
                        # Slave faction - set dummy values
                        native_culture = "none"
                        self.factions_processed[current_faction]['has_native_culture'] = True
                    elif current_faction in self.factions_meta:
                        fmeta = self.factions_meta[current_faction]
                        native_culture = (fmeta.get("default_religion") or fmeta.get("culture") or "").strip()
                        if native_culture:
                            self.factions_processed[current_faction]['has_native_culture'] = True
                        else:
                            self.debug_logs.append(f"WARNING: Faction {current_faction} has no native culture/religion defined")
                    else:
                        self.debug_logs.append(f"WARNING: Faction {current_faction} not found in descr_sm_factions.txt")
            
            # Track settlement count for this faction
            if current_faction and current_faction in self.factions_processed:
                self.factions_processed[current_faction]['settlements_count'] += 1
            
            # Skip processing if faction has issues (but preserve the block unchanged)
            # Exception: slave faction is always processed (to remove buildings)
            if current_faction not in NO_MILITARY_FACTIONS:
                if not current_faction or not capital_region or not native_culture:
                    rebuilt.append(block_text)
                    last_end = end
                    continue
            
            # Process settlement
            rebuilt_block, changed = self.process_settlement_block(
                block_lines, current_faction, capital_region, native_culture
            )
            
            if changed:
                settlements_changed += 1
            
            rebuilt.append("".join(rebuilt_block))
            last_end = end
        
        rebuilt.append(content[last_end:])
        
        # Write outputs
        _out.mkdir(parents=True, exist_ok=True)
        (_out / "descr_strat.txt").write_text("".join(rebuilt), encoding='utf-8')

        # Write comprehensive summary with changes at the top
        summary_output = []
        summary_output.append("="*80)
        summary_output.append("MILITARY BUILDINGS SUMMARY")
        summary_output.append("="*80)
        summary_output.append("")
        summary_output.append(f"Total settlements processed: {len(blocks)}")
        summary_output.append(f"Total settlements with military buildings: {len(self.all_military_buildings)}")
        summary_output.append(f"Total changes made: {settlements_changed}")
        summary_output.append("")
        summary_output.append("="*80)
        summary_output.append("CHANGES MADE (Items marked with [CHANGED])")
        summary_output.append("="*80)
        summary_output.append("")
        
        # Extract only changed items
        changes_only = [line for line in self.changelog if line.startswith("[CHANGED]")]
        if changes_only:
            for change in changes_only:
                # Remove the [CHANGED] prefix for display
                summary_output.append(change.replace("[CHANGED] ", ""))
        else:
            summary_output.append("No changes were made.")
        
        summary_output.append("")
        summary_output.append("="*80)
        summary_output.append("ALL MILITARY BUILDINGS (Complete List)")
        summary_output.append("="*80)
        summary_output.append("")
        
        if self.all_military_buildings:
            for building in sorted(self.all_military_buildings):
                summary_output.append(building)
        else:
            summary_output.append("No military buildings found.")
        
        (_out / "military_buildings_summary.txt").write_text("\n".join(summary_output), encoding='utf-8')

        # Write other output files
        (_out / "decisions.txt").write_text("\n".join(self.decisions), encoding='utf-8')
        (_out / "buildings.txt").write_text("\n".join(sorted(self.building_set)), encoding='utf-8')

        # Enhanced debug log with faction analysis
        debug_output = self.debug_logs.copy()
        debug_output.append("\n" + "="*60)
        debug_output.append("FACTION PROCESSING SUMMARY")
        debug_output.append("="*60)

        for faction_id, info in sorted(self.factions_processed.items()):
            debug_output.append(f"\nFaction: {faction_id}")
            debug_output.append(f"  Settlements found: {info['settlements_count']}")
            debug_output.append(f"  Has valid capital: {info['has_valid_capital']}")
            debug_output.append(f"  Has native culture: {info['has_native_culture']}")
            debug_output.append(f"  Processed: {info['has_valid_capital'] and info['has_native_culture']}")
            if faction_id in NO_MILITARY_FACTIONS:
                debug_output.append(f"  Note: NO_MILITARY_FACTIONS - all military buildings removed")

        if self.factions_without_land:
            debug_output.append(f"\nFactions without valid starting land: {sorted(self.factions_without_land)}")

        (_out / "debug_log.txt").write_text("\n".join(debug_output), encoding='utf-8')

        print(f"\nProcessing complete!")
        print(f"Total military buildings: {len(self.all_military_buildings)}")
        print(f"Settlements changed: {settlements_changed}")
        print(f"Factions processed: {sum(1 for f in self.factions_processed.values() if f['has_valid_capital'] and f['has_native_culture'])}")
        print(f"Factions skipped (no valid land): {len(self.factions_without_land)}")
        if self.factions_without_land:
            print(f"  Skipped factions: {', '.join(sorted(list(self.factions_without_land)[:10]))}" + (" ..." if len(self.factions_without_land) > 10 else ""))
        print(f"Output saved to: {_out}")
        print(f"\nSee 'military_buildings_summary.txt' for complete list and changes")


if __name__ == "__main__":
    MilitaryBuildingProcessor().run()