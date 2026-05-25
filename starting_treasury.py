#!/usr/bin/env python3
"""
starting_treasury.py — sets each faction's starting denari in descr_strat:

    denari = 5000 + 500 * (number of starting settlements)

Certain factions are left exactly as-is (slave/dummies and the emergent/rebel
markers in KEEP). Pipeline step: .run(run_strat=, run_out=) — reads the strat it's
given and writes descr_strat.txt to run_out (does not edit files in place).
"""

import sys, re
sys.dont_write_bytecode = True
from pathlib import Path

BASE_DIR = Path(__file__).parent
CONFIG_DIR = BASE_DIR / "config"
OUTPUT_DIR = BASE_DIR / "processed_output"
STRAT_FILE = CONFIG_DIR / "descr_strat.txt"

# Factions left untouched (no formula applied).
KEEP = {
    "slave", "dummies",
    "egypt", "greeks", "lycia", "chrysaoria",
    "ptolemaic_rebels", "seleucid_rebels", "seleucid_rebels2",
}
BASE_DENARI, PER_REGION = 5000, 500

_faction_re = re.compile(r"^faction\s+(\S+?),")
_denari_re = re.compile(r"^(denari)(\s+)(-?\d+)\s*$")
_settlement_re = re.compile(r"^settlement\s*$")


class StartingTreasuryProcessor:
    def __init__(self):
        self.changelog = []
        self.decisions = []

    def run(self, run_strat=None, run_out=None):
        _strat = Path(run_strat) if run_strat else STRAT_FILE
        _out = Path(run_out) if run_out else OUTPUT_DIR
        if not _strat.exists():
            print(f"ERROR: Strategy file not found: {_strat}")
            return
        lines = _strat.read_text(encoding="utf-8", errors="ignore").splitlines(keepends=True)

        # Pass 1: per faction, find its denari line index and count settlements.
        order, denari_idx, counts = [], {}, {}
        cur = None
        for i, line in enumerate(lines):
            m = _faction_re.match(line)
            if m:
                cur = m.group(1)
                order.append(cur)
                counts[cur] = 0
                denari_idx[cur] = None
                continue
            if cur is None:
                continue
            if denari_idx[cur] is None and _denari_re.match(line) and "denari_kings_purse" not in line:
                denari_idx[cur] = i
                continue
            if _settlement_re.match(line):
                counts[cur] += 1

        # Pass 2: rewrite denari lines.
        changed = 0
        for name in order:
            idx = denari_idx[name]
            if idx is None:
                self.decisions.append(f"WARN: no denari line for {name}")
                continue
            m = _denari_re.match(lines[idx])
            old = int(m.group(3))
            if name in KEEP:
                self.decisions.append(f"{name}: KEEP (denari {old})")
                continue
            new = BASE_DENARI + PER_REGION * counts[name]
            self.decisions.append(f"{name}: {counts[name]} settlements -> denari {new} (was {old})")
            if new != old:
                lines[idx] = f"{m.group(1)}{m.group(2)}{new}\n"
                self.changelog.append(f"{name}: denari {old} -> {new} ({counts[name]} settlements)")
                changed += 1

        _out.mkdir(parents=True, exist_ok=True)
        (_out / "descr_strat.txt").write_text("".join(lines), encoding="utf-8")
        (_out / "changelog.txt").write_text("\n".join(self.changelog) if self.changelog else "No changes were made.", encoding="utf-8")
        (_out / "decisions.txt").write_text("\n".join(self.decisions), encoding="utf-8")
        print(f"Starting treasury: {changed} faction denari values changed. Output: {_out}")


if __name__ == "__main__":
    StartingTreasuryProcessor().run()
