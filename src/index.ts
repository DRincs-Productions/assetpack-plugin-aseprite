import Aseprite from "ase-parser";
import { type AssetPipe, BuildReporter, createNewAssetAt, stripTags } from "@assetpack/core";
import sharp from "sharp";
import { version } from "../package.json";

export { asepriteManifestMod, type AsepriteManifestModOptions } from "./manifest";

export interface AsepritePluginOptions {
    /** Include only raster layers whose names begin with this value. */
    layerPrefix?: string;
    /**
     * Maximum width of the generated texture. Frames are laid out left to right and wrap to a new
     * row when the next frame would exceed this width.
     * @default 4096
     */
    maxTextureSize?: number;
}

/** Sharp's maximum image dimension. */
const SHARP_MAX_DIMENSION = 16383;
/** Header flag: layer opacity has a valid value. */
const HEADER_LAYER_OPACITY_VALID = 1;
/** Header flag: group opacity and blend mode have valid values. */
const HEADER_GROUP_OPACITY_VALID = 2;

interface RenderOptions {
    layerPrefix?: string;
    layerOpacityValid: boolean;
    groupOpacityValid: boolean;
}

interface FrameLayout {
    columns: number;
    rows: number;
}

interface LayerNode {
    layer: Aseprite.Layer;
    index: number;
    children: LayerNode[];
}

interface RenderedFrame {
    data: Buffer;
    duration: number;
}

const PLAYBACK_DIRECTIONS: Record<string, string> = {
    Forward: "forward",
    Reverse: "reverse",
    "Ping-pong": "pingpong",
    "Ping-pong Reverse": "pingpong_reverse",
};

/**
 * Converts Aseprite/LibreSprite files into a PNG strip and PixiJS spritesheet
 * JSON while AssetPack builds the project.
 */
export function aseprite(options: AsepritePluginOptions = {}): AssetPipe {
    return {
        name: "aseprite",
        defaultOptions: { maxTextureSize: 4096, ...options },
        test(asset) {
            return !asset.isFolder && [".ase", ".aseprite"].includes(asset.extension.toLowerCase());
        },
        async transform(asset, pipeOptions: AsepritePluginOptions, pipeSystem) {
            const ase = new Aseprite(asset.buffer, asset.filename);
            ase.parse();

            if (ase.colorDepth !== 32) {
                throw new Error(
                    `Aseprite plugin supports 32-bit RGBA documents; ${asset.filename} is ${ase.colorDepth}-bit.`,
                );
            }

            const headerFlags = asset.buffer.readUInt32LE(14);
            const renderOptions: RenderOptions = {
                layerPrefix: pipeOptions.layerPrefix,
                layerOpacityValid: (headerFlags & HEADER_LAYER_OPACITY_VALID) !== 0,
                groupOpacityValid: (headerFlags & HEADER_GROUP_OPACITY_VALID) !== 0,
            };
            const layout = getFrameLayout(ase, pipeOptions.maxTextureSize ?? 4096, asset.filename);
            const textureWidth = ase.width * layout.columns;
            const textureHeight = ase.height * layout.rows;

            const rendered = ase.frames.map((frame, frameIndex) => ({
                data: renderFrame(ase, frameIndex, renderOptions),
                duration: frame.frameDuration,
            }));
            const texture = Buffer.alloc(textureWidth * textureHeight * 4);
            rendered.forEach(({ data }, frameIndex) => {
                const { x, y } = getFramePosition(ase, layout, frameIndex);
                for (let row = 0; row < ase.height; row++) {
                    const sourceStart = row * ase.width * 4;
                    const targetStart = ((y + row) * textureWidth + x) * 4;
                    data.copy(texture, targetStart, sourceStart, sourceStart + ase.width * 4);
                }
            });

            const baseName = asset.filename.replace(/\.(aseprite|ase)$/i, "");
            const name = stripTags(baseName);
            const imageName = `${baseName}.png`;
            const jsonName = `${baseName}.json`;
            const png = await sharp(texture, {
                raw: { width: textureWidth, height: textureHeight, channels: 4 },
            })
                .png()
                .toBuffer();
            const json = createSpritesheetJson(ase, rendered, layout, imageName, name);

            const imageAsset = createNewAssetAt(asset, imageName, pipeSystem.outputPath);
            imageAsset.buffer = png;
            imageAsset.metaData.nomip = true;
            // The strip is only consumed through the spritesheet JSON, so keep it (and its
            // compressed variants) out of the manifest entry, as AssetPack's texturePacker does.
            imageAsset.metaData.mIgnore = true;

            const jsonAsset = createNewAssetAt(asset, jsonName, pipeSystem.outputPath);
            jsonAsset.buffer = Buffer.from(JSON.stringify(json, null, 2));
            jsonAsset.metaData.tps = true;
            return [imageAsset, jsonAsset];
        },
    };
}

