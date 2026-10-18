# StamCont documentation

This directory contains StamCont's user guides and runtime/reference documentation. It includes inherited Continue-compatible material; upstream package names, settings IDs, and service links on legacy pages must not be interpreted as StamCont-owned distribution or services.

## Start here

- [Project overview](../README.md) — what StamCont implements and how to build the CLI.
- [CLI quickstart](cli/quickstart.mdx) — standalone artifact or source installation.
- [IDE package installation](ide-extensions/install.mdx) — VS Code and JetBrains release artifacts.
- [Agent Runtime](STAMCONT_AGENT_RUNTIME.md) — durable event model, replay and resume.
- [Agent Kernel](STAMCONT_AGENT_KERNEL.md) — authority and sandbox boundaries.
- [Upstream provenance](../UPSTREAM.md) — imported Continue baseline and attribution.

## Preview or build the documentation site

The repository's documentation website is implemented in `docs-site/` (Next.js) and reads this directory's `docs.json` navigation plus its MDX pages.

Use **Node.js 20.20.1** (see `../.nvmrc`), then:

```bash
cd docs-site
npm ci
npm run dev
```

From the same directory, `npm run build` performs a static documentation build; the GitHub Pages workflow is manual and separate from a local build. Building or previewing documentation does **not** publish a release.

## Documentation ownership

New StamCont-specific pages should describe behavior implemented in this repository. When adjusting inherited pages, preserve accurate references to original Continue APIs and authors, but distinguish legacy compatibility workflows from supported StamCont installation paths. Avoid linking to the upstream Continue marketplace or npm packages as if they were StamCont releases.
