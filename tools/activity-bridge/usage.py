#!/usr/bin/env python3
"""Reduce local activity facts into conservative, separately attributed estimates."""
import argparse
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import re
import time
from urllib.parse import urlsplit, unquote
from zoneinfo import ZoneInfo

START = '<!-- usage-estimate:start -->'
END = '<!-- usage-estimate:end -->'


def write_json(path, value):
    path = Path(path)
    tmp = path.with_suffix('.tmp')
    with open(tmp, 'w', encoding='utf-8') as out:
        os.chmod(tmp, 0o600)
        json.dump(value, out, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def matches(sample, rule):
    if sample['at'] < rule['effectiveFrom'] or sample.get('app') != rule['app']:
        return False
    kind, value = rule['kind'], rule['value']
    if kind == 'codexThreadId':
        return sample.get('threadId') == value
    if kind == 'codexThreadTitle':
        if sample.get('threadIdentityEvidence') in ('ambiguous_title', 'index_unavailable'):
            return False
        return sample.get('contextKind') == kind and sample.get('context') == value
    doc = urlsplit(sample.get('document', ''))
    if kind == 'documentPrefix':
        target = urlsplit(value)
        return (doc.scheme, doc.netloc) == (target.scheme, target.netloc) and (
            doc.path == target.path.rstrip('/') or doc.path.startswith(target.path.rstrip('/') + '/'))
    if kind == 'worktree':
        path = unquote(doc.path)
        return doc.scheme == 'file' and (path == value.rstrip('/') or path.startswith(value.rstrip('/') + '/'))
    return False


def context(s):
    return tuple(s.get(k) for k in ('app', 'windowTitle', 'contextKind', 'context', 'document', 'threadId', 'threadIdentityEvidence'))


def classify(a, b, rules, idle_limit, max_gap):
    if b['at'] - a['at'] > max_gap or a.get('session') != b.get('session'):
        return 'gap', None, '采样中断或进程重启'
    for state in ('paused', 'locked', 'private', 'permission_required', 'unavailable', 'transition'):
        if state in (a.get('state'), b.get('state')):
            return state, None, state
    if any(s.get('state') != 'observed' or not isinstance(s.get('idleSeconds'), (int, float)) for s in (a,b)):
        return 'unavailable', None, '缺少活动信号'
    if any(s['idleSeconds'] > idle_limit for s in (a, b)):
        return 'idle', None, '无输入超过阈值（阅读可能被低估）'
    if context(a) != context(b):
        return 'unassigned', None, '窗口或上下文切换'
    owners = {r['taskId'] for r in rules if matches(a, r) and matches(b, r)}
    if len(owners) == 1:
        return 'assigned', owners.pop(), '明确规则匹配'
    return 'unassigned', None, '规则冲突' if owners else '没有明确关联证据'


def reduce(samples, rules, timezone='Asia/Shanghai', idle_limit=60, max_gap=15):
    unique = {(s['at'], s.get('session')): s for s in samples}
    rows = sorted(unique.values(), key=lambda s: s['at'])
    spans = []
    zone = ZoneInfo(timezone)
    for a, b in zip(rows, rows[1:]):
        if b['at'] <= a['at']:
            continue
        state, task, reason = classify(a, b, rules, idle_limit, max_gap)
        start = a['at']
        while start < b['at']:
            local = dt.datetime.fromtimestamp(start, zone)
            midnight = dt.datetime.combine(local.date() + dt.timedelta(days=1), dt.time(), zone).timestamp()
            end = min(b['at'], midnight)
            span = dict(start=start, end=end, date=str(local.date()), state=state, taskId=task, reason=reason)
            if state in ('assigned','unassigned'):
                span.update({k: a[k] for k in ('app','windowTitle','context','document', 'threadIdentityEvidence') if k in a})
                if context(a) == context(b) and a.get('threadId'):
                    span['threadId'] = a['threadId']
            if spans and all(spans[-1].get(k) == v for k,v in span.items() if k not in ('start','end')) and spans[-1]['end'] == start:
                spans[-1]['end'] = end
            else:
                spans.append(span)
            start = end
    days = {}
    for s in spans:
        day = days.setdefault(s['date'], {'states': {}, 'tasks': {}, 'threads': {}})
        seconds = s['end'] - s['start']
        day['states'][s['state']] = day['states'].get(s['state'], 0) + seconds
        if s['taskId']:
            day['tasks'][s['taskId']] = day['tasks'].get(s['taskId'], 0) + seconds
        if s.get('threadId'):
            thread = day['threads'].setdefault(s['threadId'], {'seconds': 0, 'title': s.get('context', ''),
                'evidence': s.get('threadIdentityEvidence', '')})
            thread['seconds'] += seconds
            thread['title'] = s.get('context', '')
    return {'days': days, 'spans': spans}


def notes_with_estimate(notes, block):
    pattern = re.escape(START) + r'.*?' + re.escape(END)
    section = START + '\n' + block + '\n' + END
    if START in notes and END not in notes:
        raise ValueError('Incomplete owned notes section')
    return re.sub(pattern, lambda _: section, notes, flags=re.S) if START in notes else notes.rstrip() + '\n\n' + section


def run(config):
    root = Path(config['factsDir'])
    report_root = Path(config['reportsDir'])
    report_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    samples = []
    invalid = 0
    for path in sorted(root.glob('????-??-??.jsonl')):
        with path.open() as stream:
            for line in stream:
                if not line.endswith('\n'):  # concurrent append; retry next run
                    continue
                try:
                    row = json.loads(line)
                    if not isinstance(row.get('at'), (int,float)) or not row.get('session'):
                        raise ValueError()
                    samples.append(row)
                except (ValueError, TypeError):
                    invalid += 1
    rules = json.loads(Path(config['rulesFile']).read_text())['rules']
    report = reduce(samples, rules, config.get('timezone','Asia/Shanghai'), config.get('idleSeconds',60))
    report.update(generatedAt=time.time(), invalidLines=invalid)
    status_path = root / 'status.json'
    report['sampler'] = json.loads(status_path.read_text()) if status_path.exists() else {}
    report['sampler']['stale'] = time.time() - report['sampler'].get('checkedAt',0) > 20
    report['sync'] = {'enabled': config.get('syncNotes',False), 'updated':0, 'errors':0}
    if config.get('syncNotes'):
        from tasks import request, task_route
        today = str(dt.datetime.now(ZoneInfo(config.get('timezone','Asia/Shanghai'))).date())
        totals = report['days'].get(today, {}).get('tasks',{})
        for task_id in sorted({r['taskId'] for r in rules}):
            try:
                task = request('GET', task_route(task_id))
                if task.get('isDone'):
                    continue
                minutes = int(totals.get(task_id,0) // 60)
                capture = '采集心跳过期' if report['sampler']['stale'] else report['sampler'].get('state', 'unknown')
                block = f'人工活动估算 · {today}：{minutes} 分钟\n采集状态：{capture}\n仅累计有明确关联证据的前台活动；独立于正式工时。\n本机日报：{report_root / "latest.md"}'
                notes = task.get('notes') or ''
                updated = notes_with_estimate(notes, block)
                if updated != notes:
                    # Re-read immediately before patch to avoid overwriting routine observer updates.
                    task = request('GET', task_route(task_id))
                    if task.get('isDone'):
                        continue
                    updated = notes_with_estimate(task.get('notes') or '', block)
                    request('PATCH', task_route(task_id), {'notes': updated})
                    report['sync']['updated'] += 1
            except Exception:
                report['sync']['errors'] += 1
    write_json(report_root / 'latest.json', report)
    lines = ['# 电脑活动统计', '', '人工时间为估算；空闲、锁屏、暂停及采样缺口不计工时。原始活动仅保存在本机。', '',
             f'采集状态：{report["sampler"].get("state", "unknown")}；心跳过期：{report["sampler"]["stale"]}', '']
    for date, day in sorted(report['days'].items()):
        lines.extend([f'## {date}', '', *[f'- {key}：{value/60:.1f} 分钟' for key,value in day['states'].items()], ''])
        if day['threads']:
            lines.extend(['### Codex 会话活动估算', '', '身份依据：前台主标题与工具栏一致，并在配置的本机索引中唯一匹配；不是直接读取页面会话 ID。', ''])
            for thread_id, thread in sorted(day['threads'].items(), key=lambda item: -item[1]['seconds']):
                title = str(thread['title']).replace('\n', ' ')
                lines.append(f'- {title}：{thread["seconds"]/60:.1f} 分钟 · `{thread_id}`')
            lines.append('')
    lines.extend(['## 活动时间线（最近 500 段）', ''])
    zone = ZoneInfo(config.get('timezone','Asia/Shanghai'))
    for s in report['spans'][-500:]:
        start = dt.datetime.fromtimestamp(s['start'],zone).strftime('%m-%d %H:%M:%S')
        end = dt.datetime.fromtimestamp(s['end'],zone).strftime('%H:%M:%S')
        title = str(s.get('context',s.get('windowTitle',''))).replace('\n',' ')
        identity = ' · 会话 ' + s['threadId'] if s.get('threadId') else ''
        lines.append(f'- {start}—{end} · {s["state"]} · {s.get("app", "")} · {title}{identity} · {s["taskId"] or s["reason"]}')
    path = report_root / 'latest.md'
    path.write_text('\n'.join(lines) + '\n')
    path.chmod(0o600)
    print(json.dumps({'days':len(report['days']), 'samples':len(samples), 'sync':report['sync']}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True, type=Path)
    args = parser.parse_args()
    config = json.loads(args.config.read_text())
    with open(str(args.config) + '.lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        run(config)
