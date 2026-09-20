import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";

const WINDOWS_SANDBOX_LAUNCHER = String.raw`
param(
  [Parameter(Mandatory = $true)]
  [string]$ConfigBase64
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$configJson = [Text.Encoding]::UTF8.GetString(
  [Convert]::FromBase64String($ConfigBase64)
)
$config = $configJson | ConvertFrom-Json

function Write-StamContDiagnostic {
  param([Parameter(Mandatory = $true)][string]$Stage)

  $diagnosticsPath = [string]$config.DiagnosticsPath
  if ([string]::IsNullOrWhiteSpace($diagnosticsPath)) {
    return
  }

  try {
    Add-Content -LiteralPath $diagnosticsPath -Encoding UTF8 -Value (
      ([DateTime]::UtcNow.ToString("O")) +
      " pid=" + $PID +
      " profile=" + ([string]$config.ProfileName) +
      " stage=" + $Stage
    )
  }
  catch {
    # Diagnostics are strictly best-effort.
  }
}

Write-StamContDiagnostic -Stage "powershell-config-parsed"
Write-StamContDiagnostic -Stage "before-add-type"

Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class StamContAppContainer
{
    public static string DiagnosticsPath = "";
    public static long LastStdoutBytes = 0;
    public static long LastStderrBytes = 0;
    public static string LastStdoutBase64 = "";
    public static string LastStderrBase64 = "";

    private static void Diagnostic(
        string diagnosticsPath,
        string profileName,
        string stage)
    {
        if (String.IsNullOrWhiteSpace(diagnosticsPath))
        {
            return;
        }

        try
        {
            string line =
                DateTime.UtcNow.ToString("O") +
                " pid=" + System.Diagnostics.Process.GetCurrentProcess().Id +
                " profile=" + profileName +
                " stage=" + stage +
                Environment.NewLine;
            File.AppendAllText(diagnosticsPath, line, Encoding.UTF8);
        }
        catch
        {
            // Diagnostics must never change sandbox behavior.
        }
    }
    private const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const uint HANDLE_FLAG_INHERIT = 0x00000001;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const int ERROR_BROKEN_PIPE = 109;
    private const uint FILE_GENERIC_READ = 0x00120089;
    private const uint FILE_GENERIC_EXECUTE = 0x001200A0;
    private const uint FILE_ALL_ACCESS = 0x001F01FF;
    private const uint FILE_TRAVERSE = 0x00000020;
    private const uint FILE_READ_ATTRIBUTES = 0x00000080;
    private const uint SE_FILE_OBJECT = 1;
    private const uint DACL_SECURITY_INFORMATION = 0x00000004;
    private const uint GRANT_ACCESS = 1;
    private const uint REVOKE_ACCESS = 4;
    private const uint OBJECT_INHERIT_ACE = 0x1;
    private const uint CONTAINER_INHERIT_ACE = 0x2;
    private const uint TRUSTEE_IS_SID = 0;
    private const uint TRUSTEE_IS_UNKNOWN = 0;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint INFINITE = 0xFFFFFFFF;
    private static readonly IntPtr PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES =
        new IntPtr(0x00020009);
    private static readonly IntPtr PROC_THREAD_ATTRIBUTE_HANDLE_LIST =
        new IntPtr(0x00020002);

    [StructLayout(LayoutKind.Sequential)]
    private struct SECURITY_CAPABILITIES
    {
        public IntPtr AppContainerSid;
        public IntPtr Capabilities;
        public uint CapabilityCount;
        public uint Reserved;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct TRUSTEE
    {
        public IntPtr pMultipleTrustee;
        public uint MultipleTrusteeOperation;
        public uint TrusteeForm;
        public uint TrusteeType;
        public IntPtr ptstrName;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct EXPLICIT_ACCESS
    {
        public uint grfAccessPermissions;
        public uint grfAccessMode;
        public uint grfInheritance;
        public TRUSTEE Trustee;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public uint cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public uint dwX;
        public uint dwY;
        public uint dwXSize;
        public uint dwYSize;
        public uint dwXCountChars;
        public uint dwYCountChars;
        public uint dwFillAttribute;
        public uint dwFlags;
        public ushort wShowWindow;
        public ushort cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct STARTUPINFOEX
    {
        public STARTUPINFO StartupInfo;
        public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SECURITY_ATTRIBUTES
    {
        public uint nLength;
        public IntPtr lpSecurityDescriptor;
        [MarshalAs(UnmanagedType.Bool)]
        public bool bInheritHandle;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
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
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    private static extern int CreateAppContainerProfile(
        string pszAppContainerName,
        string pszDisplayName,
        string pszDescription,
        IntPtr pCapabilities,
        uint dwCapabilityCount,
        out IntPtr ppSidAppContainerSid);

    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    private static extern int DeriveAppContainerSidFromAppContainerName(
        string pszAppContainerName,
        out IntPtr ppsidAppContainerSid);

    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    private static extern int DeleteAppContainerProfile(
        string pszAppContainerName);

    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    private static extern int GetAppContainerFolderPath(
        string pszAppContainerSid,
        out IntPtr ppszPath);

    [DllImport("ole32.dll")]
    private static extern void CoTaskMemFree(IntPtr pv);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern IntPtr FreeSid(IntPtr pSid);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool ConvertSidToStringSidW(
        IntPtr Sid,
        out IntPtr StringSid);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
    private static extern uint GetNamedSecurityInfoW(
        string pObjectName,
        uint ObjectType,
        uint SecurityInfo,
        out IntPtr ppsidOwner,
        out IntPtr ppsidGroup,
        out IntPtr ppDacl,
        out IntPtr ppSacl,
        out IntPtr ppSecurityDescriptor);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
    private static extern uint SetNamedSecurityInfoW(
        string pObjectName,
        uint ObjectType,
        uint SecurityInfo,
        IntPtr psidOwner,
        IntPtr psidGroup,
        IntPtr pDacl,
        IntPtr pSacl);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
    private static extern uint SetEntriesInAclW(
        uint cCountOfExplicitEntries,
        ref EXPLICIT_ACCESS pListOfExplicitEntries,
        IntPtr OldAcl,
        out IntPtr NewAcl);

    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr hMem);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool InitializeProcThreadAttributeList(
        IntPtr lpAttributeList,
        int dwAttributeCount,
        int dwFlags,
        ref IntPtr lpSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateProcThreadAttribute(
        IntPtr lpAttributeList,
        uint dwFlags,
        IntPtr Attribute,
        IntPtr lpValue,
        IntPtr cbSize,
        IntPtr lpPreviousValue,
        IntPtr lpReturnSize);

    [DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(
        IntPtr lpAttributeList);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessW(
        string lpApplicationName,
        StringBuilder lpCommandLine,
        IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes,
        bool bInheritHandles,
        uint dwCreationFlags,
        IntPtr lpEnvironment,
        string lpCurrentDirectory,
        ref STARTUPINFOEX lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateJobObjectW(
        IntPtr lpJobAttributes,
        string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr hJob,
        int JobObjectInfoClass,
        IntPtr lpJobObjectInfo,
        uint cbJobObjectInfoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(
        IntPtr hJob,
        IntPtr hProcess);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr hThread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(
        IntPtr hHandle,
        uint dwMilliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(
        IntPtr hProcess,
        out uint lpExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CreatePipe(
        out IntPtr hReadPipe,
        out IntPtr hWritePipe,
        ref SECURITY_ATTRIBUTES lpPipeAttributes,
        uint nSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetHandleInformation(
        IntPtr hObject,
        uint dwMask,
        uint dwFlags);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool PeekNamedPipe(
        IntPtr hNamedPipe,
        IntPtr lpBuffer,
        uint nBufferSize,
        IntPtr lpBytesRead,
        out uint lpTotalBytesAvail,
        IntPtr lpBytesLeftThisMessage);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool ReadFile(
        IntPtr hFile,
        byte[] lpBuffer,
        uint nNumberOfBytesToRead,
        out uint lpNumberOfBytesRead,
        IntPtr lpOverlapped);

    private static void PumpPipe(
        IntPtr readHandle,
        MemoryStream destination,
        bool isStdout,
        ManualResetEventSlim stop)
    {
        byte[] buffer = new byte[8192];

        while (true)
        {
            uint available;
            if (!PeekNamedPipe(
                    readHandle,
                    IntPtr.Zero,
                    0,
                    IntPtr.Zero,
                    out available,
                    IntPtr.Zero))
            {
                int error = Marshal.GetLastWin32Error();
                if (error == ERROR_BROKEN_PIPE)
                {
                    break;
                }
                throw new Win32Exception(
                    error,
                    "PeekNamedPipe failed for sandbox output");
            }

            if (available == 0)
            {
                if (stop.IsSet)
                {
                    break;
                }
                Thread.Sleep(2);
                continue;
            }

            uint requested = Math.Min((uint)buffer.Length, available);
            uint read;
            if (!ReadFile(
                    readHandle,
                    buffer,
                    requested,
                    out read,
                    IntPtr.Zero))
            {
                int error = Marshal.GetLastWin32Error();
                if (error == ERROR_BROKEN_PIPE)
                {
                    break;
                }
                throw new Win32Exception(
                    error,
                    "ReadFile failed for sandbox output");
            }
            if (read == 0)
            {
                if (stop.IsSet)
                {
                    break;
                }
                continue;
            }

            if (isStdout)
            {
                Interlocked.Add(ref LastStdoutBytes, (long)read);
            }
            else
            {
                Interlocked.Add(ref LastStderrBytes, (long)read);
            }
            destination.Write(buffer, 0, (int)read);
        }
    }

    private static void ApplyProfileAcl(
        string profileName,
        string targetPath,
        uint accessMask,
        uint accessMode,
        bool inherit)
    {
        IntPtr sid = IntPtr.Zero;
        IntPtr securityDescriptor = IntPtr.Zero;
        IntPtr oldDacl = IntPtr.Zero;
        IntPtr newDacl = IntPtr.Zero;

        try
        {
            Diagnostic(DiagnosticsPath, profileName, "acl-before-derive target=" + targetPath);
            int hr = DeriveAppContainerSidFromAppContainerName(
                profileName,
                out sid);
            if (hr < 0)
            {
                Marshal.ThrowExceptionForHR(hr);
            }

            Diagnostic(DiagnosticsPath, profileName, "acl-after-derive target=" + targetPath);

            IntPtr owner;
            IntPtr group;
            IntPtr sacl;
            Diagnostic(DiagnosticsPath, profileName, "acl-before-get-security target=" + targetPath);
            uint result = GetNamedSecurityInfoW(
                targetPath,
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                out owner,
                out group,
                out oldDacl,
                out sacl,
                out securityDescriptor);
            if (result != 0)
            {
                throw new Win32Exception(
                    unchecked((int)result),
                    "GetNamedSecurityInfoW failed for " + targetPath);
            }
            Diagnostic(DiagnosticsPath, profileName, "acl-after-get-security target=" + targetPath);

            EXPLICIT_ACCESS entry = new EXPLICIT_ACCESS
            {
                grfAccessPermissions = accessMask,
                grfAccessMode = accessMode,
                grfInheritance = inherit
                    ? OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE
                    : 0,
                Trustee = new TRUSTEE
                {
                    pMultipleTrustee = IntPtr.Zero,
                    MultipleTrusteeOperation = 0,
                    TrusteeForm = TRUSTEE_IS_SID,
                    TrusteeType = TRUSTEE_IS_UNKNOWN,
                    ptstrName = sid,
                },
            };

            Diagnostic(DiagnosticsPath, profileName, "acl-before-set-entries target=" + targetPath);
            result = SetEntriesInAclW(1, ref entry, oldDacl, out newDacl);
            if (result != 0)
            {
                throw new Win32Exception(
                    unchecked((int)result),
                    "SetEntriesInAclW failed for " + targetPath);
            }
            Diagnostic(DiagnosticsPath, profileName, "acl-after-set-entries target=" + targetPath);

            Diagnostic(DiagnosticsPath, profileName, "acl-before-set-security target=" + targetPath);
            result = SetNamedSecurityInfoW(
                targetPath,
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                IntPtr.Zero,
                IntPtr.Zero,
                newDacl,
                IntPtr.Zero);
            if (result != 0)
            {
                throw new Win32Exception(
                    unchecked((int)result),
                    "SetNamedSecurityInfoW failed for " + targetPath);
            }
            Diagnostic(DiagnosticsPath, profileName, "acl-after-set-security target=" + targetPath);
        }
        finally
        {
            if (newDacl != IntPtr.Zero)
            {
                LocalFree(newDacl);
            }
            if (securityDescriptor != IntPtr.Zero)
            {
                LocalFree(securityDescriptor);
            }
            if (sid != IntPtr.Zero)
            {
                FreeSid(sid);
            }
        }
    }

    public static void GrantProfileReadExecute(
        string profileName,
        string targetPath,
        bool inherit)
    {
        ApplyProfileAcl(
            profileName,
            targetPath,
            FILE_GENERIC_READ | FILE_GENERIC_EXECUTE,
            GRANT_ACCESS,
            inherit);
    }

    public static void GrantProfileFullAccess(
        string profileName,
        string targetPath,
        bool inherit)
    {
        ApplyProfileAcl(
            profileName,
            targetPath,
            FILE_ALL_ACCESS,
            GRANT_ACCESS,
            inherit);
    }

    public static void GrantProfileTraverse(
        string profileName,
        string targetPath)
    {
        ApplyProfileAcl(
            profileName,
            targetPath,
            FILE_TRAVERSE | FILE_READ_ATTRIBUTES,
            GRANT_ACCESS,
            false);
    }

    public static void RevokeProfileAccess(
        string profileName,
        string targetPath)
    {
        ApplyProfileAcl(
            profileName,
            targetPath,
            0,
            REVOKE_ACCESS,
            false);
    }

    public static string CreateProfile(string profileName)
    {
        IntPtr sid = IntPtr.Zero;
        IntPtr sidString = IntPtr.Zero;
        try
        {
            int hr = CreateAppContainerProfile(
                profileName,
                "StamCont Interactive Sandbox",
                "Ephemeral StamCont execution sandbox",
                IntPtr.Zero,
                0,
                out sid);
            if (hr < 0)
            {
                Marshal.ThrowExceptionForHR(hr);
            }

            if (!ConvertSidToStringSidW(sid, out sidString))
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "ConvertSidToStringSidW failed");
            }
            return Marshal.PtrToStringUni(sidString);
        }
        finally
        {
            if (sidString != IntPtr.Zero)
            {
                LocalFree(sidString);
            }
            if (sid != IntPtr.Zero)
            {
                FreeSid(sid);
            }
        }
    }

    public static string GetProfileFolderPath(string profileName)
    {
        IntPtr sid = IntPtr.Zero;
        IntPtr sidString = IntPtr.Zero;
        IntPtr folderPath = IntPtr.Zero;
        try
        {
            int hr = DeriveAppContainerSidFromAppContainerName(
                profileName,
                out sid);
            if (hr < 0)
            {
                Marshal.ThrowExceptionForHR(hr);
            }

            if (!ConvertSidToStringSidW(sid, out sidString))
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "ConvertSidToStringSidW failed for AppContainer profile");
            }

            string sidText = Marshal.PtrToStringUni(sidString);
            hr = GetAppContainerFolderPath(sidText, out folderPath);
            if (hr < 0)
            {
                Marshal.ThrowExceptionForHR(hr);
            }
            string result = Marshal.PtrToStringUni(folderPath);
            if (String.IsNullOrWhiteSpace(result))
            {
                throw new InvalidOperationException(
                    "GetAppContainerFolderPath returned an empty path");
            }
            return result;
        }
        finally
        {
            if (folderPath != IntPtr.Zero)
            {
                CoTaskMemFree(folderPath);
            }
            if (sidString != IntPtr.Zero)
            {
                LocalFree(sidString);
            }
            if (sid != IntPtr.Zero)
            {
                FreeSid(sid);
            }
        }
    }

    public static void DeleteProfile(string profileName)
    {
        int hr = DeleteAppContainerProfile(profileName);
        if (hr < 0)
        {
            Marshal.ThrowExceptionForHR(hr);
        }
    }

    public static int RunBase64(
        string profileName,
        string commandInterpreter,
        string commandUtf8Base64,
        string workingDirectory,
        string diagnosticsPath)
    {
        byte[] commandBytes = Convert.FromBase64String(commandUtf8Base64);
        string commandText = Encoding.UTF8.GetString(commandBytes);
        return Run(
            profileName,
            commandInterpreter,
            commandText,
            workingDirectory,
            diagnosticsPath);
    }

    public static int Run(
        string profileName,
        string commandInterpreter,
        string commandText,
        string workingDirectory,
        string diagnosticsPath)
    {
        IntPtr appContainerSid = IntPtr.Zero;
        IntPtr attributeList = IntPtr.Zero;
        IntPtr securityCapabilitiesPtr = IntPtr.Zero;
        IntPtr job = IntPtr.Zero;
        IntPtr jobInfoPtr = IntPtr.Zero;
        IntPtr handleListPtr = IntPtr.Zero;
        IntPtr childStdIn = IntPtr.Zero;
        IntPtr stdinWrite = IntPtr.Zero;
        IntPtr childStdOut = IntPtr.Zero;
        IntPtr childStdErr = IntPtr.Zero;
        IntPtr stdoutRead = IntPtr.Zero;
        IntPtr stderrRead = IntPtr.Zero;
        Thread stdoutThread = null;
        Thread stderrThread = null;
        ManualResetEventSlim outputStop = new ManualResetEventSlim(false);
        Exception stdoutPumpError = null;
        Exception stderrPumpError = null;
        MemoryStream stdoutBuffer = new MemoryStream();
        MemoryStream stderrBuffer = new MemoryStream();
        PROCESS_INFORMATION processInfo = new PROCESS_INFORMATION();

        try
        {
            Diagnostic(diagnosticsPath, profileName, "run-start");
            Interlocked.Exchange(ref LastStdoutBytes, 0);
            Interlocked.Exchange(ref LastStderrBytes, 0);
            LastStdoutBase64 = "";
            LastStderrBase64 = "";

            int hr = DeriveAppContainerSidFromAppContainerName(
                profileName,
                out appContainerSid);
            if (hr < 0)
            {
                Marshal.ThrowExceptionForHR(hr);
            }
            Diagnostic(diagnosticsPath, profileName, "sid-derived");

            SECURITY_CAPABILITIES capabilities = new SECURITY_CAPABILITIES
            {
                AppContainerSid = appContainerSid,
                Capabilities = IntPtr.Zero,
                CapabilityCount = 0,
                Reserved = 0,
            };
            securityCapabilitiesPtr =
                Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SECURITY_CAPABILITIES)));
            Marshal.StructureToPtr(
                capabilities,
                securityCapabilitiesPtr,
                false);

            IntPtr attributeListSize = IntPtr.Zero;
            InitializeProcThreadAttributeList(
                IntPtr.Zero,
                2,
                0,
                ref attributeListSize);
            attributeList = Marshal.AllocHGlobal(attributeListSize);
            if (!InitializeProcThreadAttributeList(
                attributeList,
                2,
                0,
                ref attributeListSize))
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "InitializeProcThreadAttributeList failed");
            }

            if (!UpdateProcThreadAttribute(
                attributeList,
                0,
                PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
                securityCapabilitiesPtr,
                new IntPtr(Marshal.SizeOf(typeof(SECURITY_CAPABILITIES))),
                IntPtr.Zero,
                IntPtr.Zero))
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "Setting AppContainer security capabilities failed");
            }
            Diagnostic(diagnosticsPath, profileName, "security-capabilities-ready");

            job = CreateJobObjectW(IntPtr.Zero, null);
            if (job == IntPtr.Zero)
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "CreateJobObjectW failed");
            }

            JOBOBJECT_EXTENDED_LIMIT_INFORMATION jobInfo =
                new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            jobInfo.BasicLimitInformation.LimitFlags =
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            int jobInfoSize =
                Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            jobInfoPtr = Marshal.AllocHGlobal(jobInfoSize);
            Marshal.StructureToPtr(jobInfo, jobInfoPtr, false);
            if (!SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                jobInfoPtr,
                (uint)jobInfoSize))
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "SetInformationJobObject failed");
            }
            Diagnostic(diagnosticsPath, profileName, "job-ready");

            // The child will be created suspended, attached to this Job
            // Object, and only then resumed. No untrusted instruction executes
            // outside StamCont's kill-on-close descendant boundary.

            // Use broker-owned anonymous pipes for all standard streams.
            // The sandbox is non-interactive: stdin receives a private pipe
            // whose writer is closed immediately after process creation, so
            // reads observe deterministic EOF rather than inheriting a live
            // GitHub/PowerShell console or pipe.
            SECURITY_ATTRIBUTES pipeAttributes = new SECURITY_ATTRIBUTES
            {
                nLength = (uint)Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)),
                lpSecurityDescriptor = IntPtr.Zero,
                bInheritHandle = true,
            };

            if (!CreatePipe(
                    out childStdIn,
                    out stdinWrite,
                    ref pipeAttributes,
                    0) ||
                !SetHandleInformation(
                    stdinWrite,
                    HANDLE_FLAG_INHERIT,
                    0))
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "Creating sandbox stdin pipe failed");
            }
            if (!CreatePipe(
                    out stdoutRead,
                    out childStdOut,
                    ref pipeAttributes,
                    0) ||
                !SetHandleInformation(
                    stdoutRead,
                    HANDLE_FLAG_INHERIT,
                    0))
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "Creating sandbox stdout pipe failed");
            }
            if (!CreatePipe(
                    out stderrRead,
                    out childStdErr,
                    ref pipeAttributes,
                    0) ||
                !SetHandleInformation(
                    stderrRead,
                    HANDLE_FLAG_INHERIT,
                    0))
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "Creating sandbox stderr pipe failed");
            }

            handleListPtr = Marshal.AllocHGlobal(IntPtr.Size * 3);
            Marshal.WriteIntPtr(handleListPtr, 0 * IntPtr.Size, childStdIn);
            Marshal.WriteIntPtr(handleListPtr, 1 * IntPtr.Size, childStdOut);
            Marshal.WriteIntPtr(handleListPtr, 2 * IntPtr.Size, childStdErr);
            if (!UpdateProcThreadAttribute(
                attributeList,
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                handleListPtr,
                new IntPtr(IntPtr.Size * 3),
                IntPtr.Zero,
                IntPtr.Zero))
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "Setting sandbox standard-handle whitelist failed");
            }
            Diagnostic(diagnosticsPath, profileName, "stdio-and-handle-list-ready");

            // Keep process creation narrow: SECURITY_CAPABILITIES establishes
            // the AppContainer and HANDLE_LIST exposes only stdin plus the two
            // broker-owned output pipes. The process starts suspended, is
            // assigned to the kill-on-close Job Object, then resumes.
            string shell = commandInterpreter;
            char quote = '"';
            StringBuilder commandLine = new StringBuilder(
                quote + shell + quote +
                " /d /s /c " + commandText);

            STARTUPINFOEX startup = new STARTUPINFOEX();
            startup.StartupInfo.cb =
                (uint)Marshal.SizeOf(typeof(STARTUPINFOEX));
            startup.StartupInfo.lpDesktop = "winsta0\\default";
            startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            startup.StartupInfo.hStdInput = childStdIn;
            startup.StartupInfo.hStdOutput = childStdOut;
            startup.StartupInfo.hStdError = childStdErr;
            startup.lpAttributeList = attributeList;

            Diagnostic(diagnosticsPath, profileName, "before-create-process");
            if (!CreateProcessW(
                shell,
                commandLine,
                IntPtr.Zero,
                IntPtr.Zero,
                true,
                EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW | CREATE_SUSPENDED,
                IntPtr.Zero,
                workingDirectory,
                ref startup,
                out processInfo))
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "CreateProcessW(AppContainer) failed");
            }
            Diagnostic(
                diagnosticsPath,
                profileName,
                "after-create-process childPid=" + processInfo.dwProcessId);

            if (!AssignProcessToJobObject(job, processInfo.hProcess))
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "AssignProcessToJobObject failed");
            }
            Diagnostic(diagnosticsPath, profileName, "job-assigned");

            uint previousSuspendCount = ResumeThread(processInfo.hThread);
            if (previousSuspendCount == 0xFFFFFFFF)
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "ResumeThread failed for AppContainer child");
            }
            Diagnostic(diagnosticsPath, profileName, "child-resumed");

            // The child owns its inherited stdin read handle. Drop both broker
            // copies so the child immediately observes EOF if it attempts to
            // read from stdin.
            CloseHandle(childStdIn);
            childStdIn = IntPtr.Zero;
            CloseHandle(stdinWrite);
            stdinWrite = IntPtr.Zero;

            // The lowbox inherited its write ends; drop the broker copies so
            // EOF is observable when the contained process tree exits.
            CloseHandle(childStdOut);
            childStdOut = IntPtr.Zero;
            CloseHandle(childStdErr);
            childStdErr = IntPtr.Zero;

            stdoutThread = new Thread(() =>
            {
                try
                {
                    PumpPipe(
                        stdoutRead,
                        stdoutBuffer,
                        true,
                        outputStop);
                }
                catch (Exception error)
                {
                    stdoutPumpError = error;
                }
            });
            stderrThread = new Thread(() =>
            {
                try
                {
                    PumpPipe(
                        stderrRead,
                        stderrBuffer,
                        false,
                        outputStop);
                }
                catch (Exception error)
                {
                    stderrPumpError = error;
                }
            });
            stdoutThread.IsBackground = true;
            stderrThread.IsBackground = true;
            stdoutThread.Start();
            stderrThread.Start();

            Diagnostic(diagnosticsPath, profileName, "before-wait");
            WaitForSingleObject(processInfo.hProcess, INFINITE);
            Diagnostic(diagnosticsPath, profileName, "after-wait");
            uint exitCode;
            if (!GetExitCodeProcess(processInfo.hProcess, out exitCode))
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "GetExitCodeProcess failed");
            }

            // Kill any background descendants before waiting for EOF; otherwise
            // an inherited stdout/stderr write end could keep the pumps open.
            if (job != IntPtr.Zero)
            {
                CloseHandle(job);
                job = IntPtr.Zero;
            }
            Diagnostic(diagnosticsPath, profileName, "job-closed");

            // No new writers can survive the closed job. Tell the pump loops
            // to finish once all currently buffered bytes have been drained;
            // do not wait for pipe EOF, because inherited write handles are not
            // a reliable lifecycle signal across AppContainer descendants.
            outputStop.Set();

            bool stdoutClosed = stdoutThread.Join(5000);
            bool stderrClosed = stderrThread.Join(5000);
            if (!stdoutClosed || !stderrClosed)
            {
                throw new TimeoutException(
                    "Sandbox output pumps did not stop after process-tree teardown");
            }
            if (stdoutPumpError != null)
            {
                throw new IOException(
                    "Sandbox stdout pump failed",
                    stdoutPumpError);
            }
            if (stderrPumpError != null)
            {
                throw new IOException(
                    "Sandbox stderr pump failed",
                    stderrPumpError);
            }

            LastStdoutBase64 =
                Convert.ToBase64String(stdoutBuffer.ToArray());
            LastStderrBase64 =
                Convert.ToBase64String(stderrBuffer.ToArray());
            Diagnostic(diagnosticsPath, profileName, "run-return");
            return unchecked((int)exitCode);
        }
        finally
        {
            // Exceptional paths must also release pump threads. Signal them
            // before closing their read handles; normal paths already joined
            // them above, so these joins return immediately there.
            outputStop.Set();

            if (processInfo.hThread != IntPtr.Zero)
            {
                CloseHandle(processInfo.hThread);
            }
            if (processInfo.hProcess != IntPtr.Zero)
            {
                CloseHandle(processInfo.hProcess);
            }
            // Closing a KILL_ON_JOB_CLOSE job terminates any descendants that
            // outlived the initial shell.
            if (job != IntPtr.Zero)
            {
                CloseHandle(job);
            }
            if (stdoutThread != null && stdoutThread.IsAlive)
            {
                stdoutThread.Join(1000);
            }
            if (stderrThread != null && stderrThread.IsAlive)
            {
                stderrThread.Join(1000);
            }
            if (attributeList != IntPtr.Zero)
            {
                DeleteProcThreadAttributeList(attributeList);
                Marshal.FreeHGlobal(attributeList);
            }
            if (securityCapabilitiesPtr != IntPtr.Zero)
            {
                Marshal.FreeHGlobal(securityCapabilitiesPtr);
            }
            if (handleListPtr != IntPtr.Zero)
            {
                Marshal.FreeHGlobal(handleListPtr);
            }
            if (childStdIn != IntPtr.Zero)
            {
                CloseHandle(childStdIn);
            }
            if (stdinWrite != IntPtr.Zero)
            {
                CloseHandle(stdinWrite);
            }
            if (childStdOut != IntPtr.Zero)
            {
                CloseHandle(childStdOut);
            }
            if (childStdErr != IntPtr.Zero)
            {
                CloseHandle(childStdErr);
            }
            if (stdoutRead != IntPtr.Zero)
            {
                CloseHandle(stdoutRead);
            }
            if (stderrRead != IntPtr.Zero)
            {
                CloseHandle(stderrRead);
            }
            outputStop.Dispose();
            stdoutBuffer.Dispose();
            stderrBuffer.Dispose();
            if (jobInfoPtr != IntPtr.Zero)
            {
                Marshal.FreeHGlobal(jobInfoPtr);
            }
            if (appContainerSid != IntPtr.Zero)
            {
                FreeSid(appContainerSid);
            }
        }
    }
}
'@

Write-StamContDiagnostic -Stage "after-add-type"
[StamContAppContainer]::DiagnosticsPath = [string]$config.DiagnosticsPath

$sid = $null
$grantedPaths = [System.Collections.Generic.List[string]]::new()
$grantedPathSet = [System.Collections.Generic.HashSet[string]]::new(
  [StringComparer]::OrdinalIgnoreCase
)

function Register-GrantedPath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$TargetPath
  )

  $fullPath = [IO.Path]::GetFullPath($TargetPath)
  if ($grantedPathSet.Add($fullPath)) {
    $grantedPaths.Add($fullPath)
  }
}

function Grant-ProfileReadExecute {
  param(
    [Parameter(Mandatory = $true)]
    [string]$TargetPath,
    [switch]$Required
  )

  if (-not (Test-Path -LiteralPath $TargetPath)) {
    if ($Required) {
      throw "Sandbox ACL target does not exist: $TargetPath"
    }
    return
  }

  try {
    [StamContAppContainer]::GrantProfileReadExecute(
      [string]$config.ProfileName,
      [IO.Path]::GetFullPath($TargetPath),
      $true
    )
    Register-GrantedPath -TargetPath $TargetPath
  }
  catch {
    if ($Required) {
      throw
    }
  }
}

function Grant-ProfileFullAccess {
  param(
    [Parameter(Mandatory = $true)]
    [string]$TargetPath,
    [switch]$Required
  )

  if (-not (Test-Path -LiteralPath $TargetPath)) {
    if ($Required) {
      throw "Sandbox ACL target does not exist: $TargetPath"
    }
    return
  }

  try {
    [StamContAppContainer]::GrantProfileFullAccess(
      [string]$config.ProfileName,
      [IO.Path]::GetFullPath($TargetPath),
      $true
    )
    Register-GrantedPath -TargetPath $TargetPath
  }
  catch {
    if ($Required) {
      throw
    }
  }
}

function Grant-TraverseAncestors {
  param(
    [Parameter(Mandatory = $true)]
    [string]$TargetPath
  )

  $current = [IO.Directory]::GetParent(
    [IO.Path]::GetFullPath($TargetPath)
  )
  while ($null -ne $current) {
    $ancestor = $current.FullName
    if ($grantedPathSet.Add($ancestor)) {
      Write-StamContDiagnostic -Stage ("ancestor-begin target=" + $TargetPath + " ancestor=" + $ancestor)
      try {
        [StamContAppContainer]::GrantProfileTraverse(
          [string]$config.ProfileName,
          $ancestor
        )
        $grantedPaths.Add($ancestor)
        Write-StamContDiagnostic -Stage ("ancestor-complete ancestor=" + $ancestor)
      }
      catch {
        Write-StamContDiagnostic -Stage ("ancestor-error ancestor=" + $ancestor + " error=" + $_.Exception.Message)
        # Ancestors above the current user's ownership boundary (for example
        # a volume root) may not be mutable. Windows normally permits traversal
        # through those system ancestors; required target grants below remain
        # authoritative.
      }
    }
    $current = $current.Parent
  }
}

$processExitCode = 125

try {
  Write-StamContDiagnostic -Stage "before-profile-create"
  $sid = [StamContAppContainer]::CreateProfile([string]$config.ProfileName)
  Write-StamContDiagnostic -Stage "after-profile-create"

  foreach ($target in @(
    @($config.Roots) +
    @([string]$config.Cwd) +
    @([string]$config.CommandInterpreter) +
    @($config.PathEntries)
  )) {
    if (-not [string]::IsNullOrWhiteSpace([string]$target)) {
      Write-StamContDiagnostic -Stage ("target-begin path=" + ([string]$target))
      Grant-TraverseAncestors -TargetPath ([string]$target)
    }
  }

  Write-StamContDiagnostic -Stage "after-ancestor-grants"

  foreach ($root in @($config.Roots)) {
    if ([bool]$config.ReadOnly) {
      Grant-ProfileReadExecute -TargetPath ([string]$root) -Required
    } else {
      Grant-ProfileFullAccess -TargetPath ([string]$root) -Required
    }
  }

  Write-StamContDiagnostic -Stage "after-root-grants"

  # Developer-tool PATH directories receive specific read/execute rights only.
  # Optional grants fail closed for the tool itself but do not prevent shell
  # startup when a system-protected PATH entry cannot be modified.
  foreach ($pathEntry in @($config.PathEntries)) {
    Grant-ProfileReadExecute -TargetPath ([string]$pathEntry)
  }

  Write-StamContDiagnostic -Stage "after-path-grants"

  # Bootstrap inside the AppContainer's own profile storage rather than
  # under the host user's temp tree. Windows creates this location specifically
  # for the container and grants it access by construction.
  $profileHome = [StamContAppContainer]::GetProfileFolderPath(
    [string]$config.ProfileName
  )
  $profileTemp = Join-Path $profileHome "Temp"
  [IO.Directory]::CreateDirectory($profileTemp) | Out-Null

  $env:HOME = $profileHome
  $env:USERPROFILE = $profileHome
  $env:LOCALAPPDATA = $profileHome
  $env:TEMP = $profileTemp
  $env:TMP = $profileTemp
  $env:TMPDIR = $profileTemp

  $commandText = [Text.Encoding]::UTF8.GetString(
    [Convert]::FromBase64String([string]$config.CommandUtf8Base64)
  )

  if ([bool]$config.Diagnostics) {
    $commandBytes = [Text.Encoding]::UTF8.GetBytes($commandText)
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
      $commandHash = ([BitConverter]::ToString(
        $sha.ComputeHash($commandBytes)
      )).Replace("-", "").ToLowerInvariant()
    }
    finally {
      $sha.Dispose()
    }

    if ($commandBytes.Length -ne [int]$config.CommandUtf8Length) {
      $processExitCode = 246
      throw "Decoded sandbox command length mismatch"
    }
    if ($commandHash -ne [string]$config.CommandSha256) {
      $processExitCode = 247
      throw "Decoded sandbox command hash mismatch"
    }
  }

  function Invoke-StamContUserCommand {
    $exitCode = [StamContAppContainer]::RunBase64(
      [string]$config.ProfileName,
      [string]$config.CommandInterpreter,
      [string]$config.CommandUtf8Base64,
      [string]$config.Cwd,
      [string]$config.DiagnosticsPath
    )

    $stdoutBase64 = [StamContAppContainer]::LastStdoutBase64
    if (-not [string]::IsNullOrEmpty($stdoutBase64)) {
      $stdoutText = [Text.Encoding]::UTF8.GetString(
        [Convert]::FromBase64String($stdoutBase64)
      )
      [Console]::Out.Write($stdoutText)
      [Console]::Out.Flush()
    }

    $stderrBase64 = [StamContAppContainer]::LastStderrBase64
    if (-not [string]::IsNullOrEmpty($stderrBase64)) {
      $stderrText = [Text.Encoding]::UTF8.GetString(
        [Convert]::FromBase64String($stderrBase64)
      )
      [Console]::Error.Write($stderrText)
      [Console]::Error.Flush()
    }

    return $exitCode
  }

  Write-StamContDiagnostic -Stage "before-user-command"
  $processExitCode = Invoke-StamContUserCommand
  Write-StamContDiagnostic -Stage "after-user-command"

}
finally {
  Write-StamContDiagnostic -Stage "before-acl-revoke"
  if ($sid) {
    for ($i = $grantedPaths.Count - 1; $i -ge 0; $i--) {
      try {
        [StamContAppContainer]::RevokeProfileAccess(
          [string]$config.ProfileName,
          [string]$grantedPaths[$i]
        )
      }
      catch {
        Write-Warning "Failed to revoke StamCont AppContainer ACL from $($grantedPaths[$i]): $_"
      }
    }
  }
  Write-StamContDiagnostic -Stage "after-acl-revoke"
  try {
    Write-StamContDiagnostic -Stage "before-profile-delete"
    [StamContAppContainer]::DeleteProfile([string]$config.ProfileName)
    Write-StamContDiagnostic -Stage "after-profile-delete"
  }
  catch {
    Write-Error "Failed to delete StamCont AppContainer profile: $_"
  }
}

exit $processExitCode
`;

