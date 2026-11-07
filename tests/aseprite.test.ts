import { join } from "node:path";
import { Asset, BuildReporter, PipeSystem } from "@assetpack/core";
import sharp from "sharp";
import { afterEach, describe, expect, test, vi } from "vitest";
import packageJson from "../package.json";
import { type AsepritePluginOptions, aseprite } from "../src";
import { buildAseprite, type FixtureOptions, makeAsepriteFixture } from "./fixtures/aseprite-file";

const RED: [number, number, number, number] = [255, 0, 0, 255];
const GREEN: [number, number, number, number] = [0, 255, 0, 255];
const BLUE: [number, number, number, number] = [0, 0, 255, 255];
const CLEAR = [0, 0, 0, 0];

afterEach(() => {
    vi.restoreAllMocks();
});

async function convert(
    buffer: Buffer,
    filename = "fixture.ase",
    options: AsepritePluginOptions = {},
    pipeOptionsOverride: AsepritePluginOptions = {},
) {
    const root = new Asset({ path: process.cwd(), isFolder: true });
    const input = new Asset({ path: join(process.cwd(), filename) });
    root.addChild(input);
    input.buffer = buffer;
    const outputPath = join(process.cwd(), ".tmp-aseprite-test");
    const pipe = aseprite(options);
    const pipeSystem = new PipeSystem({ pipes: [pipe], outputPath, entryPath: process.cwd() });
    if (!pipe.transform) throw new Error("Aseprite pipe is missing its transform method.");
    const [image, json] = await pipe.transform(
        input,
        { ...pipe.defaultOptions, ...pipeOptionsOverride },
        pipeSystem,
    );
    const { data, info } = await sharp(image.buffer).raw().toBuffer({ resolveWithObject: true });
    const pixel = (x: number, y = 0) => [
        ...data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4),
    ];
    return { image, json, data: JSON.parse(json.buffer.toString()), info, pixel };
}

/** A 1x1 document with one frame per color, on one image layer. */
function colorFrames(
    colors: [number, number, number, number][],
    extra: Partial<FixtureOptions> = {},
) {
    return buildAseprite({
        width: 1,
        height: 1,
        layers: [{ name: "layer" }],
        frames: colors.map((color) => ({ duration: 100, cels: [{ layer: 0, pixels: [color] }] })),
        ...extra,
    });
}

describe("spritesheet output", () => {
    test("converts frames, tags, durations, pixels, and source metadata to AssetPack assets", async () => {
        const { image, json, data: metadata, pixel } = await convert(makeAsepriteFixture());

        expect(image.filename).toBe("fixture.png");
        expect(json.filename).toBe("fixture.json");
        expect(metadata.frames.fixture_0.duration).toBe(80);
        expect(metadata.frames.fixture_1.duration).toBe(120);
        expect(metadata.animations.walk).toEqual([
            "fixture_0",
            "fixture_1",
            "fixture_2",
            "fixture_1",
        ]);
        expect(metadata.meta.aseprite.tags[0]).toMatchObject({
            name: "walk",
            animDirection: "Ping-pong",
        });
        expect(metadata.meta.aseprite.layers[0].name).toBe("body");
        expect(metadata.meta.aseprite.layers[1].flags.visible).toBe(false);
        expect(metadata.meta.aseprite.slices).toEqual([]);
        expect(metadata.meta.aseprite.frames[1].cels[0]).toMatchObject({
            x: 1,
            y: 0,
            opacity: 255,
            width: 1,
            height: 1,
        });

        expect(pixel(0)).toEqual(RED);
        expect(pixel(1)).toEqual(CLEAR);
        expect(pixel(3)).toEqual(GREEN);
        expect(pixel(4)).toEqual(BLUE);
        expect(image.metaData.nomip).toBe(true);
        expect(image.metaData.mIgnore).toBe(true);
        expect(json.metaData.tps).toBe(true);
    });

    test("writes the PixiJS spritesheet meta fields", async () => {
        const { data } = await convert(colorFrames([RED, GREEN]));
        expect(data.meta).toMatchObject({
            app: "@drincs/assetpack-plugin-aseprite",
            version: packageJson.version,
            image: "fixture.png",
            format: "RGBA8888",
            size: { w: 2, h: 1 },
            related_multi_packs: [],
        });
        expect(data.frames.fixture_1).toMatchObject({
            frame: { x: 1, y: 0, w: 1, h: 1 },
            rotated: false,
            trimmed: false,
            spriteSourceSize: { x: 0, y: 0, w: 1, h: 1 },
            sourceSize: { w: 1, h: 1 },
        });
    });

    test("adds an animation with every frame, named after the file, when there are no tags", async () => {
        const { data } = await convert(
            makeAsepriteFixture({ withTags: false }),
            "untagged.aseprite",
        );
        expect(data.animations).toEqual({ untagged: ["untagged_0", "untagged_1", "untagged_2"] });
        expect(Object.keys(data.frames)).toEqual(["untagged_0", "untagged_1", "untagged_2"]);
        expect(data.meta.aseprite.tags).toEqual([]);
    });

    test("strips AssetPack tags from the animation and frame names", async () => {
        const { image, data } = await convert(colorFrames([RED, GREEN]), "smoke{m}.aseprite");
        expect(image.filename).toBe("smoke{m}.png");
        expect(data.animations).toEqual({ smoke: ["smoke_0", "smoke_1"] });
    });
});