function getFrameLayout(ase: Aseprite, maxTextureSize: number, filename: string): FrameLayout {
    const frameCount = ase.frames.length;
    const columns = Math.min(frameCount, Math.max(1, Math.floor(maxTextureSize / ase.width)));
    const rows = Math.ceil(frameCount / columns);
    const width = ase.width * columns;
    const height = ase.height * rows;
    if (Math.max(width, height) > SHARP_MAX_DIMENSION) {
        throw new Error(
            `Aseprite texture for ${filename} (${width}x${height}) exceeds Sharp's ${SHARP_MAX_DIMENSION}-pixel dimension limit.`,
        );
    }
    if (Math.max(width, height) > maxTextureSize) {
        BuildReporter.warn(
            `[aseprite] Texture for ${filename} is ${width}x${height}, larger than maxTextureSize ${maxTextureSize}; some GPUs cannot load it.`,
        );
    }
    return { columns, rows };
}

function getFramePosition(ase: Aseprite, layout: FrameLayout, frameIndex: number) {
    return {
        x: (frameIndex % layout.columns) * ase.width,
        y: Math.floor(frameIndex / layout.columns) * ase.height,
    };
}

function renderFrame(ase: Aseprite, frameIndex: number, options: RenderOptions): Buffer {
    const output = Buffer.alloc(ase.width * ase.height * 4);
    const tree = createLayerTree(ase.layers);
    const cels = ase.frames[frameIndex].cels;

    const renderNode = (node: LayerNode, target: Buffer, inheritedOpacity: number): void => {
        const { layer } = node;
        // Reference layers are editor-only, Aseprite never exports them.
        if (!layer.flags.visible || layer.flags.reference) return;

        if (layer.type === 1) {
            const opacity = options.groupOpacityValid
                ? (inheritedOpacity * layer.opacity) / 255
                : inheritedOpacity;
            if (options.groupOpacityValid && layer.blendMode !== 0) {
                throw new Error(
                    `Unsupported blend mode ${layer.blendMode} in group "${layer.name}"; only normal blending is supported.`,
                );
            }
            const group = Buffer.alloc(output.length);
            for (const child of node.children) renderNode(child, group, 1);
            composite(target, group, ase.width, ase.height, 0, 0, opacity, ase.width, ase.height);
            return;
        }
        if (options.layerPrefix && !layer.name.startsWith(options.layerPrefix)) return;
        if (layer.type !== 0) {
            throw new Error(
                `Unsupported Aseprite layer type ${layer.type} in layer "${layer.name}".`,
            );
        }
        const opacity = options.layerOpacityValid
            ? (inheritedOpacity * layer.opacity) / 255
            : inheritedOpacity;
        if (layer.blendMode !== 0) {
            throw new Error(
                `Unsupported blend mode ${layer.blendMode} in layer "${layer.name}"; only normal blending is supported.`,
            );
        }

        for (const cel of cels) {
            if (cel.layerIndex !== node.index) continue;
            if (cel.celType === 3)
                throw new Error(`Tilemap cels are not supported (layer "${layer.name}").`);
            if (cel.zIndex !== 0)
                throw new Error(
                    `Aseprite cel z-index ${cel.zIndex} is not supported (layer "${layer.name}").`,
                );
            if (!cel.rawCelData || cel.rawCelData.length !== cel.w * cel.h * 4) {
                throw new Error(`Invalid or unsupported cel data in layer "${layer.name}".`);
            }
            composite(
                target,
                cel.rawCelData,
                ase.width,
                ase.height,
                cel.xpos,
                cel.ypos,
                (opacity * cel.opacity) / 255,
                cel.w,
                cel.h,
            );
        }
    };

    for (const node of tree) renderNode(node, output, 1);
    return output;
}

function createLayerTree(layers: Aseprite.Layer[]): LayerNode[] {
    const roots: LayerNode[] = [];
    const parents: LayerNode[] = [];
    for (const [index, layer] of layers.entries()) {
        const node = { layer, index, children: [] };
        while (parents.length > layer.layerChildLevel) parents.pop();
        const parent = parents.at(-1);
        if (parent) parent.children.push(node);
        else roots.push(node);
        if (layer.type === 1) parents.push(node);
    }
    return roots;
}

