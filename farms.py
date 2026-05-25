import sys, re, json
from pathlib import Path
from datetime import datetime

# --- CONFIG ---
BASE_DIR = Path(__file__).parent
CONFIG_DIR = BASE_DIR / "config"
OUTPUT_DIR = BASE_DIR / "processed_output"
STRAT_FILE = CONFIG_DIR / "descr_strat.txt"
REGIONS_FILE = CONFIG_DIR / "descr_regions.txt"
EDB_FILE = CONFIG_DIR / "export_descr_buildings.txt"

EXCLUDE_SETTLEMENTS = set()  # Add settlement names to exclude if needed

LEVEL_TO_TIER = {
    "village": 0,
    "town": 1,
    "large_town": 2,
    "minor_city": 3,
    "city": 3,
    "large_city": 4,
    "huge_city": 5
}

TIER_TO_LEVEL = {v: k for k, v in LEVEL_TO_TIER.items()}

FARM_CHAINS = [
    "irrigated_farming", "rainfed_farming", "qanat_farming", "highland_pastoralism",
    "sedentary_animal_husbandry", "marsh_reclamation", "wetland_pastoralism",
    "nomadic_pastoralism", "forest_pastoralism", "shifting_cultivation",
    "farms"
]

BUMP_AMOUNT = 1  # Extra tiers required above building minimum (set to 0 to disable bump)
FERTILITY_SKIP_BUMP = 10  # Skip bump rule when region fertility >= this value

