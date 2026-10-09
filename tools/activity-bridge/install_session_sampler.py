#!/usr/bin/env python3
"""Install an isolated local session sampler; collection starts via launchctl."""
import argparse
import os
from pathlib import Path
import plistlib
import subprocess


def private_plist(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('wb') as stream:
        os.chmod(path, 0o600)
        plistlib.dump(value, stream)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True, type=Path)
    args = parser.parse_args()
    config = args.config.resolve(strict=True)
    home = Path.home()
    label = 'local.matto.session-sampler'
    service = f'gui/{os.getuid()}/{label}'
    running = subprocess.run(['launchctl', 'print', service], capture_output=True)
    if running.returncode == 0:
        parser.error('Stop the session sampler before replacing its executable')
    app = home / 'Applications/MattoSessionSampler.app'
    binary = app / 'Contents/MacOS/session-sampler'
    binary.parent.mkdir(parents=True, exist_ok=True)
    private_plist(app / 'Contents/Info.plist', {
        'CFBundleExecutable': binary.name, 'CFBundleIdentifier': label,
        'CFBundleName': 'Matto Session Sampler', 'CFBundlePackageType': 'APPL',
        'CFBundleVersion': '1', 'CFBundleShortVersionString': '1.0', 'LSUIElement': True,
    })
    source = Path(__file__).resolve().parent / 'foreground_sampler.swift'
    subprocess.run(['swiftc', str(source), '-o', str(binary)], check=True)
    subprocess.run(['codesign', '--force', '--sign', '-', '--timestamp=none', str(app)], check=True)
    subprocess.run([str(binary), '--self-test'], check=True)
    agent = home / f'Library/LaunchAgents/{label}.plist'
    for suffix in ('stdout', 'stderr'):
        log = config.parent / f'session-sampler.{suffix}.log'
        fd = os.open(log, os.O_CREAT | os.O_APPEND | os.O_WRONLY, 0o600)
        os.close(fd)
        log.chmod(0o600)
    private_plist(agent, {
        'Label': label, 'ProgramArguments': [str(binary), '--facts', str(config)],
        'RunAtLoad': True, 'KeepAlive': True, 'ThrottleInterval': 60,
        'ProcessType': 'Background',
        'StandardOutPath': str(config.parent / 'session-sampler.stdout.log'),
        'StandardErrorPath': str(config.parent / 'session-sampler.stderr.log'),
    })
    print(app)
    print(agent)


if __name__ == '__main__':
    main()
