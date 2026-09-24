import unittest
import json
import tempfile
from pathlib import Path
from unittest.mock import patch
import bridge
from bridge import ForegroundThread, human_intervals, ai_intervals, add_interval, merged_human_intervals
from zoneinfo import ZoneInfo

B = [{'title':'Task A','taskId':'a','threadId':'one'}, {'title':'Task B','taskId':'b','threadId':'two'}]

def event(second, app='com.openai.codex', text='no_change', mode='diffFromPrevious'):
    return {'timestamp': f'2026-09-07T07:{second//60:02d}:{second%60:02d}Z', 'app':{'bundleIdentifier':app}, 'ax':{'mode':mode,'text':text}}

class BridgeTests(unittest.TestCase):
    def test_foreground_and_history_overlap_count_once(self):
        ledger = {'human': {'old': ['a', 100, 160]},
                  'foregroundHuman': {'new': ['a', 150, 220], 'other': ['b', 200, 240]}}
        self.assertEqual(sorted(merged_human_intervals(ledger)),
                         [('a', 100, 220), ('b', 200, 240)])

    def test_invalid_foreground_interval_fails_without_resetting_receipts(self):
        with self.assertRaisesRegex(ValueError, 'Invalid foregroundHuman interval'):
            list(merged_human_intervals({'human': {},
                                         'foregroundHuman': {'bad': ['a', 220, 100]}}))

    def test_ai_only_preserves_human_ledger_and_does_not_read_history(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            ledger = root / 'ledger.json'
            original = '{"human":{"a/100":["a",100,160]}}'
            ledger.write_text(original)
            config = {'since': 0, 'bindings': B[:1], 'ledgerFile': str(ledger),
                      'reportFile': str(root / 'report.json'), 'source': 'test'}
            with patch.object(bridge, 'read_history', side_effect=AssertionError('History must not be read')), \
                 patch.object(bridge, 'read_runs', return_value={'local': {'one': []}}), \
                 patch.object(bridge, 'ai_intervals', return_value=iter([(100, 220)])), \
                 patch.object(bridge, 'api') as api:
                result = bridge.run(config, apply=True, ai_only=True)
            self.assertEqual(ledger.read_text(), original)
            body = api.call_args.args[3]
            self.assertEqual(body['humanMs'], 60000)
            self.assertEqual(body['aiMs'], 120000)
            self.assertEqual(result['humanCollection'], 'skipped_preserved_ledger')

    def test_ai_only_imports_foreground_interval_and_reports_live_collector(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            ledger = root / 'ledger.json'
            with patch.object(bridge.time, 'time', return_value=220):
                ledger.write_text(json.dumps({
                    'human': {}, 'foregroundHuman': {'a/100': ['a', 100, 160]},
                    'foregroundStatus': 'observing', 'foregroundLastCheck': 215,
                }))
                config = {'since': 0, 'bindings': B[:1], 'ledgerFile': str(ledger),
                          'reportFile': str(root / 'report.json'), 'source': 'test'}
                with patch.object(bridge, 'read_runs', return_value={'local': {'one': []}}), \
                     patch.object(bridge, 'api') as api:
                    result = bridge.run(config, apply=True, ai_only=True)
            self.assertEqual(api.call_args.args[3]['humanMs'], 60000)
            self.assertEqual(result['humanCollection'], 'collected')
            self.assertEqual(result['foregroundCollection'], 'observing')

    def test_stale_foreground_collector_preserves_time_without_claiming_collection(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            ledger = root / 'ledger.json'
            ledger.write_text(json.dumps({
                'human': {}, 'foregroundHuman': {'a/100': ['a', 100, 160]},
                'foregroundStatus': 'observing', 'foregroundLastCheck': 100,
            }))
            config = {'since': 0, 'bindings': B[:1], 'ledgerFile': str(ledger),
                      'reportFile': str(root / 'report.json'), 'source': 'test'}
            with patch.object(bridge.time, 'time', return_value=2000), \
                 patch.object(bridge, 'read_runs', return_value={'local': {'one': []}}):
                result = bridge.run(config, ai_only=True)
            self.assertEqual(result['tasks']['a']['1970-01-01']['humanMs'], 60000)
            self.assertEqual(result['humanCollection'], 'foreground_stale')

    def test_ai_only_missing_ledger_cannot_reset_imported_human_time(self):
        with tempfile.TemporaryDirectory() as directory:
            config = {'since': 0, 'ledgerFile': str(Path(directory) / 'missing')}
            with self.assertRaisesRegex(ValueError, 'existing human ledger'):
                bridge.run(config, apply=True, ai_only=True)

    def test_header_only_not_sidebar(self):
        r = ForegroundThread(B)
        self.assertIsNone(r.observe(event(0,text='3 按钮 Task A\n4 container Task A',mode='fullTree')))
        self.assertEqual(r.observe(event(1,text='+ 8 container (collapsed) Task B\n+ 9 弹出式按钮 (collapsed) 聊天操作'))['taskId'],'b')
        self.assertIsNone(r.observe(event(2,text='Removed element IDs: 8-9')))
    def test_idle_cap_and_other_app_switch(self):
        e=[event(0,text='8 container Task A\n9 弹出式按钮 聊天操作',mode='fullTree'), event(120),event(130,app='com.chrome'),event(140)]
        rows=list(human_intervals(e,B))
        self.assertEqual([round(end-start) for _,start,end in rows],[60,10])
    def test_no_ai_infinite_count_or_duplicate_complete(self):
        start={'type':'task_started','turn_id':'x','timestamp':'2026-09-07T07:00:00Z'}
        end={'type':'task_complete','turn_id':'x','timestamp':'2026-09-07T07:01:00Z','started_at':'2026-09-07T07:00:00Z'}
        self.assertEqual(len(list(ai_intervals([start,end,end],0,9999999999))),1)
        self.assertEqual(list(ai_intervals([start],0,9999999999)),[])
    def test_midnight_split(self):
        totals={}
        from bridge import timestamp
        add_interval(totals,'a',timestamp('2026-09-07T15:59:30Z'),timestamp('2026-09-07T16:00:30Z'),'humanMs',ZoneInfo('Asia/Shanghai'))
        self.assertEqual(totals['a']['2026-09-07']['humanMs'],30000)
        self.assertEqual(totals['a']['2026-09-08']['humanMs'],30000)

if __name__ == '__main__': unittest.main()
