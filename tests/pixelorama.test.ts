import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Asset, PipeSystem } from "@assetpack/core";
import { unzipSync } from "fflate";
import sharp from "sharp";
import { describe, expect, test } from "vitest";
import { type AsepritePluginOptions, aseprite } from "../src";
import {
    buildPixelorama,
    editPixelorama,
    type PxoFixtureOptions,
} from "./fixtures/pixelorama-file";

const RED: [number, number, number, number] = [255, 0, 0, 255];
const GREEN: [number, number, number, number] = [0, 255, 0, 255];
const BLUE: [number, number, number, number] = [0, 0, 255, 255];
const CLEAR = [0, 0, 0, 0];
const FIXTURES = join(import.meta.dirname, "fixtures", "pixelorama");
const readFixture = (name: string) => readFileSync(join(FIXTURES, name));

async function convert(
    buffer: Buffer,
    filename = "fixture.pxo",
    options: AsepritePluginOptions = {},
) {
    const root = new Asset({ path: process.cwd(), isFolder: true });
    const input = new Asset({ path: join(process.cwd(), filename) });
    root.addChild(input);
    input.buffer = buffer;
    const outputPath = join(process.cwd(), ".tmp-pixelorama-test");
    const pipe = aseprite(options);
    const pipeSystem = new PipeSystem({ pipes: [pipe], outputPath, entryPath: process.cwd() });
    if (!pipe.transform) throw new Error("Aseprite pipe is missing its transform method.");
    const [image, json] = await pipe.transform(input, pipe.defaultOptions, pipeSystem);
    const { data, info } = await sharp(image.buffer).raw().toBuffer({ resolveWithObject: true });
    const pixel = (x: number, y = 0) => [
        ...data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4),
    ];
    return { image, json, data: JSON.parse(json.buffer.toString()), info, pixel };
}

/** A 1x1 project with one pixel layer and one frame per color. */
function colorFrames(
    colors: [number, number, number, number][],
    extra: Partial<PxoFixtureOptions> = {},
) {
    return buildPixelorama({
        width: 1,
        height: 1,
        layers: [{ name: "layer" }],
        frames: colors.map((color) => ({ cels: [{ pixels: [color] }] })),
        ...extra,
    });
}

describe("pipe", () => {
    test("matches .pxo files", () => {
        const pipe = aseprite();
        expect(pipe.test?.(new Asset({ path: "hero.pxo" }), {})).toBe(true);
        expect(pipe.test?.(new Asset({ path: "hero.PXO" }), {})).toBe(true);
    });

    test("names the outputs, frames, and default animation after the file", async () => {
        const { image, json, data } = await convert(colorFrames([RED, GREEN]), "hero{m}.pxo");
        expect(image.filename).toBe("hero{m}.png");
        expect(json.filename).toBe("hero{m}.json");
        expect(data.animations).toEqual({ hero: ["hero_0", "hero_1"] });
        expect(data.meta).toMatchObject({ image: "hero{m}.png", size: { w: 2, h: 1 } });
        expect(image.metaData.mIgnore).toBe(true);
        expect(json.metaData.tps).toBe(true);
    });
});

describe("frames and tags", () => {
    test("converts relative frame durations to milliseconds with the project fps", async () => {
        const { data } = await convert(
            buildPixelorama({
                width: 1,
                height: 1,
                fps: 10,
                layers: [{ name: "layer" }],
                frames: [
                    { duration: 1, cels: [{ pixels: [RED] }] },
                    { duration: 2.5, cels: [{ pixels: [GREEN] }] },
                ],
            }),
        );
        expect(data.frames.fixture_0.duration).toBe(100);
        expect(data.frames.fixture_1.duration).toBe(250);
        expect(
            data.meta.pixelorama.frames.map((frame: { duration: number }) => frame.duration),
        ).toEqual([100, 250]);
    });

    test("turns 1-based Pixelorama tags into animations", async () => {
        const { data } = await convert(
            colorFrames([RED, GREEN, BLUE], {
                tags: [
                    { name: "idle", from: 1, to: 1 },
                    { name: "walk", from: 2, to: 3 },
                ],
            }),
        );
        expect(data.animations).toEqual({
            idle: ["fixture_0"],
            walk: ["fixture_1", "fixture_2"],
        });
        expect(data.meta.pixelorama.tags).toMatchObject([
            { name: "idle", from: 0, to: 0 },
            { name: "walk", from: 1, to: 2 },
        ]);
    });

    test("rejects a tag outside the frame range", async () => {
        await expect(
            convert(colorFrames([RED], { tags: [{ name: "broken", from: 1, to: 3 }] })),
        ).rejects.toThrow('Invalid frame range for Pixelorama tag "broken"');
    });

    test("stores project metadata under meta.pixelorama", async () => {
        const { data } = await convert(colorFrames([RED], { fps: 12 }));
        expect(data.meta.pixelorama).toMatchObject({
            source: "fixture.pxo",
            pixeloramaVersion: "v1.2.3-stable",
            pxoVersion: 8,
            width: 1,
            height: 1,
            fps: 12,
            colorMode: "rgba8",
            layers: [
                { name: "layer", type: 0, visible: true, opacity: 1, blendMode: 0, parent: -1 },
            ],
        });
        expect(data.meta.aseprite).toBeUndefined();
    });
});

