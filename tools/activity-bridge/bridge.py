#!/usr/bin/env python3
"""Local, opt-in Computer History + Codex observation bridge. No screen capture.
Reads only configured threads. Sends aggregate seconds, never history text, to SP.
"""
import argparse
import datetime as dt
import json
import math
import re
import subprocess
import time
import urllib.request
import urllib.error
from pathlib import Path
from zoneinfo import ZoneInfo
from mappings import load_mapping, effective_config, projection, merge_projection

NODE = re.compile(r'^[+~]?\s*(\d+) (.*)$')
MARKER = re.compile(r'^(?:container)(?: \([^)]*\))* (.+)$')


def timestamp(value):
    if isinstance(value, (int, float)):
        return value / 1000 if value > 100000000000 else value
    return dt.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()


class ForegroundThread:
    def __init__(self, bindings):
        self.nodes = {}
        self.bindings = bindings

    def observe(self, event):
        if event.get('app', {}).get('bundleIdentifier') != 'com.openai.codex':
            return None
        ax = event.get('ax', {})
        text = ax.get('text', '')
        if ax.get('mode') == 'fullTree':
            self.nodes.clear()
        for line in text.splitlines():
            if line.startswith('Removed element IDs:'):
                for piece in line.partition(':')[2].strip().split(','):
                    pair = piece.strip().split('-')
                    if all(p.isdigit() for p in pair):
                        for i in range(int(pair[0]), int(pair[-1]) + 1):
                            self.nodes.pop(i, None)
            else:
                match = NODE.match(line)
                if match:
                    self.nodes[int(match[1])] = match[2]
        # Main-pane header immediately precedes Chat actions; never match sidebar titles.
        candidates = []
        for key, node in self.nodes.items():
            if re.search(r'(?:弹出式按钮|pop.up button).*?(?:聊天操作|Chat actions)$', node, re.I):
                title = MARKER.match(self.nodes.get(key - 1, ''))
                if title:
                    candidates.extend(b for b in self.bindings if title[1] == b['title'])
        return candidates[0] if len(candidates) == 1 else None


def human_intervals(events, bindings, idle_seconds=60):
    """Event-bounded attention estimate, never extrapolated past the last event."""
    resolver = ForegroundThread(bindings)
    previous = None
    for event in events:
        at = timestamp(event['timestamp'])
        binding = resolver.observe(event)
        if previous:
            start, owner = previous
            # Stops at switch events; reading without new input is capped by idle threshold.
            if owner and at > start:
                yield owner['taskId'], start, min(at, start + idle_seconds)
        previous = (at, binding)


def add_interval(totals, task, start, end, field, timezone):
    while end > start:
        date = dt.datetime.fromtimestamp(start, timezone).date()
        next_day = dt.datetime.combine(date + dt.timedelta(days=1), dt.time(), timezone).timestamp()
        stop = min(end, next_day)
        bucket = totals.setdefault(task, {}).setdefault(str(date), {'humanMs': 0, 'aiMs': 0})
        bucket[field] += round((stop - start) * 1000)
        start = stop


def merged_human_intervals(ledger):
    """Union independently collected human spans before adding them to a day."""
    by_task = {}
    for source in ('human', 'foregroundHuman'):
        entries = ledger.get(source, {})
        if not isinstance(entries, dict):
            raise ValueError(f'Invalid {source} ledger')
        for entry in entries.values():
            if (not isinstance(entry, list) or len(entry) != 3 or
                    not isinstance(entry[0], str) or
                    not all(isinstance(value, (int, float)) and not isinstance(value, bool)
                            and math.isfinite(value) for value in entry[1:]) or
                    entry[2] <= entry[1] or entry[2] - entry[1] > 86400):
                raise ValueError(f'Invalid {source} interval')
            by_task.setdefault(entry[0], []).append((entry[1], entry[2]))
    for task, spans in by_task.items():
        current = None
        for start, end in sorted(spans):
            if current is None:
                current = (start, end)
            elif start <= current[1]:
                current = (current[0], max(current[1], end))
            else:
                yield task, *current
                current = (start, end)
        if current is not None:
            yield task, *current


