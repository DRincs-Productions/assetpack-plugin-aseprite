import Aseprite from "ase-parser";
import { createNewAssetAt, type AssetPipe } from "@assetpack/core";
import sharp from "sharp";

export interface AsepritePluginOptions {
    /** Include only raster layers whose names begin with this value. */
    layerPrefix?: string;
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
        defaultOptions: { ...options },
        test(asset) {
            return !asset.isFolder && [".ase", ".aseprite"].includes(asset.extension.toLowerCase());
        },
        async transform(asset, _pipeOptions, pipeSystem) {
            const ase = new Aseprite(asset.buffer, asset.filename);
            ase.parse();

            if (ase.colorDepth !== 32) {
                throw new Error(
                    `Aseprite plugin supports 32-bit RGBA documents; ${asset.filename} is ${ase.colorDepth}-bit.`,
                );
            }
            if (Math.max(ase.width * ase.numFrames, ase.height) > 16383) {
                throw new Error(
                    `Aseprite sprite strip for ${asset.filename} exceeds Sharp's 16383-pixel dimension limit.`,
                );
            }

            const rendered = ase.frames.map((frame, frameIndex) => ({
                data: renderFrame(ase, frameIndex, options),
                duration: frame.frameDuration,
            }));
            const strip = Buffer.alloc(ase.width * rendered.length * ase.height * 4);
            rendered.forEach(({ data }, frameIndex) => {
                for (let row = 0; row < ase.height; row++) {
                    const sourceStart = row * ase.width * 4;
                    const targetStart =
                        (row * ase.width * rendered.length + frameIndex * ase.width) * 4;
                    data.copy(strip, targetStart, sourceStart, sourceStart + ase.width * 4);
                }
            });

            const baseName = asset.filename.replace(/\.(aseprite|ase)$/i, "");
            const imageName = `${baseName}.png`;
            const jsonName = `${baseName}.json`;
            const png = await sharp(strip, {
                raw: { width: ase.width * rendered.length, height: ase.height, channels: 4 },
            })
                .png()
                .toBuffer();
            const json = createSpritesheetJson(ase, rendered, imageName);

            const imageAsset = createNewAssetAt(asset, imageName, pipeSystem.outputPath);
            imageAsset.buffer = png;
            imageAsset.metaData.nomip = true;

            const jsonAsset = createNewAssetAt(asset, jsonName, pipeSystem.outputPath);
            jsonAsset.buffer = Buffer.from(JSON.stringify(json, null, 2));
            jsonAsset.metaData.tps = true;
            return [imageAsset, jsonAsset];
        },
    };
}

function renderFrame(ase: Aseprite, frameIndex: number, options: AsepritePluginOptions): Buffer {
    const output = Buffer.alloc(ase.width * ase.height * 4);
    const tree = createLayerTree(ase.layers);
    const cels = ase.frames[frameIndex].cels;

    const renderNode = (node: LayerNode, target: Buffer, inheritedOpacity: number): void => {
        const { layer } = node;
        if (!layer.flags.visible) return;
        const opacity = (inheritedOpacity * layer.opacity) / 255;

        if (layer.type === 1) {
            if (layer.blendMode !== 0) {
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

function createSpritesheetJson(ase: Aseprite, frames: RenderedFrame[], imageName: string) {
    const frameData: Record<string, unknown> = {};
    const animations: Record<string, string[]> = {};
    frames.forEach(({ duration }, index) => {
        const name = `frame${index}`;
        frameData[name] = {
            frame: { x: index * ase.width, y: 0, w: ase.width, h: ase.height },
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
        animations[tag.name] = indices.map((index) => `frame${index}`);
    }

    return {
        frames: frameData,
        animations,
        meta: {
            app: "@drincs/assetpack-plugin-aseprite",
            version: "0.1.0",
            image: imageName,
            format: "RGBA8888",
            size: { w: ase.width * frames.length, h: ase.height },
            scale: "1",
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