describe("compositing", () => {
    test("places cropped cels at their offset", async () => {
        const { pixel } = await convert(
            buildPixelorama({
                width: 3,
                height: 2,
                layers: [{ name: "layer" }],
                frames: [{ cels: [{ x: 1, y: 1, width: 2, height: 1, pixels: [RED, GREEN] }] }],
            }),
        );
        expect(pixel(0, 0)).toEqual(CLEAR);
        expect(pixel(1, 1)).toEqual(RED);
        expect(pixel(2, 1)).toEqual(GREEN);
    });

    test("draws layers bottom to top and multiplies layer and cel opacity", async () => {
        const { pixel } = await convert(
            buildPixelorama({
                width: 2,
                height: 1,
                layers: [{ name: "bottom" }, { name: "top", opacity: 0.5 }],
                frames: [
                    {
                        cels: [
                            { width: 2, pixels: [RED, RED] },
                            { width: 2, opacity: 0.5, pixels: [BLUE, CLEAR as never] },
                        ],
                    },
                ],
            }),
        );
        expect(pixel(0)).toEqual([191, 0, 64, 255]);
        expect(pixel(1)).toEqual(RED);
    });

    test("skips hidden layers, layers inside hidden groups, and audio layers", async () => {
        const { pixel } = await convert(
            buildPixelorama({
                width: 1,
                height: 1,
                layers: [
                    { name: "art" },
                    { name: "hidden", visible: false },
                    { name: "child", parent: 3 },
                    { name: "hidden-group", type: 1, visible: false },
                    { name: "music", type: 4 },
                ],
                frames: [
                    {
                        cels: [{ pixels: [RED] }, { pixels: [BLUE] }, { pixels: [GREEN] }, {}, {}],
                    },
                ],
            }),
        );
        expect(pixel(0)).toEqual(RED);
    });

    test("applies group opacity for normal groups and ignores it for pass-through groups", async () => {
        const file = (blendMode: number) =>
            buildPixelorama({
                width: 1,
                height: 1,
                layers: [
                    { name: "child", parent: 1 },
                    { name: "group", type: 1, opacity: 0.5, blendMode },
                ],
                frames: [{ cels: [{ pixels: [GREEN] }, {}] }],
            });
        expect((await convert(file(0))).pixel(0)).toEqual([0, 255, 0, 128]);
        expect((await convert(file(-2))).pixel(0)).toEqual(GREEN);
    });

    test("includes only layers that match layerPrefix", async () => {
        const file = buildPixelorama({
            width: 1,
            height: 1,
            layers: [{ name: "hero-body" }, { name: "shadow" }],
            frames: [{ cels: [{ pixels: [RED] }, { pixels: [BLUE] }] }],
        });
        expect((await convert(file)).pixel(0)).toEqual(BLUE);
        expect((await convert(file, "fixture.pxo", { layerPrefix: "hero" })).pixel(0)).toEqual(RED);
    });

    test("uses pre-blended frames when the project includes them", async () => {
        const file = buildPixelorama({
            width: 1,
            height: 1,
            layers: [{ name: "glow", effects: [{ enabled: true }] }],
            frames: [{ cels: [{ pixels: [RED] }] }, { cels: [{ pixels: [RED] }] }],
            blendedImages: [[BLUE], [GREEN]],
        });
        const { pixel } = await convert(file);
        expect(pixel(0)).toEqual(BLUE);
        expect(pixel(1)).toEqual(GREEN);
    });

    test("renders the layers instead of the pre-blended frames when layerPrefix is set", async () => {
        const file = buildPixelorama({
            width: 1,
            height: 1,
            layers: [{ name: "hero" }],
            frames: [{ cels: [{ pixels: [RED] }] }],
            blendedImages: [[BLUE]],
        });
        expect((await convert(file, "fixture.pxo", { layerPrefix: "hero" })).pixel(0)).toEqual(RED);
    });

    test("ignores disabled layer effects", async () => {
        const { pixel } = await convert(
            buildPixelorama({
                width: 1,
                height: 1,
                layers: [{ name: "layer", effects: [{ enabled: false }] }],
                frames: [{ cels: [{ pixels: [RED] }] }],
            }),
        );
        expect(pixel(0)).toEqual(RED);
    });
});