class FarmExploitProcessor:
    def __init__(self):
        self.region_map = {}
        self.resources_by_region = {}
        self.chains_with_minimums = {}
        self.region_to_city = {}
        self.changelog = []
        self.decisions = []
        self.debug_logs = []
        self.settlements_farm_exploit = {}
        self.building_set = set()
        self.tie_settlements = []
        self.previous_assignments = {}

    def get_block(self, text, start_offset):
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
                return text[first_brace + 1: i], i + 1
        return None, -1

    def parse_edb_farm_levels_with_settlement_min(self):
        """Parse export_descr_buildings.txt for farm chain levels"""
        if not EDB_FILE.exists():
            self.debug_logs.append(f"WARNING: EDB file not found: {EDB_FILE}")
            return {}
        
        with open(EDB_FILE, 'r', encoding='utf-8', errors='ignore') as f:
            full_content = f.read()
        
        chains = {}
        building_matches = re.finditer(r'^\s*building\s+(\w+)', full_content, re.MULTILINE)
        
        for match in building_matches:
            building_name = match.group(1)
            full_building_text, _ = self.get_block(full_content, match.end())
            if not full_building_text: continue
            if building_name not in FARM_CHAINS: continue
            
            levels_match = re.search(r'levels\s+([^\n{]+)', full_building_text)
            if not levels_match: continue
            
            level_names = levels_match.group(1).strip().split()
            levels_block_content, _ = self.get_block(full_building_text, levels_match.end())
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
                    block, next_pos = self.get_block(chunk, search_for_block_start)
                    if block is None: break
                    level_def_content = block
                    search_for_block_start = next_pos
                
                s_match = re.search(r'settlement_min\s+(\w+)', level_def_content)
                edb_min = None
                if s_match:
                    edb_min = s_match.group(1)
                    last_known_min = edb_min
                elif last_known_min:
                    edb_min = last_known_min
                
                levels_info.append({'level': level_name, 'settlement_min': edb_min})
            
            if levels_info:
                chains[building_name] = levels_info
        
        return chains

    def load_regions_data(self):
        """Load region data from descr_regions.txt"""
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
                self.region_map[current_region] = {"capital": None, "hidden_resources": set(), "fertility": 0}
                line_count = 0
                self.debug_logs.append(f"Found region: {current_region}")
            elif current_region:
                line_count += 1
                # Line 2 is the capital
                if line_count == 1:
                    capital = line.strip()
                    self.region_map[current_region]["capital"] = capital
                    self.region_to_city[current_region] = capital
                # Line 6 contains the resources
                elif line_count == 5:
                    # Parse comma-separated resources
                    resources = [r.strip().lower() for r in line.strip().split(',')]
                    self.region_map[current_region]["hidden_resources"].update(resources)
                    self.debug_logs.append(f"  Resources for {current_region}: {resources[:10]}...")
                # Line 8: Fertility
                elif line_count == 7:
                    try:
                        self.region_map[current_region]["fertility"] = int(line.strip())
                    except ValueError:
                        pass

    def parse_resources_by_region(self, strat_text):
        """Parse resources from descr_strat.txt - handles hyphens and ampersands"""
        # FIXED: Added hyphen and ampersand to character class for region names
        for m in re.finditer(r'resource\s+([\w_-]+),\s*([\d.]+),\s*\d+,\s*\d+\s*;\s*([\w_&-]+)', strat_text, flags=re.IGNORECASE):
            region = m.group(3).strip()
            resource = m.group(1)
            amount = float(m.group(2))
            if region not in self.resources_by_region:
                self.resources_by_region[region] = {}
            self.resources_by_region[region][resource] = self.resources_by_region[region].get(resource, 0) + amount

    def extract_settlement_meta(self, block):
        """Extract settlement metadata - handles hyphens and ampersands"""
        region, level = None, "town"
        resources = {}
        farm_exploit_type = None
        farm_exploit_level = None
        
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
            elif s.startswith("resource"):
                parts = s.split()
                if len(parts) >= 3:
                    res = parts[1].replace(",", "")
                    try: 
                        amt = float(parts[2].replace(",", ""))
                    except: 
                        amt = 1
                    resources[res] = resources.get(res, 0) + amt
            elif s.startswith("building"):
                i = block.index(l)
                while i < len(block) and "}" not in block[i]:
                    if block[i].strip().startswith("type"):
                        type_parts = block[i].strip().split()
                        if len(type_parts) >= 2 and type_parts[1] in FARM_CHAINS:
                            farm_exploit_type = type_parts[1]
                            if len(type_parts) > 2:
                                farm_exploit_level = type_parts[2]
                    i += 1
        
        return region, level, resources, farm_exploit_type, farm_exploit_level

    def has_any(self, dictionary, keys):
        return any(k in dictionary for k in keys)

    def has_any_hr(self, hidden_resources, keys):
        return any(k in hidden_resources for k in keys)

    # Tier-1 farm levels that should never be assigned (base clearing levels)
    BLOCKED_FARM_LEVELS = {"land_clearance", "farms"}

    def choose_farm_level_for_settlement(self, farm_levels, settlement_tier, fertility=0):
        skip_bump = fertility >= FERTILITY_SKIP_BUMP
        bump = 0 if skip_bump else BUMP_AMOUNT
        allowed = []
        for lvl in farm_levels:
            min_size = lvl.get('settlement_min', None)
            if min_size is None:
                continue
            if lvl['level'] in self.BLOCKED_FARM_LEVELS:
                continue
            min_tier = LEVEL_TO_TIER.get(min_size, 1)
            if settlement_tier >= min_tier + bump:
                allowed.append(lvl['level'])
        if not allowed:
            return None
        return allowed[-1]

    def select_farm_chain(self, hidden, resources, tier, owner_faction, fertility=0, debug_log=None):
        if debug_log is None:
            debug_log = []

        def logmsg(msg):
            debug_log.append(msg)

        logmsg(f"select_farm_chain inputs: hidden={hidden}, resources={resources}, tier={tier}, owner_faction={owner_faction}, fertility={fertility}")

        if tier < 2:
            logmsg(f"Tier {tier} is too low for farm selection.")
            return None, None

        def pick_chain(chain_name):
            lvls = self.chains_with_minimums.get(chain_name)
            if lvls:
                farm_level = self.choose_farm_level_for_settlement(lvls, tier, fertility=fertility)
                if farm_level:
                    logmsg(f"Selected {chain_name}, level: {farm_level}")
                    return chain_name, farm_level
            return None, None

        # Forest logic - forest_pastoralism for cold climates or livestock, otherwise shifting_cultivation
        if "forest" in hidden:
            if "sub_artic" in hidden or "alpine" in hidden or "livestock" in resources:
                logmsg("Forest + cold climate or livestock detected, selecting forest_pastoralism")
                return pick_chain("forest_pastoralism")
            logmsg("Forest in warm climate without livestock, selecting shifting_cultivation")
            return pick_chain("shifting_cultivation")

        if "river_valley" in hidden:
            if "livestock" in resources and self.has_any(resources, ["horses", "sheep", "salt", "elephants", "wild_animals"]):
                return pick_chain("sedentary_animal_husbandry")
            if not self.has_any_hr(hidden, ["oceanic", "continental", "temperate"]):
                return pick_chain("irrigated_farming")
            if self.has_any_hr(hidden, ["oceanic", "continental", "temperate"]):
                return pick_chain("rainfed_farming")

        if "plateau" in hidden:
            plateau_irrigation = ["irrigation_river", "irrigation_springs", "irrigation_lake", "irrigation_oasis"]
            climate = ["oceanic", "continental", "temperate", "sub_artic"]
            if "irrigation_aquifer" in hidden:
                return pick_chain("qanat_farming")
            if "sheep" in resources:
                return pick_chain("highland_pastoralism")
            if (not self.has_any_hr(hidden, plateau_irrigation + ["arid", "sub_artic", "alpine"])) or self.has_any_hr(hidden, ["oceanic", "continental", "temperate"]):
                return pick_chain("rainfed_farming")
            if ("plateau" in hidden and self.has_any_hr(hidden, plateau_irrigation)) and not self.has_any_hr(hidden, climate):
                return pick_chain("irrigated_farming")
            return pick_chain("highland_pastoralism")

        if "steppe" in hidden:
            if "irrigation_aquifer" in hidden and ("grain" in resources or "sulphur" in resources or "cotton" in resources):
                return pick_chain("qanat_farming")
            if any(r in resources for r in ["livestock", "horses", "camels", "wild_animals"]):
                return pick_chain("nomadic_pastoralism")
            if (any(hr in hidden for hr in ["irrigation_river", "irrigation_springs", "irrigation_lake", "irrigation_oasis"]) and any(r in resources for r in ["grain", "sulphur", "cotton", "wine"]) and not any(hr in hidden for hr in ["oceanic", "continental", "temperate", "sub_artic"])):
                return pick_chain("irrigated_farming")
            if "sub_artic" in hidden:
                return pick_chain("nomadic_pastoralism")
            if (not any(hr in hidden for hr in ["arid", "irrigation_river", "irrigation_springs", "irrigation_lake", "irrigation_oasis"]) or any(hr in hidden for hr in ["oceanic", "continental", "temperate"])):
                return pick_chain("rainfed_farming")
            return pick_chain("nomadic_pastoralism")

        if "hills" in hidden:
            hills_irrigation = ["irrigation_river", "irrigation_springs", "irrigation_lake", "irrigation_oasis"]
            climate = ["oceanic", "continental", "temperate", "sub_artic"]
            if "irrigation_aquifer" in hidden:
                return pick_chain("qanat_farming")
            if (self.has_any(resources, ["grain", "sulphur", "wine", "olive_oil", "cotton"])
                    and (not self.has_any_hr(hidden, hills_irrigation + ["arid", "sub_artic", "alpine"])
                         or self.has_any_hr(hidden, ["oceanic", "continental", "temperate"]))):
                return pick_chain("rainfed_farming")
            if self.has_any(resources, ["sheep", "livestock"]):
                return pick_chain("highland_pastoralism")
            if (self.has_any(resources, ["grain", "sulphur", "wine", "olive_oil", "cotton"]) and self.has_any_hr(hidden, hills_irrigation) and not self.has_any_hr(hidden, climate)):
                return pick_chain("irrigated_farming")
            return pick_chain("highland_pastoralism")

        if "mountain_valley" in hidden:
            mv_irrigation = ["irrigation_river", "irrigation_springs", "irrigation_lake", "irrigation_oasis"]
            climate = ["oceanic", "continental", "temperate", "sub_artic"]
            if "irrigation_aquifer" in hidden:
                return pick_chain("qanat_farming")
            if (self.has_any(resources, ["grain", "sulphur", "wine", "olive_oil", "cotton"])
                    and (not self.has_any_hr(hidden, mv_irrigation + ["arid", "sub_artic", "alpine"])
                         or self.has_any_hr(hidden, ["oceanic", "continental", "temperate"]))):
                return pick_chain("rainfed_farming")
            if (self.has_any(resources, ["grain", "sulphur", "wine", "olive_oil", "cotton"]) and self.has_any_hr(hidden, mv_irrigation) and not self.has_any_hr(hidden, climate)):
                return pick_chain("irrigated_farming")
            return pick_chain("highland_pastoralism")

        if "mountains" in hidden:
            return pick_chain("highland_pastoralism")

        if "desert" in hidden:
            if "irrigation_aquifer" in hidden and self.has_any(resources,["dates","grain","fruits","cotton"]):
                return pick_chain("qanat_farming")
            if self.has_any_hr(hidden,["irrigation_river","irrigation_springs","irrigation_lake","irrigation_oasis"]) and self.has_any(resources,["dates","grain","fruits","cotton"]):
                return pick_chain("irrigated_farming")
            return pick_chain("nomadic_pastoralism")

        if "small_islands_and_rocky_coast" in hidden:
            if self.has_any(resources, ["sulphur", "wine", "olive_oil", "slave_trade", "fruits", "cotton", "grain"]) and not self.has_any_hr(hidden, ["arid", "irrigation_river", "irrigation_springs", "irrigation_lake", "irrigation_oasis"]):
                return pick_chain("rainfed_farming")
            if self.has_any(resources, ["sulphur", "wine", "olive_oil", "slave_trade", "fruits", "cotton", "grain"]) and self.has_any_hr(hidden, ["irrigation_river", "irrigation_springs", "irrigation_lake", "irrigation_oasis"]) and not self.has_any_hr(hidden, ["oceanic", "continental", "temperate", "sub_artic"]):
                return pick_chain("irrigated_farming")
            if self.has_any(resources, ["sheep", "livestock"]):
                return pick_chain("sedentary_animal_husbandry")
            if self.has_any_hr(hidden, ["oceanic", "continental", "temperate"]) and self.has_any(resources, ["sulphur", "wine", "olive_oil", "slave_trade", "fruits", "cotton", "flax"]):
                return pick_chain("rainfed_farming")
            return pick_chain("sedentary_animal_husbandry")

        if "karst_terrain" in hidden:
            irrigation = {"irrigation_river", "irrigation_springs", "irrigation_lake", "irrigation_oasis"}
            climate = {"oceanic", "continental", "temperate", "sub_artic"}
            climate_rule2 = {"oceanic", "continental", "temperate"}  # sub_artic excluded from rule 2 only
            if self.has_any(resources, ["sheep", "livestock"]):
                return pick_chain("highland_pastoralism")
            if not self.has_any_hr(hidden, irrigation) or self.has_any_hr(hidden, climate_rule2):
                return pick_chain("rainfed_farming")
            if self.has_any_hr(hidden, irrigation) and not self.has_any_hr(hidden, climate):
                return pick_chain("irrigated_farming")

        # FIXED: Wetlands logic - handle all Roman factions + aetolia
        if "wetlands" in hidden:
            # Factions that can reclaim marshes - EXPANDED to include all Roman factions + aetolia
            allowed = {
                "acarnania", "aetolia", "bosporan", "carthage", "emporion", "massalia", 
                "mauryan", "olbia", "pentapolis", "ptolemaic", "seleucid", "characene",
                # All Roman factions:
                "romans_julii", "roman_rebels_1", "roman_rebels_2", "roman_senate"
            }
            faction_lower = owner_faction.strip().lower()
            logmsg(f"Wetlands detected. Owner faction: {faction_lower}")
            
            if faction_lower in allowed and self.has_any(resources, ["grain", "sulphur", "slave_trade", "wine", "olive_oil", "cotton", "fruits"]):
                logmsg(f"Faction {faction_lower} can reclaim marshes (has qualifying resource), selecting marsh_reclamation")
                return pick_chain("marsh_reclamation")
            else:
                logmsg(f"Faction {faction_lower} -> wetland_pastoralism")
                return pick_chain("wetland_pastoralism")

        if "grassland" in hidden:
            if self.has_any(resources, ["livestock"]) and self.has_any(resources, ["horses", "sheep", "salt", "elephants", "wild_animals"]):
                return pick_chain("sedentary_animal_husbandry")
            if self.has_any_hr(hidden, ["irrigation_river", "irrigation_springs", "irrigation_lake", "irrigation_oasis"]) and not self.has_any_hr(hidden, ["oceanic", "continental", "temperate", "sub_artic"]):
                return pick_chain("irrigated_farming")
            if (self.has_any_hr(hidden, ["grassland"]) and not self.has_any_hr(hidden, ["irrigation_river", "irrigation_springs", "irrigation_lake", "irrigation_oasis"])) or (self.has_any_hr(hidden, ["grassland"]) and self.has_any_hr(hidden, ["oceanic", "continental", "temperate"])):
                return pick_chain("rainfed_farming")

        if "floodplains_delta" in hidden:
            sed = self.chains_with_minimums.get("sedentary_animal_husbandry", [])
            irr = self.chains_with_minimums.get("irrigated_farming", [])
            rain = self.chains_with_minimums.get("rainfed_farming", [])
            logmsg(f"Floodplains_delta logic: sedentary={sed}, irrigated={irr}, rainfed={rain}")
            if self.has_any(resources, ["livestock"]) and self.has_any(resources, ["horses", "sheep", "salt"]) and sed:
                farm_level = self.choose_farm_level_for_settlement(sed, tier, fertility=fertility)
                if farm_level:
                    logmsg(f"Floodplains_delta: Selecting sedentary_animal_husbandry {farm_level}")
                    return "sedentary_animal_husbandry", farm_level
            elif not self.has_any_hr(hidden, ["oceanic", "continental", "temperate"]) and irr:
                farm_level = self.choose_farm_level_for_settlement(irr, tier, fertility=fertility)
                if farm_level:
                    logmsg(f"Floodplains_delta: Selecting irrigated_farming {farm_level}")
                    return "irrigated_farming", farm_level
            # rule 3 (rainfed on oceanic/continental/temperate) removed per design

        logmsg(f"No farm chain selected for current conditions.")
        return None, None

    def apply_new_tier_farming_rules(self, level, resources, hidden_resources):
        """
        NEW RULES for town, large_town, minor_city, and large_city (override old rules when conditions apply).
        Returns (farm_chain, farm_level, market_needed) or (None, None, False) if no match.
        """
        
        # Helper functions
        def grain_high():
            return "grain" in resources and resources["grain"] in (3, 4, 5)
        
        def livestock_high():
            return "livestock" in resources and resources["livestock"] in (3, 4, 5)
        
        def sheep_high():
            return "sheep" in resources and resources["sheep"] in (3, 4, 5)
        
        def horses_high():
            return "horses" in resources and resources["horses"] in (3, 4, 5)
        
        def camels_high():
            return "camels" in resources and resources["camels"] in (3, 4, 5)
        
        # Define hidden resource sets
        farm10_14 = {"farm10", "farm11", "farm12", "farm13", "farm14"}
        farm11_14 = {"farm11", "farm12", "farm13", "farm14"}
        terrain_hidden = {"grassland", "river_valley", "floodplains_delta"}
        irrigation_hidden = {"irrigation_river", "irrigation_springs", "irrigation_lake", "irrigation_oasis"}
        cold_hidden = {"temperate", "continental", "sub_artic", "alpine"}
        temperate_hidden = {"temperate", "continental"}
        highland_hidden = {"mountain_valley", "mountains", "hills", "plateau"}
        
        # ==================== TOWN RULES ====================
        if level == "town":
            # Rule 1: irrigated_farming irrigation_ditches
            if (
                (hidden_resources.intersection(farm10_14) or grain_high())
                and hidden_resources.intersection(terrain_hidden)
                and hidden_resources.intersection(irrigation_hidden)
                and not hidden_resources.intersection(cold_hidden)
            ):
                return "irrigated_farming", "irrigation_ditches", False
            
            # Rule 2: rainfed_farming land_clearance
            if (
                (hidden_resources.intersection(farm11_14) or grain_high())
                and hidden_resources.intersection(terrain_hidden)
                and hidden_resources.intersection(temperate_hidden)
            ):
                return "rainfed_farming", "land_clearance", False
            
            # Rule 3: highland_pastoralism slope_herding
            if (
                (livestock_high() or sheep_high())
                and hidden_resources.intersection(highland_hidden)
            ):
                return "highland_pastoralism", "slope_herding", False
            
            # Rule 4: nomadic_pastoralism nomadic_herding
            if (
                (livestock_high() or horses_high() or camels_high())
                and "steppe" in hidden_resources
            ):
                return "nomadic_pastoralism", "nomadic_herding", False
        
        # ==================== LARGE TOWN RULES ====================
        elif level == "large_town":
            # Rule 1: irrigated_farming basin_irrigation
            if (
                (hidden_resources.intersection(farm10_14) or grain_high())
                and hidden_resources.intersection(terrain_hidden)
                and hidden_resources.intersection(irrigation_hidden)
                and not hidden_resources.intersection(cold_hidden)
            ):
                return "irrigated_farming", "basin_irrigation", False
            
            # Rule 2: rainfed_farming contour_furrows
            if (
                (hidden_resources.intersection(farm11_14) or grain_high())
                and hidden_resources.intersection(terrain_hidden)
                and hidden_resources.intersection(temperate_hidden)
            ):
                return "rainfed_farming", "contour_furrows", False
            
            # Rule 3: highland_pastoralism highland_pasturing
            if (
                (livestock_high() or sheep_high())
                and hidden_resources.intersection(highland_hidden)
            ):
                return "highland_pastoralism", "highland_pasturing", False
            
            # Rule 4: nomadic_pastoralism collective_draw_rights
            if (
                (livestock_high() or horses_high() or camels_high())
                and "steppe" in hidden_resources
            ):
                return "nomadic_pastoralism", "collective_draw_rights", False
        
        # ==================== MINOR CITY RULES ====================
        elif level == "minor_city":
            # Rule 1: irrigated_farming canal_network
            if (
                (hidden_resources.intersection(farm10_14) or grain_high())
                and hidden_resources.intersection(terrain_hidden)
                and hidden_resources.intersection(irrigation_hidden)
                and not hidden_resources.intersection(cold_hidden)
            ):
                return "irrigated_farming", "canal_network", False
            
            # Rule 2: rainfed_farming terraces
            if (
                (hidden_resources.intersection(farm11_14) or grain_high())
                and hidden_resources.intersection(terrain_hidden)
                and hidden_resources.intersection(temperate_hidden)
            ):
                return "rainfed_farming", "terraces", False
            
            # Rule 3: highland_pastoralism transhumance
            if (
                (livestock_high() or sheep_high())
                and hidden_resources.intersection(highland_hidden)
            ):
                return "highland_pastoralism", "transhumance", False
            
            # Rule 4: nomadic_pastoralism communal_grazing_zones
            if (
                (livestock_high() or horses_high() or camels_high())
                and "steppe" in hidden_resources
            ):
                return "nomadic_pastoralism", "communal_grazing_zones", False
        
        # ==================== LARGE CITY RULES ====================
        elif level == "large_city":
            # Rule 1: irrigated_farming irrigation_aquaducts
            if (
                (hidden_resources.intersection(farm10_14) or grain_high())
                and hidden_resources.intersection(terrain_hidden)
                and hidden_resources.intersection(irrigation_hidden)
                and not hidden_resources.intersection(cold_hidden)
            ):
                return "irrigated_farming", "irrigation_aquaducts", False
            
            # Rule 2: rainfed_farming runoff_harvesting
            if (
                (hidden_resources.intersection(farm11_14) or grain_high())
                and hidden_resources.intersection(terrain_hidden)
                and hidden_resources.intersection(temperate_hidden)
            ):
                return "rainfed_farming", "runoff_harvesting", False
            
            # Rule 3: highland_pastoralism great_droveways
            if (
                (livestock_high() or sheep_high())
                and hidden_resources.intersection(highland_hidden)
            ):
                return "highland_pastoralism", "great_droveways", False
            
            # Rule 4: nomadic_pastoralism warlords_herd_reserve
            if (
                (livestock_high() or horses_high() or camels_high())
                and "steppe" in hidden_resources
            ):
                return "nomadic_pastoralism", "warlords_herd_reserve", False
        
        return None, None, False

    def process_settlement_block(self, block, farm_chain, farm_level, market_needed=False):
        new_block = []
        i = 0
        n = len(block)
        market_present = False
        
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
                        if len(type_parts) >= 2 and type_parts[1] == "market":
                            market_present = True
                    i += 1
                
                if i < n:
                    bb.append(block[i])
                    if block[i].strip().startswith("type"):
                        type_parts = block[i].strip().split()
                        if len(type_parts) >= 2 and type_parts[1] == "market":
                            market_present = True
                
                is_farm = any(l.strip().startswith("type") and len(l.strip().split()) >= 2 and l.strip().split()[1] in FARM_CHAINS for l in bb)
                if not is_farm:
                    new_block += bb
                i += 1
            else:
                new_block.append(line)
                i += 1
        
        idx = -1
        for j in reversed(range(len(new_block))):
            if new_block[j].strip() == "}":
                idx = j
                break
        
        nb = []
        if farm_chain and farm_level and farm_chain in self.chains_with_minimums:
            levels_for_chain = [lvl['level'] if isinstance(lvl, dict) else lvl for lvl in self.chains_with_minimums[farm_chain]]
            if farm_level in levels_for_chain:
                nb = ["\tbuilding\n", "\t{\n", f"\t\ttype {farm_chain} {farm_level}\n", "\t}\n"]
        
        # Add market 1 if needed and not present
        if market_needed and not market_present:
            nb += ["\tbuilding\n", "\t{\n", "\t\ttype market 1\n", "\t}\n"]
        
        if nb and idx != -1:
            while idx > 0 and new_block[idx - 1].strip() == "":
                idx -= 1
            new_block = new_block[:idx] + nb + new_block[idx:]
        
        return new_block

    def parse_farm_exploits_from_strat(self, strat_text):
        """Parse existing farm exploits - handles hyphens and ampersands"""
        settlements = {}
        lines = strat_text.splitlines()
        
        i = 0
        n = len(lines)
        
        while i < n:
            if lines[i].strip().startswith("settlement"):
                start = i
                bc = 0
                fb = False
                
                for j in range(i, n):
                    if '{' in lines[j]:
                        fb = True
                    if fb:
                        bc += lines[j].count('{')
                        bc -= lines[j].count('}')
                    if fb and bc == 0:
                        end = j
                        break
                
                block = lines[start:end + 1]
                region = None
                
                for l in block:
                    s = l.strip()
                    # FIXED: Added hyphen and ampersand to character class for region names
                    if s.startswith("region"):
                        m = re.match(r'region\s+([\w_&-]+)', s)
                        if m:
                            region = m.group(1)
                            break
                
                city = self.region_map.get(region, {}).get("capital", region)
                in_b = False
                bt = None
                bl = None
                
                for l in block:
                    s = l.strip()
                    if s.startswith("building"):
                        in_b = True
                        bt = None
                        bl = None
                    elif in_b and s.startswith("type"):
                        p = s.split()
                        if len(p) >= 3 and p[1] in FARM_CHAINS:
                            bt = p[1]
                            bl = p[2]
                    if in_b and '}' in s:
                        if bt and bl:
                            settlements[city] = f"{bt} {bl}"
                        in_b = False
                        bt = None
                        bl = None
                
                i = end + 1
            else:
                i += 1
        
        return settlements

    def _find_settlement_blocks(self, text):
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
        self.parse_resources_by_region(content)
        self.chains_with_minimums = self.parse_edb_farm_levels_with_settlement_min()
        self.previous_assignments = self.parse_farm_exploits_from_strat(content)
        
        print(f"Loaded {len(self.region_map)} regions from descr_regions.txt")
        print(f"Loaded {len(self.chains_with_minimums)} farm chains from export_descr_buildings.txt")
        
        # Find settlement blocks
        blocks = self._find_settlement_blocks(content)
        print(f"Found {len(blocks)} settlement blocks")
        
        # Process settlements
        rebuilt = []
        last_end = 0
        current_owner_faction = None
        decision_log = []
        
        for start, end in blocks:
            # Add content before this settlement
            pre_content = content[last_end:start]
            rebuilt.append(pre_content)
            
            # Check for faction change
            faction_match = re.search(r'^faction\s+([^\s,]+)', pre_content, re.MULTILINE)
            if faction_match:
                current_owner_faction = faction_match.group(1)
            
            block_text = content[start:end]
            block_lines = block_text.splitlines(keepends=True)
            
            region, level, block_resources, prev_type, prev_level = self.extract_settlement_meta(block_lines)
            city = self.region_to_city.get(region, region)
            tier = LEVEL_TO_TIER.get(level, 1)
            
            resources = {}
            log_entry = [f"--- Settlement: {city} ({region}) ---", f"Level: {level} (tier {tier})"]
            
            if region in self.resources_by_region:
                for res, amt in self.resources_by_region[region].items():
                    resources[res] = resources.get(res, 0) + amt
            
            for res, amt in block_resources.items():
                resources[res] = resources.get(res, 0) + amt
            
            debug_per_settlement = []
            region_data = self.region_map.get(region, {})
            hidden_resources = region_data.get("hidden_resources", set())
            fertility = region_data.get("fertility", 0)
            
            if city in EXCLUDE_SETTLEMENTS:
                rebuilt.append(block_text)
                self.changelog.append(f"{city} ({region}): Skipped (excluded)")
                last_end = end
                continue
            
            log_entry.append(f"Resources (total): {resources}")
            log_entry.append(f"Hidden Resources: {hidden_resources}")
            
            # --- NEW TIER FARMING RULES (OVERRIDE) ---
            farm_chain, farm_level, market_needed = self.apply_new_tier_farming_rules(level, resources, hidden_resources)
            
            if farm_chain:
                log_entry.append(f"NEW TIER RULES: Assigned farm exploit: {farm_chain} {farm_level}")
                self.settlements_farm_exploit[city] = f"{farm_chain} {farm_level}"
                self.building_set.add(f"{farm_chain} {farm_level}")
                
                rebuilt_block = self.process_settlement_block(block_lines, farm_chain, farm_level, market_needed=market_needed)
                rebuilt.append("".join(rebuilt_block))
                decision_log.append("\n".join(log_entry))
                
                # Track changes
                prev = self.previous_assignments.get(city)
                new = f"{farm_chain} {farm_level}"
                if prev != new:
                    if prev and new:
                        self.changelog.append(f"{city} ({region}): Changed from {prev} to {new}")
                    elif new:
                        self.changelog.append(f"{city} ({region}): Added {new}")
                
                last_end = end
                continue
            
            # --- FALLBACK TO NORMAL LOGIC ---
            farm_chain, farm_level = self.select_farm_chain(
                hidden_resources, resources, tier, current_owner_faction or "", fertility=fertility, debug_log=debug_per_settlement
            )
            
            if farm_chain:
                log_entry.append(f"Assigned farm exploit: {farm_chain} {farm_level}")
                self.settlements_farm_exploit[city] = f"{farm_chain} {farm_level}"
                self.building_set.add(f"{farm_chain} {farm_level}")
            else:
                log_entry.append("No farm exploit assigned: No qualifying terrain or below tier threshold.")
            
            prev = self.previous_assignments.get(city)
            new = f"{farm_chain} {farm_level}" if farm_chain else None
            if prev != new:
                if prev and new:
                    self.changelog.append(f"{city} ({region}): Changed from {prev} to {new}")
                elif new:
                    self.changelog.append(f"{city} ({region}): Added {new}")
                elif prev:
                    self.changelog.append(f"{city} ({region}): Removed {prev}")
            
            rebuilt_block = self.process_settlement_block(block_lines, farm_chain, farm_level)
            rebuilt.append("".join(rebuilt_block))
            decision_log.append("\n".join(log_entry))
            last_end = end
        
        rebuilt.append(content[last_end:])
        
        # Write outputs
        _out.mkdir(parents=True, exist_ok=True)
        (_out / "descr_strat.txt").write_text("".join(rebuilt), encoding='utf-8')
        (_out / "changelog.txt").write_text("\n".join(self.changelog), encoding='utf-8')
        (_out / "decisions.txt").write_text("\n\n".join(decision_log), encoding='utf-8')
        (_out / "buildings.txt").write_text("\n".join(sorted(self.building_set)), encoding='utf-8')
        (_out / "debug_log.txt").write_text("\n".join(self.debug_logs), encoding='utf-8')

        print(f"DONE. Check {_out} for logs.")

if __name__ == "__main__":
    FarmExploitProcessor().run()