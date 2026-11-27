"""Linux-only confinement for the document decoder and fixed search subprocesses."""

import ctypes
import ctypes.util
import errno
import os
import platform
import resource
import sys
from pathlib import Path


def check(value):
    if value < 0:
        raise OSError(ctypes.get_errno(), "Managed file sandbox unavailable")
    return value


def confine(root, search_binary, pdf_binary):
    if platform.machine() not in ("x86_64", "aarch64") or sys.platform != "linux":
        raise RuntimeError("Managed files require a supported Linux deployment.")
    libc = ctypes.CDLL(None, use_errno=True)
    seccomp = ctypes.CDLL("libseccomp.so.2", use_errno=True)
    seccomp.seccomp_init.restype = ctypes.c_void_p
    seccomp.seccomp_rule_add.argtypes = [
        ctypes.c_void_p,
        ctypes.c_uint32,
        ctypes.c_int,
        ctypes.c_uint,
    ]
    seccomp.seccomp_load.argtypes = [ctypes.c_void_p]
    seccomp.seccomp_release.argtypes = [ctypes.c_void_p]
    seccomp.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    # Landlock ABI 3 covers refer and truncate. The worker never receives inherited descriptors besides pipes.
    abi = check(libc.syscall(444, 0, 0, 1))
    if abi < 3:
        raise RuntimeError("Managed files require Landlock ABI 3.")
    all_rules = (1 << 15) - 1
    ruleset = check(libc.syscall(444, ctypes.byref(ctypes.c_uint64(all_rules)), 8, 0))
    try:

        def allow(raw, access):
            target = Path(raw).resolve(strict=True)
            descriptor = os.open(target, os.O_PATH | os.O_CLOEXEC)
            try:
                bits = ctypes.create_string_buffer(12)
                ctypes.c_uint64.from_buffer(bits).value = access
                ctypes.c_int.from_buffer(bits, 8).value = descriptor
                check(libc.syscall(445, ruleset, 1, bits, 0))
            finally:
                os.close(descriptor)

        read_file, read_dir, execute = 1 << 2, 1 << 3, 1
        # Startup imports are complete; decoders may still need installed Python modules, shared libraries and font maps.
        for location in {
            Path(__file__).parent,
            *(Path(v) for v in sys.path if v and Path(v).is_dir()),
            Path("/usr/lib"),
            Path("/usr/share/poppler"),
            Path("/usr/share/fonts"),
            Path("/etc/fonts"),
        }:
            if location.exists():
                allow(location, read_file | read_dir)
        for location in (
            Path("/etc/ld.so.cache"),
            Path("/dev/urandom"),
            Path("/dev/null"),
        ):
            if location.exists():
                allow(location, read_file)
        for location in (search_binary, pdf_binary):
            if location:
                allow(location, execute | read_file)
        # Dynamic executables need their loader. Grant execute on the loader file only.
        for location in ["/lib64/ld-linux-x86-64.so.2", "/lib/ld-linux-aarch64.so.1"]:
            if Path(location).exists():
                allow(location, execute | read_file)
        allow(root, all_rules & ~execute)
        check(libc.prctl(38, 1, 0, 0, 0))
        check(libc.syscall(446, ruleset, 0))
    finally:
        os.close(ruleset)
    policy = seccomp.seccomp_init(0x7FFF0000)
    if not policy:
        raise MemoryError("Failed to create decoder policy.")
    try:
        for syscall in (
            "socket",
            "socketpair",
            "connect",
            "bind",
            "listen",
            "accept",
            "accept4",
            "sendto",
            "sendmsg",
            "ptrace",
            "process_vm_readv",
            "process_vm_writev",
            "bpf",
            "mount",
            "unshare",
            "setns",
            "io_uring_setup",
        ):
            number = seccomp.seccomp_syscall_resolve_name(syscall.encode())
            if number >= 0:
                check(
                    seccomp.seccomp_rule_add(policy, 0x50000 | errno.EPERM, number, 0)
                )
        check(seccomp.seccomp_load(policy))
    finally:
        seccomp.seccomp_release(policy)
    # The parent additionally bounds wall time/output and terminates the entire process group on cancellation.
    for limit, maximum in [
        (resource.RLIMIT_CPU, 15),
        (resource.RLIMIT_AS, 1024**3),
        (resource.RLIMIT_FSIZE, 80 * 1024**2),
        (resource.RLIMIT_NOFILE, 96),
        (resource.RLIMIT_CORE, 0),
    ]:
        resource.setrlimit(limit, (maximum, maximum))
