// changelog.js — per-version "What's New" entries for the Settlement Processor
// Suite, newest first. Rendered as cards by updater-ui.js after an update.
// Each entry: { version, date, items: [{ type, text }] }
// Types: "feature" | "fix" | "improvement" | "change". `text` supports **bold**
// and `code`.
window.SPS_TYPE_COLOURS = { feature: "#4a9", fix: "#c66", improvement: "#6ac", change: "#ba6" };

window.SPS_CHANGELOG = [
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