describe("tags", () => {
    test("expands every playback direction and keeps the repeat count as metadata", async () => {
        const { data } = await convert(
            colorFrames([RED, GREEN, BLUE], {
                tags: [
                    { name: "forward", from: 0, to: 2, direction: 0, repeat: 3 },
                    { name: "reverse", from: 0, to: 2, direction: 1 },
                    { name: "pingpong", from: 0, to: 2, direction: 2 },
                    { name: "pingpong-reverse", from: 0, to: 2, direction: 3 },
                    { name: "single", from: 1, to: 1, direction: 2 },
                ],
            }),
        );
        expect(data.animations).toEqual({
            forward: ["fixture_0", "fixture_1", "fixture_2"],
            reverse: ["fixture_2", "fixture_1", "fixture_0"],
            pingpong: ["fixture_0", "fixture_1", "fixture_2", "fixture_1"],
            "pingpong-reverse": ["fixture_2", "fixture_1", "fixture_0", "fixture_1"],
            single: ["fixture_1"],
        });
        expect(data.meta.aseprite.tags[0]).toMatchObject({ name: "forward", repeat: 3 });
    });

    test("does not add the file-name animation when the file has tags", async () => {
        const { data } = await convert(
            colorFrames([RED, GREEN], { tags: [{ name: "idle", from: 0, to: 0 }] }),
        );
        expect(Object.keys(data.animations)).toEqual(["idle"]);
    });

    test("keeps the first of two tags with the same name and warns", async () => {
        const warn = vi.spyOn(BuildReporter, "warn").mockImplementation(() => {});
        const { data } = await convert(
            colorFrames([RED, GREEN], {
                tags: [
                    { name: "idle", from: 0, to: 0 },
                    { name: "idle", from: 1, to: 1 },
                ],
            }),
        );
        expect(data.animations.idle).toEqual(["fixture_0"]);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('Duplicate tag "idle"'));
    });

    test("rejects a tag outside the frame range", async () => {
        await expect(
            convert(colorFrames([RED], { tags: [{ name: "broken", from: 0, to: 3 }] })),
        ).rejects.toThrow('Invalid frame range for Aseprite tag "broken"');
    });
});

