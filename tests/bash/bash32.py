#!/usr/bin/env python3
"""Extract the official container's interpreter into a temp dir; no install/build.

Run the host-side offline harness under that Bash, retaining host Python/curl stubs.
No container starts a collector; the only container command archives three files.
"""
import io
import os
import pathlib
import subprocess
import tarfile
import tempfile

root = pathlib.Path(__file__).resolve().parents[2]
image = 'bash:3.2@sha256:0fd7cb8499c63a3c9345e7088a9cd83bb69f6e895e83833859aff838a0312091'
files = ['usr/local/bin/bash', 'lib/ld-musl-x86_64.so.1', 'usr/lib/libncursesw.so.6']
with tempfile.TemporaryDirectory(prefix='connect-bash32-') as temp:
    dest = pathlib.Path(temp)
    archive = subprocess.run(
        ['docker', 'run', '--rm', '--network', 'none', '--read-only', '--entrypoint',
         '/bin/sh', image, '-c', 'tar -chf - /' + ' /'.join(files)],
        capture_output=True, check=True,
    ).stdout
    with tarfile.open(fileobj=io.BytesIO(archive)) as tf:
        for name in files:
            member = tf.getmember(name)
            if not member.isfile():
                raise RuntimeError('Expected an ordinary binary in Bash image')
            target = dest / pathlib.Path(name).name
            target.write_bytes(tf.extractfile(member).read())
            target.chmod(0o700)
    wrapper = dest / 'bash32'
    wrapper.write_text(
        '#!/bin/sh\nexec "' + str(dest / 'ld-musl-x86_64.so.1') + '" --library-path "'
        + temp + '" "' + str(dest / 'bash') + '" "$@"\n'
    )
    wrapper.chmod(0o700)
    subprocess.run([str(wrapper), 'tests/bash/unit.sh'], cwd=root, check=True)
    subprocess.run(['python3', 'tests/bash/test.py'], cwd=root, check=True,
                   env=dict(os.environ, TEST_BASH=str(wrapper)))
