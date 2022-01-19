import * as vscode from 'vscode';
import { ClientProvider } from './client-provider';
import { OneDriveFileSystemProvider } from './onedrive-filesystem-provider';
import { openOneDrive } from './open-onedrive-command';

export function activate(context: vscode.ExtensionContext) {
  const clientProvider = new ClientProvider();

  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(
      OneDriveFileSystemProvider.scheme,
      new OneDriveFileSystemProvider(clientProvider)
    ),

    vscode.commands.registerCommand('onedrive-browser.openOneDrive', () =>
      openOneDrive(clientProvider)
    )
  );
}
