# Local activity bridge

This fork combines **Computer History evidence** with **Codex lifecycle events**.
It does not control or scrape the Codex application, change observation settings,
or upload screen/keyboard contents. Only configured task IDs, dates and aggregate
durations are sent to Super Productivity's authenticated localhost API.

Run with Python 3.9+:

```sh
python3 tools/activity-bridge/bridge.py --config /absolute/path/config.json
# After inspecting reportFile:
python3 tools/activity-bridge/bridge.py --config /absolute/path/config.json --apply
# If History status is unavailable/stopped/stale, update independent AI time:
python3 tools/activity-bridge/bridge.py --config /absolute/path/config.json --ai-only --apply
```

Configuration fields: `historyRoot` from the Computer History status tool,
`since` (ISO timestamp), `timezone` (IANA, default Asia/Shanghai), `idleSeconds`
(default 60), `source` (stable device collector ID), `tokenFile`, `ledgerFile`,
`reportFile`, optional `aiBindings` for separately verified AI-only associations, and `bindings`: `{taskId, threadId, title, host}`. `host` is `local`
or an existing SSH alias. Bind only sessions whose work belongs to that todo;
general-purpose group or mixed-topic sessions require separate attribution.

Before each run, the calling agent must check Computer History status and current
time with its tools. Do not treat paused/stopped/stale recording as fresh input.
Never read or change observation settings files. The collector uses already
recorded, eligible activity only. Run one collector instance per configuration.
`--ai-only` does not read History or change its ledger. It reuses the existing
human ledger totals (including configured corrections) so cumulative imports do
not reset human time. A missing ledger is an error. The report explicitly marks
human collection as skipped; AI lifecycle collection continues independently. AI bindings can cover more verified conversations without inventing foreground-review mappings.

- **Human estimate:** foreground Codex main-pane header must match exactly one
  configured title. Sidebar matches are ignored. Adjacent event intervals are
  capped at 60 seconds, split on application switches and local midnight. Nothing
  is extrapolated after the last observed event. This estimates on-screen
  attention, not proof of thinking or continuous keyboard use. Unobserved switches,
  renamed/ambiguous headers and quiet reading limit coverage. Raw history text is
  never persisted by this bridge; the private ledger retains only task/time spans.
- **AI elapsed:** Codex turns, using their
  duration metadata when available, otherwise matched start/end events. This is
  end-to-end agent runtime (including tools/waits), not model token latency. It
  includes background/remote runs and allows parallel totals. Open runs count only through their latest recorded assistant/tool activity; no time is extrapolated to the collector clock. Resumed files are matched by session identity and repeated intervals are merged. Missing session data preserves old receipts and appears in `missingSessionTaskIds`.
- **Progress:** only a recent AI observation (within ten minutes, on the current day) can mark its todo in progress; historical backfills do not change status, and awaiting-review tasks stay in review; completing
  a run does not imply that the user's todo is complete. Use the widget to reset
  progress or mark the task complete.
- **Deduplication:** human intervals use stable timestamp keys; imported cumulative
  totals use a source/day receipt in task notes. Preserve the receipt and stable
  source ID. Native time can be manually adjusted without resetting import totals.
  Avoid simultaneously running a manual native timer for the same automatically
  measured attention. When such overlap is needed, use estimates as a separate
  report rather than import both.
- **Coverage:** current implementation binds Codex sessions only. A todo backed
  only by a Claude transcript stays unbound rather than receiving guessed times.
  Periodic runs include evidence-bounded open turns; this is not a per-second live timer. Human history access/status failures remain explicit collection failures, not zero review time.
- **Corrections:** optional `corrections` maps task ID → date → signed `humanMs` /
  `aiMs` adjustments. These are added to observed totals on every run, clamped at
  zero, so manual corrections survive subsequent imports.

The private configuration/ledger belong outside the repository. A report-only
run (`--apply` omitted) never changes tasks. On import, native work logs and the
small aggregate receipts follow the user's existing sync provider; raw history
remains local.

## macOS foreground sampler alternative

`foreground_sampler.swift` is a separate opt-in source for *future* Codex review
time when Computer History is unavailable. It samples every five seconds and
counts an interval only when both endpoints have the same uniquely configured
Todo, Codex is the foreground application, the focused window's web-area and
main-pane header titles agree, and system idle time is at most `idleSeconds`.
It skips app switches, ambiguous titles, long gaps, and time before `humanSince`.
This is an on-screen attention estimate, not total human work; it cannot backfill
past activity or count work in an IDE, browser, document, or meeting.

The helper reads only title, foreground-app identity, and idle duration. It
persists task IDs and interval timestamps in the `foregroundHuman` field of
`ledgerFile`; no
screen content or raw title is written. `bridge.py --ai-only` unions these
intervals with existing Computer History intervals, so overlapping evidence is
counted once. AI time remains separate and must not be added to human time.
Only exact, unique `humanTitleMatch` bindings with whole-thread scope are
eligible; title changes and duplicate titles require review before counting.

On macOS, prepare the fixed app identity with:

```sh
bash tools/activity-bridge/install_foreground_sampler.sh
```

The installed app is
`~/Applications/MattoForegroundSampler.app`; the script stages a LaunchAgent but
does not start it. Grant that app Accessibility in System Settings, then start
the agent with:

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.matto.foreground-sampler.plist
```

Verify the *agent*
identity by reading `foregroundStatus` and `foregroundLastCheck` in the private
ledger; an interactive `--check` alone is not proof of background access. Use
`launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/local.matto.foreground-sampler.plist`
to stop it. Rebuilds
may require Accessibility to be granted again because the local app is ad hoc
signed. Never alter macOS privacy databases to enable it.

## Independent observer

[OBSERVER.md](OBSERVER.md) describes the five-minute observer that reuses one dedicated conversation for explicit user completion acknowledgments and activity collection. It replaces the source-thread heartbeat and the removed matto-productivity-dev skill. `tasks.py` provides read-only lookup and exact-ID, readback-verified completion. The observer never injects messages into business conversations.

## Canonical associations

Set `mappingFile` to a private JSON file with `schemaVersion: 1`, a monotonically
increasing `revision`, `profiles` and `tasks`. Each profile has `host`, `hostId`,
and `codexRoot` (expanded on the target machine). Each task has `taskId` and
`links`; each link has `threadId`, `profileId`, `role` (`primary`, `supporting`,
`background`) and `scope` (`pending`, `wholeThread`, `selectedTurns`, `excluded`).
`selectedTurns` requires nonempty `turnIds`. Optional `humanTitleMatch` enables
foreground estimation only for a whole-thread execution link.

Managed tasks override all three legacy arrays. Unmanaged tasks retain their
existing mappings. The observer should read effective associations with:

```sh
python3 tools/activity-bridge/tasks.py associations --config /absolute/path/config.json
```

Pending and reference-only tasks retain their historical receipts and do not
accrue new AI time. A missing profile/session also preserves old receipts. Shared
execution scopes cannot overlap; background references never accrue time.
Report-only mode previews durations and associations without writing tasks.
On apply, association summaries are projected into a compatible task-notes
comment, and the widget uses the canonical default thread for navigation.
The summary includes range, last check, and whether human estimates were refreshed.
No transcripts or credentials are projected. After 15 minutes the widget marks
an old summary stale when task data next refreshes.

Reports retain collection intervals, thread/turn identifiers and mapping revision
for auditing. Changing scope replaces prior daily receipts for the same source,
including days now empty. Manual time is retained by the activity API's delta
merge. CLI collectors sharing a ledger use a nonblocking file lock.
