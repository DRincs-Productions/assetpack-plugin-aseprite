import { BuildReporter } from "@assetpack/core";
import sharp from "sharp";
import { version } from "../package.json";
import type { SpriteDocument } from "./document";

/** Sharp's maximum image dimension. */
const SHARP_MAX_DIMENSION = 16383;

interface FrameLayout {
    columns: number;
    rows: number;
}

/** Packs the frames of a document into a PNG texture and a PixiJS spritesheet JSON. */
export async function createSpritesheet(
    document: SpriteDocument,
    {
        name,
        imageName,
        filename,
        maxTextureSize,
    }: {
        /** Prefix of frame names and name of the default animation. */
        name: string;
        imageName: string;
        filename: string;
        maxTextureSize: number;
    },
) {
    const layout = getFrameLayout(document, maxTextureSize, filename);
    const textureWidth = document.width * layout.columns;
    const textureHeight = document.height * layout.rows;
    const texture = Buffer.alloc(textureWidth * textureHeight * 4);
    document.frames.forEach(({ data }, frameIndex) => {
        const { x, y } = getFramePosition(document, layout, frameIndex);
        for (let row = 0; row < document.height; row++) {
            const sourceStart = row * document.width * 4;
            const targetStart = ((y + row) * textureWidth + x) * 4;
            data.copy(texture, targetStart, sourceStart, sourceStart + document.width * 4);
        }
    });
    const png = await sharp(texture, {
        raw: { width: textureWidth, height: textureHeight, channels: 4 },
    })
        .png()
        .toBuffer();

    // Frame names are prefixed with the file name because PixiJS caches every spritesheet
    // texture globally by frame name: two files with "frame0" would overwrite each other.
    const frameName = (index: number) => `${name}_${index}`;
    const frames: Record<string, unknown> = {};
    document.frames.forEach(({ duration }, index) => {
        const { x, y } = getFramePosition(document, layout, index);
        frames[frameName(index)] = {
            frame: { x, y, w: document.width, h: document.height },
            rotated: false,
            trimmed: false,
            spriteSourceSize: { x: 0, y: 0, w: document.width, h: document.height },
            sourceSize: { w: document.width, h: document.height },
            duration,
        };
    });

    const animations: Record<string, string[]> = {};
    for (const animation of document.animations) {
        if (animations[animation.name]) {
            BuildReporter.warn(
                `[aseprite] Duplicate tag "${animation.name}" in ${filename}; only the first one becomes an animation.`,
            );
            continue;
        }
        animations[animation.name] = animation.frames.map(frameName);
    }
    if (document.animations.length === 0) {
        // Without tags, expose every frame as one animation named after the source file.
        animations[name] = document.frames.map((_, index) => frameName(index));
    }

    const json = {
        frames,
        animations,
        meta: {
            app: "@drincs/assetpack-plugin-aseprite",
            version,
            image: imageName,
            format: "RGBA8888",
            size: { w: textureWidth, h: textureHeight },
            scale: "1",
            // AssetPack's texturePackerCompress hides the per-format JSON copies from the
            // manifest unless this field exists, as it does in AssetPack's own texture packer.
            related_multi_packs: [],
            ...document.meta,
        },
    };
    return { png, json };
}

function getFrameLayout(
    document: SpriteDocument,
    maxTextureSize: number,
    filename: string,
): FrameLayout {
    const frameCount = document.frames.length;
    const columns = Math.min(frameCount, Math.max(1, Math.floor(maxTextureSize / document.width)));
    const rows = Math.ceil(frameCount / columns);
    const width = document.width * columns;
    const height = document.height * rows;
    if (Math.max(width, height) > SHARP_MAX_DIMENSION) {
        throw new Error(
            `Texture for ${filename} (${width}x${height}) exceeds Sharp's ${SHARP_MAX_DIMENSION}-pixel dimension limit.`,
        );
    }
    if (Math.max(width, height) > maxTextureSize) {
        BuildReporter.warn(
            `[aseprite] Texture for ${filename} is ${width}x${height}, larger than maxTextureSize ${maxTextureSize}; some GPUs cannot load it.`,
        );
    }
    return { columns, rows };
}

function getFramePosition(document: SpriteDocument, layout: FrameLayout, frameIndex: number) {
    return {
        x: (frameIndex % layout.columns) * document.width,
        y: Math.floor(frameIndex / layout.columns) * document.height,
    };
}
