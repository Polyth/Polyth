// Polyth's Windows execution boundary: the counterpart of polyth-supervisor.c.
//
// `run <job>` puts this helper into a new named Job Object that kills every
// member when its last handle closes and lets no member break away, then
// starts the command line from POLYTH_JOB_COMMAND_LINE inside it, handing over
// its own standard handles. Every descendant inherits the job. The helper ends
// the whole job, itself included, when the command exits or the process that
// started it dies; if the helper is killed instead, its handle closes and the
// kernel ends the job. A job name that no longer exists is therefore proof
// that nothing launched in it can still run: `probe` and `terminate` let a
// restarted Polyth check that, or end a job whose owner is gone.
//
// Built with the C# compiler of the .NET Framework 4.x that ships with
// Windows (build-supervisor.mjs), so it needs no toolchain or dependency.
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

static class PolythJob
{
    const string CommandLineVariable = "POLYTH_JOB_COMMAND_LINE";
    static readonly Regex JobName = new Regex(@"^Local\\polyth-runtime-[0-9a-f]{24}-[1-9][0-9]{0,15}$");

    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    const int JobObjectBasicAccountingInformation = 1;
    const int JobObjectExtendedLimitInformation = 9;
    const uint JOB_OBJECT_QUERY = 0x0004;
    const uint JOB_OBJECT_TERMINATE = 0x0008;
    const uint SYNCHRONIZE = 0x00100000;
    const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    const int ERROR_FILE_NOT_FOUND = 2;
    const int ERROR_ALREADY_EXISTS = 183;
    const uint WAIT_OBJECT_0 = 0;
    const uint INFINITE = 0xFFFFFFFF;
    const int STARTF_USESTDHANDLES = 0x100;
    const int STD_INPUT_HANDLE = -10;
    const int STD_OUTPUT_HANDLE = -11;
    const int STD_ERROR_HANDLE = -12;

