import { type AssetPipe, createNewAssetAt, stripTags } from "@assetpack/core";
import { version } from "../package.json";
import { decodeAseprite } from "./aseprite";
import { decodePixelorama } from "./pixelorama";
import { createSpritesheet } from "./spritesheet";

export interface AsepritePluginOptions {
    /** Include only pixel layers whose names begin with this value. */
    layerPrefix?: string;
    /**
     * Maximum width of the generated texture. Frames are laid out left to right and wrap to a new
     * row when the next frame would exceed this width.
     * @default 4096
     */
    maxTextureSize?: number;
}

const SOURCE_EXTENSION = /\.(aseprite|ase|pxo)$/i;

/**
 * Converts Aseprite/LibreSprite (`.ase`, `.aseprite`) and Pixelorama (`.pxo`) files into a PNG
 * texture and a PixiJS spritesheet JSON while AssetPack builds the project.
 */
export function aseprite(options: AsepritePluginOptions = {}): AssetPipe {
    return {
        name: "aseprite",
        // AssetPack hashes defaultOptions into its cache name, so including the plugin version
        // makes a plugin upgrade convert the files again instead of reusing old output.
        defaultOptions: { maxTextureSize: 4096, ...options, pluginVersion: version },
        test(asset) {
            return !asset.isFolder && SOURCE_EXTENSION.test(asset.filename);
        },
        async transform(asset, pipeOptions: AsepritePluginOptions, pipeSystem) {
            const decodeOptions = { layerPrefix: pipeOptions.layerPrefix };
            const document =
                asset.extension.toLowerCase() === ".pxo"
                    ? decodePixelorama(asset.buffer, asset.filename, decodeOptions)
                    : decodeAseprite(asset.buffer, asset.filename, decodeOptions);

            const baseName = asset.filename.replace(SOURCE_EXTENSION, "");
            const imageName = `${baseName}.png`;
            const jsonName = `${baseName}.json`;
            const { png, json } = await createSpritesheet(document, {
                name: stripTags(baseName),
                imageName,
                filename: asset.filename,
                maxTextureSize: pipeOptions.maxTextureSize ?? 4096,
            });

            const imageAsset = createNewAssetAt(asset, imageName, pipeSystem.outputPath);
            imageAsset.buffer = png;
            imageAsset.metaData.nomip = true;
            // The texture is only consumed through the spritesheet JSON, so keep it (and its
            // compressed variants) out of the manifest entry, as AssetPack's texturePacker does.
            imageAsset.metaData.mIgnore = true;

            const jsonAsset = createNewAssetAt(asset, jsonName, pipeSystem.outputPath);
            jsonAsset.buffer = Buffer.from(JSON.stringify(json, null, 2));
            jsonAsset.metaData.tps = true;
            return [imageAsset, jsonAsset];
        },
    };
}
