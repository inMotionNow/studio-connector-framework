import { Connector, Media } from '@chili-publish/studio-connectors';

// ─── Lytho API Types ──────────────────────────────────────────────────────────

interface LythoDownloadLink {
  link: string;
  exp: number;
}

interface LythoTag {
  id: string;
  name: string;
}

interface LythoAsset {
  id: string;
  name: string;
  fileName: string;
  extension: string;
  fileType: string;
  width: number | null;
  height: number | null;
  tags: LythoTag[];
  links: {
    previewLink: LythoDownloadLink;
    hrPreviewLink?: LythoDownloadLink;
  };
}

// Slim, connector-owned shape returned by POST /search/grafx/api/v1/search. Decoupled from Lytho's
// internal search models (the connector is destined for CHILI's public repo).
interface ConnectorSearchHit {
  id: string;
  name: string;
  fileName: string;
  extension: string;
  fileType: string;
  width: number | null;
  height: number | null;
  tags: LythoTag[];
}

interface ConnectorSearchResponse {
  totalHits: number;
  from: number;
  size: number;
  hits: ConnectorSearchHit[];
}

// CHILI GraFx-supported asset file types (per docs.chiligrafx.com/GraFx-Media/overview/filetypes).
// Sent with the search request to filter search/browse results to assets CHILI can use. This does
// not constrain direct id lookups — detail() and the query() ObjectID intercept resolve a known
// asset regardless of extension; browse filtering is what prevents placing unsupported types.
// The search API matches extensions case-sensitively, so each format is listed in both lower- and
// upper-case; `jpeg`/`tiff` are the `jpg`/`tif` synonyms.
// NOTE: mixed-case extensions (e.g. `.Tif`) are still missed — the DAM stores `extension` as a
// case-sensitive keyword. A case-insensitive fix (index normalizer) is tracked as a separate ticket.
const SUPPORTED_FILE_FORMATS = ['eps', 'jpg', 'jpeg', 'pdf', 'png', 'psd', 'tif', 'tiff', 'ai'];
const SUPPORTED_EXTENSIONS = SUPPORTED_FILE_FORMATS.flatMap((ext) => [ext, ext.toUpperCase()]);

// GraFx expects PNG/JPEG for on-screen (web) display. Assets already in these formats are
// served as their original bytes; any other supported type (EPS/PDF/PSD/TIFF/AI) is served
// as the DAM's rasterized `hrpreview` twin so the canvas can decode it. Matched case-insensitively
// — the DAM stores `extension` as a case-sensitive keyword, so `.JPG`/`.Png` must be lower-cased first.
const WEB_NATIVE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg']);

// Types CHILI's export and animation pipelines cannot ingest as raw originals. Per CHILI's Media
// Connector docs, `fullres`/`print` expects PNG/JPEG/PDF ("for asset types other than PNG / JPEG /
// PDF one should serve the asset wrapped as a PDF file") and `fullres`/`animation` expects
// PNG/JPEG. EPS/PSD/TIFF meet neither, so they reroute: print gets a PDF rendition converted from
// the original, animation gets the rasterized `hrpreview` twin.
//
// PDF and AI are deliberately NOT listed. A literal reading of the animation contract would include
// them, but both render correctly today through CHILI's own vector passthrough, and not regressing
// them outranks the letter of the docs. Revisit only with evidence of a real failure.
//
// Matched case-insensitively: `extension` is stored as a case-sensitive value, so `.EPS` and `.Tif`
// must be lower-cased before lookup.
const EXPORT_INCOMPATIBLE_EXTENSIONS = new Set(['eps', 'psd', 'tif', 'tiff']);

// ─── Connector Implementation ─────────────────────────────────────────────────

export default class LythoMediaConnector implements Media.MediaConnector {
  private runtime: Connector.ConnectorRuntimeContext;

  constructor(runtime: Connector.ConnectorRuntimeContext) {
    this.runtime = runtime;
  }

