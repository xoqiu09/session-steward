#!/usr/bin/env python3
"""Developer-only process check for the isolated demo; Python 3.9+, no packages.

Does not install software, change HOME/CODEX_HOME, or touch a real SS service.
All fixtures and receipts live under a new explicitly selected output directory.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import sqlite3
import subprocess
import time
import urllib.error
import urllib.request


def check(binary, output, sample):
    output.mkdir(mode=0o700)  # Existing paths, even empty ones, are not reused.
    protected = output / 'protected-data'
    protected.mkdir(mode=0o700)
    sentinel = protected / 'config.json'
    original = b'{"listen":"invalid-protected-setting","keep":"unchanged"}\n'
    sentinel.write_bytes(original)
    traps = output / 'tool-traps'
    traps.mkdir(mode=0o700)
    marker = output / 'unexpected-tool-call'
    for name in ['git', 'claude', 'codex', 'tmux', 'open', 'xdg-open']:
        path = traps / name
        # This marker is local synthetic test material, never a real command.
        quoted = "'" + str(marker).replace("'", "'\\''") + "'"
        path.write_text('#!/bin/sh\necho unexpected-tool-call >> ' + quoted + '\nexit 73\n')
        path.chmod(0o700)
    environment = dict(os.environ, STEWARD_HOME=str(protected), PATH=str(traps))
    processes = []
    streams = []
    result = {'status': 'running', 'binary_sha256': hashlib.sha256(binary.read_bytes()).hexdigest(),
              'scope': 'synthetic process and API checks; not a clean-Mac App installation', 'checks': {}}
    checks = result['checks']

    def start(name):
        directory = output / name
        log = (output / (name + '.log')).open('wb')
        streams.append(log)
        proc = subprocess.Popen([str(binary), 'demo', '--no-open', '--dir', str(directory)],
                                env=environment, stdout=log, stderr=subprocess.STDOUT)
        processes.append(proc)
        configuration = directory / 'config.json'
        deadline = time.monotonic() + 12
        while time.monotonic() < deadline:
            if proc.poll() is not None:
                raise RuntimeError('demo exited before readiness: ' + name)
            if configuration.exists():
                address = json.loads(configuration.read_text())['listen']
                token = (directory / 'panel.token').read_text().strip()
                try:
                    return proc, directory, address, token, api(address, token, '/api/snapshot')
                except (OSError, ValueError):
                    pass
            time.sleep(0.05)
        raise RuntimeError('demo readiness timed out: ' + name)

    def api(address, token, path, body=None, headers=True):
        values = {'Cookie': 'steward_panel=' + token}
        if headers:
            values.update({'X-Steward': '1', 'Content-Type': 'application/json'})
        req = urllib.request.Request('http://' + address + path, headers=values,
                                     data=None if body is None else json.dumps(body).encode(),
                                     method='GET' if body is None else 'PUT')
        with urllib.request.urlopen(req, timeout=5) as response:
            return json.load(response)

    def denied(address, token, path, expected, body=None, headers=True):
        try:
            api(address, token, path, body, headers)
        except urllib.error.HTTPError as error:
            assert error.code == expected, (path, error.code, expected)
        else:
            raise AssertionError('expected rejection: ' + path)

    def business(db):
        connection = sqlite3.connect(db.as_uri() + '?mode=ro', uri=True)
        tables = ['project_features', 'feature_reports', 'feature_acceptances', 'feature_scope_decisions',
                  'work_items', 'work_item_state_changes', 'orchestration_mandates', 'approvals']
        hashes = {}
        for table in tables:
            rows = sorted(json.dumps(list(row), ensure_ascii=False) for row in connection.execute('SELECT * FROM ' + table))
            hashes[table] = hashlib.sha256(json.dumps(rows).encode()).hexdigest()
        connection.close()
        return hashes

    try:
        proc, directory, address, token, before = start('first-demo')
        assert len(before['repos']) == 3 and len(before['features']) == 9 and len(before['structures']) == 2
        assert len(before['work_items']) == 3
        assert all(r['name'].startswith('示例-') and r['common_dir'].startswith('dir:' + str(directory.resolve())) for r in before['repos'])
        assert not any(f['accepted'] for f in before['features'])
        assert not any(session['resume_command'] for session in before['sessions'])
        assert before.get('managed_unavailable')
        checks['fresh_fixture_and_no_owner_acceptance'] = True
        denied(address, '', '/api/snapshot', 401)
        denied(address, token, '/hook/ping', 403)
        denied(address, token, '/api/sessions/1/conversation', 403)
        asset = next(r['id'] for r in before['repos'] if r['name'] == '示例-素材册')
        route = '/api/projects/' + str(asset) + '/structure'
        assert api(address, token, route)['structure'] is None
        document = json.loads(sample.read_text())
        baseline = business(directory / 'steward.sqlite')
        denied(address, token, route, 403, {'base_revision': '', 'document': document}, headers=False)
        assert api(address, token, route)['structure'] is None
        checks['authentication_and_write_guard'] = True
        # Import preview itself is checked through the UI; only Save performs this PUT.
        saved = api(address, token, route, {'base_revision': '', 'document': document})['structure']
        assert saved['author'] == 'user' and saved['document'] == document
        assert api(address, token, route)['structure']['revision'] == saved['revision']
        after = api(address, token, '/api/snapshot')
        assert len(after['structures']) == 3 and len(after['features']) == 9
        assert baseline == business(directory / 'steward.sqlite')
        checks['save_and_readback_preserve_business_tables'] = True
        denied(address, token, route, 409, {'base_revision': '', 'document': document})
        denied(address, token, route, 409, {'base_revision': saved['revision'], 'document': document, 'origin': 'agent'})
        assert api(address, token, route)['structure']['revision'] == saved['revision']
        checks['stale_revision_and_manual_edit_protection'] = True
        other_proc, other_dir, other_address, _, other = start('second-demo')
        assert other_address != address and len(other['structures']) == 2
        assert other_dir.resolve() != directory.resolve()
        checks['simultaneous_instances_are_isolated'] = True
        existing = subprocess.run([str(binary), 'demo', '--no-open', '--dir', str(protected)],
                                  env=environment, capture_output=True, timeout=10)
        assert existing.returncode != 0 and sentinel.read_bytes() == original
        occupied = output / 'occupied-port-rejected'
        collision = subprocess.run([str(binary), 'demo', '--no-open', '--dir', str(occupied), '--listen', address],
                                   env=environment, capture_output=True, timeout=10)
        assert collision.returncode != 0 and not occupied.exists()
        checks['existing_data_and_occupied_port_preserved'] = True
        # An open browser tab holds an event stream; it must not delay shutdown.
        stream = urllib.request.urlopen(urllib.request.Request('http://' + address + '/api/stream',
                                        headers={'Cookie': 'steward_panel=' + token}), timeout=5)
        stopping = time.monotonic()
        proc.send_signal(signal.SIGTERM)
        assert proc.wait(timeout=8) == 0
        stream.close()
        assert time.monotonic() - stopping < 2, 'open event stream delayed shutdown'
        try:
            api(address, token, '/api/snapshot')
        except OSError:
            pass
        else:
            raise AssertionError('listener still active after shutdown')
        db = sqlite3.connect((directory / 'steward.sqlite').as_uri() + '?mode=ro', uri=True)
        assert db.execute('PRAGMA quick_check').fetchone()[0] == 'ok'
        restored = json.loads(db.execute('SELECT v FROM meta WHERE k=?', ('project_structure:' + str(asset),)).fetchone()[0])
        db.close()
        assert restored['revision'] == saved['revision']
        checks['shutdown_releases_port_and_retains_import'] = True
        assert sentinel.read_bytes() == original and len(list(protected.iterdir())) == 1
        assert not marker.exists()
        checks['protected_config_unchanged_and_no_tools_invoked'] = True
        result['status'] = 'passed'
    except Exception as error:
        result.update(status='failed', error=str(error))
        raise
    finally:
        for proc in processes:
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()
        for stream in streams:
            stream.close()
        receipt = output / 'verification.json'
        receipt.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
        for path in output.rglob('*'):
            if path.is_file() and path.parent != traps:
                path.chmod(0o600)
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True, help='new absolute directory; parent must exist')
    args = parser.parse_args()
    if not args.output.is_absolute() or args.output.exists() or args.output.is_symlink():
        parser.error('--output must be a new absolute directory')
    result = check(args.binary.resolve(strict=True), args.output,
                   Path(__file__).resolve().parents[1] / 'examples/project-structure/asset-library.json')
    print(json.dumps({'status': result['status'], 'checks': len(result['checks']),
                      'receipt': str(args.output / 'verification.json')}, ensure_ascii=False))
