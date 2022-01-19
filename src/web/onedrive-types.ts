import * as vscode from 'vscode';

const root = 'https://graph.microsoft.com/v1.0/';

export class ResponseError extends Error {
  public static is(e: unknown, statusCode: number): e is ResponseError {
    return e instanceof ResponseError && e.response.status === statusCode;
  }

  constructor(public readonly response: Response, public readonly body: string) {
    super(`${response.status} ${response.statusText} from ${response.url}: ${body}`);
  }
}

export class OneDriveClient {
  constructor(private readonly accessToken: string) {}

  public getOwnDrives(): Promise<MyDrives.Response> {
    return this.fetchJson(`me/drives`);
  }

  public getRootChildren(driveId: string): Promise<Children.Response> {
    return this.fetchJson(`drives/${driveId}/root/children`);
  }

  public getFileMetadata(driveId: string, filePath: string): Promise<Children.DriveItem> {
    return this.fetchJson(`drives/${driveId}/root:/${filePath}`);
  }

  public getNestedChildren(driveId: string, itemId: string): Promise<Children.Response> {
    return this.fetchJson(`drives/${driveId}/items/${itemId}/children`);
  }

  public createFolder(
    driveId: string,
    parentId: string,
    folderName: string
  ): Promise<Children.DriveItem> {
    return this.fetchJson(`drives/${driveId}/items/${parentId}/children`, {
      method: 'POST',
      headers: new Headers([['Content-Type', 'application/json']]),
      body: JSON.stringify({
        name: folderName,
        folder: {},
        '@microsoft.graph.conflictBehavior': 'rename',
      }),
    });
  }

  public async downloadFile(driveId: string, filePath: string) {
    const res = await this.fetch(`drives/${driveId}/items/root:/${encodeURI(filePath)}:/content`, {
      redirect: 'follow',
    });

    return res.arrayBuffer();
  }

  public async delete(driveId: string, path: string): Promise<void> {
    try {
      await this.fetch(`drives/${driveId}/items/root:/${encodeURI(path)}`, {
        method: 'DELETE',
      });
    } catch (e) {
      if (!ResponseError.is(e, 404)) {
        throw e;
      }
    }
  }

  public move(driveId: string, itemId: string, newParentId: string, newName: string) {
    return this.fetchJson(`drives/${driveId}/items/${itemId}`, {
      method: 'PATCH',
      headers: new Headers([['Content-Type', 'application/json']]),
      body: JSON.stringify({
        name: newName,
        parentReference: {
          id: newParentId,
        },
      }),
    });
  }

  public copy(driveId: string, itemId: string, newParentId: string, newName: string) {
    return this.fetchJson(`drives/${driveId}/items/${itemId}/copy`, {
      method: 'POST',
      headers: new Headers([['Content-Type', 'application/json']]),
      body: JSON.stringify({
        name: newName,
        parentReference: {
          id: newParentId,
        },
      }),
    });
  }

  public saveFile(
    driveId: string,
    filename: string,
    body: Uint8Array,
    mimeType?: string
  ): Promise<Children.DriveItem> {
    const headers = new Headers();
    if (mimeType) {
      headers.set('content-type', mimeType);
    }

    return this.fetchJson(`drives/${driveId}/items/root:/${encodeURI(filename)}:/content`, {
      method: 'PUT',
      body,
      headers,
    });
  }

  public async *watch(driveId: string, interval: number, ct: vscode.CancellationToken) {
    const loadDelta = async (routeOrUrl: string) => {
      const res = await this.fetch(routeOrUrl);
      const currentDate = res.headers.get('Date');

      const response: DeltaResponse = await res.json();
      while (response['@odata.nextLink']) {
        const next = await this.fetchJson<DeltaResponse>(response['@odata.nextLink']);
        response.value = response.value.concat(next.value);
        response['@odata.deltaLink'] = next['@odata.deltaLink'];
        response['@odata.nextLink'] = next['@odata.nextLink'];
      }

      return new DeltaResultInteractor(response, currentDate);
    };

    let results = await loadDelta(`drives/${driveId}/items/root/delta`);

    while (!ct.isCancellationRequested) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          l.dispose();
          resolve();
        }, interval);
        const l = ct.onCancellationRequested(() => {
          clearTimeout(timeout);
          resolve();
        });
      });

      if (ct.isCancellationRequested) {
        return;
      }

      const next = await loadDelta(results.next);
      if (ct.isCancellationRequested) {
        return;
      }

      const changes = [...next].map((value) => {
        const path = next.getPathForItem(value);

        if (value.deleted) {
          return { type: vscode.FileChangeType.Deleted, path };
        } else if (new Date(value.createdDateTime)) {
          return { type: vscode.FileChangeType.Created, path };
        } else {
          return { type: vscode.FileChangeType.Changed, path };
        }
      });

      yield changes;
      results = next;
    }
  }

  private async fetch(route: string, params: RequestInit = {}) {
    params.headers = new Headers(params.headers);
    params.headers.set('authorization', `Bearer ${this.accessToken}`);

    const response = await fetch(route.startsWith('https:') ? route : root + route, params);
    if (!response.ok) {
      let body: string;
      try {
        body = await response.text();
      } catch {
        body = '<unreadable>';
      }

      throw new ResponseError(response, body);
    }

    return response;
  }

  private async fetchJson<T>(route: string, params?: RequestInit): Promise<T> {
    const response = await this.fetch(route, params);
    return await response.json();
  }
}