  async query(
    options: Connector.QueryOptions,
    context: Connector.Dictionary
  ): Promise<Media.MediaPage> {
    const baseUrl = this._getBaseUrl();
    const from = parseInt(String(options.pageToken ?? '0')) || 0;
    const pageSize = options.pageSize ?? 20;
    const terms = options.filter?.join(' ') ?? '';

    // Studio resolves saved assets by calling query(size=1, terms=assetId).
    // The Lytho full-text search API rejects MongoDB ObjectIDs as search terms (returns 500).
    // Intercept this pattern and fetch the asset directly via the detail endpoint.
    if (pageSize === 1 && /^[0-9a-f]{24}$/i.test(terms.trim())) {
      const result = await this.runtime.fetch(
        `${baseUrl}/assets/assets/${encodeURIComponent(terms.trim())}`,
        { method: 'GET' }
      );
      if (!result.ok) {
        throw new ConnectorHttpError(result.status, `Lytho: Asset lookup failed ${result.status} ${result.statusText}`);
      }
      const asset = JSON.parse(result.text) as LythoAsset;
      return {
        pageSize: 1,
        data: [{
          id: asset.id,
          name: asset.name,
          relativePath: '/' + asset.id,
          type: 0,
          extension: asset.extension ?? '',
          metaData: {
            fileType: asset.fileType ?? '',
            tags: asset.tags?.map((t) => t.name).join(', ') ?? '',
          },
        }],
        links: { nextPage: '' },
      };
    }

    // Tenant is resolved server-side from the authenticated user (realm/token); the connector
    // sends only the filters it uses. The full search request is built inside dam-service-search.
    const collectionId =
      options.collection && options.collection !== '/' ? options.collection : null;

    const body = {
      terms,
      collectionId,
      from,
      size: pageSize,
      extensions: SUPPORTED_EXTENSIONS,
    };

    const result = await this.runtime.fetch(`${baseUrl}/search/grafx/api/v1/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!result.ok) {
      throw new ConnectorHttpError(
        result.status,
        `Lytho: Query failed ${result.status} ${result.statusText}`
      );
    }

    const json = JSON.parse(result.text) as ConnectorSearchResponse;
    const hits = json.hits ?? [];
    const totalHits = json.totalHits ?? 0;
    const nextFrom = from + pageSize;

    return {
      pageSize,
      data: hits.map((h) => this._searchHitToMedia(h)),
      links: {
        nextPage: nextFrom < totalHits ? String(nextFrom) : '',
      },
    };
  }

  async detail(
    id: string,
    context: Connector.Dictionary
  ): Promise<Media.MediaDetail> {
    const baseUrl = this._getBaseUrl();

    // Metadata read uses the pre-existing `/assets/assets/{id}` endpoint. This is deliberately
    // a different path shape from the `/assets/grafx/...` byte-download endpoint (see download());
    // the two are not meant to match.
    const result = await this.runtime.fetch(
      `${baseUrl}/assets/assets/${encodeURIComponent(id)}`,
      { method: 'GET' }
    );

    if (!result.ok) {
      throw new ConnectorHttpError(
        result.status,
        `Lytho: Detail failed ${result.status} ${result.statusText}`
      );
    }

    const asset = JSON.parse(result.text) as LythoAsset;

    return {
      id: asset.id,
      name: asset.name,
      relativePath: '/' + asset.id,
      type: 0,
      extension: asset.extension ?? '',
      width: asset.width ?? undefined,
      height: asset.height ?? undefined,
      metaData: {
        fileType: asset.fileType ?? '',
        fileName: asset.fileName ?? '',
        tags: asset.tags?.map((t) => t.name).join(', ') ?? '',
      },
    };
  }

  async download(
    id: string,
    previewType: Media.DownloadType,
    intent: Media.DownloadIntent,
    context: Connector.Dictionary
  ): Promise<Connector.ArrayBufferPointer> {
    const baseUrl = this._getBaseUrl();

    let variant: string;
    switch (previewType) {
      case 'thumbnail':
        variant = 'preview';
        break;
      case 'mediumres':
        variant = 'hrpreview';
        break;
      case 'highres': {
        if (intent === 'web') {
          // Loaded into editor frames for on-screen display. GraFx expects a decodable raster
          // (PNG/JPEG) here for every file type — it has no "serve original" carve-out — so web
          // always serves the rasterized twin, no type lookup needed.
          variant = 'hrpreview';
          break;
        }
        // print / animation. The contract asks for a high-quality image, but routing *every* type
        // here would downscale a 4000px JPEG that exports correctly today, so stay type-aware:
        // only the types CHILI cannot ingest are rerouted.
        //
        // DEFENSIVE. Studio has not been observed requesting `highres` on any intent — the display
        // path uses `mediumres`/`web`. These branches cost nothing and the contract permits the
        // tier, but the behaviour is unobserved rather than confirmed.
        const ext = await this._getExtension(id);
        variant = EXPORT_INCOMPATIBLE_EXTENSIONS.has(ext) ? 'hrpreview' : 'content';
        break;
      }
      case 'fullres': {
        // download() isn't handed the file type, so look it up — one extra metadata call per
        // fullres download. Accepted cost; revisit only if this ever proves to be a hot path.
        const ext = await this._getExtension(id);
        if (intent === 'web') {
          // Serve PNG/JPEG originals as-is; anything else becomes the rasterized twin so the
          // canvas can decode it.
          variant = WEB_NATIVE_EXTENSIONS.has(ext) ? 'content' : 'hrpreview';
        } else if (!EXPORT_INCOMPATIBLE_EXTENSIONS.has(ext)) {
          // png/jpg/pdf/ai already export and animate correctly as their original bytes.
          variant = 'content';
        } else if (intent === 'print') {
          // CHILI's PDF export engine ingests only PNG/JPEG/PDF. Serve the DAM's on-demand PDF
          // rendition. If conversion fails the DAM degrades to raster server-side and still
          // returns 200 — there is nothing for the connector to retry or detect.
          variant = 'pdf';
        } else {
          // animation: the contract wants PNG/JPEG, and `hrpreview` is exactly that.
          variant = 'hrpreview';
        }
        break;
      }
      // 'original' → full-resolution original bytes
      default:
        variant = 'content';
        break;
    }
    // NOTE — path shape is intentional, do not "fix" it to match detail()/query().
    // Byte downloads use the `/assets/grafx/...` endpoint family, purpose-built for the
    // connector to stream asset bytes directly and bypass Lytho's signed-S3 download links.
    // Metadata reads (detail, and the query() ObjectID lookup) use the older, pre-existing
    // `/assets/assets/{id}` endpoint. The two path families serve different purposes and are
    // NOT meant to match.
    const path = `/assets/grafx/assets/${encodeURIComponent(id)}/${variant}`;

    const result = await this.runtime.fetch(`${baseUrl}${path}`, { method: 'GET' });
    if (!result.ok) {
      throw new ConnectorHttpError(
        result.status,
        `Lytho: Download failed ${result.status} ${result.statusText}`
      );
    }
    return result.arrayBuffer;
  }

  getConfigurationOptions(): Connector.ConnectorConfigValue[] | null {
    // BASE_URL is a runtime option configured at deploy time — no per-instance
    // configuration options are needed for this connector.
    return null;
  }

  getCapabilities(): Media.MediaConnectorCapabilities {
    return {
      query: true,
      detail: true,
      filtering: true,
      metadata: true,
    };
  }

  // ─── Private Helpers ──────────────────────────────────────────────────────

  private _getBaseUrl(): string {
    const baseUrl = this.runtime.options['BASE_URL'];
    if (typeof baseUrl !== 'string' || baseUrl.trim().length === 0) {
      return '';
    }
    return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  }

  // Resolve an asset's file extension (lower-cased) for download-variant routing. download() is
  // handed only the id, so the extension — needed to decide PNG/JPEG-vs-convert for web fullres —
  // is read from the metadata endpoint. Same `/assets/assets/{id}` read that detail() performs.
  private async _getExtension(id: string): Promise<string> {
    const baseUrl = this._getBaseUrl();
    const result = await this.runtime.fetch(
      `${baseUrl}/assets/assets/${encodeURIComponent(id)}`,
      { method: 'GET' }
    );
    if (!result.ok) {
      throw new ConnectorHttpError(
        result.status,
        `Lytho: Asset lookup failed ${result.status} ${result.statusText}`
      );
    }
    const asset = JSON.parse(result.text) as LythoAsset;
    return (asset.extension ?? '').toLowerCase();
  }

  private _searchHitToMedia(hit: ConnectorSearchHit): Media.Media {
    return {
      id: hit.id,
      name: hit.name,
      relativePath: '/' + hit.id,
      type: 0,
      extension: hit.extension ?? '',
      metaData: {
        fileType: hit.fileType ?? '',
        tags: hit.tags?.map((t) => t.name).join(', ') ?? '',
      },
    };
  }
}
