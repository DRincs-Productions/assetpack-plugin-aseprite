import { AssetPack } from "@assetpack/core";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { aseprite } from "../src";
import { makeAsepriteFixture } from "./fixtures/aseprite-file";

test("reuses unchanged source conversions across builds and rebuilds changed sources", async () => {
    const root = await mkdtemp(join(tmpdir(), "aseprite-cache-"));
    try {
        const entry = join(root, "input");
        await mkdir(entry);
        const source = join(entry, "sprite.aseprite");
        const bytes = makeAsepriteFixture();
        await writeFile(source, bytes);
        const pipe = aseprite();
        const transform = vi.fn(pipe.transform);
        pipe.transform = transform;
        const config = {
            entry,
            output: join(root, "output"),
            cacheLocation: join(root, "cache"),
            cache: true,
            strict: true,
            pipes: [pipe],
        };
        await new AssetPack(config).run();
        expect(transform).toHaveBeenCalledTimes(1);
        await new AssetPack(config).run();
        expect(transform).toHaveBeenCalledTimes(1);
        bytes.writeUInt16LE(90, 128 + 8);
        await writeFile(source, bytes);
        await new AssetPack(config).run();
        expect(transform).toHaveBeenCalledTimes(2);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