const driveRootPrefix = '/drive/root:';

class DeltaResultInteractor {
  private readonly results = new Map<string, Children.DriveItem>();
  private readonly lastUpdated: number;
  public readonly next: string;

  constructor(res: DeltaResponse, dateHeader: string | null) {
    this.lastUpdated = dateHeader ? new Date(dateHeader).getTime() : Date.now();
    this.next = res['@odata.deltaLink'];
    for (const item of res.value) {
      this.results.set(item.id, item);
    }
  }

  public isNew(item: Children.DriveItem) {
    return new Date(item.createdDateTime).getTime() > this.lastUpdated;
  }

  public getPathForItem(item: Children.DriveItem): string {
    if (item.root) {
      return '';
    }

    if (!item.parentReference) {
      return item.name;
    }

    if (item.parentReference.path === driveRootPrefix) {
      return item.name;
    }

    if (item.parentReference.path) {
      return item.parentReference.path.slice(driveRootPrefix.length + 1) + '/' + item.name;
    }

    const parentItem = this.results.get(item.parentReference.id);
    return parentItem ? this.getPathForItem(parentItem) + '/' + item.name : item.name;
  }

  [Symbol.iterator]() {
    return this.results.values();
  }
}

export namespace Common {
  export interface Thumbnail {
    height: number;
    sourceItemId: string;
    url: string;
    width: number;
  }
  export interface Thumbnails {
    id: string;
    large?: Thumbnail;
    medium?: Thumbnail;
    small?: Thumbnail;
    source?: Thumbnail;
  }

  export interface GraphIdentity {
    displayName: string;
    id: string;
    thumbnails?: Thumbnails;
  }
}

export namespace MyDrives {
  export interface User {
    displayName: string;
    id: string;
  }

  export interface Owner {
    user: User;
  }

  export interface StoragePlanInformation {
    upgradeAvailable: boolean;
  }

  export interface Quota {
    deleted: number;
    remaining: number;
    state: string;
    total: number;
    used: number;
    storagePlanInformation: StoragePlanInformation;
  }

  export interface Drive {
    driveType: 'personal' | 'business' | 'documentLibrary';
    id: string;
    name?: string;
    owner:
      | { user: Common.GraphIdentity }
      | { application: Common.GraphIdentity }
      | { device: Common.GraphIdentity };
    quota: Quota;
  }

  export const getOwnerIdentity = (value: Drive) => {
    if ('user' in value.owner) {
      return value.owner.user;
    } else if ('application' in value.owner) {
      return value.owner.application;
    } else if ('device' in value.owner) {
      return value.owner.device;
    }
  };

  export interface Response {
    value: Drive[];
  }
}

interface DeltaResponse {
  '@odata.deltaLink': string;
  '@odata.nextLink': string;
  '@odata.context': string;
  value: Children.DriveItem[];
}

export namespace Children {
  export interface Response {
    '@odata.context': string;
    '@odata.count': number;
    value: DriveItem[];
  }

  export interface DriveItem {
    createdDateTime: Date;
    cTag: string;
    eTag: string;
    id: string;
    lastModifiedDateTime: Date;
    name: string;
    size: number;
    webUrl: string;
    reactions: Reactions;
    createdBy: EdBy;
    lastModifiedBy: EdBy;
    parentReference: ParentReference;
    fileSystemInfo: FileSystemInfo;
    root?: {};
    folder?: Folder;
    specialFolder?: SpecialFolder;
    deleted?: { state: string };
    '@microsoft.graph.downloadUrl'?: string;
    file?: File;
    image?: Image;
    photo?: Photo;
  }

  export interface EdBy {
    user: Common.GraphIdentity;
    application?: Common.GraphIdentity;
    device?: Common.GraphIdentity;
    oneDriveSync?: Common.GraphIdentity;
  }

  export interface File {
    mimeType: string;
    hashes: Hashes;
  }

  export interface Hashes {
    quickXorHash?: string;
    sha1Hash: string;
    sha256Hash?: string;
    crc32Hash?: string;
  }

  export interface FileSystemInfo {
    createdDateTime: Date;
    lastModifiedDateTime: Date;
  }

  export interface Folder {
    childCount: number;
    view: View;
  }

  export interface View {
    viewType: string;
    sortBy: string;
    sortOrder: string;
  }

  export interface Image {
    height: number;
    width: number;
  }

  export interface ParentReference {
    driveId: string;
    driveType: string;
    id: string;
    path?: string;
    name?: string;
  }

  export interface Photo {
    cameraMake?: string;
    cameraModel?: string;
    exposureDenominator?: number;
    exposureNumerator?: number;
    focalLength?: number;
    fNumber?: number;
    iso?: number;
    orientation?: number;
    takenDateTime?: Date;
  }

  export interface Reactions {
    commentCount: number;
  }

  export interface SpecialFolder {
    name: string;
  }
}
