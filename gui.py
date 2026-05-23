"""
Apple's Settlement Processor Suite — GUI
"""

import sys
sys.dont_write_bytecode = True

import os
import re
import json
import shutil
import threading
import queue
import io
from pathlib import Path
from datetime import datetime

import customtkinter as ctk
import tkinter as tk
from tkinter import filedialog

try:
    import darkdetect
except ImportError:
    darkdetect = None

# ── Dual Theme System ─────────────────────────────────────────────────────

THEMES = {
    "light": {
        "bg":             "#F5F5F7",
        "surface":        "#FFFFFF",
        "surface_raised": "#FFFFFF",
        "sidebar":        "#EBEBF0",
        "sidebar_hover":  "#DDDDE3",
        "accent":         "#0071E3",
        "accent_hover":   "#0077ED",
        "accent_muted":   "#E8F0FE",
        "success":        "#34C759",
        "success_muted":  "#E5F8EC",
        "warning":        "#FF9500",
        "warning_muted":  "#FFF3E0",
        "error":          "#FF3B30",
        "error_muted":    "#FFEBEE",
        "text1":          "#1D1D1F",
        "text2":          "#6E6E73",
        "text3":          "#AEAEB2",
        "border":         "#D2D2D7",
        "border_subtle":  "#E5E5EA",
        "input_bg":       "#F2F2F7",
        "log_bg":         "#1E1E2E",
        "log_text":       "#CDD6F4",
        "log_dim":        "#6C7086",
        "log_accent":     "#89B4FA",
        "log_green":      "#A6E3A1",
        "log_red":        "#F38BA8",
        "log_yellow":     "#F9E2AF",
        "badge_idle_bg":  "#E5E5EA",
        "badge_idle_fg":  "#8E8E93",
        "scrollbar":      "#C7C7CC",
        "card_hover":     "#F8F8FA",
        "tab_active":     "#FFFFFF",
        "tab_inactive":   "#E5E5EA",
        "divider":        "#E5E5EA",
        "change_add":     "#34C759",
        "change_remove":  "#FF3B30",
        "change_modify":  "#FF9500",
        "change_row_alt": "#F9F9FB",
    },
    "dark": {
        "bg":             "#1C1C1E",
        "surface":        "#2C2C2E",
        "surface_raised": "#3A3A3C",
        "sidebar":        "#252528",
        "sidebar_hover":  "#38383A",
        "accent":         "#0A84FF",
        "accent_hover":   "#409CFF",
        "accent_muted":   "#0A84FF20",
        "success":        "#30D158",
        "success_muted":  "#30D15820",
        "warning":        "#FF9F0A",
        "warning_muted":  "#FF9F0A20",
        "error":          "#FF453A",
        "error_muted":    "#FF453A20",
        "text1":          "#F5F5F7",
        "text2":          "#98989D",
        "text3":          "#636366",
        "border":         "#48484A",
        "border_subtle":  "#38383A",
        "input_bg":       "#1C1C1E",
        "log_bg":         "#161618",
        "log_text":       "#CDD6F4",
        "log_dim":        "#6C7086",
        "log_accent":     "#89B4FA",
        "log_green":      "#A6E3A1",
        "log_red":        "#F38BA8",
        "log_yellow":     "#F9E2AF",
        "badge_idle_bg":  "#48484A",
        "badge_idle_fg":  "#98989D",
        "scrollbar":      "#636366",
        "card_hover":     "#3A3A3C",
        "tab_active":     "#3A3A3C",
        "tab_inactive":   "#2C2C2E",
        "divider":        "#38383A",
        "change_add":     "#30D158",
        "change_remove":  "#FF453A",
        "change_modify":  "#FF9F0A",
        "change_row_alt": "#34343A",
    },
}

FONT_FAMILY = "Segoe UI"
MONO_FONT   = "Cascadia Code"

# ── Pipeline step definitions ──────────────────────────────────────────────

STEPS = [
    {"id": "01_farms",               "name": "Farms",                "desc": "Agricultural & pastoral buildings",   "color": "#34C759",
     "call": lambda mod, s, o: mod.FarmExploitProcessor().run(run_strat=s, run_out=o)},
    {"id": "02_heavy_industry",      "name": "Heavy Industry",       "desc": "Mining, smithing & production",       "color": "#8E8E93",
     "call": lambda mod, s, o: mod.HeavyIndustryProcessor().run(run_strat=s, run_out=o)},
    {"id": "03_sanitation_healers",  "name": "Sanitation",           "desc": "Health & sanitation buildings",       "color": "#5AC8FA",
     "call": lambda mod, s, o: mod.PrioritySanitationProcessorV90().run(run_strat=s, run_out=o)},
    {"id": "04_mics",                "name": "Military",             "desc": "Garrison & military-industrial",      "color": "#FF3B30",
     "call": lambda mod, s, o: mod.MilitaryBuildingProcessor().run(run_strat=s, run_out=o)},
    {"id": "05_homelands",           "name": "Homelands",            "desc": "Government & colony buildings",       "color": "#AF52DE",
     "call": lambda mod, s, o: mod.main(run_strat=s, run_out=o)},
    {"id": "06_rural_exploits",      "name": "Rural Exploits",       "desc": "Wine, timber, horses & more",         "color": "#FF9500",
     "call": lambda mod, s, o: mod.main(run_strat=s, run_out=o)},
    {"id": "07_urban_exploits",      "name": "Urban Exploits",       "desc": "Silk, ivory, glass & trade goods",    "color": "#FFCC00",
     "call": lambda mod, s, o: mod.main(run_strat=s, run_out=o)},
    {"id": "08_port_authority",      "name": "Port Authority",       "desc": "Ports, shipwrights & docks",          "color": "#0071E3",
     "call": lambda mod, s, o: mod.main(run_strat=s, run_out=o)},
    {"id": "09_settlement_processor","name": "Settlement Processor",  "desc": "Final settlement post-processing",   "color": "#5856D6",
     "call": lambda mod, s, o: mod.SettlementProcessor(run_out=o).process_file(str(s))},
    {"id": "10_slave_placer",        "name": "Slave Placer",          "desc": "Place slave resources per region",   "color": "#FF2D55",
     "call": lambda mod, s, o: mod.run(run_strat=s, run_out=o)},
]

