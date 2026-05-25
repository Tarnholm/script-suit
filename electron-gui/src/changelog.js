// changelog.js — per-version "What's New" entries for the Settlement Processor
// Suite, newest first. Rendered as cards by updater-ui.js after an update.
// Each entry: { version, date, items: [{ type, text }] }
// Types: "feature" | "fix" | "improvement" | "change". `text` supports **bold**
// and `code`.
window.SPS_TYPE_COLOURS = { feature: "#4a9", fix: "#c66", improvement: "#6ac", change: "#ba6" };

window.SPS_CHANGELOG = [
  {
    version: "0.16.16",
    date: "2026-05-25",
    items: [
      { type: "fix", text: "**Walls: size bump restored.** Regular walls are one tier below settlement size, capped at `stone_wall` (tier 3): town → none, large_town → wooden_pallisade, city → wooden_wall, large_city/huge_city → stone_wall. Per-region exceptions (Trinakria 4, Korinthia 3) stay un-bumped (full tier up to their cap). Fixes tier-1 walls on tier-1 towns." },
    ],
  },
  {
    version: "0.16.15",
    date: "2026-05-25",
    items: [
      { type: "feature", text: "**Starting Treasury step.** Sets each faction's starting denari = **5000 + 500 × (starting settlements)**. Slave/dummies and the emergent/rebel markers are left untouched. New pipeline step — runs with the others, editable KEEP list in the script." },
    ],
  },
  {
    version: "0.16.14",
    date: "2026-05-25",
    items: [
      { type: "fix", text: "**Walls reach stone_wall (tier 3) again** for cities — the size bump was capping them at wooden_wall. Exceptions (Trinakria 4, Korinthia 3) and never-exceed-settlement-tier still apply." },
      { type: "fix", text: "**Roads bump restored** (large_town → roads, city → paved_roads, large_city+ → highways) and **highways now also require** the region's total resource amount to exceed 12 (size still gates it). Roma → highways." },
      { type: "fix", text: "**Treasuries are built again**, capped at tier 2 (large_treasury) — the bump had been dropping them." },
      { type: "fix", text: "**Heavy industry: enabling vs scoring resources.** A building is only considered when one of its real inputs is present (e.g. mines needs an actual metal/coal); slave_trade/timber/grain/glass/amber etc. only adjust the score." },
      { type: "fix", text: "**Ports:** towns that no longer qualify are correctly reported as **removed** (the port was already stripped, but the report mislabeled it as kept)." },
      { type: "change", text: "Urban-exploit priority list reordered; farms **mountains** reverted to plain highland_pastoralism." },
    ],
  },
  {
    version: "0.16.13",
    date: "2026-05-25",
    items: [
      { type: "feature", text: "**Grain exports step.** A region with **grain ≥2** and a sea/river outlet (`base_port_level` 1-3 or `rivertrade`) gets a `food_storage` granary: large_town → `granary`, city/large_city/huge_city → `granary+1`; towns get none. Region **Gynaikopolites_Nomos** → `granary+2`. New pipeline step (editable, runs with the others)." },
    ],
  },
  {
    version: "0.16.12",
    date: "2026-05-25",
    items: [
      { type: "change", text: "**Port authority reworked.** Coastal port always wins when a `base_port_level` 1-3 is present (even alongside rivertrade); tier-1 `port` is now a **town**-level building. Coastal bump keys off the region's **total resource amount** (>5 = no bump → bigger port at smaller settlement size); river-port bump keys off grain/stone/marble/timber presence." },
      { type: "change", text: "**Roads rule.** Desert / mountains / alpine / sub_artic / small-islands / karst cap roads at **tier 1**; **highways** require the region's total resource amount to **exceed 12**, otherwise paved_roads; region **Roma** always gets highways." },
    ],
  },
  {
    version: "0.16.11",
    date: "2026-05-24",
    items: [
      { type: "change", text: "**Urban exploits reworked around stack size** (matching rural). Placed when a mapped resource is at stack **2+**; **highest amount wins** (priority breaks exact ties). Building tier follows settlement size + amount: **towns get none**, large_town only at amount 4-5; tier = settlement_tier−1 (4-5) or −2 (2-3), capped at 3. `…supply` levels are never used. `sheep`/`flax`/`cotton` → `textiles_production`; fish no longer needs salt." },
    ],
  },
  {
    version: "0.16.10",
    date: "2026-05-24",
    items: [
      { type: "change", text: "**Rural exploits reworked around stack size.** A rural building is placed whenever a mapped resource is present in a stack of **2+**; the **highest-amount** resource wins (priority list breaks exact ties). Building tier follows settlement size **and** amount: tier = settlement tier for amount 4-5, one below for 2-3 (capped at 3) — so a town only gets one at amount 4-5. `…supply`/`…sawmill` levels are never used (drops to the tier below)." },
      { type: "change", text: "**Elephants → ivory_trade moved from urban to rural** exploits." },
    ],
  },
  {
    version: "0.16.9",
    date: "2026-05-24",
    items: [
      { type: "change", text: "**Military capped at tier 2.** Both MIC and garrison are capped at their tier-2 building (`mic_2` / `garrison+1`) — enables full homeland recruitment while leaving higher tiers for the player to build." },
      { type: "change", text: "**Fewer pre-built cisterns.** Sanitation's water rule no longer counts `irrigation_lake` / `irrigation_springs` (only `lead` & `irrigation_river`), so fewer settlements start with a health building." },
    ],
  },
  {
    version: "0.16.8",
    date: "2026-05-24",
    items: [
      { type: "change", text: "**Heavy industry rebalanced to per-building weights.** Each building now scores resources with its own weights (e.g. mines gold 9 / silver 8…, jewelry gemstones 8…, smith iron 7 / coal 6…) instead of one global table. Added two buildings — **`salt_production`** and **`pitch_gathering`** — and a new tie-break order." },
      { type: "fix", text: "**No more `…_supply` levels.** A building's top `_supply` level is never selected; it drops to the tier below (affects salt, pitch, jewelry, stone, sulphur, purple_dye, marble)." },
    ],
  },
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
