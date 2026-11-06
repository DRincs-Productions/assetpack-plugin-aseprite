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
    pipes: [aseprite(), ...pixiPipes()],
};
```

AssetPack caches source content hashes and reuses unchanged conversions across builds. Keep the `.assetpack` directory between runs, including in CI, to retain that cache. A source content change or a change to plugin options invalidates the relevant cache. Setting `cache: false` forces conversion again.

Each source file produces a horizontal PNG strip and a PixiJS spritesheet JSON with frame rectangles, frame durations, and named animations from Aseprite tags. The JSON also retains JSON-safe Aseprite data under `meta.aseprite` (document header, layers, tags including playback/repeat settings, slices, palette, color profile, and durations). This data is available to game code after loading the spritesheet. Tags with finite repeats preserve the repeat count as metadata; PixiJS animation definitions themselves do not enforce per-tag repeat counts.

The default output names replace the source extension, for example `walk.aseprite` becomes `walk.png` and `walk.json`. Use the generated JSON with PixiJS `Spritesheet` / `AnimatedSprite`; this package adds no runtime sprite component.

PixiJS resolves the named tag to textures, while the frame-specific durations stay in `meta.aseprite`. Pass them to `AnimatedSprite` as timed frame objects when you need Aseprite timing:

```ts
const names = sheet.data.animations.walk;
const animation = new AnimatedSprite({
    textures: names.map((name) => ({
        texture: sheet.textures[name],
        time: sheet.data.meta.aseprite.frames[Number(name.slice(5))].duration,
    })),
});
```

## Current limits

- Only 32-bit RGBA documents, normal blend mode, and regular pixel layers are rendered. Other color depths, blend modes, tilemaps, and non-zero cel z-index values fail with a descriptive error rather than rendering incorrectly.
- Aseprite groups and layer/cel visibility and opacity are applied during compositing. `layerPrefix` can be passed to `aseprite({ layerPrefix: "character" })` to include only raster layers whose names start with that value; parent group visibility and opacity still apply.
- Color profile information is preserved as metadata, but the pixel output is not color-managed.
- Output is a single horizontal strip and must fit Sharp's 16383-pixel maximum dimension.
- Palette, slices, tags, and other parsed metadata are preserved, but user-data chunks and every editor-specific feature are not currently interpreted.

## Development

```sh
npm install
npm test
npm run build
```