MODULE_NAMES = {s["id"]: s["id"].split("_", 1)[1] for s in STEPS}
# Fix multi-word module names
MODULE_NAMES["02_heavy_industry"]      = "heavy_industry"
MODULE_NAMES["03_sanitation_healers"]  = "sanitation_healers"
MODULE_NAMES["06_rural_exploits"]      = "rural_exploits"
MODULE_NAMES["07_urban_exploits"]      = "urban_exploits"
MODULE_NAMES["08_port_authority"]      = "port_authority"
MODULE_NAMES["09_settlement_processor"]= "settlement_processor"
MODULE_NAMES["10_slave_placer"]        = "slave_placer"


# ── Changelog parsing ─────────────────────────────────────────────────────

CHANGELOG_FILES = {
    "01_farms":               [("changelog.txt", "Farms")],
    "02_heavy_industry":      [("heavy_industry_changelog.txt", "Heavy Industry")],
    "03_sanitation_healers":  [("changelog.txt", "Sanitation")],
    "04_mics":                [("military_buildings_summary.txt", "Military")],
    "05_homelands":           [("report.txt", "Homelands")],
    "06_rural_exploits":      [("rural_exploits_changelog.txt", "Rural Exploits")],
    "07_urban_exploits":      [("urban_exploit_changelog.txt", "Urban Exploits")],
    "08_port_authority":      [("changelog.txt", "Port Authority")],
    "09_settlement_processor":[("settlement_changelog.txt", "Settlement Processor")],
    "10_slave_placer":        [("changelog.txt", "Slave Placer")],
}


def parse_changes_from_run(run_dir):
    """Parse changelog files from a completed run into structured change entries."""
    changes = []  # list of (step_label, step_color, line_text)

    for step in STEPS:
        step_dir = run_dir / step["id"]
        if not step_dir.is_dir():
            continue

        file_specs = CHANGELOG_FILES.get(step["id"], [])
        for fname, label in file_specs:
            fpath = step_dir / fname
            if not fpath.exists():
                continue

            try:
                content = fpath.read_text(encoding="utf-8", errors="ignore")
            except Exception:
                continue

            for raw_line in content.splitlines():
                line = raw_line.strip()
                if not line:
                    continue
                # Skip header/separator lines
                if line.startswith("=") or line.startswith("-" * 5):
                    continue
                if line.upper().startswith("UNCHANGED") or "No changes" in line:
                    continue
                if line.startswith("CHANGES MADE") or "marked with [CHANGED]" in line:
                    continue

                changes.append((label, step["color"], line))

    return changes


# ── Utility: capture stdout ───────────────────────────────────────────────

class OutputCapture(io.StringIO):
    def __init__(self, msg_queue, original_stdout):
        super().__init__()
        self.msg_queue = msg_queue
        self.original = original_stdout

    def write(self, text):
        if text and text.strip():
            self.msg_queue.put(("log", text))
        if self.original:
            self.original.write(text)
        return len(text)

    def flush(self):
        if self.original:
            self.original.flush()


# ── Step Card Widget ──────────────────────────────────────────────────────

class StepCard(ctk.CTkFrame):
    STATE_IDLE    = "idle"
    STATE_RUNNING = "running"
    STATE_DONE    = "done"
    STATE_ERROR   = "error"

    def __init__(self, master, step_info, index, theme, on_check_change=None, **kwargs):
        self.T = theme
        super().__init__(master, corner_radius=10, fg_color=self.T["surface"],
                         border_width=1, border_color=self.T["border_subtle"], **kwargs)

        self.step_info = step_info
        self.index = index
        self.on_check_change = on_check_change
        self.state = self.STATE_IDLE
        self.step_color = step_info["color"]

        self.configure(cursor="hand2")
        self.grid_columnconfigure(2, weight=1)

        # Checkbox — controls whether this step runs
        self.check_var = ctk.BooleanVar(value=True)
        self.checkbox = ctk.CTkCheckBox(
            self, text="", variable=self.check_var, width=20,
            checkbox_width=18, checkbox_height=18, corner_radius=4,
            border_width=2, border_color=self.T["border"],
            fg_color=self.step_color, hover_color=self.step_color,
            command=self._notify_check_change,
        )
        self.checkbox.grid(row=0, column=0, rowspan=2, padx=(12, 6), pady=10)

        # Color accent bar (left edge indicator for run state)
        self.accent_bar = ctk.CTkFrame(
            self, width=4, height=36, corner_radius=2,
            fg_color=self.T["badge_idle_bg"],
        )
        self.accent_bar.grid(row=0, column=1, rowspan=2, padx=(0, 8), pady=10)

        # Title + desc stacked
        text_frame = ctk.CTkFrame(self, fg_color="transparent")
        text_frame.grid(row=0, column=2, rowspan=2, sticky="nsew", pady=10)
        text_frame.grid_columnconfigure(0, weight=1)

        self.title_label = ctk.CTkLabel(
            text_frame, text=f"{index + 1:02d}  {step_info['name']}",
            font=ctk.CTkFont(family=FONT_FAMILY, size=13, weight="bold"),
            text_color=self.T["text1"], anchor="w",
        )
        self.title_label.grid(row=0, column=0, sticky="w")

        self.desc_label = ctk.CTkLabel(
            text_frame, text=step_info["desc"],
            font=ctk.CTkFont(family=FONT_FAMILY, size=11),
            text_color=self.T["text3"], anchor="w",
        )
        self.desc_label.grid(row=1, column=0, sticky="w")

        # Status pill
        self.status_pill = ctk.CTkLabel(
            self, text="", width=50, height=22, corner_radius=11,
            font=ctk.CTkFont(family=FONT_FAMILY, size=10, weight="bold"),
            fg_color="transparent", text_color=self.T["text3"],
        )
        self.status_pill.grid(row=0, column=3, rowspan=2, padx=(8, 12), pady=10)

        # Click anywhere on the card body toggles the checkbox.
        for w in [self, self.accent_bar, text_frame,
                  self.title_label, self.desc_label, self.status_pill]:
            w.bind("<Button-1>", self._toggle_from_card)

    def _toggle_from_card(self, event=None):
        self.check_var.set(not self.check_var.get())
        self._notify_check_change()

    def _notify_check_change(self):
        if self.on_check_change:
            self.on_check_change(self.index, self.check_var.get())

    def is_checked(self):
        return bool(self.check_var.get())

    def set_checked(self, checked):
        self.check_var.set(bool(checked))

    def set_state(self, state):
        self.state = state
        if state == self.STATE_IDLE:
            self.accent_bar.configure(fg_color=self.T["badge_idle_bg"])
            self.status_pill.configure(text="", fg_color="transparent")
        elif state == self.STATE_RUNNING:
            self.accent_bar.configure(fg_color=self.T["warning"])
            self.status_pill.configure(
                text="RUN", fg_color=self.T["warning_muted"],
                text_color=self.T["warning"],
            )
        elif state == self.STATE_DONE:
            self.accent_bar.configure(fg_color=self.step_color)
            self.status_pill.configure(
                text="DONE", fg_color=self.T["success_muted"],
                text_color=self.T["success"],
            )
        elif state == self.STATE_ERROR:
            self.accent_bar.configure(fg_color=self.T["error"])
            self.status_pill.configure(
                text="ERR", fg_color=self.T["error_muted"],
                text_color=self.T["error"],
            )

    def update_theme(self, theme):
        self.T = theme
        self.configure(fg_color=self.T["surface"], border_color=self.T["border_subtle"])
        self.checkbox.configure(border_color=self.T["border"])
        self.title_label.configure(text_color=self.T["text1"])
        self.desc_label.configure(text_color=self.T["text3"])
        self.set_state(self.state)


