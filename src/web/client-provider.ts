import * as vscode from 'vscode';
import { OneDriveClient } from './onedrive-types';

const CLIENT_ID = '58b63433-308f-49dd-833c-76175555e44a';

const SCOPES = [
  `VSCODE_CLIENT_ID:${CLIENT_ID}`,
  `VSCODE_TENANT:consumers`,
  'profile',
  'openid',
  'offline_access',
  'Files.ReadWrite',
];

export class ClientProvider {
  private session?: Thenable<vscode.AuthenticationSession>;

  public async demandForFs() {
    const session = await this.getSession();
    return new OneDriveClient(session.accessToken);
  }

  public async request() {
    try {
      return this.demandForFs();
    } catch {
      return undefined;
    }
  }

  private getSession() {
    this.session ??= vscode.authentication.getSession('microsoft', SCOPES, {
      createIfNone: true,
    });

    return this.session;
  }
}
