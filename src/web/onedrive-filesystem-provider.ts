import * as vscode from 'vscode';
import { ClientProvider } from './client-provider';
import { OneDriveClient, ResponseError } from './onedrive-types';

export class OneDriveFileSystemProvider implements vscode.FileSystemProvider {
  public static readonly scheme = 'onedrive';
  private readonly changeEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  private watcher?: { count: number; cts: vscode.CancellationTokenSource };

  constructor(private readonly client: ClientProvider) {}

  /** @inheritdoc */
  public readonly onDidChangeFile = this.changeEmitter.event;

  /** @inheritdoc */
  watch(uri: vscode.Uri, options: { recursive: boolean; excludes: string[] }): vscode.Disposable {
    // we just watch the root, once, here. VS Code and extensions can request
    // watchers for child directories, but usually someone will always request
    // a watcher for the workspace and there's no need to duplicate them.

    if (this.watcher) {
      this.watcher.count++;
    } else {
      const { driveId } = this.parseUri(uri);
      const cts = new vscode.CancellationTokenSource();

      this.client.demandForFs().then(async (client) => {
        for await (const changes of client.watch(driveId, 10_000, cts.token)) {
          this.changeEmitter.fire(
            changes.map((change) => ({
              type: change.type,
              uri: vscode.Uri.from({
                scheme: OneDriveFileSystemProvider.scheme,
                authority: driveId,
                path: `/${change.path}`,
              }),
            }))
          );
        }
      });

      this.watcher = { cts, count: 1 };
    }

    let disposed = false;
    return {
      dispose: () => {
        if (!disposed && this.watcher && --this.watcher.count === 0) {
          this.watcher.cts.cancel();
          this.watcher = undefined;
        }
        disposed = true;
      },
    };
  }

  /** @inheritdoc */
  public async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const { driveId, path } = this.parseUri(uri);
    const client = await this.client.demandForFs();
    try {
      const metadata = await client.getFileMetadata(driveId, path);
      return {
        ctime: new Date(metadata.createdDateTime).getTime(),
        mtime: new Date(metadata.lastModifiedDateTime).getTime(),
        size: metadata.size,
        type: metadata.folder ? vscode.FileType.Directory : vscode.FileType.File,
      };
    } catch (e) {
      if (ResponseError.is(e, 404)) {
        throw vscode.FileSystemError.FileNotFound(uri);
      } else {
        throw e;
      }
    }
  }

  /** @inheritdoc */
  public async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const { driveId } = this.parseUri(uri);
    const client = await this.client.demandForFs();
    const parentId = await this.getItemIdForPath(uri);
    try {
      const children = await client.getNestedChildren(driveId, parentId);
      return children.value.map(({ name, folder }) => [
        name,
        folder ? vscode.FileType.Directory : vscode.FileType.File,
      ]);
    } catch (e) {
      if (ResponseError.is(e, 404)) {
        throw vscode.FileSystemError.FileNotFound(uri);
      } else {
        throw e;
      }
    }
  }

  /** @inheritdoc */
  public async createDirectory(uri: vscode.Uri): Promise<void> {
    const { driveId } = this.parseUri(uri);
    const parentId = await this.getItemIdForPath(parentUri(uri));
    const client = await this.client.demandForFs();
    await client.createFolder(driveId, parentId, basename(uri));
  }

  /** @inheritdoc */
  public async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    try {
      const { driveId, path } = this.parseUri(uri);
      const client = await this.client.demandForFs();
      return new Uint8Array(await client.downloadFile(driveId, path));
    } catch (e) {
      if (ResponseError.is(e, 404)) {
        throw vscode.FileSystemError.FileNotFound(uri);
      } else {
        throw e;
      }
    }
  }

  /** @inheritdoc */
  public async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    const { driveId, path } = this.parseUri(uri);
    const client = await this.client.demandForFs();
    await client.saveFile(driveId, path, content);
  }

  /** @inheritdoc */
  public async delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> {
    const { driveId, path } = this.parseUri(uri);
    const client = await this.client.demandForFs();
    client.delete(driveId, path);
  }

  /** @inheritdoc */
  public async rename(oldUri: vscode.Uri, newUri: vscode.Uri): Promise<void> {
    const { driveId } = this.parseUri(oldUri);
    const [itemId, newParentId] = await Promise.all([
      this.getItemIdForPath(oldUri),
      this.getItemIdForPath(parentUri(newUri)),
    ]);

    const client = await this.client.demandForFs();
    await client.move(driveId, itemId, newParentId, basename(newUri));
  }

  /** @inheritdoc */
  public async copy(source: vscode.Uri, destination: vscode.Uri) {
    const { driveId } = this.parseUri(source);
    const [itemId, newParentId] = await Promise.all([
      this.getItemIdForPath(source),
      this.getItemIdForPath(parentUri(destination)),
    ]);

    const client = await this.client.demandForFs();
    await client.copy(driveId, itemId, newParentId, basename(destination));
  }

  private async getItemIdForPath(uri: vscode.Uri) {
    try {
      const { driveId, path } = this.parseUri(uri);
      const client = await this.client.demandForFs();
      const { id } = await client.getFileMetadata(driveId, path);
      return id;
    } catch (e) {
      if (ResponseError.is(e, 404)) {
        throw vscode.FileSystemError.FileNotFound(uri);
      } else {
        throw e;
      }
    }
  }

  private parseUri(uri: vscode.Uri) {
    if (uri.scheme !== OneDriveFileSystemProvider.scheme) {
      throw new Error(`Unsupported scheme: ${uri.scheme}`);
    }

    const driveId = uri.authority;
    return { driveId, path: uri.path.replace(/^\/+/, '') };
  }
}

const parentUri = (uri: vscode.Uri) => {
  const index = uri.path.lastIndexOf('/');
  return uri.with({ path: uri.path.slice(0, index) });
};

const basename = (uri: vscode.Uri) => {
  const index = uri.path.lastIndexOf('/');
  return uri.path.slice(index + 1);
};
