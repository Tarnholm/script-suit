// changelog.js — per-version "What's New" entries for the Settlement Processor
// Suite, newest first. Rendered as cards by updater-ui.js after an update.
// Each entry: { version, date, items: [{ type, text }] }
// Types: "feature" | "fix" | "improvement" | "change". `text` supports **bold**
// and `code`.
window.SPS_TYPE_COLOURS = { feature: "#4a9", fix: "#c66", improvement: "#6ac", change: "#ba6" };

window.SPS_CHANGELOG = [
  {
    version: "0.16.7",
    date: "2026-05-24",
    items: [
      { type: "fix", text: "**Heavy industry cleaned up.** Removed urban/rural chains (glass, amber, slave, wine, timber, textile, livestock) and the defunct single-resource mines from the heavy-industry pool — fixes duplicate buildings (e.g. double glass in Alexandria) and references to buildings that no longer exist. Heavy industry now competes only among real `heavy_ind` buildings." },
      { type: "change", text: "**Farms rules updated.** Plateau/Hills/Mountain-valley rainfed rules now key off the no-irrigation/cold exclusion (incl. `sub_artic` & `alpine`) or a warm climate; Hills & Mountain-valley gain a qanat rule for `irrigation_aquifer`; Mountains now needs sheep/livestock/perfumes/honey/salt (else no farm); Karst rainfed drops `sub_artic`; Wetlands marsh_reclamation needs a qualifying resource; Floodplains drops its rainfed fallback." },
    ],
  },
  {
    version: "0.16.6",
    date: "2026-05-24",
    items: [
      { type: "feature", text: "**Civic buildings step.** A new pipeline section places civic buildings (`magistrate_court`, `centralized_mint`/`autonomous_mint`, `academy`) per settlement from an **editable list** (`config/civic_buildings.txt`). Edit it in the config editor, or click **Import List** on the Civic step to drop in an updated .txt — then re-run with the other scripts. Existing civics are replaced (`no_other_civic`)." },
      { type: "improvement", text: "Double-clicking the version to watch for updates now **auto-installs** the update the moment it finishes downloading — no \"Restart & install\" click needed. Double-click again to cancel before one appears." },
    ],
  },
  {
    version: "0.16.5",
    date: "2026-05-24",
    items: [
      { type: "fix", text: "**Temples now use the suite-wide -1 tier rule.** A non-capital settlement gets a temple one tier below its size (e.g. a large_town → a tier-1 temple); only the faction capital gets a temple matching its full level. Matches mics.py and the other placement scripts." },
      { type: "feature", text: "**Special temples are respected.** A settlement that already has a special temple (`temples_of_viking`, `temples_of_horse`, etc.) keeps it and gets no culture temple — RTW allows only one temple per settlement." },
    ],
  },
  {
    version: "0.16.4",
    date: "2026-05-23",
    items: [
      { type: "change", text: "**Heavy-industry weights now read correctly.** coal=5, glass=3, amber=3, elephants=3 are the real values (previously masked by old defaults). `tin` stays 3 globally with an artisans-only override of 5 so **artisans** — not smith — wins tin settlements. No change to actual placements." },
    ],
  },
  {
    version: "0.16.3",
    date: "2026-05-23",
    items: [
      { type: "feature", text: "**“What’s New” cards.** After an update the app shows release-notes cards summarising what changed in each new version (this card!)." },
    ],
  },
  {
    version: "0.16.2",
    date: "2026-05-23",
    items: [
      { type: "feature", text: "**Update watcher indicator.** Double-clicking the version number shows a pulsing **👀 watching…** badge while it polls for a new release every 5 seconds." },
    ],
  },
  {
    version: "0.16.1",
    date: "2026-05-23",
    items: [
      { type: "improvement", text: "**Heavy industry — luxury crafting.** Settlements with glass, amber or elephants now build **jewelry** instead of raw mining (`mines`). The glass/amber **trade** chains are urban and no longer compete in the heavy-industry step." },
    ],
  },
  {
    version: "0.16.0",
    date: "2026-05-23",
    items: [
      { type: "feature", text: "**Temples by culture (`temples.py`).** Each settlement's temple is assigned from the region's dominant **culture %**; ties go to the owning faction's own culture. Wired into the pipeline, Master and the GUI." },
      { type: "change", text: "**Wall caps.** Walls are capped at **tier 3**, with per-region exceptions (Trinakria 4, Korinthia 3) and no walls in Elis, Kappadokia and Lucensia_Meridionalis. A wall never exceeds the settlement's own tier." },
      { type: "improvement", text: "**Heavy-industry scoring.** Per-building resource weights — smith values coal more; artisans pick up tin/lead." },
      { type: "feature", text: "**Auto-updates.** The app updates itself from GitHub releases — click the version number to check, double-click to keep watching." },
    ],
  },
];
