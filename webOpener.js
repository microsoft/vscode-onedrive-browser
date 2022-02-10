export default function doRoute(route) {
  // If we're not already opening a OneDrive, show the picker immediately
  // when the user hits `vscode.dev/+ms-vscode.onedrive-browser`.
  if (route.workspace.folderUri?.scheme !== 'onedrive') {
    route.onDidCreateWorkbench.runCommands.push({
      command: 'onedrive-browser.openOneDrive',
      args: [],
    });
  }
}
