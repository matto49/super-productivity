#!/usr/bin/env python3
"""Read tasks and complete an explicitly selected task through the local app API."""
import argparse
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

BASE = 'http://127.0.0.1:3876'
TOKEN_FILE = Path.home() / 'Library/Application Support/superProductivity/local-rest-api-token'


def request(method, route, body=None):
    token = TOKEN_FILE.read_text().strip()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    req = urllib.request.Request(
        BASE + route, method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'},
    )
    with opener.open(req, timeout=15) as response:
        result = json.load(response)
    if not result.get('ok'):
        raise RuntimeError('API reported failure; no successful update confirmed')
    return result['data']


def compact(task, links=False):
    result = {k: task.get(k) for k in ('id', 'title', 'projectId', 'isDone', 'parentId')}
    if links:
        result['codexLinks'] = sorted(set(re.findall(
            r'codex://threads/[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}(?=[\s)]|$)',
            task.get('notes') or '',
        )))
    return result


def task_route(task_id):
    return '/tasks/' + urllib.parse.quote(task_id, safe='')


def complete(task_id, expected_title):
    route = task_route(task_id)
    task = request('GET', route)
    if task.get('title') != expected_title:
        raise RuntimeError('Title changed; re-read and resolve the intended task before updating')
    if task.get('isDone'):
        return {'status': 'already_done', 'task': compact(task)}
    request('PATCH', route, {'isDone': True})
    verified = request('GET', route)
    if verified.get('isDone') is not True:
        raise RuntimeError('Completion readback failed; inspect current state before retrying')
    return {'status': 'completed', 'task': compact(verified)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    listing = sub.add_parser('list')
    listing.add_argument('--query', default='')
    listing.add_argument('--include-done', action='store_true')
    show = sub.add_parser('show')
    show.add_argument('--id', required=True)
    associations = sub.add_parser('associations', help='Read effective canonical thread bindings')
    associations.add_argument('--config', required=True, type=Path)
    done = sub.add_parser('complete')
    done.add_argument('--id', required=True)
    done.add_argument('--expected-title', required=True)
    args = parser.parse_args()
    try:
        if args.command == 'associations':
            from mappings import load_mapping, effective_config
            config = json.loads(args.config.read_text())
            effective = effective_config(config, load_mapping(config))
            output = {key: effective.get(key, []) for key in ('aiBindings', 'observerBindings')}
        elif args.command == 'list':
            tasks = request('GET', '/tasks')
            output = [compact(t) for t in tasks
                      if (args.include_done or not t.get('isDone'))
                      and args.query.casefold() in t.get('title', '').casefold()]
        elif args.command == 'show':
            output = compact(request('GET', task_route(args.id)), links=True)
        else:
            output = complete(args.id, args.expected_title)
        print(json.dumps(output, ensure_ascii=False, indent=2))
    except urllib.error.HTTPError as error:
        print(f'Local API HTTP {error.code}; update not confirmed. Read current state before retrying.', file=sys.stderr)
        return 1
    except (OSError, ValueError, KeyError, TypeError, RuntimeError) as error:
        # Do not expose response bodies, bearer tokens, notes or raw activity.
        message = str(error) if isinstance(error, RuntimeError) else type(error).__name__
        print(f'Cannot confirm task operation: {message}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
