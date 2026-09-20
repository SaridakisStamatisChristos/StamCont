import {
  access,
  mkdtemp,
  realpath,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { IDE } from "..";
import {
  assertRestrictedNetworkTarget,
  createPinnedLookup,
  createRestrictedFetch,
  type RestrictedDnsResolver,
  SandboxExecutionBackend,
  SandboxViolationError,
  sanitizeSandboxEnvironment,
} from "./sandbox";

const tempRoots: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function ideWithWorkspaces(...workspaces: string[]): IDE {
  return {
    getWorkspaceDirs: async () =>
      workspaces.map((workspace) => pathToFileURL(workspace).href),
    getIdeInfo: async () => ({
      ideType: "vscode",
      name: "test",
      version: "test",
      remoteName: "local",
      extensionVersion: "test",
      isPrerelease: false,
    }),
    fileExists: async (uri: string) => {
      try {
        await access(new URL(uri));
        return true;
      } catch {
        return false;
      }
    },
  } as unknown as IDE;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("SandboxExecutionBackend filesystem confinement", () => {
  it("resolves files inside any configured workspace root", async () => {
    const rootA = await tempDir("stamcont-sandbox-a-");
    const rootB = await tempDir("stamcont-sandbox-b-");
    await writeFile(path.join(rootB, "target.txt"), "ok", "utf8");

    const backend = new SandboxExecutionBackend(ideWithWorkspaces(rootA, rootB));
    const resolved = await backend.resolveExistingPath("target.txt");

    expect(resolved?.displayPath).toBe(
      await realpath(path.join(rootB, "target.txt")),
    );
    await expect(backend.readFile(resolved!)).resolves.toBe("ok");
  });

  it("rejects absolute, traversal, nested traversal, and file URL escapes", async () => {
    const workspace = await tempDir("stamcont-sandbox-workspace-");
    const outside = await tempDir("stamcont-sandbox-outside-");
    const target = path.join(outside, "secret.txt");
    await writeFile(target, "secret", "utf8");

    const backend = new SandboxExecutionBackend(ideWithWorkspaces(workspace));

    await expect(backend.resolveExistingPath(target)).rejects.toBeInstanceOf(
      SandboxViolationError,
    );
    await expect(
      backend.resolveExistingPath(path.join("..", path.basename(outside), "secret.txt")),
    ).rejects.toBeInstanceOf(SandboxViolationError);
    await expect(
      backend.resolveExistingPath(
        path.join("nested", "..", "..", path.basename(outside), "secret.txt"),
      ),
    ).rejects.toBeInstanceOf(SandboxViolationError);
    await expect(
      backend.resolveExistingPath(pathToFileURL(target).href),
    ).rejects.toBeInstanceOf(SandboxViolationError);
  });

  it("rejects symlink or junction escapes for read, write, and cwd", async () => {
    const workspace = await tempDir("stamcont-sandbox-workspace-");
    const outside = await tempDir("stamcont-sandbox-outside-");
    await writeFile(path.join(outside, "secret.txt"), "secret", "utf8");
    await symlink(
      outside,
      path.join(workspace, "escape"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const backend = new SandboxExecutionBackend(ideWithWorkspaces(workspace));

    await expect(
      backend.resolveExistingPath("escape/secret.txt"),
    ).rejects.toBeInstanceOf(SandboxViolationError);
    await expect(
      backend.resolveWritablePath("escape/new.txt"),
    ).rejects.toBeInstanceOf(SandboxViolationError);
    await expect(
      backend.resolveWorkingDirectory("escape"),
    ).rejects.toBeInstanceOf(SandboxViolationError);
  });

  it.skipIf(process.platform !== "win32")(
    "rejects Windows drive-relative and unrelated drive or UNC-style paths",
    async () => {
      const workspace = await tempDir("stamcont-win-paths-");
      const backend = new SandboxExecutionBackend(ideWithWorkspaces(workspace));

      await expect(
        backend.resolveExistingPath("C:relative.txt"),
      ).rejects.toBeInstanceOf(SandboxViolationError);

      const workspaceDrive = path.parse(workspace).root.slice(0, 2);
      const otherDrive = workspaceDrive.toUpperCase() === "C:" ? "D:" : "C:";
      await expect(
        backend.resolveWritablePath(`${otherDrive}\\unrelated\\file.txt`),
      ).rejects.toBeInstanceOf(SandboxViolationError);

      await expect(
        backend.resolveWritablePath("\\\\server\\share\\file.txt"),
      ).rejects.toBeInstanceOf(SandboxViolationError);
    },
  );

  it("rejects creation through an outside absolute path", async () => {
    const workspace = await tempDir("stamcont-sandbox-workspace-");
    const outside = await tempDir("stamcont-sandbox-outside-");
    const backend = new SandboxExecutionBackend(ideWithWorkspaces(workspace));

    await expect(
      backend.resolveWritablePath(path.join(outside, "new", "file.txt")),
    ).rejects.toBeInstanceOf(SandboxViolationError);
  });

  it("allows creation below a workspace root", async () => {
    const workspace = await tempDir("stamcont-sandbox-workspace-");
    const backend = new SandboxExecutionBackend(ideWithWorkspaces(workspace));
    const target = await backend.resolveWritablePath("new/nested/file.txt");

    await backend.writeFile(target, "sandboxed");

    await expect(
      readFile(path.join(workspace, "new/nested/file.txt"), "utf8"),
    ).resolves.toBe("sandboxed");
  });

  it("makes Plan writable-path and write operations fail closed", async () => {
    const workspace = await tempDir("stamcont-sandbox-plan-");
    await writeFile(path.join(workspace, "existing.txt"), "before", "utf8");
    const backend = new SandboxExecutionBackend(ideWithWorkspaces(workspace), {
      readOnly: true,
    });

    await expect(
      backend.resolveWritablePath("new.txt"),
    ).rejects.toBeInstanceOf(SandboxViolationError);

    const existing = await backend.resolveExistingPath("existing.txt");
    await expect(backend.writeFile(existing!, "after")).rejects.toBeInstanceOf(
      SandboxViolationError,
    );
    await expect(
      readFile(path.join(workspace, "existing.txt"), "utf8"),
    ).resolves.toBe("before");
  });

  it("rejects a working directory outside the workspace", async () => {
    const workspace = await tempDir("stamcont-sandbox-workspace-");
    const outside = await tempDir("stamcont-sandbox-outside-");
    await mkdir(path.join(outside, "project"));

    const backend = new SandboxExecutionBackend(ideWithWorkspaces(workspace));

    await expect(
      backend.resolveWorkingDirectory(path.join(outside, "project")),
    ).rejects.toBeInstanceOf(SandboxViolationError);
  });
});

describe("Interactive restricted network policy", () => {
  const publicResolver: RestrictedDnsResolver = async () => [
    { address: "93.184.216.34", family: 4 },
  ];

  it("blocks localhost, private IPv4, IPv6 loopback, and IPv4-mapped private addresses", async () => {
    const delegate = vi.fn();
    const fetch = createRestrictedFetch(delegate as any, {
      resolver: publicResolver,
    });

    for (const target of [
      "http://127.0.0.1:3000",
      "http://10.0.0.5",
      "http://[::1]/",
      "http://[::ffff:192.168.1.10]/",
    ]) {
      await expect(fetch(target)).rejects.toBeInstanceOf(SandboxViolationError);
    }
    expect(delegate).not.toHaveBeenCalled();
  });

  it("rejects URL credentials and mixed public/private DNS answers", async () => {
    const mixedResolver: RestrictedDnsResolver = async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.7", family: 4 },
    ];

    await expect(
      assertRestrictedNetworkTarget(
        "https://user:password@example.test/",
        publicResolver,
      ),
    ).rejects.toBeInstanceOf(SandboxViolationError);
    await expect(
      assertRestrictedNetworkTarget("https://example.test/", mixedResolver),
    ).rejects.toBeInstanceOf(SandboxViolationError);
  });

  it("normalizes IDN hostnames before resolution", async () => {
    const resolver = vi.fn(publicResolver);
    await assertRestrictedNetworkTarget("https://bücher.example/", resolver);
    expect(resolver).toHaveBeenCalledWith("xn--bcher-kva.example");
  });

  it("revalidates every redirect target", async () => {
    const resolver = vi.fn<RestrictedDnsResolver>(async (hostname) => {
      if (hostname === "private.example") {
        return [{ address: "127.0.0.1", family: 4 }];
      }
      return [{ address: "93.184.216.34", family: 4 }];
    });
    const delegate = vi.fn().mockResolvedValue({
      status: 302,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "location"
            ? "https://private.example/admin"
            : null,
      },
    });

    const fetch = createRestrictedFetch(delegate as any, { resolver });

    await expect(fetch("https://public.example/start")).rejects.toBeInstanceOf(
      SandboxViolationError,
    );
    expect(delegate).toHaveBeenCalledTimes(1);
    expect(resolver).toHaveBeenCalledWith("public.example");
    expect(resolver).toHaveBeenCalledWith("private.example");
  });

  it("strips caller Host/proxy auth and cross-origin credentials on redirects", async () => {
    const delegate = vi
      .fn()
      .mockResolvedValueOnce({
        status: 302,
        headers: {
          get: (name: string) =>
            name.toLowerCase() === "location"
              ? "https://other.example/next"
              : null,
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: { get: () => null },
      });

    const fetch = createRestrictedFetch(delegate as any, {
      resolver: publicResolver,
    });

    await fetch("https://public.example/start", {
      headers: {
        Host: "attacker.invalid",
        Authorization: "Bearer secret",
        Cookie: "sid=secret",
        "Proxy-Authorization": "Basic secret",
        "X-Trace": "kept",
      },
    } as any);

    expect(delegate).toHaveBeenCalledTimes(2);

    const firstHeaders = Object.fromEntries(
      Object.entries(delegate.mock.calls[0][1].headers).map(([key, value]) => [
        key.toLowerCase(),
        value,
      ]),
    );
    expect(firstHeaders.host).toBeUndefined();
    expect(firstHeaders["proxy-authorization"]).toBeUndefined();
    expect(firstHeaders.authorization).toBe("Bearer secret");
    expect(firstHeaders.cookie).toBe("sid=secret");

    const redirectedHeaders = Object.fromEntries(
      Object.entries(delegate.mock.calls[1][1].headers).map(([key, value]) => [
        key.toLowerCase(),
        value,
      ]),
    );
    expect(redirectedHeaders.host).toBeUndefined();
    expect(redirectedHeaders["proxy-authorization"]).toBeUndefined();
    expect(redirectedHeaders.authorization).toBeUndefined();
    expect(redirectedHeaders.cookie).toBeUndefined();
    expect(redirectedHeaders["x-trace"]).toBe("kept");
  });

  it("uses fetch-compatible POST redirect semantics without forwarding body metadata", async () => {
    const delegate = vi
      .fn()
      .mockResolvedValueOnce({
        status: 302,
        headers: {
          get: (name: string) =>
            name.toLowerCase() === "location" ? "/next" : null,
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: { get: () => null },
      });

    const fetch = createRestrictedFetch(delegate as any, {
      resolver: publicResolver,
    });

    await fetch("https://public.example/start", {
      method: "POST",
      body: "a=1",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": "3",
        "X-Trace": "kept",
      },
    } as any);

    expect(delegate).toHaveBeenCalledTimes(2);
    const redirectedInit = delegate.mock.calls[1][1];
    expect(redirectedInit.method).toBe("GET");
    expect(redirectedInit.body).toBeUndefined();

    const redirectedHeaders = Object.fromEntries(
      Object.entries(redirectedInit.headers).map(([key, value]) => [
        key.toLowerCase(),
        value,
      ]),
    );
    expect(redirectedHeaders["content-type"]).toBeUndefined();
    expect(redirectedHeaders["content-length"]).toBeUndefined();
    expect(redirectedHeaders["x-trace"]).toBe("kept");
  });

  it("pins the connection lookup to the validated DNS answer", async () => {
    let resolverCalls = 0;
    const resolver: RestrictedDnsResolver = async () => {
      resolverCalls += 1;
      return resolverCalls === 1
        ? [{ address: "93.184.216.34", family: 4 }]
        : [{ address: "127.0.0.1", family: 4 }];
    };

    const delegate = vi.fn(async (_url: URL, init: any) => {
      const lookupFn = init.agent.options.lookup;
      const pinned = await new Promise<{ address: string; family: number }>(
        (resolve, reject) => {
          lookupFn(
            "public.example",
            {},
            (error: Error | null, address: string, family: number) => {
              if (error) {
                reject(error);
              } else {
                resolve({ address, family });
              }
            },
          );
        },
      );
      expect(pinned).toEqual({ address: "93.184.216.34", family: 4 });
      return { status: 200, headers: { get: () => null } };
    });

    const fetch = createRestrictedFetch(delegate as any, { resolver });
    await fetch("https://public.example/resource");

    expect(resolverCalls).toBe(1);
    expect(delegate).toHaveBeenCalledTimes(1);
  });

  it("rejects hostname drift inside a pinned lookup", async () => {
    const lookupFn = createPinnedLookup({
      url: new URL("https://public.example/"),
      address: "93.184.216.34",
      family: 4,
    });

    await expect(
      new Promise((resolve, reject) => {
        lookupFn("different.example", {}, (error: Error | null) => {
          if (error) {
            reject(error);
          } else {
            resolve(undefined);
          }
        });
      }),
    ).rejects.toBeInstanceOf(SandboxViolationError);
  });
});

describe("sandbox environment", () => {
  it("drops secrets and loader injection variables and isolates HOME/TMP", () => {
    const workspace = path.join(os.tmpdir(), "sandbox-home");
    const privateTemp = path.join(os.tmpdir(), "sandbox-private-temp");
    const env = sanitizeSandboxEnvironment(
      {
        Path: process.env.PATH,
        LANG: "C",
        OPENAI_API_KEY: "secret",
        ANTHROPIC_API_KEY: "secret",
        GITHUB_TOKEN: "secret",
        GH_TOKEN: "secret",
        AWS_ACCESS_KEY_ID: "secret",
        AWS_SECRET_ACCESS_KEY: "secret",
        AWS_SESSION_TOKEN: "secret",
        AZURE_TOKEN: "secret",
        GOOGLE_APPLICATION_CREDENTIALS: "secret",
        NPM_TOKEN: "secret",
        PYPI_TOKEN: "secret",
        DOCKER_CONFIG: "secret",
        SSH_AUTH_SOCK: "secret",
        LD_PRELOAD: "inject",
        LD_LIBRARY_PATH: "inject",
        DYLD_INSERT_LIBRARIES: "inject",
        NODE_OPTIONS: "--require hostile.js",
        PYTHONPATH: "inject",
        RUBYOPT: "inject",
        PERL5OPT: "inject",
        BASH_ENV: "inject",
        ENV: "inject",
        PROMPT_COMMAND: "inject",
        TMPDIR: "/host/tmp",
        TEMP: "C:\\host-temp",
        STAMCONT_HOST_SECRET: "secret",
      },
      workspace,
      privateTemp,
    );

    expect(env.PATH).toBe(process.env.PATH);
    expect(env.LANG).toBe("C");
    expect(env.HOME).toBe(workspace);
    expect(env.USERPROFILE).toBe(workspace);
    expect(env.TMPDIR).toBe(privateTemp);
    expect(env.TEMP).toBe(privateTemp);
    expect(env.TMP).toBe(privateTemp);
    expect(env.STAMCONT_SANDBOX).toBe("1");

    for (const key of [
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "AZURE_TOKEN",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "NPM_TOKEN",
      "PYPI_TOKEN",
      "DOCKER_CONFIG",
      "SSH_AUTH_SOCK",
      "LD_PRELOAD",
      "LD_LIBRARY_PATH",
      "DYLD_INSERT_LIBRARIES",
      "NODE_OPTIONS",
      "PYTHONPATH",
      "RUBYOPT",
      "PERL5OPT",
      "BASH_ENV",
      "ENV",
      "PROMPT_COMMAND",
      "STAMCONT_HOST_SECRET",
    ]) {
      expect(env[key]).toBeUndefined();
    }
  });
});
