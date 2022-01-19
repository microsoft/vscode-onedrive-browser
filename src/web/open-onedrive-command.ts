import { ClientProvider } from './client-provider';
import * as vscode from 'vscode';
import { Children, MyDrives, OneDriveClient } from './onedrive-types';
import { OneDriveFileSystemProvider } from './onedrive-filesystem-provider';

export async function openOneDrive(clientProvider: ClientProvider) {
  const client = await clientProvider.request();
  if (!client) {
    return;
  }

  const drive = await pickDriveId(client);
  if (!drive) {
    return;
  }

  if (drive.action === ItemAction.open) {
    return vscode.commands.executeCommand(
      'vscode.openFolder',
      vscode.Uri.from({
        scheme: OneDriveFileSystemProvider.scheme,
        authority: drive.driveId,
      })
    );
  }

  const context: Children.DriveItem[] = [];
  while (true) {
    const pick = await pickFolder(
      client,
      drive.driveId,
      context.length
        ? { itemId: context[context.length - 1].id, prefix: context.map((c) => c.name).join('/') }
        : undefined
    );

    if (!pick) {
      return;
    }

    if (pick.item === 'parent') {
      context.pop();
      continue;
    }

    context.push(pick.item);

    if (pick.action === ItemAction.open) {
      const uri = vscode.Uri.from({
        scheme: OneDriveFileSystemProvider.scheme,
        authority: drive.driveId,
        path: `/${context.map((c) => c.name).join('/')}`,
      });

      return vscode.commands.executeCommand(
        pick.item.folder ? 'vscode.openFolder' : 'vscode.open',
        uri
      );
    }
  }
}

const enum ItemAction {
  browse,
  open,
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const numberFormat = new Intl.NumberFormat();

type FolderPickItem = vscode.QuickPickItem & {
  item: Children.DriveItem | 'parent';
  sortText: string;
};

function pickFolder(
  client: OneDriveClient,
  driveId: string,
  context?: { itemId: string; prefix: string }
): Promise<{ item: Children.DriveItem | 'parent'; action: ItemAction } | undefined> {
  const qp = vscode.window.createQuickPick<FolderPickItem>();
  qp.ignoreFocusOut = true;
  qp.busy = true;
  qp.title = 'Pick file or folder to open';

  const children = context
    ? client.getNestedChildren(driveId, context.itemId)
    : client.getRootChildren(driveId);

  children.then((children) => {
    const items: FolderPickItem[] = children.value.map((item) => {
      const mtime = new Date(item.lastModifiedDateTime);
      const desc = `${item.lastModifiedBy.user.displayName} at ${dateFormat.format(mtime)}`;
      return item.folder
        ? {
            item,
            sortText: '\0${child.name}',
            label: `$(folder) ${item.name}`,
            description: `${numberFormat.format(item.folder.childCount)} items • ${desc}`,
            buttons: [
              {
                iconPath: new vscode.ThemeIcon('folder-opened'),
                tooltip: 'Open Drive',
              },
            ],
          }
        : {
            item,
            sortText: item.name,
            label: item.name,
            description: desc,
          };
    });

    if (context) {
      items.push({
        item: 'parent' as 'parent',
        sortText: '\0\0',
        label: '↩ Back to parent folder',
      });
    }

    items.sort((a, b) => a.sortText.localeCompare(b.sortText));

    qp.items = items;
    qp.busy = false;
  });

  qp.show();

  return new Promise((resolve) => {
    qp.onDidTriggerItemButton((e) => {
      resolve({ item: e.item.item, action: ItemAction.open });
    });
    qp.onDidAccept(() => {
      const selected = qp.selectedItems[0];
      resolve(selected ? { item: selected.item, action: ItemAction.browse } : undefined);
    });
    qp.onDidHide(() => {
      resolve(undefined);
    });
  });
}

function pickDriveId(
  client: OneDriveClient
): Promise<{ driveId: string; action: ItemAction } | undefined> {
  const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { driveId: string }>();
  qp.ignoreFocusOut = true;
  qp.busy = true;
  qp.title = 'Pick OneDrive to open';
  client.getOwnDrives().then((drives) => {
    qp.busy = false;
    qp.items = drives.value.map((drive) => ({
      driveId: drive.id,
      label: drive.name || MyDrives.getOwnerIdentity(drive)?.displayName || 'Unnamed Drive',
      description: drive.id,
      buttons: [
        {
          iconPath: new vscode.ThemeIcon('folder-opened'),
          tooltip: 'Open Drive',
        },
      ],
    }));
  });

  qp.show();

  return new Promise((resolve) => {
    qp.onDidTriggerItemButton((e) => {
      resolve({ driveId: e.item.driveId, action: ItemAction.open });
    });
    qp.onDidAccept(() => {
      const driveId = qp.selectedItems[0]?.driveId;
      resolve(driveId ? { driveId, action: ItemAction.browse } : undefined);
    });
    qp.onDidHide(() => {
      resolve(undefined);
    });
  });
}