function composite(
    target: Buffer,
    source: Buffer,
    targetWidth: number,
    targetHeight: number,
    left: number,
    top: number,
    opacity: number,
    width: number,
    height: number,
): void {
    if (opacity <= 0) return;
    for (let sourceY = 0; sourceY < height; sourceY++) {
        const y = top + sourceY;
        if (y < 0 || y >= targetHeight) continue;
        for (let sourceX = 0; sourceX < width; sourceX++) {
            const x = left + sourceX;
            if (x < 0 || x >= targetWidth) continue;
            const sourceOffset = (sourceY * width + sourceX) * 4;
            const targetOffset = (y * targetWidth + x) * 4;
            const sourceAlpha = (source[sourceOffset + 3] / 255) * opacity;
            if (sourceAlpha <= 0) continue;
            const targetAlpha = target[targetOffset + 3] / 255;
            const outputAlpha = sourceAlpha + targetAlpha * (1 - sourceAlpha);
            for (let channel = 0; channel < 3; channel++) {
                target[targetOffset + channel] = Math.round(
                    (source[sourceOffset + channel] * sourceAlpha +
                        target[targetOffset + channel] * targetAlpha * (1 - sourceAlpha)) /
                        outputAlpha,
                );
            }
            target[targetOffset + 3] = Math.round(outputAlpha * 255);
        }
    }
}

function createSpritesheetJson(
    ase: Aseprite,
    frames: RenderedFrame[],
    layout: FrameLayout,
    imageName: string,
    name: string,
) {
    // Frame names are prefixed with the file name because PixiJS caches every spritesheet
    // texture globally by frame name: two files with "frame0" would overwrite each other.
    const frameName = (index: number) => `${name}_${index}`;
    const frameData: Record<string, unknown> = {};
    const animations: Record<string, string[]> = {};
    frames.forEach(({ duration }, index) => {
        const { x, y } = getFramePosition(ase, layout, index);
        frameData[frameName(index)] = {
            frame: { x, y, w: ase.width, h: ase.height },
            rotated: false,
            trimmed: false,
            spriteSourceSize: { x: 0, y: 0, w: ase.width, h: ase.height },
            sourceSize: { w: ase.width, h: ase.height },
            duration,
        };
    });
    for (const tag of ase.tags) {
        if (tag.from > tag.to || tag.from < 0 || tag.to >= frames.length) {
            throw new Error(`Invalid frame range for Aseprite tag "${tag.name}".`);
        }
        const indices = Array.from(
            { length: tag.to - tag.from + 1 },
            (_, index) => tag.from + index,
        );
        const direction = PLAYBACK_DIRECTIONS[tag.animDirection];
        if (!direction)
            throw new Error(
                `Unknown Aseprite playback direction "${tag.animDirection}" for tag "${tag.name}".`,
            );
        if (direction === "reverse") indices.reverse();
        if (direction === "pingpong") indices.push(...indices.slice(1, -1).reverse());
        if (direction === "pingpong_reverse") {
            indices.reverse();
            indices.push(...indices.slice(1, -1).reverse());
        }
        if (animations[tag.name]) {
            BuildReporter.warn(
                `[aseprite] Duplicate tag "${tag.name}" in ${ase.name}; only the first one becomes an animation.`,
            );
            continue;
        }
        animations[tag.name] = indices.map(frameName);
    }
    if (ase.tags.length === 0) {
        // Without tags, expose every frame as one animation named after the source file.
        animations[name] = frames.map((_, index) => frameName(index));
    }

    return {
        frames: frameData,
        animations,
        meta: {
            app: "@drincs/assetpack-plugin-aseprite",
            version,
            image: imageName,
            format: "RGBA8888",
            size: { w: ase.width * layout.columns, h: ase.height * layout.rows },
            scale: "1",
            // AssetPack's texturePackerCompress hides the per-format JSON copies from the
            // manifest unless this field exists, as it does in AssetPack's own texture packer.
            related_multi_packs: [],
            aseprite: {
                source: ase.name,
                fileSize: ase.fileSize,
                frameCount: ase.numFrames,
                width: ase.width,
                height: ase.height,
                colorDepth: ase.colorDepth,
                pixelRatio: ase.pixelRatio,
                layers: ase.layers,
                tags: ase.tags,
                slices: ase.slices,
                palette: ase.palette,
                colorProfile: ase.colorProfile
                    ? {
                          ...ase.colorProfile,
                          icc: undefined,
                          hasIccProfile: Boolean(ase.colorProfile.icc),
                      }
                    : undefined,
                frames: ase.frames.map((frame) => ({
                    duration: frame.frameDuration,
                    cels: frame.cels.map(
                        ({ layerIndex, xpos, ypos, opacity, celType, zIndex, link, w, h }) => ({
                            layerIndex,
                            x: xpos,
                            y: ypos,
                            opacity,
                            type: celType,
                            zIndex,
                            link,
                            width: w,
                            height: h,
                        }),
                    ),
                })),
            },
        },
    };
}