describe("compositing", () => {
    test("renders linked cels with the linked pixels", async () => {
        const { pixel, data } = await convert(
            buildAseprite({
                width: 2,
                height: 1,
                layers: [{ name: "layer" }],
                frames: [
                    { duration: 100, cels: [{ layer: 0, pixels: [RED] }] },
                    { duration: 100, cels: [{ layer: 0, x: 1, linkedFrame: 0 }] },
                ],
            }),
        );
        expect(data.meta.aseprite.frames[1].cels[0]).toMatchObject({ type: 1, link: 0 });
        expect(pixel(0)).toEqual(RED);
        expect(pixel(2)).toEqual(CLEAR);
        expect(pixel(3)).toEqual(RED);
    });

    test("skips reference layers", async () => {
        const { pixel } = await convert(
            buildAseprite({
                width: 1,
                height: 1,
                layers: [{ name: "art" }, { name: "reference", reference: true }],
                frames: [
                    {
                        duration: 100,
                        cels: [
                            { layer: 0, pixels: [RED] },
                            { layer: 1, pixels: [BLUE] },
                        ],
                    },
                ],
            }),
        );
        expect(pixel(0)).toEqual(RED);
    });

    test("applies layer and cel opacity only when the header marks layer opacity as valid", async () => {
        const file = (headerFlags: number) =>
            buildAseprite({
                width: 2,
                height: 1,
                headerFlags,
                layers: [{ name: "half", opacity: 128 }],
                frames: [
                    {
                        duration: 100,
                        cels: [
                            { layer: 0, pixels: [RED] },
                            { layer: 0, x: 1, opacity: 128, pixels: [RED] },
                        ],
                    },
                ],
            });
        const valid = await convert(file(1));
        expect(valid.pixel(0)).toEqual([255, 0, 0, 128]);
        expect(valid.pixel(1)).toEqual([255, 0, 0, 64]);
        const legacy = await convert(file(0));
        expect(legacy.pixel(0)).toEqual(RED);
        expect(legacy.pixel(1)).toEqual([255, 0, 0, 128]);
    });

    test("applies group opacity and blend mode only when the header marks them as valid", async () => {
        const file = (headerFlags: number) =>
            buildAseprite({
                width: 1,
                height: 1,
                headerFlags,
                layers: [
                    { name: "group", type: 1, opacity: 128, blendMode: 1 },
                    { name: "child", childLevel: 1 },
                ],
                frames: [{ duration: 100, cels: [{ layer: 1, pixels: [GREEN] }] }],
            });
        await expect(convert(file(3))).rejects.toThrow('Unsupported blend mode 1 in group "group"');
        const legacy = await convert(file(1));
        expect(legacy.pixel(0)).toEqual(GREEN);
    });

    test("blends layers in order and clips cels outside the canvas", async () => {
        const { pixel } = await convert(
            buildAseprite({
                width: 2,
                height: 1,
                layers: [{ name: "bottom" }, { name: "top" }],
                frames: [
                    {
                        duration: 100,
                        cels: [
                            { layer: 0, width: 2, height: 1, pixels: [RED, RED] },
                            {
                                layer: 1,
                                x: -1,
                                width: 2,
                                height: 1,
                                pixels: [BLUE, [0, 0, 255, 128]],
                            },
                        ],
                    },
                ],
            }),
        );
        expect(pixel(0)).toEqual([127, 0, 128, 255]);
        expect(pixel(1)).toEqual(RED);
    });

    test("includes only layers that match layerPrefix", async () => {
        const file = buildAseprite({
            width: 1,
            height: 1,
            layers: [{ name: "hero-body" }, { name: "shadow" }],
            frames: [
                {
                    duration: 100,
                    cels: [
                        { layer: 0, pixels: [RED] },
                        { layer: 1, pixels: [BLUE] },
                    ],
                },
            ],
        });
        expect((await convert(file)).pixel(0)).toEqual(BLUE);
        expect((await convert(file, "fixture.ase", { layerPrefix: "hero" })).pixel(0)).toEqual(RED);
    });

    test("uses the options AssetPack passes to transform (per-asset settings)", async () => {
        const file = buildAseprite({
            width: 1,
            height: 1,
            layers: [{ name: "hero-body" }, { name: "shadow" }],
            frames: [
                {
                    duration: 100,
                    cels: [
                        { layer: 0, pixels: [RED] },
                        { layer: 1, pixels: [BLUE] },
                    ],
                },
            ],
        });
        const { pixel } = await convert(file, "fixture.ase", {}, { layerPrefix: "hero" });
        expect(pixel(0)).toEqual(RED);
    });
});