def read_history(root, since, until):
    events = []
    segments = Path(root) / 'segments'
    list(segments.iterdir())  # Surface missing paths and macOS permission errors.
    # Raw segments roll forward; callers retain a private event ledger of time + association only.
    for folder in sorted((Path(root) / 'segments').glob('*')):
        try:
            segment_time = timestamp(folder.name.replace('Z', '').replace('T', 'T', 1)[:10] + 'T' + folder.name[11:19].replace('-', ':') + 'Z')
        except ValueError:
            continue
        if segment_time + 600 < since or segment_time > until:
            continue
        try:
            with (folder / 'events.jsonl').open() as stream:
                for line in stream:
                    try:
                        event = json.loads(line)
                        if timestamp(event['timestamp']) <= until:
                            events.append(event)
                    except (ValueError, KeyError):
                        continue
        except FileNotFoundError:
            continue
    return sorted(events, key=lambda e: (e['timestamp'], e.get('id', 0)))


# Runs via python stdin remotely as well. Output is lifecycle metadata only.
READ_RUNS = r'''
import json,pathlib,sys,re
ids=json.loads(sys.argv[1]); root=pathlib.Path(sys.argv[2]).expanduser() if len(sys.argv)>2 else pathlib.Path.home()/'.codex'; result={i:None for i in ids}
for base in ['sessions','archived_sessions']:
 for path in (root/base).rglob('*.jsonl'):
  # Resumed rollouts may append a new UUID; verify identity from session_meta.
  if not any(i in path.name for i in ids):continue
  owner=None; active=None
  with path.open() as lines:
   for line in lines:
    try:e=json.loads(line)
    except ValueError:continue
    p=e.get('payload',{}); kind=e.get('type')
    if kind=='session_meta':
     owner=p.get('id') if p.get('id') in ids else None
     if owner and result[owner] is None:result[owner]=[]
     continue
    if owner is None:continue
    if kind=='turn_context':active=p.get('turn_id',active)
    if kind=='event_msg' and p.get('type') in ['task_started','task_complete','turn_aborted']:
     active=p.get('turn_id',active)
     result[owner].append({'timestamp':e['timestamp'],'turn_id':active,**{k:p[k] for k in ['type','started_at','completed_at','duration_ms'] if k in p}})
     if p['type']!='task_started':active=None
    elif active and ((kind=='response_item' and (p.get('role')=='assistant' or p.get('type') in ['function_call','function_call_output','custom_tool_call','custom_tool_call_output'])) or (kind=='event_msg' and p.get('type') in ['item_completed','token_count'])):
     result[owner].append({'timestamp':e['timestamp'],'type':'task_progress','turn_id':active})
print(json.dumps(result))
'''


def run_key(binding):
    return binding.get('profileId', binding.get('host', 'local'))


def read_runs(bindings):
    groups = {}
    for b in bindings:
        groups.setdefault((b.get('host', 'local'), b.get('codexRoot', '~/.codex'), run_key(b)), []).append(b['threadId'])
    result = {}
    for (host, root, key), ids in groups.items():
        args = ['python3', '-', json.dumps(sorted(set(ids))), root]
        if host != 'local':
            if not re.fullmatch(r'[a-zA-Z0-9_.-]+', host):
                raise ValueError('Invalid configured SSH alias')
            import shlex
            args = ['ssh', '-oBatchMode=yes', '-oConnectTimeout=8', host, shlex.join(args)]
        try:
            process = subprocess.run(args, input=READ_RUNS, text=True, capture_output=True, timeout=35, check=True)
            result[key] = json.loads(process.stdout)
        except (subprocess.SubprocessError, ValueError, OSError):
            result[key] = {thread: None for thread in ids}
    return result


def ai_intervals(events, since, until):
    """Count observed run spans, including open turns only up to last evidence."""
    starts, progress, spans, completed = {}, {}, [], set()
    for e in sorted(events, key=lambda item: timestamp(item['timestamp'])):
        turn = e.get('turn_id')
        at = timestamp(e['timestamp'])
        if e['type'] == 'task_started':
            starts[turn] = timestamp(e.get('started_at', e['timestamp']))
        elif e['type'] == 'task_progress' and turn in starts:
            progress[turn] = at
        elif e['type'] in ('task_complete', 'turn_aborted'):
            start = timestamp(e['started_at']) if e.get('started_at') else starts.get(turn)
            if isinstance(e.get('duration_ms'), (int, float)) and e['duration_ms'] >= 0:
                start = at - e['duration_ms'] / 1000
            if start is not None and turn not in completed:
                spans.append((start, at)); completed.add(turn)
            starts.pop(turn, None)
    for turn, start in starts.items():
        if turn not in completed and progress.get(turn, start) > start:
            spans.append((start, progress[turn]))
    # Duplicate rollouts and repeated lifecycle messages must not double count.
    merged = []
    for start, end in sorted((max(a, since), min(b, until)) for a, b in spans if b > since and a < until):
        if end <= start:continue
        if merged and start <= merged[-1][1]:merged[-1] = (merged[-1][0], max(end, merged[-1][1]))
        else:merged.append((start, end))
    yield from merged


