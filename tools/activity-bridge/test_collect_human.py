import fcntl
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import bridge
import collect_human


class HumanCollectionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.ledger = self.root / 'ledger.json'
        self.ledger.write_text(json.dumps({'human': {}, 'preserve': 'existing-field'}))
        segment = self.root / 'history/segments/2026-01-01T00-00-00Z'
        segment.mkdir(parents=True)
        events = [
            {'timestamp': '2026-01-01T00:00:00Z', 'app': {'bundleIdentifier': 'com.openai.codex'},
             'ax': {'mode': 'fullTree', 'text': '100 container Work\n101 pop-up button Chat actions'}},
            {'timestamp': '2026-01-01T00:00:30Z', 'app': {'bundleIdentifier': 'com.apple.finder'}},
        ]
        (segment / 'events.jsonl').write_text('\n'.join(json.dumps(e) for e in events))
        self.config = {
            'since': '2026-01-01T00:00:00Z', 'historyRoot': str(self.root / 'history'),
            'ledgerFile': str(self.ledger), 'reportFile': str(self.root / 'report.json'),
            'bindings': [{'taskId': 'task', 'threadId': 'thread', 'title': 'Work'}],
            'source': 'existing-device',
        }

    def test_replay_and_ai_import_preserve_cumulative_human_time(self):
        first = collect_human.collect(self.config)
        self.assertEqual(first['newLedgerEntries'], 1)
        snapshot = self.ledger.read_bytes()
        second = collect_human.collect(self.config)
        self.assertEqual(second['newLedgerEntries'], 0)
        self.assertEqual(self.ledger.read_bytes(), snapshot)
        with patch.object(bridge, 'read_runs', return_value={'local': {'thread': []}}), \
                patch.object(bridge, 'api') as api:
            bridge.run(self.config, apply=True, ai_only=True)
            bridge.run(self.config, apply=True, ai_only=True)
        self.assertEqual(api.call_count, 2)
        for call in api.call_args_list:
            self.assertEqual(call.args[3]['humanMs'], 30000)
            self.assertEqual(call.args[3]['source'], 'existing-device')
        self.assertEqual(self.ledger.read_bytes(), snapshot)
        self.assertEqual(json.loads(snapshot)['preserve'], 'existing-field')

    def test_failed_read_preserves_ledger_and_marks_failure(self):
        before = self.ledger.read_bytes()
        with patch.object(bridge, 'read_history', side_effect=PermissionError('denied')):
            with self.assertRaises(PermissionError):
                collect_human.collect(self.config)
        self.assertEqual(self.ledger.read_bytes(), before)
        report = json.loads((self.root / 'human-collection.json').read_text())
        self.assertEqual(report['status'], 'failed')

    def test_old_evidence_does_not_claim_running_or_fresh(self):
        result = collect_human.collect(self.config)
        self.assertEqual(result['recordingStatus'], 'unknown')
        self.assertFalse(result['evidenceFresh'])

    def test_parallel_collector_cannot_overwrite_ledger(self):
        with self.ledger.with_suffix('.human.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                collect_human.collect(self.config)


if __name__ == '__main__':
    unittest.main()
