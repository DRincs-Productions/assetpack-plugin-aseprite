# Aseprite → PixiJS spritesheet plugin for AssetPack

`@drincs/assetpack-plugin-aseprite` is an AssetPack pipe that converts Aseprite and LibreSprite `.ase`/`.aseprite` files into PixiJS spritesheets during the asset build. It uses Node.js packages only; no Aseprite or LibreSprite CLI is required on the build machine.

## Install

```sh
npm install --save-dev @drincs/assetpack-plugin-aseprite @assetpack/core
```

Install the plugin and AssetPack as development dependencies. They run during the asset build, and the generated PNG and JSON files are deployed with the game.

## Configure AssetPack

```ts
import { aseprite } from "@drincs/assetpack-plugin-aseprite";
import { pixiPipes } from "@assetpack/core/pixi";

export default {
    entry: "public/assets",
    output: "public/assets-build",
    cache: true,
    cacheLocation: ".assetpack",
    pipes: [aseprite(), ...pixiPipes({ manifest: { createShortcuts: true, trimExtensions: true } })],
};
```

`aseprite()` must come before `pixiPipes()`.

Manifest aliases come from the source file name. AssetPack's `trimExtensions` removes `.ase` (`walk.ase` → `walk`) but not `.aseprite`, because it skips extensions longer than six characters: a `walk.aseprite` file is only reachable as `walk.aseprite`. Save files with the `.ase` extension (same format) to get aliases without the extension.

AssetPack caches source content hashes and reuses unchanged conversions across builds. Keep the `.assetpack` directory between runs, including in CI, to retain that cache. A source content change or a change to plugin options invalidates the relevant cache. Setting `cache: false` forces conversion again.

Each source file produces a PNG texture and a PixiJS spritesheet JSON with frame rectangles, frame durations, and named animations from Aseprite tags. The JSON also retains JSON-safe Aseprite data under `meta.aseprite` (document header, layers, tags including playback/repeat settings, slices, palette, color profile, and durations). This data is available to game code after loading the spritesheet. Tags with finite repeats preserve the repeat count as metadata; PixiJS animation definitions themselves do not enforce per-tag repeat counts.

Frames are named after the source file and the frame index (`walk_0`, `walk_1`, ...). PixiJS caches every spritesheet texture globally by frame name, so this keeps the frames of different files from overwriting each other. AssetPack tags in the file name are removed (`walk{m}.aseprite` still gives `walk_0`).

A file without tags gets one animation with every frame, named after the source file (for example `walk.aseprite` exposes `animations.walk`), so it can be played without listing frame names. When a file has two tags with the same name, only the first becomes an animation and the build prints a warning.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `layerPrefix` | none | Include only raster layers whose names start with this value. Parent group visibility and opacity still apply. |
| `maxTextureSize` | `4096` | Maximum texture width. Frames are placed left to right and wrap to a new row when the next frame would go past this width. The build warns when the texture is still larger, for example when one frame is wider than this value. |

Options can also be set for single files through AssetPack's `assetSettings`:

```ts
assetSettings: [{ files: ["**/hero.aseprite"], settings: { aseprite: { layerPrefix: "hero" } } }],
```

With `pixiPipes()`, the manifest entry of each source file points only to the spritesheet JSON files (one per compressed format, such as `.png.json` and `.webp.json`), like AssetPack's own texture packer output. Loading the alias gives a PixiJS `Spritesheet`, never the bare PNG strip.

The default output names replace the source extension, for example `walk.aseprite` becomes `walk.png` and `walk.json`. Use the generated JSON with PixiJS `Spritesheet` / `AnimatedSprite`; this package adds no runtime sprite component.

PixiJS resolves the named tag to textures, while each frame keeps its Aseprite duration in the `duration` field of its frame entry. Pass them to `AnimatedSprite` as timed frame objects when you need Aseprite timing:

```ts
const names = sheet.data.animations.walk;
const animation = new AnimatedSprite({
    textures: names.map((name) => ({
        texture: sheet.textures[name],
        time: sheet.data.frames[name].duration,
    })),
});
```

## Current limits

- Only 32-bit RGBA documents, normal blend mode, and regular pixel layers are rendered. Other color depths, blend modes, tilemaps, and non-zero cel z-index values fail with a descriptive error rather than rendering incorrectly.
- Aseprite groups and layer/cel visibility and opacity are applied during compositing, following the header flags that mark layer and group opacity as valid. Linked cels are supported. Reference layers are skipped, as in Aseprite's own export.
- Color profile information is preserved as metadata, but the pixel output is not color-managed.
- Frames are not trimmed or packed: every frame takes the full canvas size, and the texture must fit Sharp's 16383-pixel maximum dimension.
- Palette, slices, tags, and other parsed metadata are preserved, but user-data chunks and every editor-specific feature are not currently interpreted.

## Development

```sh
npm install
npm test
npm run build
```
