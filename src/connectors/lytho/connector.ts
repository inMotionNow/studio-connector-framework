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
      case 'highres':
      case 'fullres':
        // On-screen canvas (web intent) can't decode raw non-raster originals (PSD/EPS/AI/TIFF).
        // Serve the DAM's rasterized hi-res twin for display; keep the original for print/animation
        // so the export pipeline preserves vector fidelity (e.g. AI) and full resolution.
        variant = intent === 'web' ? 'hrpreview' : 'content';
        break;
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
