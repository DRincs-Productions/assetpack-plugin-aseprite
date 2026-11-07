import { AssetPack } from "@assetpack/core";
import { pixiPipes } from "@assetpack/core/pixi";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { aseprite, asepriteManifestMod } from "../src";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { force: true, recursive: true })),
    );
});

test("lists only the spritesheet JSON files for a real Aseprite file in the PixiJS manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "aseprite-manifest-"));
    temporaryDirectories.push(root);
    const entry = join(root, "input");
    const output = join(root, "output");
    const manifestPath = join(root, "manifest.json");
    await mkdir(join(entry, "animated-sprite"), { recursive: true });
    await copyFile(
        join(import.meta.dirname, "fixtures", "pixel-fire.aseprite"),
        join(entry, "animated-sprite", "pixel-fire.aseprite"),
    );

    await new AssetPack({
        entry,
        output,
        cache: false,
        pipes: [
            aseprite(),
            ...pixiPipes({
                manifest: { output: manifestPath, createShortcuts: true, trimExtensions: true },
            }),
            asepriteManifestMod({ output: manifestPath }),
        ],
    }).run();

    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const assets = manifest.bundles.flatMap((bundle: { assets: unknown[] }) => bundle.assets);
    expect(assets).toHaveLength(1);
    expect(assets[0].alias).toEqual([
        "animated-sprite/pixel-fire.aseprite",
        "pixel-fire.aseprite",
        "animated-sprite/pixel-fire",
        "pixel-fire",
    ]);
    expect(assets[0].src).toHaveLength(2);
    for (const src of assets[0].src) expect(src).toMatch(/\.(png|webp)\.json$/);

    const outputFiles = await readdir(join(output, "animated-sprite"));
    for (const src of assets[0].src) {
        const fileName = src.split("/").pop();
        expect(outputFiles).toContain(fileName);
        const json = JSON.parse(await readFile(join(output, src), "utf8"));
        expect(outputFiles).toContain(json.meta.image);
        expect(Object.keys(json.frames)).toHaveLength(14);
        expect(json.animations["pixel-fire"]).toEqual(
            Array.from({ length: 14 }, (_, index) => `frame${index}`),
        );
    }
});
