import unittest

from audit_mappings import audit


THREAD = '01a08530-a5b7-7923-97c4-cc8ab25958f7'


def task(task_id='one', **changes):
    return dict({'id': task_id, 'title': 'Current Todo',
                 'notes': '[Open](codex://threads/' + THREAD + ')'}, **changes)


class MappingAuditTests(unittest.TestCase):
    def test_linked_but_unmetered_is_visible(self):
        result = audit([task()], {})
        self.assertEqual(result['linkedTaskCount'], 1)
        self.assertIn('aiBindings:incomplete_note_coverage', result['tasks'][0]['issues'])
        self.assertEqual(result['tasks'][0]['semanticVerification'], 'not_checked')
        self.assertNotIn('notes', result['tasks'][0])

    def test_title_matcher_is_not_a_stale_task_label(self):
        row = audit([task()], {'bindings': [
            {'taskId': 'one', 'threadId': THREAD, 'title': 'Different thread title'}],
            'observerBindings': [{'taskId': 'one', 'threadId': THREAD,
                                  'taskTitle': 'Old Todo'}]})['tasks'][0]
        self.assertNotIn('bindings:stale_task_title', row['issues'])
        self.assertIn('observerBindings:stale_task_title', row['issues'])

    def test_shared_threads_and_missing_links_are_distinct(self):
        result = audit([task(), task('two'), task('three', notes=''),
                        task('done', isDone=True)], {})
        self.assertEqual(result['openTaskCount'], 3)
        self.assertEqual(result['sharedNoteThreads'][THREAD], ['one', 'two'])
        self.assertIn('missing_note_link', result['tasks'][2]['issues'])

    def test_observer_extra_thread_does_not_become_ai_binding(self):
        config = {'observerBindings': [{'taskId': 'one', 'threadId': THREAD}]}
        row = audit([task(notes='')], config)['tasks'][0]
        self.assertIn('observerBindings:extra_threads_need_review', row['issues'])
        self.assertEqual(row['coverage']['aiBindings']['threadIds'], [])
        self.assertNotIn('aiBindings', config)


if __name__ == '__main__':
    unittest.main()
