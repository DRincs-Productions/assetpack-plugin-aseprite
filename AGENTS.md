# Developing the Aseprite AssetPack plugin

This repository converts Aseprite and LibreSprite source files into PixiJS spritesheets through
PixiJS AssetPack. It has no Pixi'VN runtime component. Keep changes focused on build-time asset
conversion and export public APIs from `src/index.ts`.

## Tests

Use Vitest for conversion behavior that can be observed without a browser. Tests belong in `tests/`
and should cover generated PNG pixels, spritesheet JSON, and preserved Aseprite metadata. Prefer
small synthetic fixtures; use a real Aseprite/LibreSprite file when a parser behavior cannot be
represented by a synthetic fixture. Run the suite with:

```bash
npm test
```

The project also provides `npm run build`, `npm run lint`, and `npm run check` for build and code
quality checks.

## Project skills

As the project develops, add a root `skills/` directory with project-specific `SKILL.md` files that
explain the plugin's public APIs and common development workflows in clear, actionable language for
AI coding agents. Create or update a skill when a feature introduces non-obvious usage, conventions,
or setup steps that an agent would need in another project. Keep skills specific to this plugin,
accurate to the current source, and written in English. This directory is optional; the skill
validation workflow skips its checks until at least one `skills/<name>/SKILL.md` exists.

Validate the skill files before release with:

```bash
npm run skills:validate
```

Each skill should live in its own `skills/<name>/SKILL.md` directory and include the required
frontmatter described by `scripts/validate-skills.mjs`.
