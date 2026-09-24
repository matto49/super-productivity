"""Canonical local associations; legacy arrays are fallback only for unmanaged tasks."""
import json
from pathlib import Path

PREFIX = '<!-- sp-codex-v1:'
SUFFIX = ' -->'


def load_mapping(config):
    if not config.get('mappingFile'):
        return None
    value = json.loads(Path(config['mappingFile']).expanduser().read_text())
    if value.get('schemaVersion') != 1:
        raise ValueError('Unsupported mapping version')
    owners = {}
    task_ids = set()
    for task in value['tasks']:
        if task['taskId'] in task_ids:
            raise ValueError('Duplicate task mapping')
        task_ids.add(task['taskId'])
        primary = 0
        for link in task['links']:
            if link['profileId'] not in value['profiles']:
                raise ValueError('Unknown collector profile')
            if link['role'] not in ('primary', 'supporting', 'background'):
                raise ValueError('Invalid link role')
            primary += link['role'] == 'primary'
            if link['scope'] not in ('pending', 'wholeThread', 'selectedTurns', 'excluded'):
                raise ValueError('Invalid attribution scope')
            if link['scope'] == 'selectedTurns' and not link.get('turnIds'):
                raise ValueError('Selected turns cannot be empty')
            if link['role'] == 'background' and link['scope'] not in ('pending', 'excluded'):
                raise ValueError('Background reference cannot collect time')
            if link['scope'] not in ('wholeThread', 'selectedTurns'):
                continue
            profile = value['profiles'][link['profileId']]
            identity = (profile['hostId'], link['threadId'])
            turns = None if link['scope'] == 'wholeThread' else set(link['turnIds'])
            for previous in owners.setdefault(identity, []):
                if turns is None or previous is None or turns & previous:
                    raise ValueError('Overlapping thread attribution')
            owners[identity].append(turns)
        if primary > 1:
            raise ValueError('Only one primary link is allowed')
    return value


def effective_config(config, mapping):
    if mapping is None:
        return config
    result = dict(config)
    managed = {task['taskId'] for task in mapping['tasks']}
    for key in ('bindings', 'aiBindings', 'observerBindings'):
        result[key] = [b for b in config.get(key, config.get('bindings', []) if key == 'aiBindings' else [])
                       if b['taskId'] not in managed]
    for task in mapping['tasks']:
        pending = any(link['scope'] == 'pending' for link in task['links'])
        for link in task['links']:
            profile = mapping['profiles'][link['profileId']]
            binding = {'taskId': task['taskId'], 'threadId': link['threadId'],
                       'host': profile['host'], 'hostId': profile['hostId'],
                       'codexRoot': profile['codexRoot'], 'profileId': link['profileId'],
                       'taskTitle': task.get('taskTitle', ''),
                       'title': link.get('threadTitle', ''),
                       'scope': link['scope'], 'turnIds': link.get('turnIds', [])}
            if link['role'] != 'background':
                result['observerBindings'].append(binding)
            if not pending and link['scope'] in ('wholeThread', 'selectedTurns') and link['role'] != 'background':
                result['aiBindings'].append(binding)
                if link.get('humanTitleMatch') and link['scope'] == 'wholeThread':
                    result['bindings'].append(dict(binding, title=link['humanTitleMatch']))
    # Reject duplicate ownership against unmanaged legacy records too.
    seen = {}
    for binding in result['aiBindings']:
        key = (binding.get('hostId', binding.get('host', 'local')), binding['threadId'])
        scope = set(binding['turnIds']) if binding.get('scope') == 'selectedTurns' else None
        for owner, turns in seen.setdefault(key, []):
            if owner != binding['taskId'] and (scope is None or turns is None or scope & turns):
                raise ValueError('Legacy mapping conflicts with canonical attribution')
        seen[key].append((binding['taskId'], scope))
    return result


def projection(task, mapping, result):
    links = task['links']
    pending = any(link['scope'] == 'pending' for link in links)
    selected = next((link for link in links if link['role'] == 'primary'), links[0] if links else None)
    status = ('needs_scope' if pending else
              'not_collected' if not any(link['scope'] in ('wholeThread', 'selectedTurns') for link in links)
              else 'missing' if task['taskId'] in result['missingSessionTaskIds'] else 'collected')
    human_binding = not pending and any(
        link['scope'] == 'wholeThread' and link['role'] != 'background'
        and link.get('humanTitleMatch') for link in links)
    return {'threadUrl': 'codex://threads/' + selected['threadId'] if selected else '',
            'threadCount': len(links), 'status': status, 'checkedAt': result['asOf'],
            'since': result['since'], 'revision': mapping['revision'],
            'humanStatus': result['humanCollection'] if human_binding else 'not_collected'}


def merge_projection(notes, value):
    start = notes.find(PREFIX)
    if start >= 0:
        end = notes.find(SUFFIX, start)
        if end < 0 or notes.find(PREFIX, end) >= 0:
            raise ValueError('Invalid existing mapping projection')
        notes = notes[:start] + notes[end + len(SUFFIX):]
    return notes.rstrip() + '\n\n' + PREFIX + json.dumps(value, ensure_ascii=False) + SUFFIX
