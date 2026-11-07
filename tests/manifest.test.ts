import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AssetPack, type AssetPackConfig } from "@assetpack/core";
import { pixiPipes } from "@assetpack/core/pixi";
import sharp from "sharp";
import { afterEach, expect, test } from "vitest";
import { aseprite, asepriteManifestMod } from "../src";
import { buildAseprite } from "./fixtures/aseprite-file";

const PIXEL_FIRE = join(import.meta.dirname, "fixtures", "pixel-fire.aseprite");
const temporaryDirectories: string[] = [];

interface ManifestAsset {
    alias: string[];
    src: string[];
}

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { force: true, recursive: true })),
    );
});

/** Copies or writes the given files into a temporary entry folder and runs AssetPack with pixiPipes. */
async function build(
    files: Record<string, string | Buffer>,
    {
        manifestMod = true,
        manifestOutput,
        assetSettings,
    }: {
        manifestMod?: boolean;
        manifestOutput?: string;
        assetSettings?: AssetPackConfig["assetSettings"];
    } = {},
) {
    const root = await mkdtemp(join(tmpdir(), "aseprite-manifest-"));
    temporaryDirectories.push(root);
    const entry = join(root, "input");
    const output = join(root, "output");
    for (const [path, source] of Object.entries(files)) {
        const target = join(entry, path);
        await mkdir(dirname(target), { recursive: true });
        if (typeof source === "string") await copyFile(source, target);
        else await writeFile(target, source);
    }
    const manifestPath = manifestOutput ?? join(root, "manifest.json");
    await new AssetPack({
        entry,
        output,
        cache: false,
        assetSettings,
        pipes: [
            aseprite(),
            ...pixiPipes({
                manifest: { output: manifestPath, createShortcuts: true, trimExtensions: true },
            }),
            ...(manifestMod ? [asepriteManifestMod({ output: manifestPath })] : []),
        ],
    }).run();

    const manifestFile = manifestOutput ? join(output, manifestOutput) : manifestPath;
    const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
    const assets: ManifestAsset[] = manifest.bundles.flatMap(
        (bundle: { assets: ManifestAsset[] }) => bundle.assets,
    );
    const find = (alias: string) => {
        const asset = assets.find((item) => item.alias.includes(alias));
        if (!asset) throw new Error(`No manifest entry with alias ${alias}.`);
        return asset;
    };
    const readJson = async (src: string) => JSON.parse(await readFile(join(output, src), "utf8"));
    return { root, output, assets, find, readJson };
}

test("lists only the spritesheet JSON files for a real Aseprite file in the PixiJS manifest", async () => {
    const { output, assets, readJson } = await build({
        "animated-sprite/pixel-fire.aseprite": PIXEL_FIRE,
    });

    expect(assets).toHaveLength(1);
    expect(assets[0].alias).toEqual([
        "animated-sprite/pixel-fire.aseprite",
        "pixel-fire.aseprite",
        "animated-sprite/pixel-fire",
        "pixel-fire",
    ]);
    expect(assets[0].src).toHaveLength(2);
    expect(assets[0].src.map((src) => src.match(/\.(png|webp)\.json$/)?.[1]).sort()).toEqual([
        "png",
        "webp",
    ]);

    const outputFiles = await readdir(join(output, "animated-sprite"));
    for (const src of assets[0].src) {
        const json = await readJson(src);
        expect(outputFiles).toContain(src.split("/").pop());
        expect(outputFiles).toContain(json.meta.image);
        expect(json.meta.image.endsWith(src.endsWith(".webp.json") ? ".webp" : ".png")).toBe(true);
        expect(Object.keys(json.frames)).toHaveLength(14);
        expect(json.animations["pixel-fire"]).toEqual(
            Array.from({ length: 14 }, (_, index) => `pixel-fire_${index}`),
        );

        const image = await sharp(join(output, "animated-sprite", json.meta.image)).metadata();
        expect([image.width, image.height]).toEqual([json.meta.size.w, json.meta.size.h]);
    }
});