describe("texture layout", () => {
    test("keeps a single row while it fits in maxTextureSize", async () => {
        const { info, data } = await convert(colorFrames([RED, GREEN, BLUE]));
        expect([info.width, info.height]).toEqual([3, 1]);
        expect(data.meta.size).toEqual({ w: 3, h: 1 });
    });

    test("wraps frames into rows when a single row would exceed maxTextureSize", async () => {
        const { info, data, pixel } = await convert(
            colorFrames([RED, GREEN, BLUE, RED, GREEN]),
            "fixture.ase",
            { maxTextureSize: 2 },
        );
        expect([info.width, info.height]).toEqual([2, 3]);
        expect(data.meta.size).toEqual({ w: 2, h: 3 });
        expect(data.frames.fixture_2.frame).toEqual({ x: 0, y: 1, w: 1, h: 1 });
        expect(data.frames.fixture_4.frame).toEqual({ x: 0, y: 2, w: 1, h: 1 });
        expect(pixel(0, 0)).toEqual(RED);
        expect(pixel(1, 0)).toEqual(GREEN);
        expect(pixel(0, 1)).toEqual(BLUE);
        expect(pixel(1, 1)).toEqual(RED);
        expect(pixel(0, 2)).toEqual(GREEN);
        expect(pixel(1, 2)).toEqual(CLEAR);
    });

    test("warns when a single frame is larger than maxTextureSize", async () => {
        const warn = vi.spyOn(BuildReporter, "warn").mockImplementation(() => {});
        const { info } = await convert(
            buildAseprite({
                width: 5,
                height: 1,
                layers: [{ name: "layer" }],
                frames: [{ duration: 100, cels: [] }],
            }),
            "wide.ase",
            { maxTextureSize: 4 },
        );
        expect(info.width).toBe(5);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("larger than maxTextureSize 4"));
    });

    test("rejects textures larger than Sharp's dimension limit", async () => {
        vi.spyOn(BuildReporter, "warn").mockImplementation(() => {});
        await expect(
            convert(
                buildAseprite({
                    width: 16384,
                    height: 1,
                    layers: [{ name: "layer" }],
                    frames: [{ duration: 100, cels: [] }],
                }),
            ),
        ).rejects.toThrow("exceeds Sharp's 16383-pixel dimension limit");
    });
});

describe("unsupported input", () => {
    test("rejects documents that are not 32-bit RGBA", async () => {
        await expect(
            convert(
                buildAseprite({
                    width: 1,
                    height: 1,
                    colorDepth: 8,
                    layers: [],
                    frames: [{ duration: 100, cels: [] }],
                }),
            ),
        ).rejects.toThrow("supports 32-bit RGBA documents; fixture.ase is 8-bit");
    });

    test("rejects layer blend modes other than normal", async () => {
        await expect(
            convert(
                buildAseprite({
                    width: 1,
                    height: 1,
                    layers: [{ name: "multiply", blendMode: 1 }],
                    frames: [{ duration: 100, cels: [] }],
                }),
            ),
        ).rejects.toThrow('Unsupported blend mode 1 in layer "multiply"');
    });

    test("rejects tilemap layers", async () => {
        await expect(
            convert(
                buildAseprite({
                    width: 1,
                    height: 1,
                    layers: [{ name: "tiles", type: 2 }],
                    frames: [{ duration: 100, cels: [] }],
                }),
            ),
        ).rejects.toThrow('Unsupported Aseprite layer type 2 in layer "tiles"');
    });

    test("rejects cels with a z-index", async () => {
        await expect(
            convert(
                buildAseprite({
                    width: 1,
                    height: 1,
                    layers: [{ name: "layer" }],
                    frames: [{ duration: 100, cels: [{ layer: 0, zIndex: 1, pixels: [RED] }] }],
                }),
            ),
        ).rejects.toThrow('Aseprite cel z-index 1 is not supported (layer "layer")');
    });

    test("ignores unsupported layers that are hidden", async () => {
        const { pixel } = await convert(
            buildAseprite({
                width: 1,
                height: 1,
                layers: [{ name: "art" }, { name: "multiply", blendMode: 1, visible: false }],
                frames: [{ duration: 100, cels: [{ layer: 0, pixels: [RED] }] }],
            }),
        );
        expect(pixel(0)).toEqual(RED);
    });
});

test("does not match unrelated asset extensions", () => {
    const pipe = aseprite();
    expect(pipe.test?.(new Asset({ path: "sprite.png" }), {})).toBe(false);
    expect(pipe.test?.(new Asset({ path: "sprite.aseprite" }), {})).toBe(true);
    expect(pipe.test?.(new Asset({ path: "sprite.ASE" }), {})).toBe(true);
    expect(pipe.test?.(new Asset({ path: "sprites.ase", isFolder: true }), {})).toBe(false);
});
