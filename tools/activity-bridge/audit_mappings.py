#!/usr/bin/env python3
"""Read-only reconciliation of open Todo links and legacy timing bindings.

This checks configuration coverage, not thread existence or semantic ownership.
Output contains task metadata only; no notes, credentials or transcripts.
"""
import argparse
import json
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

import tasks


def audit(items, config):
    rows = []
    owners = defaultdict(set)
    for task in items:
        if task.get('isDone'):
            continue
        links = tasks.compact(task, links=True)['codexLinks']
        thread_ids = [urlsplit(link).path.rsplit('/', 1)[-1].lower() for link in links]
        coverage = {}
        issues = []
        if not thread_ids:
            issues.append('missing_note_link')
        for key in ('bindings', 'aiBindings', 'observerBindings'):
            matches = [b for b in config.get(key, []) if b.get('taskId') == task['id']]
            bound_ids = {b.get('threadId', '').lower() for b in matches}
            coverage[key] = {
                'threadIds': sorted(bound_ids),
                'noteThreadsWithoutBinding': sorted(set(thread_ids) - bound_ids),
                'bindingThreadsOutsideNotes': sorted(bound_ids - set(thread_ids)),
            }
            if set(thread_ids) - bound_ids:
                issues.append(key + ':incomplete_note_coverage')
            if bound_ids - set(thread_ids):
                issues.append(key + ':extra_threads_need_review')
            # Legacy `title` is a foreground thread-title matcher, NOT a Todo title.
            if any(b.get('taskTitle') and b['taskTitle'] != task['title'] for b in matches):
                issues.append(key + ':stale_task_title')
        for thread_id in thread_ids:
            owners[thread_id].add(task['id'])
        rows.append({
            'taskId': task['id'], 'taskTitle': task['title'],
            'threadIds': sorted(set(thread_ids)), 'coverage': coverage,
            'issues': issues, 'semanticVerification': 'not_checked',
        })
    shared = {key: sorted(value) for key, value in owners.items() if len(value) > 1}
    for row in rows:
        if any(thread in shared for thread in row['threadIds']):
            row['issues'].append('shared_thread_requires_attribution_scope')
    return {'schemaVersion': 1, 'openTaskCount': len(rows),
            'linkedTaskCount': sum(bool(row['threadIds']) for row in rows),
            'sharedNoteThreads': shared, 'tasks': rows}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--project-id', help='Limit audit to one project')
    args = parser.parse_args()
    config = json.loads(args.config.read_text())
    from mappings import load_mapping, effective_config
    config = effective_config(config, load_mapping(config))
    items = tasks.request('GET', '/tasks')
    if args.project_id:
        items = [task for task in items if task.get('projectId') == args.project_id]
    result = audit(items, config)
    result['checkedAt'] = datetime.now(timezone.utc).isoformat()
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
