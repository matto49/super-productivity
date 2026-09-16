#!/usr/bin/env python3
"""Update the existing human ledger inside an authorized Mac execution context.

No API writes, AI collection, observation-setting changes, or permission changes.
Status describes the query result independently of historical evidence availability.
"""
import argparse
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import time

import bridge


def save(path, value):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    temporary.chmod(0o600)
    temporary.replace(path)


def collect(config, recording_status='unknown'):
    ledger_path = Path(config['ledgerFile']).expanduser()
    report_path = ledger_path.with_name('human-collection.json')
    # A first installation is a different operation; recovery must preserve its ledger.
    if not ledger_path.exists():
        raise ValueError('Existing human ledger required')
    with ledger_path.with_suffix('.human.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        now = time.time()
        try:
            ledger = json.loads(ledger_path.read_text())
            if not isinstance(ledger.get('human'), dict):
                raise ValueError('Invalid human ledger')
            since = bridge.timestamp(config['since'])
            events = bridge.read_history(config['historyRoot'], since, now)
            intervals = list(bridge.human_intervals(
                events, config['bindings'], config.get('idleSeconds', 60)))
            before = len(ledger['human'])
            for task, start, end in intervals:
                if end > since:
                    start = max(start, since)
                    ledger['human'][f'{task}/{start}'] = [task, start, end]
            # Only time spans and task IDs leave the raw-history reader.
            backup = ledger_path.with_name('ledger.before-human-enable.json')
            if not backup.exists():
                save(backup, json.loads(ledger_path.read_text()))
            save(ledger_path, ledger)
            latest = max((bridge.timestamp(e['timestamp']) for e in events), default=None)
            result = {
                'checkedAt': dt.datetime.fromtimestamp(now, dt.timezone.utc).isoformat(),
                'status': 'collected', 'recordingStatus': recording_status,
                'latestEventAt': latest,
                'evidenceFresh': latest is not None and 0 <= now - latest <= 180,
                'matchedIntervals': len(intervals),
                'newLedgerEntries': len(ledger['human']) - before,
                'ledgerEntries': len(ledger['human']),
                'taskIds': sorted({entry[0] for entry in ledger['human'].values()}),
                'apiApplied': False,
            }
            save(report_path, result)
            return result
        except Exception as error:
            # Do not misreport inaccessible History as an empty successful collection.
            save(report_path, {
                'checkedAt': dt.datetime.now(dt.timezone.utc).isoformat(),
                'status': 'failed', 'recordingStatus': recording_status,
                'errorType': type(error).__name__, 'apiApplied': False,
            })
            raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    parser.add_argument('--recording-status', choices=['running', 'paused', 'stopped', 'unknown'],
                        default='unknown', help='Actual official status query result; errors mean unknown')
    args = parser.parse_args()
    os.umask(0o077)
    result = collect(json.loads(Path(args.config).read_text()), args.recording_status)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
