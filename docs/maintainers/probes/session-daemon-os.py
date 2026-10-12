#!/usr/bin/env python3
"""Disposable kernel-primitive evidence; not a production daemon/lock implementation."""

import ctypes
import json
import os
import pathlib
import signal
import socket
import subprocess
import sys
import tempfile


def lock_worker(path, hold):
    import fcntl
    with open(path, "a+") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("held", flush=True)
            return
        print("acquired", flush=True)
        if hold:
            sys.stdin.read()


def main():
    if len(sys.argv) > 1:
        lock_worker(sys.argv[2], sys.argv[1] == "hold")
        return
    result = {"platform": sys.platform, "python": sys.version.split()[0]}
    if sys.platform not in ("darwin", "linux"):
        result["status"] = "not-run: POSIX-only probe; Windows native acceptance remains blocked"
        print(json.dumps(result, indent=2))
        return
    import fcntl
    with tempfile.TemporaryDirectory(prefix="f-s1-", dir="/tmp") as temporary:
        root = pathlib.Path(temporary)
        root.chmod(0o700)
        lock = root / "owner.lock"
        lock.touch(mode=0o600)
        owner = subprocess.Popen(
            [sys.executable, __file__, "hold", str(lock)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
        )
        try:
            assert owner.stdout.readline().strip() == "acquired"

            def contender():
                return subprocess.check_output(
                    [sys.executable, __file__, "try", str(lock)], text=True, timeout=5,
                ).strip()

            assert contender() == "held"
            os.kill(owner.pid, signal.SIGSTOP)
            assert contender() == "held"
            os.kill(owner.pid, signal.SIGCONT)
            alias = root / "alias"
            alias.symlink_to(root, target_is_directory=True)
            assert (alias / lock.name).resolve() == lock.resolve()
            assert (alias / lock.name).stat().st_ino == lock.stat().st_ino
            result["exclusive_lock_live_paused_alias"] = "pass"
            owner.kill()
            owner.wait(timeout=5)
            assert contender() == "acquired"
            result["kernel_release_after_sigkill"] = "pass"
        finally:
            if owner.poll() is None:
                owner.kill()
                owner.wait(timeout=5)
            owner.stdin.close()
            owner.stdout.close()

        with open(lock, "a+") as held:
            fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
            old_identity = (os.fstat(held.fileno()).st_dev, os.fstat(held.fileno()).st_ino)
            lock.unlink()
            lock.touch(mode=0o600)
            assert old_identity != (lock.stat().st_dev, lock.stat().st_ino)
            assert contender() == "acquired"
            result["path_replacement"] = "detected: a new inode bypasses an old inode lock; identity monitoring is required"

        endpoint = str(root / "s")
        with socket.socket(socket.AF_UNIX) as server, socket.socket(socket.AF_UNIX) as client:
            server.bind(endpoint)
            os.chmod(endpoint, 0o600)
            server.listen(1)
            client.connect(endpoint)
            peer, _ = server.accept()
            with peer:
                if sys.platform == "darwin":
                    uid, gid = ctypes.c_uint(), ctypes.c_uint()
                    libc = ctypes.CDLL(None, use_errno=True)
                    getpeereid = libc.getpeereid
                    getpeereid.argtypes = [ctypes.c_int, ctypes.POINTER(ctypes.c_uint), ctypes.POINTER(ctypes.c_uint)]
                    getpeereid.restype = ctypes.c_int
                    assert getpeereid(peer.fileno(), ctypes.byref(uid), ctypes.byref(gid)) == 0
                    assert uid.value == os.getuid() and gid.value == os.getgid()
                    result["native_peer_identity"] = "pass: getpeereid"
                else:
                    import struct
                    _, uid, gid = struct.unpack("3i", peer.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                    assert uid == os.getuid() and gid == os.getgid()
                    result["native_peer_identity"] = "pass: SO_PEERCRED"
                client.sendall(b"probe")
                assert peer.recv(5) == b"probe"
            assert root.stat().st_mode & 0o777 == 0o700
            assert pathlib.Path(endpoint).stat().st_mode & 0o777 == 0o600
            result["owner_only_unix_socket"] = "pass: directory 0700, socket 0600, same-user roundtrip"
        maximum = 103 if sys.platform == "darwin" else 107
        prefix = str(root) + "/"
        boundary = prefix + "p" * (maximum - len(prefix.encode()))
        with socket.socket(socket.AF_UNIX) as bound:
            bound.bind(boundary)
        try:
            with socket.socket(socket.AF_UNIX) as too_long:
                too_long.bind(boundary + "p")
        except OSError:
            result["unix_path_limit"] = "pass: %d bytes accepted; %d rejected" % (maximum, maximum + 1)
        else:
            raise AssertionError("Expected overlong Unix socket path to be rejected")
        result["status"] = "pass: primitives only; native Node binding and cross-user tests still required"
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
