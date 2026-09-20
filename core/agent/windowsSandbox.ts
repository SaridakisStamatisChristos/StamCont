import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
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

Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class StamContAppContainer
{
    private const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const uint HANDLE_FLAG_INHERIT = 0x00000001;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint INFINITE = 0xFFFFFFFF;
    private static readonly IntPtr PROC_THREAD_ATTRIBUTE_HANDLE_LIST =
        new IntPtr(0x00020002);
    private static readonly IntPtr PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES =
        new IntPtr(0x00020009);

    [StructLayout(LayoutKind.Sequential)]
    private struct SECURITY_CAPABILITIES
    {
        public IntPtr AppContainerSid;
        public IntPtr Capabilities;
        public uint CapabilityCount;
        public uint Reserved;
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

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern IntPtr FreeSid(IntPtr pSid);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool ConvertSidToStringSidW(
        IntPtr Sid,
        out IntPtr StringSid);

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
    private static extern bool TerminateProcess(
        IntPtr hProcess,
        uint uExitCode);

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
    private static extern IntPtr GetStdHandle(int nStdHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetHandleInformation(
        IntPtr hObject,
        uint dwMask,
        uint dwFlags);

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

    public static void DeleteProfile(string profileName)
    {
        int hr = DeleteAppContainerProfile(profileName);
        if (hr < 0)
        {
            Marshal.ThrowExceptionForHR(hr);
        }
    }

    public static int Run(
        string profileName,
        string encodedCommand,
        string workingDirectory)
    {
        IntPtr appContainerSid = IntPtr.Zero;
        IntPtr attributeList = IntPtr.Zero;
        IntPtr securityCapabilitiesPtr = IntPtr.Zero;
        IntPtr handleListPtr = IntPtr.Zero;
        IntPtr job = IntPtr.Zero;
        IntPtr jobInfoPtr = IntPtr.Zero;
        PROCESS_INFORMATION processInfo = new PROCESS_INFORMATION();
        bool processCreated = false;

        try
        {
            int hr = DeriveAppContainerSidFromAppContainerName(
                profileName,
                out appContainerSid);
            if (hr < 0)
            {
                Marshal.ThrowExceptionForHR(hr);
            }

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

            IntPtr stdin = GetStdHandle(-10);
            IntPtr stdout = GetStdHandle(-11);
            IntPtr stderr = GetStdHandle(-12);
            IntPtr[] stdHandles = new IntPtr[] { stdin, stdout, stderr };
            foreach (IntPtr handle in stdHandles)
            {
                if (handle != IntPtr.Zero && handle != new IntPtr(-1))
                {
                    if (!SetHandleInformation(
                        handle,
                        HANDLE_FLAG_INHERIT,
                        HANDLE_FLAG_INHERIT))
                    {
                        throw new Win32Exception(
                            Marshal.GetLastWin32Error(),
                            "SetHandleInformation failed");
                    }
                }
            }

            handleListPtr = Marshal.AllocHGlobal(IntPtr.Size * stdHandles.Length);
            for (int i = 0; i < stdHandles.Length; i++)
            {
                Marshal.WriteIntPtr(
                    handleListPtr,
                    i * IntPtr.Size,
                    stdHandles[i]);
            }

            if (!UpdateProcThreadAttribute(
                attributeList,
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                handleListPtr,
                new IntPtr(IntPtr.Size * stdHandles.Length),
                IntPtr.Zero,
                IntPtr.Zero))
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "Setting inherited handle allowlist failed");
            }

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

            string powerShell = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.Windows),
                "System32",
                "WindowsPowerShell",
                "v1.0",
                "powershell.exe");
            StringBuilder commandLine = new StringBuilder(
                """ + powerShell + """ +
                " -NoLogo -NoProfile -NonInteractive" +
                " -ExecutionPolicy Bypass -EncodedCommand " +
                encodedCommand);

            STARTUPINFOEX startup = new STARTUPINFOEX();
            startup.StartupInfo.cb =
                (uint)Marshal.SizeOf(typeof(STARTUPINFOEX));
            startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            startup.StartupInfo.hStdInput = stdin;
            startup.StartupInfo.hStdOutput = stdout;
            startup.StartupInfo.hStdError = stderr;
            startup.lpAttributeList = attributeList;

            if (!CreateProcessW(
                powerShell,
                commandLine,
                IntPtr.Zero,
                IntPtr.Zero,
                true,
                EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED,
                IntPtr.Zero,
                workingDirectory,
                ref startup,
                out processInfo))
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "CreateProcessW(AppContainer) failed");
            }
            processCreated = true;

            if (!AssignProcessToJobObject(job, processInfo.hProcess))
            {
                int error = Marshal.GetLastWin32Error();
                TerminateProcess(processInfo.hProcess, 125);
                throw new Win32Exception(
                    error,
                    "AssignProcessToJobObject failed");
            }

            if (ResumeThread(processInfo.hThread) == 0xFFFFFFFF)
            {
                int error = Marshal.GetLastWin32Error();
                TerminateProcess(processInfo.hProcess, 125);
                throw new Win32Exception(error, "ResumeThread failed");
            }

            WaitForSingleObject(processInfo.hProcess, INFINITE);
            uint exitCode;
            if (!GetExitCodeProcess(processInfo.hProcess, out exitCode))
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "GetExitCodeProcess failed");
            }
            return unchecked((int)exitCode);
        }
        finally
        {
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

$sid = $null
$grantedPaths = [System.Collections.Generic.List[string]]::new()

function Grant-SandboxAcl {
  param(
    [Parameter(Mandatory = $true)]
    [string]$TargetPath,
    [Parameter(Mandatory = $true)]
    [string]$Rights,
    [switch]$Required
  )

  if (-not (Test-Path -LiteralPath $TargetPath)) {
    if ($Required) {
      throw "Sandbox ACL target does not exist: $TargetPath"
    }
    return
  }

  & icacls.exe $TargetPath /grant "*$($sid):(OI)(CI)$Rights" /C /Q | Out-Null
  if ($LASTEXITCODE -eq 0) {
    $grantedPaths.Add($TargetPath)
    return
  }

  if ($Required) {
    throw "Unable to grant AppContainer access to $TargetPath"
  }
}

try {
  $sid = [StamContAppContainer]::CreateProfile([string]$config.ProfileName)
  $workspaceRights = if ([bool]$config.ReadOnly) { "RX" } else { "M" }

  foreach ($root in @($config.Roots)) {
    Grant-SandboxAcl -TargetPath ([string]$root) -Rights $workspaceRights -Required
  }

  Grant-SandboxAcl -TargetPath ([string]$config.HomeDirectory) -Rights "M" -Required
  Grant-SandboxAcl -TargetPath ([string]$config.TempDirectory) -Rights "M" -Required

  # AppContainer can already execute Windows system binaries. For developer
  # tools installed into user-controlled PATH directories, grant read/execute
  # only when the current user is allowed to update that directory's ACL.
  foreach ($pathEntry in @($config.PathEntries)) {
    Grant-SandboxAcl -TargetPath ([string]$pathEntry) -Rights "RX"
  }

  $exitCode = [StamContAppContainer]::Run(
    [string]$config.ProfileName,
    [string]$config.CommandBase64,
    [string]$config.Cwd
  )
  exit $exitCode
}
finally {
  if ($sid) {
    foreach ($granted in $grantedPaths) {
      & icacls.exe $granted /remove:g "*$sid" /C /Q | Out-Null
    }
  }
  try {
    [StamContAppContainer]::DeleteProfile([string]$config.ProfileName)
  }
  catch {
    Write-Error "Failed to delete StamCont AppContainer profile: $_"
  }
}
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
    .map((entry) => entry.trim())
    .filter(Boolean);

  const config = {
    ProfileName: profileName,
    Roots: [...options.roots],
    Cwd: options.cwd,
    ReadOnly: options.readOnly,
    HomeDirectory: options.homeDirectory,
    TempDirectory: options.tempDirectory,
    PathEntries: pathEntries,
    CommandBase64: Buffer.from(command, "utf16le").toString("base64"),
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
      env: options.env,
      windowsHide: true,
      detached: true,
    },
  );
}
