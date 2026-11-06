import { Asset, PipeSystem } from "@assetpack/core";
import { join } from "node:path";
import sharp from "sharp";
import { expect, test } from "vitest";
import { aseprite } from "../src";
import { makeAsepriteFixture } from "./fixtures/aseprite-file";

test("converts frames, tags, durations, pixels, and source metadata to AssetPack assets", async () => {
    const root = new Asset({ path: process.cwd(), isFolder: true });
    const input = new Asset({ path: join(process.cwd(), "fixture.ase") });
    root.addChild(input);
    input.buffer = makeAsepriteFixture();
    const outputPath = join(process.cwd(), ".tmp-aseprite-test");
    const pipe = aseprite();
    const pipeSystem = new PipeSystem({ pipes: [pipe], outputPath, entryPath: process.cwd() });
    if (!pipe.transform) throw new Error("Aseprite pipe is missing its transform method.");
    const [image, json] = await pipe.transform(input, {}, pipeSystem);

    expect(image.filename).toBe("fixture.png");
    expect(json.filename).toBe("fixture.json");
    const metadata = JSON.parse(json.buffer.toString());
    expect(metadata.frames.frame0.duration).toBe(80);
    expect(metadata.frames.frame1.duration).toBe(120);
    expect(metadata.animations.walk).toEqual(["frame0", "frame1", "frame2", "frame1"]);
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

    const { data } = await sharp(image.buffer).raw().toBuffer({ resolveWithObject: true });
    expect([...data.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
    expect([...data.subarray(4, 8)]).toEqual([0, 0, 0, 0]);
    expect([...data.subarray(12, 16)]).toEqual([0, 255, 0, 255]);
    expect([...data.subarray(16, 20)]).toEqual([0, 0, 255, 255]);
    expect(image.metaData.nomip).toBe(true);
    expect(json.metaData.tps).toBe(true);
});

test("does not match unrelated asset extensions", () => {
    const pipe = aseprite();
    expect(pipe.test?.(new Asset({ path: "sprite.png" }), {})).toBe(false);
    expect(pipe.test?.(new Asset({ path: "sprite.aseprite" }), {})).toBe(true);
    expect(pipe.test?.(new Asset({ path: "sprites.ase", isFolder: true }), {})).toBe(false);
});