    // Exit codes before a command runs; after that the command's own code.
    const int UsageError = 64;
    const int ParentGone = 65;
    const int JobFailed = 66;
    const int JobExists = 67;
    const int LaunchFailed = 68;
    const int StillActive = 69;

    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
    {
        public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO
    {
        public int cb;
        public string lpReserved, lpDesktop, lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION
    {
        public IntPtr hProcess, hThread;
        public int dwProcessId, dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_BASIC_INFORMATION
    {
        public IntPtr ExitStatus;
        public IntPtr PebBaseAddress;
        public UIntPtr AffinityMask;
        public IntPtr BasePriority;
        public UIntPtr UniqueProcessId;
        public UIntPtr InheritedFromUniqueProcessId;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr OpenJobObjectW(uint access, bool inherit, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info, uint length, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll")]
    static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")]
    static extern void SetLastError(uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr GetStdHandle(int which);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcessW(string application, StringBuilder commandLine, IntPtr processAttributes,
        IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory,
        ref STARTUPINFO startup, out PROCESS_INFORMATION information);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool all, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);
    [DllImport("ntdll.dll")]
    static extern int NtQueryInformationProcess(IntPtr process, int infoClass, ref PROCESS_BASIC_INFORMATION info, int length, out int returned);

    static int Main(string[] args)
    {
        if (args.Length == 1 && args[0] == "selftest") return SelfTest();
        if (args.Length != 2 || !JobName.IsMatch(args[1])) return Fail(UsageError, "usage: polyth-job run|probe|terminate <job> | selftest");
        switch (args[0])
        {
            case "run": return Run(args[1]);
            case "probe": return Probe(args[1]);
            case "terminate": return Terminate(args[1]);
            default: return Fail(UsageError, "unknown command " + args[0]);
        }
    }

    static int Fail(int code, string message)
    {
        Console.Error.WriteLine("polyth-job: " + message);
        return code;
    }

    static string Win32Error()
    {
        return "Win32 error " + Marshal.GetLastWin32Error();
    }

    static bool KillOnClose(IntPtr job)
    {
        var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        // No BREAKAWAY_OK and no SILENT_BREAKAWAY_OK: nothing leaves the job.
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        return SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits,
            (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)));
    }

    /// The process that started this helper, opened only if it is still that
    /// process: a parent that already died may have left its PID to a newer
    /// process, which then started after this helper did.
    static IntPtr OpenParent()
    {
        var basic = new PROCESS_BASIC_INFORMATION();
        int returned;
        if (NtQueryInformationProcess(GetCurrentProcess(), 0, ref basic, Marshal.SizeOf(basic), out returned) != 0) return IntPtr.Zero;
        IntPtr parent = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, false, (uint)basic.InheritedFromUniqueProcessId.ToUInt64());
        if (parent == IntPtr.Zero) return IntPtr.Zero;
        long parentStart, selfStart, unused1, unused2, unused3;
        if (!GetProcessTimes(parent, out parentStart, out unused1, out unused2, out unused3)
            || !GetProcessTimes(GetCurrentProcess(), out selfStart, out unused1, out unused2, out unused3)
            || parentStart > selfStart
            || WaitForSingleObject(parent, 0) == WAIT_OBJECT_0)
        {
            CloseHandle(parent);
            return IntPtr.Zero;
        }
        return parent;
    }

    static int Run(string name)
    {
        string commandLine = Environment.GetEnvironmentVariable(CommandLineVariable);
        if (string.IsNullOrEmpty(commandLine)) return Fail(UsageError, CommandLineVariable + " is not set");
        // The command inherits this environment; it must not see the variable.
        Environment.SetEnvironmentVariable(CommandLineVariable, null);

        IntPtr parent = OpenParent();
        if (parent == IntPtr.Zero) return Fail(ParentGone, "the process that started this job is gone");

        // A new job leaves the last error alone, so clear it to tell a
        // pre-existing one (ERROR_ALREADY_EXISTS) apart.
        SetLastError(0);
        IntPtr job = CreateJobObjectW(IntPtr.Zero, name);
        if (job == IntPtr.Zero) return Fail(JobFailed, "cannot create the job: " + Win32Error());
        if (Marshal.GetLastWin32Error() == ERROR_ALREADY_EXISTS) return Fail(JobExists, "job " + name + " already exists");
        if (!KillOnClose(job)) return Fail(JobFailed, "cannot limit the job: " + Win32Error());
        if (!AssignProcessToJobObject(job, GetCurrentProcess())) return Fail(JobFailed, "cannot enter the job: " + Win32Error());
        // Checked again inside the job: a parent that died while the job was
        // being set up must not get a command started on its behalf.
        if (WaitForSingleObject(parent, 0) == WAIT_OBJECT_0)
        {
            TerminateJobObject(job, ParentGone);
            return ParentGone;
        }

        var startup = new STARTUPINFO();
        startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        startup.dwFlags = STARTF_USESTDHANDLES;
        startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
        startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
        startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
        PROCESS_INFORMATION launched;
        // Created inside the job because this helper is in it; inheriting
        // handles passes on exactly the standard pipes Polyth gave the helper
        // (the job and parent handles are not inheritable).
        if (!CreateProcessW(null, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, true, 0,
            IntPtr.Zero, null, ref startup, out launched))
        {
            int error = Marshal.GetLastWin32Error();
            TerminateJobObject(job, LaunchFailed);
            return Fail(LaunchFailed, "cannot start the command: Win32 error " + error);
        }
        CloseHandle(launched.hThread);

        uint exitCode = ParentGone;
        uint woke = WaitForMultipleObjects(2, new[] { launched.hProcess, parent }, false, INFINITE);
        if (woke == WAIT_OBJECT_0 && !GetExitCodeProcess(launched.hProcess, out exitCode)) exitCode = LaunchFailed;
        // Ends what the command left running, and this helper, with its code.
        TerminateJobObject(job, exitCode);
        return unchecked((int)exitCode);
    }

    static int SelfTest()
    {
        IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
        if (job == IntPtr.Zero || !KillOnClose(job) || !AssignProcessToJobObject(job, GetCurrentProcess()))
            return Fail(JobFailed, "job objects are unavailable: " + Win32Error());
        Console.Out.WriteLine("ok");
        return 0;
    }

    /// absent: no handle to the job exists, so the kernel has ended every
    /// process launched in it. empty: it exists with no process left.
    static string State(IntPtr job)
    {
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;
        if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, out accounting,
            (uint)Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)), IntPtr.Zero)) return null;
        return accounting.ActiveProcesses == 0 ? "empty" : "active " + accounting.ActiveProcesses;
    }

    static int Probe(string name)
    {
        IntPtr job = OpenJobObjectW(JOB_OBJECT_QUERY, false, name);
        if (job == IntPtr.Zero)
        {
            if (Marshal.GetLastWin32Error() != ERROR_FILE_NOT_FOUND) return Fail(JobFailed, "cannot open the job: " + Win32Error());
            Console.Out.WriteLine("absent");
            return 0;
        }
        string state = State(job);
        CloseHandle(job);
        if (state == null) return Fail(JobFailed, "cannot query the job: " + Win32Error());
        Console.Out.WriteLine(state);
        return 0;
    }

    static int Terminate(string name)
    {
        IntPtr job = OpenJobObjectW(JOB_OBJECT_QUERY | JOB_OBJECT_TERMINATE, false, name);
        if (job == IntPtr.Zero)
        {
            if (Marshal.GetLastWin32Error() != ERROR_FILE_NOT_FOUND) return Fail(JobFailed, "cannot open the job: " + Win32Error());
            Console.Out.WriteLine("absent");
            return 0;
        }
        if (!TerminateJobObject(job, 1)) return Fail(JobFailed, "cannot end the job: " + Win32Error());
        string state = null;
        for (int waited = 0; waited < 5000; waited += 20)
        {
            state = State(job);
            if (state == "empty") break;
            Thread.Sleep(20);
        }
        CloseHandle(job);
        if (state != "empty") return Fail(StillActive, "the job still has processes: " + (state ?? Win32Error()));
        Console.Out.WriteLine("empty");
        return 0;
    }
}