def api(config, method, route, body=None):
    token = Path(config['tokenFile']).expanduser().read_text().strip()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request('http://127.0.0.1:3876' + route, data=data, method=method,
                                headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
    with opener.open(req, timeout=15) as response:
        return json.load(response)['data']


def run(config, apply=False, ai_only=False):
    mapping = load_mapping(config)
    config = effective_config(config, mapping)
    since = timestamp(config['since'])
    human_since = timestamp(config.get('humanSince', config['since']))
    until = time.time()
    timezone = ZoneInfo(config.get('timezone', 'Asia/Shanghai'))
    events = [] if ai_only else read_history(config['historyRoot'], human_since, until)
    totals = {}
    ledger_path = Path(config['ledgerFile']).expanduser()
    if ai_only and not ledger_path.exists():
        raise ValueError('AI-only import requires the existing human ledger; refusing to reset human totals')
    ledger = json.loads(ledger_path.read_text()) if ledger_path.exists() else {'human': {}}
    # Recovery after loss of the interval ledger can retain only totals proven by
    # already-imported Todo receipts. Keep them separate from observed intervals:
    # inventing timestamps would make later attribution and deduplication unsound.
    for task, days in ledger.get('humanBaselineMs', {}).items():
        for day, milliseconds in days.items():
            if (not isinstance(milliseconds, int) or isinstance(milliseconds, bool)
                    or milliseconds < 0 or milliseconds > 86400000
                    or dt.date.fromisoformat(day).isoformat() != day):
                raise ValueError('Invalid recovered human baseline')
            bucket = totals.setdefault(task, {}).setdefault(day, {'humanMs': 0, 'aiMs': 0})
            bucket['humanMs'] += milliseconds
    for task, start, end in human_intervals(events, config['bindings'], config.get('idleSeconds', 60)):
        if end > human_since:
            start = max(start, human_since)
            # Stable timestamp key + absolute end makes replays idempotent.
            ledger['human'][f'{task}/{start}'] = [task, start, end]
    for task, start, end in merged_human_intervals(ledger):
        add_interval(totals, task, start, end, 'humanMs', timezone)
    ai_bindings = config.get('aiBindings', config['bindings'])
    runs = read_runs(ai_bindings)
    missing_tasks = {b['taskId'] for b in ai_bindings if runs[run_key(b)].get(b['threadId']) is None}
    seen_bindings = set()
    recently_active = set()
    evidence = []
    for binding in ai_bindings:
        key = (binding['taskId'], run_key(binding), binding['threadId'], tuple(binding.get('turnIds', [])))
        if key in seen_bindings or binding['taskId'] in missing_tasks:continue
        seen_bindings.add(key)
        events = runs[run_key(binding)][binding['threadId']]
        if binding.get('scope') == 'selectedTurns':
            events = [event for event in events if event.get('turn_id') in binding['turnIds']]
        for start, end in ai_intervals(events, since, until):
            add_interval(totals, binding['taskId'], start, end, 'aiMs', timezone)
            evidence.append({'taskId': binding['taskId'], 'threadId': binding['threadId'],
                             'profile': run_key(binding), 'start': start, 'end': end,
                             'scope': binding.get('scope', 'wholeThread'),
                             'turnIds': sorted({e['turn_id'] for e in events if e.get('turn_id') and start <= timestamp(e['timestamp']) <= end})})
            if end >= until - 600:recently_active.add(binding['taskId'])
    for task, days in config.get('corrections', {}).items():
        for day, correction in days.items():
            bucket = totals.setdefault(task, {}).setdefault(day, {'humanMs': 0, 'aiMs': 0})
            for field in ('humanMs', 'aiMs'):
                bucket[field] = max(0, bucket[field] + int(correction.get(field, 0)))
    if not ai_only:
        ledger_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = ledger_path.with_suffix('.tmp')
        temporary.write_text(json.dumps(ledger)); temporary.chmod(0o600); temporary.replace(ledger_path)
    foreground_status = ledger.get('foregroundStatus')
    foreground_checked = ledger.get('foregroundLastCheck')
    foreground_fresh = (isinstance(foreground_checked, (int, float)) and
                        not isinstance(foreground_checked, bool) and
                        0 <= until - foreground_checked <= 900)
    human_collection = 'skipped_preserved_ledger' if ai_only else 'collected'
    if ai_only and foreground_status and foreground_fresh:
        human_collection = ('collected' if foreground_status == 'observing'
                            else f'foreground_{foreground_status}')
    elif ai_only and foreground_status:
        human_collection = 'foreground_stale'
    human_sources = []
    if ledger.get('human') or ledger.get('humanBaselineMs'):
        human_sources.append('Computer History or recovered human baseline')
    if ledger.get('foregroundHuman'):
        human_sources.append('macOS Codex foreground and idle estimate')
    result = {'asOf': dt.datetime.now(dt.timezone.utc).isoformat(), 'tasks': totals,
              'humanSource': '; '.join(human_sources) or 'No human intervals collected',
              'aiSource': 'Codex run intervals; open turns bounded by latest activity', 'applied': apply,
              'aiEvidence': evidence, 'since': config['since'], 'mappingRevision': mapping['revision'] if mapping else None,
              'missingSessionTaskIds': sorted(missing_tasks), 'aiBindingCount': len(ai_bindings),
              'humanCollection': human_collection,
              'foregroundCollection': (foreground_status if foreground_fresh else
                                       'stale' if foreground_status else 'not_configured')}
    if mapping:
        result['associations'] = {task['taskId']: projection(task, mapping, result) for task in mapping['tasks']}
    if apply:
        inactive = {task['taskId'] for task in mapping['tasks']
                    if not any(b['taskId'] == task['taskId'] for b in ai_bindings)} if mapping else set()
        for binding in ai_bindings:
            totals.setdefault(binding['taskId'], {})
        for task, days in totals.items():
            if task in inactive:continue  # Pending/reference-only mappings preserve historical receipts.
            if task in missing_tasks:continue  # Preserve previously imported AI receipts.
            if mapping:
                try:
                    current = api(config, 'GET', f'/tasks/{task}')
                except urllib.error.HTTPError as error:
                    if error.code != 404:raise
                    result.setdefault('skippedTaskIds', []).append(task)
                    continue
                receipt = re.search(r'<!-- sp-activity-v1:(.*?) -->', current.get('notes') or '')
                for key in json.loads(receipt[1] if receipt else '{}'):
                    if key.startswith(config['source'] + '/'):
                        days.setdefault(key.split('/', 1)[1], {'humanMs': 0, 'aiMs': 0})
            for day, measures in days.items():
                try:
                    api(config, 'PUT', f'/tasks/{task}/activity', {'source': config['source'], 'date': day, 'inProgress': task in recently_active and day == str(dt.datetime.fromtimestamp(until, timezone).date()), **measures})
                except urllib.error.HTTPError as error:
                    if error.code != 404:
                        raise
                    result.setdefault('skippedTaskIds', []).append(task)
                    break
    if apply and mapping:
        for task_id, summary in result['associations'].items():
            try:
                task = api(config, 'GET', f'/tasks/{task_id}')
                notes = merge_projection(task.get('notes') or '', summary)
                api(config, 'PATCH', f'/tasks/{task_id}', {'notes': notes})
            except urllib.error.HTTPError as error:
                if error.code != 404:raise
                result.setdefault('skippedTaskIds', []).append(task_id)
    output = Path(config['reportFile']).expanduser()
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2)); output.chmod(0o600)
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--ai-only', action='store_true',
                        help='Update AI time without reading History; preserve existing human ledger totals')
    args = parser.parse_args()
    import fcntl
    config = json.loads(Path(args.config).read_text())
    with Path(config['ledgerFile']).expanduser().with_suffix('.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        result = run(config, args.apply, ai_only=args.ai_only)
    print(json.dumps({'asOf': result['asOf'], 'tasks': len(result['tasks']), 'applied': result['applied']}))


if __name__ == '__main__':
    main()
