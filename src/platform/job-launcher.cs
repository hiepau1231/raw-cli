// Raw's Windows job launcher (docs/architecture.md, "Windows process trees").
//
// Runs one command inside a Job Object that kills every process still in it when this launcher exits or is killed,
// so stopping the launcher stops the whole tree, including grandchildren whose parent already exited. Raw compiles
// this file on first use with the C# compiler that ships with the .NET Framework and caches the executable in its
// state directory. It takes exactly `--app <base64> --line <base64>`: the UTF-8 executable path and the complete
// command line, which Raw has already quoted, so no argument is re-parsed on the way. Written for C# 5.
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

static class RawJob {
  const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
  const int JobObjectExtendedLimitInformation = 9;
  const uint STARTF_USESTDHANDLES = 0x00000100;
  const uint INFINITE = 0xFFFFFFFF;
  const int STD_INPUT_HANDLE = -10;
  const int STD_OUTPUT_HANDLE = -11;
  const int STD_ERROR_HANDLE = -12;
  const int USAGE = 125;

  [StructLayout(LayoutKind.Sequential)]
  struct IO_COUNTERS {
    public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
    public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
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
  struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
    public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO {
    public int cb;
    public string lpReserved, lpDesktop, lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute;
    public uint dwFlags;
    public short wShowWindow, cbReserved2;
    public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_INFORMATION {
    public IntPtr hProcess, hThread;
    public int dwProcessId, dwThreadId;
  }

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int length);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")]
  static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")]
  static extern IntPtr GetStdHandle(int which);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcessW(string application, StringBuilder commandLine, IntPtr processAttributes,
    IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory,
    ref STARTUPINFO startup, out PROCESS_INFORMATION information);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll")]
  static extern bool CloseHandle(IntPtr handle);

  static int Main(string[] args) {
    if (args.Length != 4 || args[0] != "--app" || args[2] != "--line") {
      Console.Error.WriteLine("raw-job: usage: raw-job --app <base64> --line <base64>");
      return USAGE;
    }
    string application, line;
    try {
      application = Decode(args[1]);
      line = Decode(args[3]);
    } catch (FormatException) {
      Console.Error.WriteLine("raw-job: --app and --line must be base64");
      return USAGE;
    }

    // The job handle is not inheritable, so only this process holds it: when this process ends for any reason,
    // the job closes and Windows terminates every process left in it.
    IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
    if (job == IntPtr.Zero) return Fail("CreateJobObject");
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
    // No breakaway: Cygwin/MSYS (Git Bash) asks every child to break away whenever the job allows it, which would put
    // pipeline members and their descendants outside the job. Denying it never fails their spawn; they check first.
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits,
      Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)))) return Fail("SetInformationJobObject");
    if (!AssignProcessToJobObject(job, GetCurrentProcess())) return Fail("AssignProcessToJobObject");

    STARTUPINFO startup = new STARTUPINFO();
    startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
    startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
    PROCESS_INFORMATION child;
    if (!CreateProcessW(application, new StringBuilder(line), IntPtr.Zero, IntPtr.Zero, true, 0, IntPtr.Zero, null,
      ref startup, out child)) return Fail("CreateProcess " + application);
    CloseHandle(child.hThread);
    WaitForSingleObject(child.hProcess, INFINITE);
    uint code;
    if (!GetExitCodeProcess(child.hProcess, out code)) return Fail("GetExitCodeProcess");
    return unchecked((int)code);
  }

  static string Decode(string value) {
    return Encoding.UTF8.GetString(Convert.FromBase64String(value));
  }

  static int Fail(string what) {
    Console.Error.WriteLine("raw-job: " + what + " failed: " + new Win32Exception(Marshal.GetLastWin32Error()).Message);
    return USAGE;
  }
}
