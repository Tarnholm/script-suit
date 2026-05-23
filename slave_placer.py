"""
slave_placer.py — Places one 'slaves' resource per region at a free pixel.

Reads the incoming descr_strat.txt to find already-used resource coordinates,
then adds one slave resource line per region that doesn't already have one.
Writes the modified descr_strat.txt and a changelog.

Requires map_regions.tga from the campaign folder for pixel lookups.
"""

import sys, re
from pathlib import Path
from collections import defaultdict
from PIL import Image

# --- CONFIG ---
BASE_DIR = Path(__file__).parent
CONFIG_DIR = BASE_DIR / "config"
OUTPUT_DIR = BASE_DIR / "processed_output"

REGIONS_FILE = CONFIG_DIR / "descr_regions.txt"
MAP_REGIONS_FILE = CONFIG_DIR / "map_regions.tga"


def parse_descr_regions(file_path):
    regions_by_color = {}
    colors_by_region = {}
    region = None
    with open(file_path, encoding="utf-8") as f:
        for line in f:
            s = line.strip()
            if not s or s.startswith(";"):
                continue
            if not line[:1].isspace():
                region = s
                continue
            if region is not None:
                match = re.match(r"^(\d+)\s+(\d+)\s+(\d+)$", s)
                if match:
                    rgb = tuple(map(int, match.groups()))
                    regions_by_color[rgb] = region
                    colors_by_region[region] = rgb
                    region = None
    return regions_by_color, colors_by_region


def get_region_pixels(map_path, regions_by_color):
    region_pixels = defaultdict(set)
    with Image.open(map_path) as img:
        img = img.convert("RGB")
        width, height = img.size
        for y in range(height):
            for x in range(width):
                color = img.getpixel((x, y))
                region = regions_by_color.get(color)
                if region:
                    region_pixels[region].add((x, y))
    return region_pixels, width, height


def ingame_to_image_coords(x, y, image_height):
    return (x, image_height - y - 1)


def image_to_ingame_coords(x, y, image_height):
    return (x, image_height - y - 1)


def parse_existing_resources(strat_text):
    """Extract all resource coordinates and which regions already have slaves."""
    used_coords = defaultdict(set)
    regions_with_slaves = set()
    resource_re = re.compile(
        r"^resource\s+(\S+),\s*\d+,\s*(\d+),\s*(\d+)\s*;\s*(.+)", re.IGNORECASE
    )
    for line in strat_text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith(";"):
            continue
        m = resource_re.match(stripped)
        if m:
            res_type = m.group(1).rstrip(",")
            x = int(m.group(2))
            y = int(m.group(3))
            region = m.group(4).strip()
            used_coords[region].add((x, y))
            if res_type == "slaves":
                regions_with_slaves.add(region)
    return used_coords, regions_with_slaves


def find_last_resource_line(lines):
    """Find the index of the last 'resource ...' line in the file."""
    last_idx = -1
    for i, line in enumerate(lines):
        if line.strip().startswith("resource"):
            last_idx = i
    return last_idx


def run(run_strat=None, run_out=None):
    _strat = Path(run_strat) if run_strat else CONFIG_DIR / "descr_strat.txt"
    _out = Path(run_out) if run_out else OUTPUT_DIR / "slave_placer"

    if not _strat.exists():
        print(f"ERROR: {_strat} not found")
        sys.exit(1)

    if not MAP_REGIONS_FILE.exists():
        print(f"ERROR: {MAP_REGIONS_FILE} not found — copy map_regions.tga into config/")
        sys.exit(1)

    # Load region pixel data
    regions_by_color, colors_by_region = parse_descr_regions(REGIONS_FILE)
    region_pixels, image_width, image_height = get_region_pixels(MAP_REGIONS_FILE, regions_by_color)

    # Read input strat
    strat_text = _strat.read_text(encoding="utf-8")
    used_coords, regions_with_slaves = parse_existing_resources(strat_text)

    print(f"  Regions in map: {len(colors_by_region)}")
    print(f"  Existing resource placements: {sum(len(v) for v in used_coords.values())}")
    print(f"  Regions already with slaves: {len(regions_with_slaves)}")

    # Generate slave placements for regions that don't have one yet
    changelog = []
    new_lines = []
    skipped = []

    for region in sorted(colors_by_region.keys()):
        if region in regions_with_slaves:
            continue

        region_pixel_set = region_pixels.get(region, set())
        if not region_pixel_set:
            skipped.append(f"{region}: no pixels in map_regions")
            continue

        # Convert existing in-game coords to image coords
        used_image_pixels = set()
        for (gx, gy) in used_coords.get(region, set()):
            used_image_pixels.add(ingame_to_image_coords(gx, gy, image_height))

        available = [p for p in region_pixel_set if p not in used_image_pixels]
        if not available:
            skipped.append(f"{region}: no free pixels")
            continue

        chosen = available[0]
        ingame_x, ingame_y = image_to_ingame_coords(chosen[0], chosen[1], image_height)
        new_lines.append(f"resource\tslaves,\t1,\t{ingame_x},\t{ingame_y}\t;{region}")
        changelog.append(f"Added slaves to {region} at ({ingame_x}, {ingame_y})")

    # Insert new slave lines after the last existing resource line
    lines = strat_text.splitlines(keepends=True)
    last_res_idx = find_last_resource_line(lines)

    if last_res_idx >= 0 and new_lines:
        # Insert after the last resource line
        insert_block = "\n;slaves (auto-placed)\n" + "\n".join(new_lines) + "\n"
        # Ensure the last resource line ends with newline
        if not lines[last_res_idx].endswith("\n"):
            lines[last_res_idx] += "\n"
        lines.insert(last_res_idx + 1, insert_block)
    elif new_lines:
        # No existing resources found — append at end
        lines.append("\n;slaves (auto-placed)\n" + "\n".join(new_lines) + "\n")

    modified_strat = "".join(lines)

    # Write outputs
    _out.mkdir(parents=True, exist_ok=True)
    (_out / "descr_strat.txt").write_text(modified_strat, encoding="utf-8")

    changelog_text = "\n".join(changelog) if changelog else "No new slaves placed (all regions already had slaves)."
    if skipped:
        changelog_text += "\n\n; Skipped:\n" + "\n".join(f";  {s}" for s in skipped)
    (_out / "changelog.txt").write_text(changelog_text, encoding="utf-8")

    print(f"  Placed slaves in {len(new_lines)} new regions.")
    if skipped:
        print(f"  Skipped {len(skipped)} regions (no pixels).")


if __name__ == "__main__":
    run()
