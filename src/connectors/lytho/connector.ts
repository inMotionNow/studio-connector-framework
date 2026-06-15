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

interface LythoSearchHit {
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
    hrPreviewLink: LythoDownloadLink | null;
  };
}

interface LythoSearchResult {
  type: string;
  totalHits: number;
  hits: LythoSearchHit[];
}

interface LythoSearchResponse {
  results: LythoSearchResult[];
}

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
        { method: 'GET', headers: this._fetchHeaders() }
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

    const searchRequest: Record<string, unknown> = {
      tags: [],
      tagsOR: [],
      similarFace: null,
      similarImage: null,
      colorAsHex: null,
      collectionId: (options.collection && options.collection !== '/') ? options.collection : null,
      users: [],
      permissions: [],
      terms,
      resolution: { min: 0 },
      assetTypes: [],
      metadata: [],
      extensions: [],
      formats: [],
      dateFilter: {
        modificationStart: null,
        modificationEnd: null,
        creationStart: null,
        creationEnd: null,
      },
      embargo: {
        useTimeFrameStart: null,
        useTimeFrameEnd: null,
        visibleTimeFrameStart: null,
        visibleTimeFrameEnd: null,
        filterPlannedOnly: false,
        filterInvisibleOnly: false,
        filterUnavailableOnly: false,
      },
      visibleTo: [],
      outputGenerated: [],
      customUploads: [],
      publicationStatuses: [],
      taxonomyGroupIds: [],
      module: null,
      expiredOnly: null,
      withEmbeddedLink: null,
      withTaxonomyGroup: null,
      isFingerprinted: null,
      fingerprintResults: null,
      withQuitclaims: null,
      noQuitclaims: null,
      noPermissions: false,
      isAiSearchEnabled: false,
      sortBy: [{ fieldName: 'creationDate', order: 'desc' }],
      tenant: this.runtime.options['TENANT_ID'] ?? '',
      size: pageSize,
      from,
      showDeleted: false,
      timestamp: 0,
    };

    const body: Record<string, unknown> = {
      searchIn: ['ASSETS'],
      aggregation: 'FILTERBAR',
      scrollId: null,
      searchRequest,
    };

    const result = await this.runtime.fetch(`${baseUrl}/search`, {
      method: 'POST',
      headers: this._fetchHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });

    if (!result.ok) {
      throw new ConnectorHttpError(
        result.status,
        `Lytho: Query failed ${result.status} ${result.statusText}`
      );
    }

    const json = JSON.parse(result.text) as LythoSearchResponse;
    const assetResult = json.results?.find((r) => r.type === 'ASSETS');
    const hits = assetResult?.hits ?? [];
    const totalHits = assetResult?.totalHits ?? 0;
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

    const result = await this.runtime.fetch(
      `${baseUrl}/assets/assets/${encodeURIComponent(id)}`,
      { method: 'GET', headers: this._fetchHeaders() }
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

    let path: string;
    if (previewType === 'thumbnail') {
      path = `/preview/${encodeURIComponent(id)}`;
    } else {
      path = `/hrpreview/${encodeURIComponent(id)}`;
    }

    const result = await this.runtime.fetch(`${baseUrl}${path}`, { method: 'GET', headers: this._fetchHeaders() });
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

  private _fetchHeaders(extra?: Record<string, string>): Record<string, string> {
    return { 'ngrok-skip-browser-warning': 'true', ...extra };
  }

  private _getBaseUrl(): string {
    const baseUrl = this.runtime.options['BASE_URL'];
    if (typeof baseUrl !== 'string' || baseUrl.trim().length === 0) {
      return '';
    }
    return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  }

  private _searchHitToMedia(hit: LythoSearchHit): Media.Media {
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
