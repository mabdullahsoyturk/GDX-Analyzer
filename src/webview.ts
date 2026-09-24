import * as vscode from 'vscode';

/**
 * Version of the messages between the extension and its webviews. Increase it when
 * they change incompatibly: after an update that was installed without reloading the
 * window, the old extension code still runs while webviews load the new scripts.
 */
export const PROTOCOL = 7;

function nonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) {
    s += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return s;
}

/** HTML shell for a webview: loads media/common.css, media/table.js, media/chart.js and the given script. */
export function webviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, script: string, title: string): string {
  const media = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', f));
  const n = nonce();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${n}'; img-src blob:;">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${media('common.css')}" rel="stylesheet">
<title>${title.replace(/[<>&"]/g, '')}</title>
</head>
<body>
<div id="app" data-protocol="${PROTOCOL}"><div class="placeholder">Loading…</div></div>
<script nonce="${n}" src="${media('table.js')}"></script>
<script nonce="${n}" src="${media('chart.js')}"></script>
<script nonce="${n}" src="${media(script)}"></script>
</body>
</html>`;
}
