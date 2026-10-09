import unittest
from usage import reduce, matches, notes_with_estimate


class UsageTests(unittest.TestCase):
    def sample(self, at, **kw):
        return dict(at=at, session='one', state='observed', idleSeconds=0,
                    app='codex', contextKind='codexThreadTitle', context='task', **kw)

    def rules(self):
        return [dict(taskId='a', app='codex', kind='codexThreadTitle', value='task', effectiveFrom=0)]

    def test_assignment_duplicates_and_conservation(self):
        a,b = self.sample(100),self.sample(105)
        result=reduce([b,a,a],self.rules())
        day=next(iter(result['days'].values()))
        self.assertEqual(day['tasks'],{'a':5})
        self.assertEqual(sum(day['states'].values()),5)

    def test_conflict_switch_idle_gap_restart(self):
        for field,value,expected in [('context','other','unassigned'),('idleSeconds',61,'idle'),
                                     ('state','locked','locked'),('state','paused','paused'),
                                     ('state','private','private'),('session','two','gap'),('at',200,'gap')]:
            a,b=self.sample(100),self.sample(105)
            b[field]=value
            self.assertEqual(reduce([a,b],self.rules())['spans'][0]['state'], expected)
        rules=self.rules()+[dict(self.rules()[0],taskId='b')]
        self.assertEqual(reduce([self.sample(100),self.sample(105)],rules)['spans'][0]['state'],'unassigned')

    def test_effective_date_and_midnight(self):
        rules=self.rules()
        rules[0]['effectiveFrom']=103
        self.assertEqual(reduce([self.sample(100),self.sample(105)],rules)['spans'][0]['state'],'unassigned')
        result=reduce([self.sample(86398),self.sample(86403)],self.rules(),'UTC')
        self.assertEqual(len(result['days']),2)
        self.assertEqual([d['tasks']['a'] for d in result['days'].values()],[2,3])

    def test_url_boundaries(self):
        rule=dict(taskId='a',app='browser',kind='documentPrefix',value='https://example.com/docs/abc',effectiveFrom=0)
        for url,want in [('https://example.com/docs/abc',True),('https://example.com/docs/abc/child',True),
                         ('https://example.com.evil/docs/abc',False),('https://example.com/docs/abcdef',False)]:
            self.assertEqual(matches(dict(at=10,app='browser',document=url),rule),want)

    def test_notes_preserved_idempotent(self):
        original='User notes\n<!-- sp-codex-v1 --> receipts'
        updated=notes_with_estimate(original,'estimate')
        self.assertIn(original,updated)
        self.assertEqual(notes_with_estimate(updated,'estimate'),updated)
        self.assertNotIn('\nestimate\n',notes_with_estimate(updated,'new'))

    def test_thread_identity_switch_and_unknown(self):
        a = self.sample(100, threadId='one', threadIdentityEvidence='unique_display_title')
        b = self.sample(105, threadId='one', threadIdentityEvidence='unique_display_title')
        result = reduce([a, b], [])
        day = next(iter(result['days'].values()))
        self.assertEqual(day['threads']['one']['seconds'], 5)
        # Same title with a different ID must never be credited to either thread.
        b['threadId'] = 'two'
        self.assertEqual(next(iter(reduce([a, b], [])['days'].values()))['threads'], {})
        b['threadId'] = 'one'
        b['idleSeconds'] = 61
        self.assertEqual(next(iter(reduce([a, b], [])['days'].values()))['threads'], {})
        a.pop('threadId')
        a['threadIdentityEvidence'] = 'ambiguous_title'
        self.assertFalse(matches(a, self.rules()[0]))

    def test_thread_id_rules(self):
        rule = dict(taskId='a', app='codex', kind='codexThreadId', value='one', effectiveFrom=0)
        sample = self.sample(100, threadId='one')
        self.assertTrue(matches(sample, rule))
        sample['threadId'] = 'two'
        self.assertFalse(matches(sample, rule))


if __name__ == '__main__':
    unittest.main()
