import unittest,json,tempfile,subprocess,sys
from pathlib import Path
from unittest.mock import patch
import bridge

class RecoveryTests(unittest.TestCase):
 def test_open_turn_stops_at_last_observed_activity(self):
  e=[{'type':'task_started','turn_id':'t','timestamp':100}, {'type':'task_progress','turn_id':'t','timestamp':140}]
  self.assertEqual(list(bridge.ai_intervals(e,0,900)),[(100,140)])
  e.append({'type':'task_complete','turn_id':'t','timestamp':160,'duration_ms':60000})
  self.assertEqual(list(bridge.ai_intervals(e,0,900)),[(100,160)])
 def test_segments_and_foreign_fork_identity(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);(root/'sessions').mkdir()
   def save(name,owner,events):
    rows=[{'type':'session_meta','payload':{'id':owner}}]+events
    (root/'sessions'/name).write_text('\n'.join(json.dumps(r) for r in rows))
   save('rollout-one_segment.jsonl','one',[{'type':'event_msg','timestamp':100,'payload':{'type':'task_started','turn_id':'t'}},{'type':'response_item','timestamp':140,'payload':{'role':'assistant'}}])
   save('rollout-one_foreign.jsonl','foreign',[{'type':'event_msg','timestamp':999,'payload':{'type':'task_complete','turn_id':'t'}}])
   result=json.loads(subprocess.check_output([sys.executable,'-c',bridge.READ_RUNS,'["one","missing"]',d],text=True))
   self.assertEqual(len(result['one']),2)
   self.assertIsNone(result['missing'])
 def test_missing_session_preserves_existing_receipt(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);(root/'ledger.json').write_text('{"human":{"a/100":["a",100,160]}}')
   c={'since':0,'bindings':[{'taskId':'a','threadId':'missing'}],'ledgerFile':str(root/'ledger.json'),'reportFile':str(root/'report.json')}
   with patch.object(bridge,'read_runs',return_value={'local':{'missing':None}}),patch.object(bridge,'api') as api:
    result=bridge.run(c,True,True)
   api.assert_not_called();self.assertEqual(result['missingSessionTaskIds'],['a'])
 def test_unavailable_history_is_an_error(self):
  with tempfile.TemporaryDirectory() as d:
   with self.assertRaises(FileNotFoundError):bridge.read_history(d,0,100)
 def test_repeated_complete_and_overlapping_resume_are_not_added_twice(self):
  e=[{'type':'task_complete','turn_id':'t','timestamp':160,'started_at':100}, {'type':'task_complete','turn_id':'t','timestamp':161,'started_at':100}]
  self.assertEqual(list(bridge.ai_intervals(e,0,999)),[(100,160)])