describe("unsupported input", () => {
    const single = (
        layer: PxoFixtureOptions["layers"][number],
        cel: PxoFixtureOptions["frames"][number]["cels"][number] = {},
    ) => buildPixelorama({ width: 1, height: 1, layers: [layer], frames: [{ cels: [cel] }] });

    test.each([
        ["layer effects", single({ name: "glow", effects: [{}] }), 'Layer effects on layer "glow"'],
        [
            "clipping masks",
            single({ name: "mask", clippingMask: true }),
            'Clipping mask on layer "mask"',
        ],
        [
            "animated opacity",
            single({
                name: "fade",
                animatedParams:
                    'Dictionary[String, Dictionary]({\n"opacity": {\n0: {\n"value": 0.5\n}\n}\n})',
            }),
            'Animated opacity on layer "fade"',
        ],
        ["3D layers", single({ name: "cube", type: 2 }), '3D layer "cube"'],
        ["tilemap layers", single({ name: "tiles", type: 3 }), 'Tilemap layer "tiles"'],
    ])("rejects %s and suggests including blended images", async (_label, file, message) => {
        const error = convert(file);
        await expect(error).rejects.toThrow(message);
        await expect(error).rejects.toThrow('"Include blended images" enabled');
    });

    test("rejects blend modes other than normal", async () => {
        await expect(convert(single({ name: "multiply", blendMode: 3 }))).rejects.toThrow(
            'Unsupported blend mode 3 in layer "multiply"',
        );
    });

    test("rejects cels with a z-index", async () => {
        await expect(convert(single({ name: "layer" }, { zIndex: 1 }))).rejects.toThrow(
            'Pixelorama cel z-index 1 is not supported (layer "layer")',
        );
    });

    test("rejects color modes other than RGBA8 and indexed", async () => {
        await expect(convert(colorFrames([RED], { colorMode: 4 }))).rejects.toThrow(
            "Pixelorama color mode 4 in fixture.pxo is not supported",
        );
        expect((await convert(colorFrames([RED], { colorMode: -1 }))).pixel(0)).toEqual(RED);
    });

    test("rejects files that are not Pixelorama 1.0+ projects", async () => {
        await expect(convert(Buffer.from("not a zip"))).rejects.toThrow(
            "is not a Pixelorama 1.0+ project",
        );
    });

    test("ignores unsupported layers that are hidden", async () => {
        const { pixel } = await convert(
            buildPixelorama({
                width: 1,
                height: 1,
                layers: [{ name: "art" }, { name: "tiles", type: 3, visible: false }],
                frames: [{ cels: [{ pixels: [RED] }, {}] }],
            }),
        );
        expect(pixel(0)).toEqual(RED);
    });
});

describe("Pixelorama example projects", () => {
    test("reject the layer effect in animated_layer_effect.pxo", async () => {
        await expect(convert(readFixture("animated_layer_effect.pxo"))).rejects.toThrow(
            'Layer effects on layer "Layer 1"',
        );
    });

    test("render the cels of animated_layer_effect.pxo at their offsets once the effect is removed", async () => {
        const source = readFixture("animated_layer_effect.pxo");
        const file = editPixelorama(source, (project) => {
            for (const layer of project.layers as { effects: unknown[] }[]) layer.effects = [];
        });
        const { data, pixel } = await convert(file, "effect.pxo");
        expect(Object.keys(data.frames)).toHaveLength(6);
        expect(data.meta.pixelorama).toMatchObject({
            width: 64,
            height: 64,
            fps: 6,
            pxoVersion: 8,
        });
        expect(data.frames.effect_0.duration).toBe(167);

        // The first opaque pixel of frame 1's 6x11 cel, stored at offset (13, 40).
        const cel = unzipSync(new Uint8Array(source))["image_data/frames/1/layer_1"];
        const index = [...Array(6 * 11).keys()].find((i) => cel[i * 4 + 3] === 255);
        if (index === undefined) throw new Error("The example cel has no opaque pixel.");
        const expected = [...cel.subarray(index * 4, index * 4 + 4)];
        expect(pixel(13 + (index % 6), 40 + Math.floor(index / 6))).toEqual(expected);
        expect(pixel(0, 0)).toEqual(CLEAR);
    });

    test("reject the tilemap layer in tilemap_with_autotiling.pxo", async () => {
        await expect(convert(readFixture("tilemap_with_autotiling.pxo"))).rejects.toThrow(
            'Tilemap layer "Tilemap 2"',
        );
    });

    test("reject the 3D layer in 3d_layer_drawing.pxo", async () => {
        await expect(convert(readFixture("3d_layer_drawing.pxo"))).rejects.toThrow(
            '3D layer "Layer 2"',
        );
    });
});