# ── Main Application ──────────────────────────────────────────────────────

class App(ctk.CTk):

    MOD_FILE_MAP = [
        ("descr_strat.txt",          ["campaign"]),
        ("descr_regions.txt",         ["campaign", "world/maps/base"]),
        ("map_regions.tga",           ["campaign", "world/maps/base"]),
        ("export_descr_buildings.txt",["."]),
        ("descr_sm_factions.txt",     ["."]),
        ("export_descr_unit.txt",     ["."]),
        ("descr_win_conditions.txt",  ["campaign"]),
    ]

    def __init__(self):
        super().__init__()

        self.title("Apple's Settlement Processor Suite")
        self.geometry("1200x760")
        self.minsize(960, 640)

        # State
        self.base_dir = Path(__file__).parent
        self.config_dir = self.base_dir / "config"
        self.output_dir = self.base_dir / "processed_output"
        self.strat_file = self.config_dir / "descr_strat.txt"
        self.msg_queue = queue.Queue()
        self.running = False
        self.step_cards = []
        self.last_output_dir = None
        self.changes_data = []

        # Mod source
        self.mod_folder = None
        self.mod_data_dir = None
        self.campaigns = []
        self.selected_campaign = None
        self.mod_loaded = False

        # Settings file
        self._prefs_file = self.base_dir / ".gui_prefs.json"

        # Theme — detect system setting
        system_dark = False
        if darkdetect:
            try:
                system_dark = darkdetect.isDark()
            except Exception:
                pass
        self.dark_mode = bool(system_dark)
        self.T = THEMES[self.theme_name]

        self.configure(fg_color=self.T["bg"])
        ctk.set_appearance_mode(self.theme_name)

        # Restore last session
        self._load_prefs()

        self._build_ui()
        self._poll_id = self.after(50, self._poll_queue)

    @property
    def theme_name(self):
        return "dark" if self.dark_mode else "light"

    def _apply_theme(self):
        self.T = THEMES[self.theme_name]
        ctk.set_appearance_mode(self.theme_name)
        self.configure(fg_color=self.T["bg"])
        self._rebuild_ui()

    def _rebuild_ui(self):
        for w in self.winfo_children():
            w.destroy()
        self.step_cards = []
        self._build_ui()

    # ── UI Construction ───────────────────────────────────────────────

    def _build_ui(self):
        self.grid_columnconfigure(1, weight=1)
        self.grid_rowconfigure(0, weight=1)
        self._build_sidebar()
        self._build_content()

    def _build_sidebar(self):
        T = self.T
        sidebar = ctk.CTkFrame(self, fg_color=T["sidebar"], corner_radius=0, width=380)
        sidebar.grid(row=0, column=0, sticky="nsew")
        sidebar.grid_propagate(False)
        sidebar.grid_rowconfigure(4, weight=1)
        sidebar.grid_columnconfigure(0, weight=1)

        # ── Header with theme toggle ──
        header = ctk.CTkFrame(sidebar, fg_color="transparent")
        header.grid(row=0, column=0, sticky="ew", padx=20, pady=(20, 0))
        header.grid_columnconfigure(0, weight=1)

        title_row = ctk.CTkFrame(header, fg_color="transparent")
        title_row.grid(row=0, column=0, sticky="ew")
        title_row.grid_columnconfigure(0, weight=1)

        ctk.CTkLabel(
            title_row, text="Settlement Processor",
            font=ctk.CTkFont(family=FONT_FAMILY, size=20, weight="bold"),
            text_color=T["text1"], anchor="w",
        ).grid(row=0, column=0, sticky="w")

        # Theme toggle
        toggle_text = "Light" if self.dark_mode else "Dark"
        ctk.CTkButton(
            title_row, text=toggle_text, width=52, height=26, corner_radius=13,
            font=ctk.CTkFont(family=FONT_FAMILY, size=11),
            fg_color=T["surface_raised"], hover_color=T["sidebar_hover"],
            text_color=T["text2"], border_width=1, border_color=T["border_subtle"],
            command=self._toggle_theme,
        ).grid(row=0, column=1, sticky="e")

        ctk.CTkLabel(
            header, text="Building Assignment Pipeline",
            font=ctk.CTkFont(family=FONT_FAMILY, size=12),
            text_color=T["text2"], anchor="w",
        ).grid(row=1, column=0, sticky="w", pady=(2, 0))

        # ── Mod Source card ──
        src = ctk.CTkFrame(sidebar, fg_color=T["surface"], corner_radius=12,
                            border_width=1, border_color=T["border_subtle"])
        src.grid(row=1, column=0, sticky="ew", padx=16, pady=(14, 0))
        src.grid_columnconfigure(0, weight=1)

        # Section label
        sec_header = ctk.CTkFrame(src, fg_color="transparent")
        sec_header.grid(row=0, column=0, sticky="ew", padx=14, pady=(12, 0))
        sec_header.grid_columnconfigure(0, weight=1)
        ctk.CTkLabel(
            sec_header, text="SOURCE",
            font=ctk.CTkFont(family=FONT_FAMILY, size=10, weight="bold"),
            text_color=T["text3"], anchor="w",
        ).grid(row=0, column=0, sticky="w")

        # Mod folder
        ctk.CTkLabel(
            src, text="Mod Folder",
            font=ctk.CTkFont(family=FONT_FAMILY, size=11),
            text_color=T["text2"], anchor="w",
        ).grid(row=1, column=0, sticky="w", padx=14, pady=(8, 0))

        mod_row = ctk.CTkFrame(src, fg_color="transparent")
        mod_row.grid(row=2, column=0, sticky="ew", padx=14, pady=(3, 0))
        mod_row.grid_columnconfigure(0, weight=1)

        mod_display = self.mod_folder.name if self.mod_folder else "No mod selected"
        mod_color = T["text1"] if self.mod_folder else T["text3"]
        self.mod_path_label = ctk.CTkLabel(
            mod_row, text=mod_display,
            font=ctk.CTkFont(family=MONO_FONT, size=11),
            text_color=mod_color, anchor="w",
        )
        self.mod_path_label.grid(row=0, column=0, sticky="w")

        ctk.CTkButton(
            mod_row, text="Browse", width=62, height=26, corner_radius=8,
            font=ctk.CTkFont(family=FONT_FAMILY, size=11),
            fg_color=T["input_bg"], hover_color=T["sidebar_hover"],
            text_color=T["text1"], border_width=1, border_color=T["border_subtle"],
            command=self._choose_mod_folder,
        ).grid(row=0, column=1, sticky="e", padx=(6, 0))

        # Campaign dropdown
        ctk.CTkLabel(
            src, text="Campaign",
            font=ctk.CTkFont(family=FONT_FAMILY, size=11),
            text_color=T["text2"], anchor="w",
        ).grid(row=3, column=0, sticky="w", padx=14, pady=(8, 0))

        camp_row = ctk.CTkFrame(src, fg_color="transparent")
        camp_row.grid(row=4, column=0, sticky="ew", padx=14, pady=(3, 0))
        camp_row.grid_columnconfigure(0, weight=1)

        dd_vals = self.campaigns if self.campaigns else ["--"]
        dd_state = "normal" if self.campaigns else "disabled"
        self.campaign_dropdown = ctk.CTkOptionMenu(
            camp_row, values=dd_vals,
            font=ctk.CTkFont(family=FONT_FAMILY, size=11),
            fg_color=T["input_bg"], button_color=T["border"],
            button_hover_color=T["text3"],
            text_color=T["text1"], dropdown_fg_color=T["surface"],
            dropdown_text_color=T["text1"], dropdown_hover_color=T["sidebar"],
            corner_radius=8, height=28,
            command=self._on_campaign_selected,
            state=dd_state,
        )
        self.campaign_dropdown.grid(row=0, column=0, sticky="ew")
        if self.selected_campaign:
            self.campaign_dropdown.set(self.selected_campaign)

        # Load button + status
        load_row = ctk.CTkFrame(src, fg_color="transparent")
        load_row.grid(row=5, column=0, sticky="ew", padx=14, pady=(10, 12))
        load_row.grid_columnconfigure(0, weight=1)

        status_text = "Loaded" if self.mod_loaded else ""
        status_color = T["success"] if self.mod_loaded else T["text3"]
        self.load_status = ctk.CTkLabel(
            load_row, text=status_text,
            font=ctk.CTkFont(family=FONT_FAMILY, size=11),
            text_color=status_color, anchor="w",
        )
        self.load_status.grid(row=0, column=0, sticky="w")

        load_state = "normal" if self.selected_campaign else "disabled"
        self.load_btn = ctk.CTkButton(
            load_row, text="Load Files", width=72, height=28, corner_radius=8,
            font=ctk.CTkFont(family=FONT_FAMILY, size=11, weight="bold"),
            fg_color=T["accent"], hover_color=T["accent_hover"], text_color="#FFFFFF",
            command=self._load_mod_files, state=load_state,
        )
        self.load_btn.grid(row=0, column=1, sticky="e", padx=(6, 0))

        # ── Divider ──
        ctk.CTkFrame(sidebar, fg_color=T["divider"], height=1, corner_radius=0
                      ).grid(row=2, column=0, sticky="ew", padx=20, pady=(12, 6))

        # ── Step list header (with select-all/none toggle) ──
        steps_header = ctk.CTkFrame(sidebar, fg_color="transparent")
        steps_header.grid(row=3, column=0, sticky="ew", padx=20, pady=(2, 4))
        steps_header.grid_columnconfigure(0, weight=1)

        ctk.CTkLabel(
            steps_header, text="STEPS",
            font=ctk.CTkFont(family=FONT_FAMILY, size=10, weight="bold"),
            text_color=T["text3"], anchor="w",
        ).grid(row=0, column=0, sticky="w")

        self.toggle_all_btn = ctk.CTkButton(
            steps_header, text="None", width=58, height=22, corner_radius=8,
            font=ctk.CTkFont(family=FONT_FAMILY, size=10, weight="bold"),
            fg_color=T["surface_raised"], hover_color=T["sidebar_hover"],
            text_color=T["text2"], border_width=1, border_color=T["border_subtle"],
            command=self._toggle_all_steps,
        )
        self.toggle_all_btn.grid(row=0, column=1, sticky="e")

        # ── Step list ──
        step_scroll = ctk.CTkScrollableFrame(
            sidebar, fg_color="transparent", corner_radius=0,
            scrollbar_button_color=T["scrollbar"],
            scrollbar_button_hover_color=T["text2"],
        )
        step_scroll.grid(row=4, column=0, sticky="nsew", padx=10, pady=(2, 6))
        step_scroll.grid_columnconfigure(0, weight=1)

        for i, step in enumerate(STEPS):
            card = StepCard(step_scroll, step, i, self.T, on_check_change=self._on_step_check_change)
            card.grid(row=i, column=0, sticky="ew", pady=2)
            self.step_cards.append(card)

        # ── Action buttons ──
        btn_frame = ctk.CTkFrame(sidebar, fg_color="transparent")
        btn_frame.grid(row=5, column=0, sticky="ew", padx=16, pady=(6, 16))
        btn_frame.grid_columnconfigure(0, weight=1)

        self.run_selected_btn = ctk.CTkButton(
            btn_frame, text="Run Selected (10)", height=38, corner_radius=10,
            font=ctk.CTkFont(family=FONT_FAMILY, size=13, weight="bold"),
            fg_color=T["accent"], hover_color=T["accent_hover"], text_color="#FFFFFF",
            command=self._run_selected,
        )
        self.run_selected_btn.grid(row=0, column=0, sticky="ew")

    def _build_content(self):
        T = self.T
        content = ctk.CTkFrame(self, fg_color=T["bg"], corner_radius=0)
        content.grid(row=0, column=1, sticky="nsew")
        content.grid_rowconfigure(2, weight=1)
        content.grid_columnconfigure(0, weight=1)

        # ── Top bar ──
        top = ctk.CTkFrame(content, fg_color="transparent")
        top.grid(row=0, column=0, sticky="ew", padx=24, pady=(18, 0))
        top.grid_columnconfigure(1, weight=1)

        self.status_label = ctk.CTkLabel(
            top, text="Ready",
            font=ctk.CTkFont(family=FONT_FAMILY, size=18, weight="bold"),
            text_color=T["text1"], anchor="w",
        )
        self.status_label.grid(row=0, column=0, sticky="w")

        self.progress_label = ctk.CTkLabel(
            top, text="",
            font=ctk.CTkFont(family=FONT_FAMILY, size=12),
            text_color=T["text2"], anchor="e",
        )
        self.progress_label.grid(row=0, column=1, sticky="e", padx=(12, 0))

        # Open Output button
        self.open_output_btn = ctk.CTkButton(
            top, text="Open Output", width=100, height=30, corner_radius=8,
            font=ctk.CTkFont(family=FONT_FAMILY, size=12),
            fg_color=T["surface_raised"], hover_color=T["sidebar_hover"],
            text_color=T["text1"], border_width=1, border_color=T["border_subtle"],
            command=self._open_output_dir,
            state="disabled" if not self.last_output_dir else "normal",
        )
        self.open_output_btn.grid(row=0, column=2, sticky="e", padx=(8, 0))

        # ── Progress bar ──
        self.progress_bar = ctk.CTkProgressBar(
            content, height=3, corner_radius=2,
            fg_color=T["border_subtle"], progress_color=T["accent"],
        )
        self.progress_bar.grid(row=1, column=0, sticky="ew", padx=24, pady=(10, 0))
        self.progress_bar.set(0)

        # ── Tabbed content area ──
        tab_bar = ctk.CTkFrame(content, fg_color="transparent", height=36)
        tab_bar.grid(row=2, column=0, sticky="new", padx=24, pady=(12, 0))

        self.active_tab = "log"
        self.tab_btns = {}

        for tab_id, tab_label in [("log", "Console"), ("changes", "Changes")]:
            is_active = (tab_id == self.active_tab)
            btn_kwargs = dict(
                text=tab_label, width=80, height=30, corner_radius=8,
                font=ctk.CTkFont(family=FONT_FAMILY, size=12,
                                  weight="bold" if is_active else "normal"),
                fg_color=T["tab_active"] if is_active else T["bg"],
                hover_color=T["tab_active"],
                text_color=T["text1"] if is_active else T["text2"],
                command=lambda tid=tab_id: self._switch_tab(tid),
            )
            if is_active:
                btn_kwargs["border_width"] = 1
                btn_kwargs["border_color"] = T["border_subtle"]
            btn = ctk.CTkButton(tab_bar, **btn_kwargs)
            btn.pack(side="left", padx=(0, 4))
            self.tab_btns[tab_id] = btn

        # Tab content container
        self.tab_container = ctk.CTkFrame(content, fg_color="transparent")
        self.tab_container.grid(row=2, column=0, sticky="nsew", padx=24, pady=(42, 16))
        self.tab_container.grid_rowconfigure(0, weight=1)
        self.tab_container.grid_columnconfigure(0, weight=1)

        self._build_log_tab()
        self._build_changes_tab()
        self._show_tab(self.active_tab)

    def _build_log_tab(self):
        T = self.T
        self.log_frame = ctk.CTkFrame(
            self.tab_container, fg_color=T["log_bg"], corner_radius=12,
            border_width=1, border_color=T["border_subtle"],
        )
        self.log_frame.grid_rowconfigure(0, weight=1)
        self.log_frame.grid_columnconfigure(0, weight=1)

        self.log_text = ctk.CTkTextbox(
            self.log_frame,
            font=ctk.CTkFont(family=MONO_FONT, size=12),
            fg_color=T["log_bg"], text_color=T["log_text"],
            border_width=0, corner_radius=12,
            wrap="word", activate_scrollbars=True,
            scrollbar_button_color=T["scrollbar"],
        )
        self.log_text.grid(row=0, column=0, sticky="nsew", padx=4, pady=4)

    def _build_changes_tab(self):
        T = self.T
        self.changes_frame = ctk.CTkFrame(
            self.tab_container, fg_color=T["surface"], corner_radius=12,
            border_width=1, border_color=T["border_subtle"],
        )
        self.changes_frame.grid_rowconfigure(1, weight=1)
        self.changes_frame.grid_columnconfigure(0, weight=1)

        # Header
        ch_header = ctk.CTkFrame(self.changes_frame, fg_color="transparent")
        ch_header.grid(row=0, column=0, sticky="ew", padx=16, pady=(12, 0))
        ch_header.grid_columnconfigure(0, weight=1)

        self.changes_count_label = ctk.CTkLabel(
            ch_header, text="No changes yet",
            font=ctk.CTkFont(family=FONT_FAMILY, size=13, weight="bold"),
            text_color=T["text1"], anchor="w",
        )
        self.changes_count_label.grid(row=0, column=0, sticky="w")

        # Scrollable changes list
        self.changes_scroll = ctk.CTkScrollableFrame(
            self.changes_frame, fg_color="transparent",
            scrollbar_button_color=T["scrollbar"],
            scrollbar_button_hover_color=T["text2"],
        )
        self.changes_scroll.grid(row=1, column=0, sticky="nsew", padx=8, pady=(8, 8))
        self.changes_scroll.grid_columnconfigure(1, weight=1)

    def _populate_changes(self):
        T = self.T
        # Clear existing
        for w in self.changes_scroll.winfo_children():
            w.destroy()

        if not self.changes_data:
            self.changes_count_label.configure(text="No changes yet")
            return

        self.changes_count_label.configure(
            text=f"{len(self.changes_data)} changes across pipeline"
        )

        current_section = None
        row = 0

        for label, color, line in self.changes_data:
            # Section header when step changes
            if label != current_section:
                current_section = label
                sec_frame = ctk.CTkFrame(self.changes_scroll, fg_color="transparent")
                sec_frame.grid(row=row, column=0, columnspan=2, sticky="ew",
                               pady=(10 if row > 0 else 4, 2))
                sec_frame.grid_columnconfigure(1, weight=1)

                # Color dot
                ctk.CTkFrame(
                    sec_frame, width=8, height=8, corner_radius=4, fg_color=color,
                ).grid(row=0, column=0, padx=(8, 6))

                ctk.CTkLabel(
                    sec_frame, text=label,
                    font=ctk.CTkFont(family=FONT_FAMILY, size=12, weight="bold"),
                    text_color=T["text1"], anchor="w",
                ).grid(row=0, column=1, sticky="w")

                row += 1

            # Change line
            bg = T["change_row_alt"] if (row % 2 == 0) else "transparent"
            line_frame = ctk.CTkFrame(
                self.changes_scroll, fg_color=bg, corner_radius=6, height=28,
            )
            line_frame.grid(row=row, column=0, columnspan=2, sticky="ew", pady=1)
            line_frame.grid_columnconfigure(0, weight=1)

            ctk.CTkLabel(
                line_frame, text=line,
                font=ctk.CTkFont(family=MONO_FONT, size=11),
                text_color=T["text2"], anchor="w", wraplength=600,
            ).grid(row=0, column=0, sticky="w", padx=(28, 8), pady=3)

            row += 1

    def _show_tab(self, tab_id):
        self.log_frame.grid_forget()
        self.changes_frame.grid_forget()
        if tab_id == "log":
            self.log_frame.grid(row=0, column=0, sticky="nsew")
        else:
            self.changes_frame.grid(row=0, column=0, sticky="nsew")

    def _switch_tab(self, tab_id):
        T = self.T
        self.active_tab = tab_id
        for tid, btn in self.tab_btns.items():
            is_active = (tid == tab_id)
            btn.configure(
                fg_color=T["tab_active"] if is_active else T["bg"],
                text_color=T["text1"] if is_active else T["text2"],
                font=ctk.CTkFont(family=FONT_FAMILY, size=12,
                                  weight="bold" if is_active else "normal"),
                border_width=1 if is_active else 0,
                border_color=T["border_subtle"],
            )
        self._show_tab(tab_id)

    # ── Theme toggle ──────────────────────────────────────────────────

    def _toggle_theme(self):
        self.dark_mode = not self.dark_mode
        self._apply_theme()

    # ── Preferences ────────────────────────────────────────────────────

    def _load_prefs(self):
        """Restore last used mod folder and campaign from prefs file."""
        if not self._prefs_file.exists():
            return
        try:
            prefs = json.loads(self._prefs_file.read_text(encoding="utf-8"))
        except Exception:
            return

        mod_path = prefs.get("mod_folder")
        campaign = prefs.get("campaign")
        if not mod_path:
            return

        mod_path = Path(mod_path)
        if not mod_path.exists():
            return

        data_dir, display_root = self._find_data_dir(mod_path)
        if data_dir is None:
            return

        self.mod_folder = display_root
        self.mod_data_dir = data_dir

        campaign_base = data_dir / "world" / "maps" / "campaign"
        self.campaigns = []
        if campaign_base.is_dir():
            for child in sorted(campaign_base.iterdir()):
                if child.is_dir() and (child / "descr_strat.txt").exists():
                    self.campaigns.append(child.name)

        if not self.campaigns:
            return

        if campaign and campaign in self.campaigns:
            self.selected_campaign = campaign
        else:
            self.selected_campaign = self.campaigns[0]

    def _save_prefs(self):
        """Save current mod folder and campaign selection."""
        prefs = {}
        if self.mod_folder:
            prefs["mod_folder"] = str(self.mod_folder)
        if self.selected_campaign:
            prefs["campaign"] = self.selected_campaign
        try:
            self._prefs_file.write_text(
                json.dumps(prefs, indent=2), encoding="utf-8"
            )
        except Exception:
            pass

    # ── Mod Source Actions ────────────────────────────────────────────

    def _find_data_dir(self, root):
        root = Path(root)
        candidates = []

        if (root / "world" / "maps" / "campaign").is_dir():
            candidates.append((root, root.parent))
        if (root / "data" / "world" / "maps" / "campaign").is_dir():
            candidates.append((root / "data", root))
        for sub in ["Contents/Resources/Data/data", "Contents/Resources/Data",
                     "Data/data", "Data"]:
            p = root / sub
            if p.is_dir() and (p / "world" / "maps" / "campaign").is_dir():
                candidates.append((p, root))

        return candidates[0] if candidates else (None, None)

    def _choose_mod_folder(self):
        path = filedialog.askdirectory(
            title="Select mod folder (the one containing 'data/')",
            initialdir="C:/",
        )
        if not path:
            return

        mod_path = Path(path)
        data_dir, display_root = self._find_data_dir(mod_path)
        if data_dir is None:
            self.load_status.configure(text="No data/ found", text_color=self.T["error"])
            return
        mod_path = display_root

        self.mod_folder = mod_path
        self.mod_data_dir = data_dir
        self.mod_path_label.configure(text=mod_path.name, text_color=self.T["text1"])

        campaign_base = data_dir / "world" / "maps" / "campaign"
        self.campaigns = []
        if campaign_base.is_dir():
            for child in sorted(campaign_base.iterdir()):
                if child.is_dir() and (child / "descr_strat.txt").exists():
                    self.campaigns.append(child.name)

        if not self.campaigns:
            self.campaign_dropdown.configure(values=["--"], state="disabled")
            self.campaign_dropdown.set("--")
            self.load_btn.configure(state="disabled")
            self.load_status.configure(text="No campaigns", text_color=self.T["error"])
            return

        self.campaign_dropdown.configure(values=self.campaigns, state="normal")
        self.campaign_dropdown.set(self.campaigns[0])
        self._on_campaign_selected(self.campaigns[0])

        self._save_prefs()

        if len(self.campaigns) > 1:
            self.load_status.configure(
                text=f"{len(self.campaigns)} campaigns",
                text_color=self.T["text2"],
            )

    def _on_campaign_selected(self, campaign_name):
        self.selected_campaign = campaign_name
        self.load_btn.configure(state="normal")
        self.load_status.configure(text="Ready", text_color=self.T["text2"])
        self.mod_loaded = False
        self._save_prefs()

    def _load_mod_files(self):
        if not self.mod_data_dir or not self.selected_campaign:
            return

        campaign_dir = (self.mod_data_dir / "world" / "maps" / "campaign"
                        / self.selected_campaign)
        copied = []
        missing = []

        for target_name, search_dirs in self.MOD_FILE_MAP:
            found = False
            for search_dir in search_dirs:
                src = (campaign_dir / target_name if search_dir == "campaign"
                       else self.mod_data_dir / search_dir / target_name)
                if src.exists():
                    shutil.copy2(str(src), str(self.config_dir / target_name))
                    copied.append(target_name)
                    found = True
                    break
            if not found:
                missing.append(target_name)

        self.strat_file = self.config_dir / "descr_strat.txt"
        self.mod_loaded = True

        critical_missing = [f for f in missing
                            if f not in {"export_descr_unit.txt", "descr_win_conditions.txt"}]
        if critical_missing:
            self.load_status.configure(
                text=f"{len(copied)} loaded, {len(critical_missing)} missing",
                text_color=self.T["warning"],
            )
        else:
            self.load_status.configure(
                text=f"{len(copied)} files loaded",
                text_color=self.T["success"],
            )

        self._log(f"Loaded: {self.selected_campaign} from {self.mod_folder.name}")
        for f in copied:
            self._log(f"  + {f}")
        for f in missing:
            self._log(f"  - {f} (not found)")

    # ── Actions ───────────────────────────────────────────────────────

    def _checked_indices(self):
        return [i for i, card in enumerate(self.step_cards) if card.is_checked()]

    def _on_step_check_change(self, index, checked):
        self._refresh_run_button()
        self._refresh_toggle_all_label()

    def _refresh_run_button(self):
        if self.running:
            return
        n = len(self._checked_indices())
        if n == 0:
            self.run_selected_btn.configure(text="Run Selected (0)", state="disabled")
        else:
            self.run_selected_btn.configure(
                text=f"Run Selected ({n})", state="normal",
            )

    def _refresh_toggle_all_label(self):
        all_on = all(c.is_checked() for c in self.step_cards) if self.step_cards else False
        self.toggle_all_btn.configure(text="None" if all_on else "All")

    def _toggle_all_steps(self):
        if self.running:
            return
        target = not all(c.is_checked() for c in self.step_cards)
        for card in self.step_cards:
            card.set_checked(target)
        self._refresh_run_button()
        self._refresh_toggle_all_label()

    def _open_output_dir(self):
        if self.last_output_dir and self.last_output_dir.exists():
            os.startfile(str(self.last_output_dir))

    def _log(self, text, tag=None):
        try:
            if hasattr(self, "log_text") and self.log_text.winfo_exists():
                self.log_text.insert("end", text + "\n")
                self.log_text.see("end")
        except Exception:
            pass

    def _set_running(self, running):
        self.running = running
        if running:
            self.run_selected_btn.configure(state="disabled")
            self.toggle_all_btn.configure(state="disabled")
        else:
            self.toggle_all_btn.configure(state="normal")
            self._refresh_run_button()

    def _reset_cards(self):
        for card in self.step_cards:
            card.set_state(StepCard.STATE_IDLE)

    # ── Run pipeline ──────────────────────────────────────────────────

    def _run_selected(self):
        if self.running:
            return
        indices = self._checked_indices()
        if not indices:
            return
        self._reset_cards()
        self.log_text.delete("1.0", "end")
        self._set_running(True)
        self.progress_bar.set(0)
        if len(indices) == 1:
            self.status_label.configure(
                text=f"Running {STEPS[indices[0]]['name']}..."
            )
        elif len(indices) == len(STEPS):
            self.status_label.configure(text="Running pipeline...")
        else:
            self.status_label.configure(
                text=f"Running {len(indices)} of {len(STEPS)} steps..."
            )
        self.open_output_btn.configure(state="disabled")

        t = threading.Thread(
            target=self._pipeline_worker,
            args=(indices,), daemon=True,
        )
        t.start()

    def _pipeline_worker(self, step_indices):
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        is_full = len(step_indices) == len(STEPS)
        if is_full:
            suffix = "full_run"
        elif len(step_indices) == 1:
            suffix = f"single_{STEPS[step_indices[0]]['id']}"
        else:
            suffix = f"partial_{len(step_indices)}steps"
        run_dir = self.output_dir / f"{suffix}_{ts}"
        run_dir.mkdir(parents=True, exist_ok=True)

        current_strat = Path(self.strat_file)
        total = len(step_indices)
        errors = []

        script_dir = str(self.base_dir)
        if script_dir not in sys.path:
            sys.path.insert(0, script_dir)

        for count, idx in enumerate(step_indices):
            step = STEPS[idx]
            step_dir = run_dir / step["id"]
            step_dir.mkdir(parents=True, exist_ok=True)

            self.msg_queue.put(("step_start", idx))
            self.msg_queue.put(("progress", (count, total, step["name"])))
            self.msg_queue.put(("log", f"\n{'─' * 50}"))
            self.msg_queue.put(("log", f"  {idx + 1:02d}  {step['name']}"))
            self.msg_queue.put(("log", f"{'─' * 50}"))

            old_stdout = sys.stdout
            sys.stdout = OutputCapture(self.msg_queue, old_stdout)

            try:
                mod_name = MODULE_NAMES[step["id"]]
                mod = __import__(mod_name)
                step["call"](mod, current_strat, step_dir)

                next_strat = step_dir / "descr_strat.txt"
                if next_strat.exists():
                    current_strat = next_strat
                    self.msg_queue.put(("step_done", idx))
                else:
                    self.msg_queue.put(("log", "  Warning: no descr_strat.txt produced"))
                    if is_full:
                        self.msg_queue.put(("step_error", idx))
                        errors.append(step["name"])
                        break
                    else:
                        self.msg_queue.put(("step_done", idx))
            except Exception as e:
                import traceback
                self.msg_queue.put(("log", f"\n  ERROR: {e}"))
                self.msg_queue.put(("log", traceback.format_exc()))
                self.msg_queue.put(("step_error", idx))
                errors.append(step["name"])
                if is_full:
                    break
            finally:
                sys.stdout = old_stdout

        if is_full and not errors:
            final = run_dir / "descr_strat.txt"
            final.write_bytes(current_strat.read_bytes())
            try:
                import run_all as ra
                ra.write_unified_changelog(run_dir)
            except Exception:
                pass

        # Parse changes
        changes = parse_changes_from_run(run_dir)

        self.msg_queue.put(("progress", (total, total, "")))
        self.msg_queue.put(("done", (run_dir, errors, changes)))

    # ── Queue polling ─────────────────────────────────────────────────

    def _poll_queue(self):
        try:
            for _ in range(200):  # process up to 200 messages per tick
                try:
                    msg_type, data = self.msg_queue.get_nowait()
                except queue.Empty:
                    break

                try:
                    if msg_type == "log":
                        if hasattr(self, "log_text") and self.log_text.winfo_exists():
                            self._log(data.rstrip())
                    elif msg_type == "step_start":
                        if data < len(self.step_cards):
                            self.step_cards[data].set_state(StepCard.STATE_RUNNING)
                    elif msg_type == "step_done":
                        if data < len(self.step_cards):
                            self.step_cards[data].set_state(StepCard.STATE_DONE)
                    elif msg_type == "step_error":
                        if data < len(self.step_cards):
                            self.step_cards[data].set_state(StepCard.STATE_ERROR)
                    elif msg_type == "progress":
                        current, total, name = data
                        frac = current / total if total else 0
                        if hasattr(self, "progress_bar") and self.progress_bar.winfo_exists():
                            self.progress_bar.set(frac)
                        if name and hasattr(self, "progress_label") and self.progress_label.winfo_exists():
                            self.progress_label.configure(text=f"{current + 1} of {total}")
                    elif msg_type == "done":
                        run_dir, errors, changes = data
                        self.last_output_dir = run_dir
                        self.changes_data = changes
                        if hasattr(self, "progress_bar") and self.progress_bar.winfo_exists():
                            self.progress_bar.set(1.0)
                        self._set_running(False)
                        if hasattr(self, "open_output_btn") and self.open_output_btn.winfo_exists():
                            self.open_output_btn.configure(state="normal")

                        if errors:
                            if hasattr(self, "status_label") and self.status_label.winfo_exists():
                                self.status_label.configure(
                                    text=f"Failed: {', '.join(errors)}"
                                )
                            if hasattr(self, "progress_label") and self.progress_label.winfo_exists():
                                self.progress_label.configure(text="")
                            self._log(f"\nPipeline stopped due to errors.")
                        else:
                            n = len(changes)
                            if hasattr(self, "status_label") and self.status_label.winfo_exists():
                                self.status_label.configure(
                                    text=f"Complete — {n} change{'s' if n != 1 else ''}"
                                )
                            if hasattr(self, "progress_label") and self.progress_label.winfo_exists():
                                self.progress_label.configure(text="")
                            self._log(f"\nDone. {n} changes. Output: {run_dir.name}")

                        self._populate_changes()
                        if changes:
                            self._switch_tab("changes")
                except Exception:
                    pass  # never let a single message break the poll chain

        except Exception:
            pass  # absolute safety net

        self.after(50, self._poll_queue)


# ── Entry point ───────────────────────────────────────────────────────────

if __name__ == "__main__":
    app = App()
    app.mainloop()
