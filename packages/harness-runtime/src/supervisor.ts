/** Linux subreaper keeps daemonized/detached tool descendants under one owner.
 * fd 3 gates launch until Polyth persists the lease, and closes on owner crash.
 * A release receipt is written only after every descendant has been reaped.
 * SIGKILL of the supervisor leaves no receipt, so recovery fails closed. */
export const supervisorSource = String.raw `
import ctypes, errno, json, os, select, signal, subprocess, sys, time
config = json.loads(sys.argv[1])
if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
    sys.exit(125)
stopping = False
def stop(signum, frame):
    global stopping
    stopping = True
for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
    signal.signal(sig, stop)
def write_receipt(path):
    temp = path + '.tmp'
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as f:
        json.dump(config['proof'], f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(temp, path)
# A ready receipt proves the signal handlers and subreaper are installed.
write_receipt(config['receipt'] + '.ready')
child = None
try:
    if os.read(3, 1) == b'G' and not stopping:
        child = subprocess.Popen(config['argv'], close_fds=True)
    else:
        stopping = True
except Exception:
    stopping = True
while not stopping and child.poll() is None:
    if select.select([3], [], [], 0.05)[0] and not os.read(3, 4096):
        stopping = True
# Kill direct children; grandchildren, including setsid/double-fork daemons,
# are adopted by this subreaper and killed on subsequent passes. Direct child
# PIDs cannot be reused until this process reaps them.
while True:
    with open('/proc/self/task/%s/children' % os.getpid()) as f:
        children = [int(pid) for pid in f.read().split()]
    if not children:
        break
    for pid in children:
        try: os.kill(pid, signal.SIGKILL)
        except ProcessLookupError: pass
    while True:
        try:
            pid, status = os.waitpid(-1, os.WNOHANG)
            if pid == 0: break
        except ChildProcessError: break
    time.sleep(0.01)
write_receipt(config['receipt'])
sys.exit(0 if stopping else child.returncode or 0)
`;
