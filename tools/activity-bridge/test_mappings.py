import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import bridge
from mappings import effective_config, load_mapping, merge_projection, projection


def fixture():
    return {'schemaVersion': 1, 'revision': 1,
            'profiles': {'mac': {'host': 'local', 'hostId': 'mac', 'codexRoot': '~/.custom'}},
            'tasks': [{'taskId': 'a', 'links': [{'threadId': 'one', 'profileId': 'mac',
                       'role': 'primary', 'scope': 'selectedTurns', 'turnIds': ['yes']}]}]}


class MappingTests(unittest.TestCase):
    def validate(self, mapping):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'mapping.json'
            path.write_text(json.dumps(mapping))
            return load_mapping({'mappingFile': str(path)})

    def test_rejects_shared_turns_but_allows_disjoint_ones(self):
        m = fixture()
        other = copy.deepcopy(m['tasks'][0]); other['taskId'] = 'b'
        m['tasks'].append(other)
        with self.assertRaisesRegex(ValueError, 'Overlapping'):
            self.validate(m)
        other['links'][0]['turnIds'] = ['other']
        self.validate(m)
        other['links'][0]['scope'] = 'wholeThread'
        with self.assertRaisesRegex(ValueError, 'Overlapping'):
            self.validate(m)

    def test_canonical_overrides_managed_legacy_only(self):
        m = self.validate(fixture())
        c = effective_config({'bindings': [], 'aiBindings': [
            {'taskId': 'a', 'threadId': 'wrong'}, {'taskId': 'b', 'threadId': 'legacy'}]}, m)
        self.assertEqual([b['threadId'] for b in c['aiBindings']], ['legacy', 'one'])
        self.assertEqual(c['aiBindings'][1]['codexRoot'], '~/.custom')
        self.assertEqual(c['bindings'], [])

    def test_pending_retains_observer_without_counting(self):
        m = fixture(); m['tasks'][0]['links'][0]['scope'] = 'pending'
        c = effective_config({'bindings': []}, self.validate(m))
        self.assertEqual(c['aiBindings'], [])
        self.assertEqual(len(c['observerBindings']), 1)
        extra = copy.deepcopy(m['tasks'][0]['links'][0])
        extra.update(threadId='two', role='supporting', scope='wholeThread')
        m['tasks'][0]['links'].append(extra)
        self.assertEqual(effective_config({'bindings': []}, self.validate(m))['aiBindings'], [])

    def test_projection_preserves_other_notes_and_activity(self):
        notes = 'User notes\n<!-- sp-activity-v1:{} -->'
        first = merge_projection(notes, {'revision': 1})
        updated = merge_projection(first, {'revision': 2})
        self.assertTrue(updated.startswith(notes))
        self.assertEqual(updated.count('sp-codex-v1:'), 1)

    def test_human_collection_requires_an_eligible_task_binding(self):
        mapping = fixture()
        task = mapping['tasks'][0]
        result = {'asOf': '2026-09-24T00:00:00Z', 'since': '2026-09-23T00:00:00Z',
                  'missingSessionTaskIds': [], 'humanCollection': 'collected'}
        self.assertEqual(projection(task, mapping, result)['threadUrl'],
                         'codex://threads/one?hostId=mac')
        self.assertEqual(projection(task, mapping, result)['humanStatus'], 'not_collected')
        task['links'][0].update(scope='wholeThread', humanTitleMatch='Work')
        self.assertEqual(projection(task, mapping, result)['humanStatus'], 'collected')
        task['links'][0]['scope'] = 'pending'
        self.assertEqual(projection(task, mapping, result)['humanStatus'], 'not_collected')

    def test_selected_turn_integration_and_repeat_import(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            mapping = root / 'mapping.json'; mapping.write_text(json.dumps(fixture()))
            ledger = root / 'ledger.json'; ledger.write_text('{"human":{}}')
            config = {'mappingFile': str(mapping), 'since': 0, 'bindings': [],
                      'ledgerFile': str(ledger), 'reportFile': str(root / 'report.json'), 'source': 'test'}
            events = [{'type': 'task_complete', 'timestamp': 160, 'started_at': 100, 'turn_id': 'yes'},
                      {'type': 'task_complete', 'timestamp': 300, 'started_at': 200, 'turn_id': 'no'}]
            with patch.object(bridge, 'read_runs', return_value={'mac': {'one': events}}):
                first = bridge.run(config, ai_only=True)
                second = bridge.run(config, ai_only=True)
            self.assertEqual(first['tasks'], second['tasks'])
            self.assertEqual(first['tasks']['a']['1970-01-01']['aiMs'], 60000)
            self.assertEqual(first['associations']['a']['status'], 'collected')

    def test_apply_clears_removed_day_and_preserves_pending_task(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            m = fixture()
            pending = copy.deepcopy(m['tasks'][0]); pending['taskId'] = 'pending'
            pending['links'][0]['scope'] = 'pending'; m['tasks'].append(pending)
            path = root / 'mapping.json'; path.write_text(json.dumps(m))
            ledger = root / 'ledger.json'; ledger.write_text('{"human":{"pending/100":["pending",100,160]}}')
            config = {'mappingFile': str(path), 'since': 0, 'bindings': [],
                      'ledgerFile': str(ledger), 'reportFile': str(root / 'report.json'), 'source': 'test'}
            def api(config, method, route, body=None):
                return {'notes': 'Keep me\n<!-- sp-activity-v1:{"test/1970-01-02":{"humanMs":0,"aiMs":30000}} -->'}
            with patch.object(bridge, 'read_runs', return_value={'mac': {'one': []}}), \
                 patch.object(bridge, 'api', side_effect=api) as calls:
                bridge.run(config, apply=True, ai_only=True)
            writes = [c.args for c in calls.call_args_list if c.args[1] == 'PUT']
            self.assertEqual(len(writes), 1)
            self.assertEqual(writes[0][2], '/tasks/a/activity')
            self.assertEqual(writes[0][3]['aiMs'], 0)
            self.assertEqual(writes[0][3]['date'], '1970-01-02')
            projected = [c.args[3]['notes'] for c in calls.call_args_list if c.args[1] == 'PATCH']
            self.assertTrue(all(note.startswith('Keep me') for note in projected))
            self.assertTrue(any('needs_scope' in note for note in projected))

    def test_profile_failure_is_missing_not_zero(self):
        with patch.object(bridge.subprocess, 'run', side_effect=OSError()):
            result = bridge.read_runs([{'profileId': 'mac', 'threadId': 'one'}])
        self.assertIsNone(result['mac']['one'])


if __name__ == '__main__':
    unittest.main()