export interface WindowsSandboxSpawnOptions {
  roots: readonly string[];
  cwd: string;
  readOnly: boolean;
  homeDirectory: string;
  tempDirectory: string;
  env: NodeJS.ProcessEnv;
  spawnOptions: SpawnOptions;
}

export function spawnWindowsAppContainerShell(
  command: string,
  options: WindowsSandboxSpawnOptions,
): ChildProcess {
  if (process.platform !== "win32") {
    throw new Error("Windows AppContainer launcher is only available on win32");
  }

  const profileName = `StamContSandbox_${randomUUID()
    .replaceAll("-", "")
    .slice(0, 24)}`;
  const launcherPath = path.join(
    path.dirname(options.homeDirectory),
    "stamcont-appcontainer-launcher.ps1",
  );
  writeFileSync(launcherPath, WINDOWS_SANDBOX_LAUNCHER, {
    encoding: "utf8",
    mode: 0o600,
  });

  const pathEntries = (options.env.PATH ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
  const systemRoot =
    options.env.SYSTEMROOT || options.env.WINDIR || "C:\\Windows";
  const commandInterpreter =
    options.env.COMSPEC || path.join(systemRoot, "System32", "cmd.exe");
  const commandInterpreterDir = path.dirname(commandInterpreter);
  const sandboxPathEntries = [
    ...new Set([...pathEntries, commandInterpreterDir]),
  ];
  const sandboxEnv = {
    ...options.env,
    COMSPEC: commandInterpreter,
    PATH: sandboxPathEntries.join(path.delimiter),
  };

  const config = {
    ProfileName: profileName,
    Roots: [...options.roots],
    Cwd: options.cwd,
    ReadOnly: options.readOnly,
    HomeDirectory: options.homeDirectory,
    TempDirectory: options.tempDirectory,
    PathEntries: sandboxPathEntries,
    CommandInterpreter: commandInterpreter,
    CommandUtf8Base64: Buffer.from(command, "utf8").toString("base64"),
    CommandUtf8Length: Buffer.byteLength(command, "utf8"),
    CommandSha256: createHash("sha256").update(command, "utf8").digest("hex"),
    Diagnostics: process.env.STAMCONT_REQUIRE_OS_SANDBOX_TESTS === "1",
    DiagnosticsPath:
      process.env.STAMCONT_REQUIRE_OS_SANDBOX_TESTS === "1" &&
      process.env.RUNNER_TEMP
        ? path.join(
            process.env.RUNNER_TEMP,
            "stamcont-windows-sandbox-debug.log",
          )
        : "",
  };
  const configBase64 = Buffer.from(
    JSON.stringify(config),
    "utf8",
  ).toString("base64");

  const powerShell =
    process.env.SystemRoot || process.env.WINDIR
      ? path.join(
          process.env.SystemRoot || process.env.WINDIR || "C:\\Windows",
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe",
        )
      : "powershell.exe";

  return spawn(
    powerShell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      launcherPath,
      "-ConfigBase64",
      configBase64,
    ],
    {
      ...options.spawnOptions,
      cwd: options.cwd,
      env: sandboxEnv,
      windowsHide: true,
      detached: false,
    },
  );
}
