# StamCont Security Policy

## Reporting a vulnerability

Please **do not disclose an unpatched vulnerability in a public issue**.

Use GitHub's private vulnerability-reporting / security-advisory flow for this repository when it is available from the **Security** tab.

If private reporting is not available, open a minimal public issue stating that you need a private security contact. Do **not** include exploit details, credentials, sensitive logs, or reproduction material in that public issue.

A useful private report should include:

- a clear description of the vulnerability;
- affected component(s) and revision/commit;
- steps or a minimal proof of concept to reproduce it;
- your assessment of impact;
- relevant platform/environment information;
- any mitigation or remediation ideas you have.

Please allow reasonable time for investigation and remediation before public disclosure.

## StamCont security boundary

StamCont contains security-sensitive agent execution code, including capability checks, sandbox/host execution backends, durable tool state, restricted networking, cancellation, and nested-session authority.

The implementation-level security model and known limits are documented in:

- [StamCont Agent Kernel](docs/STAMCONT_AGENT_KERNEL.md)
- [StamCont Agent Runtime](docs/STAMCONT_AGENT_RUNTIME.md)

The repository-level security CI gate is:

- `StamCont Execution Security` — `.github/workflows/stamcont-execution-security.yml`

## Upstream issues

This repository originated from Continue and still contains inherited compatibility code. Vulnerabilities in **StamCont** should be reported here, not to `security@continue.dev`, unless the issue is independently confirmed to affect the upstream Continue project as well.