test("keeps the real file's pixels and frame durations", async () => {
    const { find, output, readJson } = await build({ "pixel-fire.aseprite": PIXEL_FIRE });
    const src = find("pixel-fire").src.find((item) => item.endsWith(".png.json"));
    if (!src) throw new Error("Missing PNG spritesheet.");
    const json = await readJson(src);
    expect(json.meta.aseprite).toMatchObject({ frameCount: 14, colorDepth: 32 });
    for (const [index, frame] of json.meta.aseprite.frames.entries()) {
        expect(json.frames[`pixel-fire_${index}`].duration).toBe(frame.duration);
    }
    const { data, info } = await sharp(join(output, json.meta.image))
        .raw()
        .toBuffer({ resolveWithObject: true });
    expect(info.channels).toBe(4);
    let opaquePixels = 0;
    for (let offset = 3; offset < data.length; offset += 4) if (data[offset] > 0) opaquePixels++;
    expect(opaquePixels).toBeGreaterThan(0);
});

test("gives each Aseprite file its own frame names so PixiJS cache keys do not clash", async () => {
    const { assets, find, readJson } = await build({
        "effects/fire.aseprite": PIXEL_FIRE,
        "effects/smoke.aseprite": PIXEL_FIRE,
    });
    expect(assets).toHaveLength(2);
    const fire = await readJson(find("fire").src[0]);
    const smoke = await readJson(find("smoke").src[0]);
    const fireFrames = new Set(Object.keys(fire.frames));
    expect(Object.keys(smoke.frames).some((name) => fireFrames.has(name))).toBe(false);
    expect(Object.keys(fire.animations)).toEqual(["fire"]);
    expect(Object.keys(smoke.animations)).toEqual(["smoke"]);
});

test("applies per-asset settings from assetSettings", async () => {
    const file = buildAseprite({
        width: 1,
        height: 1,
        layers: [{ name: "hero-body" }, { name: "shadow" }],
        frames: [
            {
                duration: 100,
                cels: [
                    { layer: 0, pixels: [[255, 0, 0, 255]] },
                    { layer: 1, pixels: [[0, 0, 255, 255]] },
                ],
            },
        ],
    });
    const { find, output, readJson } = await build(
        { "hero.aseprite": file, "other.aseprite": file },
        {
            assetSettings: [
                { files: ["**/hero.aseprite"], settings: { aseprite: { layerPrefix: "hero" } } },
            ],
        },
    );
    const firstPixel = async (alias: string) => {
        const src = find(alias).src.find((item) => item.endsWith(".png.json"));
        if (!src) throw new Error("Missing PNG spritesheet.");
        const json = await readJson(src);
        // AssetPack re-encodes fully opaque PNGs without an alpha channel.
        const { data } = await sharp(join(output, json.meta.image))
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });
        return [...data.subarray(0, 4)];
    };
    expect(await firstPixel("hero")).toEqual([255, 0, 0, 255]);
    expect(await firstPixel("other")).toEqual([0, 0, 255, 255]);
});

test("without asepriteManifestMod, the .aseprite alias keeps its extension", async () => {
    const { assets } = await build({ "pixel-fire.aseprite": PIXEL_FIRE }, { manifestMod: false });
    expect(assets[0].alias).toEqual(["pixel-fire.aseprite"]);
});

test("asepriteManifestMod does not add an alias that another asset already uses", async () => {
    const png = await sharp({
        create: { width: 1, height: 1, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } },
    })
        .png()
        .toBuffer();
    const { find } = await build({ "fire.aseprite": PIXEL_FIRE, "fire.png": png });
    expect(find("fire.png").alias).toContain("fire");
    expect(find("fire.aseprite").alias).not.toContain("fire");
});

test("asepriteManifestMod handles upper-case .ASE files", async () => {
    const { assets } = await build({ "Hero.ASE": PIXEL_FIRE });
    expect(assets[0].alias).toContain("Hero");
    expect(new Set(assets[0].alias).size).toBe(assets[0].alias.length);
});

test("asepriteManifestMod resolves a bare manifest file name inside the output folder", async () => {
    const { assets } = await build(
        { "pixel-fire.aseprite": PIXEL_FIRE },
        { manifestOutput: "manifest.json" },
    );
    expect(assets[0].alias).toContain("pixel-fire");
});
