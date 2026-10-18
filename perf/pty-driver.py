#!/usr/bin/env python3
"""Measure arrival of real TUI output bytes, not terminal painting."""
import codecs
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time

runtime = os.environ.get('PROBE_RUNTIME', '')
if not re.fullmatch(r'/tmp/fpb-[^/]+/rt', runtime) or os.environ.get('HOME') != os.path.dirname(runtime):
    sys.exit('Use node perf/run.mjs tui; an isolated runtime is required')
if '--daemon-runtime' not in sys.argv or sys.argv[sys.argv.index('--daemon-runtime') + 1:][:1] != [runtime]:
    sys.exit('Refusing a TUI without the isolated --daemon-runtime')

ANSI = re.compile(r'\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]')
TOKEN = re.compile(r'(?:⟦|zz)([0-9]+\.[0-9]+)(?:⟧|zz)')
QUERY = re.compile(rb'\x1b\[(?:0?c|6n|16t|\?u)|\x1b\](?:10|11);\?(?:\x07|\x1b\\)')
quick = os.environ.get('PERF_QUICK') == '1'
results = []
now = lambda: time.time() * 1000
spawned = now()
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 60, 220, 0, 0))
decoder = codecs.getincrementaldecoder('utf-8')('replace')
plain_tail = ''
query_tail = b''
seen = set()
latencies = []
submit = float('inf')
first = None

def metric(name, value, unit='ms', **extra):
    results.append(dict(name=name, status='ok', value=value, unit=unit, **extra))

def samples(name, values):
    if not values:
        raise RuntimeError('No samples for ' + name)
    values = sorted(values)
    at = lambda p: values[min(len(values) - 1, int(len(values) * p))]
    metric(name, at(.5), n=len(values), p50=at(.5), p90=at(.9), p99=at(.99), max=values[-1])

def pump(timeout=.02):
    global plain_tail, first, query_tail
    readable, _, _ = select.select([fd], [], [], timeout)
    if not readable:
        return ''
    try:
        data = os.read(fd, 1 << 16)
    except OSError as error:
        raise RuntimeError('PTY closed before measurements completed') from error
    if not data:
        raise RuntimeError('PTY closed before measurements completed')
    arrival = now()
    queries = query_tail + data
    for match in QUERY.finditer(queries):
        if match.end() <= len(query_tail):
            continue
        query = match.group()
        if query in (b'\x1b[c', b'\x1b[0c'):
            reply = b'\x1b[?1;2c'
        elif query == b'\x1b[6n':
            reply = b'\x1b[1;1R'
        elif query == b'\x1b[16t':
            reply = b'\x1b[6;16;8t'
        elif query == b'\x1b[?u':
            reply = b'\x1b[?0u'
        else:
            reply = b'\x1b]10;rgb:cccc/cccc/cccc\x07' if b']10;' in query else b'\x1b]11;rgb:0000/0000/0000\x07'
        os.write(fd, reply)
    query_tail = queries[-64:]
    text = ANSI.sub('', decoder.decode(data))
    plain_tail = (plain_tail + text)[-20000:]
    for match in TOKEN.finditer(plain_tail):
        stamp = match.group(1)
        if stamp in seen:
            continue
        seen.add(stamp)
        emitted = float(stamp)
        if emitted >= submit:
            latencies.append(arrival - emitted)
            if first is None:
                first = arrival - submit
    return text

def drain(seconds):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        pump(min(.02, max(0, end - time.monotonic())))

def echo(char, index, gap=0):
    drain(gap)
    started = now()
    os.write(fd, char.encode())
    recent = ''
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        recent += pump()
        if char * index in recent:
            return now() - started
    flags = termios.tcgetattr(fd)[3]
    raise RuntimeError(f'Timed out waiting for editor echo {char!r} #{index}; canonical={bool(flags & termios.ICANON)}, echo={bool(flags & termios.ECHO)}; output: {recent[-300:]!r}; screen: {plain_tail[-1500:]!r}')

def interrupted(signum, frame):
    raise RuntimeError('PTY driver interrupted')

def dismiss_dialog():
    global plain_tail
    if re.search(r'manage optional extensions|escape decides later|enter\s+select', plain_tail, re.I):
        os.write(fd, b'\x1b')
        plain_tail = ''
        return True
    return False

signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGINT, interrupted)
try:
    deadline = time.monotonic() + 30
    while not re.search(r'fake-model|Fake', plain_tail):
        pump()
        if time.monotonic() > deadline:
            raise RuntimeError('No model footer in 30s; tail: ' + plain_tail[-1500:])
    metric('startup.first-footer', now() - spawned)
    ready_at = time.monotonic() + 1
    while time.monotonic() < ready_at:
        pump()
        if dismiss_dialog():
            ready_at = time.monotonic() + 1
    os.write(fd, b'warm up\r')
    deadline = time.monotonic() + 30
    last_token = time.monotonic()
    warm_tokens = 0
    previous = len(seen)
    while time.monotonic() < deadline:
        pump()
        if dismiss_dialog() and not warm_tokens:
            drain(.3)
            os.write(fd, b'warm up\r')
        if len(seen) != previous:
            warm_tokens += len(seen) - previous
            previous = len(seen)
            last_token = time.monotonic()
        if warm_tokens and time.monotonic() - last_token > 1.5:
            break
    if not warm_tokens:
        raise RuntimeError('Warm-up produced no token markers; tail: ' + plain_tail[-1500:])
    drain(1)
    count = 8 if quick else 40
    idle = [echo('x', index + 1, .03 if quick else .08) for index in range(count)]
    samples('keystroke.idle', idle)
    os.write(fd, b'\x7f' * count)
    drain(.15)
    submit = now()
    os.write(fd, b'go\r')
    stream_echo = []
    expected_tokens = int(os.environ['PERF_EXPECT_TOKENS'])
    interval_ms = float(os.environ['PERF_INTERVAL_MS'])
    end = time.monotonic() + max(5, expected_tokens * interval_ms / 1000 * 2 + 3)
    last_echo = time.monotonic()
    while time.monotonic() < end:
        pump(.005)
        # Only sample while fresh tokens are arriving, not the post-stream idle period.
        if latencies and now() - max(map(float, seen)) < 100 and time.monotonic() - last_echo > .03 and len(stream_echo) < count:
            stream_echo.append(echo('y', len(stream_echo) + 1))
            last_echo = time.monotonic()
        if len(latencies) == expected_tokens:
            break
    if len(latencies) != expected_tokens:
        raise RuntimeError(f'Incomplete token observation: {len(latencies)}/{expected_tokens}')
    samples('token-to-pty', latencies)
    samples('keystroke.streaming', stream_echo)
    metric('submit.first-token', first)
    metric('tokens.observed', len(latencies), 'tokens')
except Exception as error:
    results.append(dict(name='pty', status='fail', reason=str(error)))
finally:
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    try:
        os.kill(pid, signal.SIGTERM)
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            if os.waitpid(pid, os.WNOHANG)[0]:
                break
            time.sleep(.02)
        else:
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
    except (ProcessLookupError, ChildProcessError):
        pass
    os.close(fd)
print(json.dumps(results, ensure_ascii=False))
sys.exit(1 if any(row['status'] == 'fail' for row in results) else 0)
