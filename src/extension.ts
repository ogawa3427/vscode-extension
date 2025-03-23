// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from "vscode";

// BLE関連の定数
const DEFAULT_MTU = 20;
const REQUESTED_MTU = 512;
const DATA_HEADER_SIZE = 6;
const PROGRAM_HEADER_SIZE = 8;
const OPENBLINK_WEBIDE_VERSION = "0.3.3";

const OPENBLINK_SERVICE_UUID = "227da52ce13a412bbefbba2256bb7fbe";
const OPENBLINK_CONSOLE_CHARACTERISTIC_UUID = "a015b3de185a4252aa047a87d38ce148";
const OPENBLINK_PROGRAM_CHARACTERISTIC_UUID = "ad9fdd5611354a84923cce5a244385e7";
const OPENBLINK_MTU_CHARACTERISTIC_UUID = "ca1411513113448bb21a6a6203d253ff";

// ステータスバーアイテム
let statusBarItem: vscode.StatusBarItem;
let lastCompileTime: number | null = null;

// WebViewプロバイダーの実装
class OpenBlinkWebviewProvider {
  public static readonly viewType = 'openBlinkWebview';
  private _panel: vscode.WebviewPanel | undefined;
  private _extensionUri: vscode.Uri;
  private _outputChannel: vscode.OutputChannel;

  constructor(extensionUri: vscode.Uri, outputChannel: vscode.OutputChannel) {
    this._extensionUri = extensionUri;
    this._outputChannel = outputChannel;
  }

  public show() {
    if (this._panel) {
      this._panel.reveal(vscode.ViewColumn.One);
      return;
    }

    this._panel = vscode.window.createWebviewPanel(
      OpenBlinkWebviewProvider.viewType,
      'Open Blink',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this._extensionUri]
      }
    );

    this._panel.webview.html = this._getHtmlForWebview(this._panel.webview);

    // WebViewからのメッセージを処理
    this._panel.webview.onDidReceiveMessage(
      async message => {
        switch (message.type) {
          case 'connected':
            statusBarItem.text = "$(check)";
            statusBarItem.tooltip = `Connected to ${message.deviceName}`;
            this._outputChannel.appendLine(`Connected to device: ${message.deviceName}`);
            break;
          case 'disconnected':
            statusBarItem.text = "$(circle-slash)";
            statusBarItem.tooltip = "Not Connected to Blink Device";
            this._outputChannel.appendLine("Device disconnected");
            break;
          case 'error':
            this._outputChannel.appendLine(`Error: ${message.message}`);
            vscode.window.showErrorMessage(message.message);
            break;
          case 'compile':
            // コンパイル処理を実行
            try {
              const startTime = performance.now();
              // ここにコンパイル処理を実装
              const compileDuration = performance.now() - startTime;
              lastCompileTime = Math.round(compileDuration);
              statusBarItem.tooltip = `Connected (Last compile: ${lastCompileTime}ms)`;
              this._panel?.webview.postMessage({
                type: 'compileResult',
                message: `Compilation completed in ${lastCompileTime}ms`
              });
            } catch (error) {
              const errorMessage = error instanceof Error ? error.message : "An unknown error occurred";
              this._panel?.webview.postMessage({
                type: 'error',
                message: errorMessage
              });
            }
            break;
        }
      },
      undefined,
      []
    );

    this._panel.onDidDispose(
      () => {
        this._panel = undefined;
      },
      null,
      []
    );
  }

  private _getHtmlForWebview(webview: vscode.Webview) {
    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <meta http-equiv="Permissions-Policy" content="bluetooth=*">
        <title>Open Blink</title>
        <style>
            body {
                padding: 20px;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
            }
            button {
                padding: 8px 16px;
                margin: 5px;
                border: none;
                border-radius: 4px;
                background-color: var(--vscode-button-background);
                color: var(--vscode-button-foreground);
                cursor: pointer;
            }
            button:hover {
                background-color: var(--vscode-button-hoverBackground);
            }
            #output {
                margin-top: 20px;
                padding: 10px;
                background-color: var(--vscode-editor-background);
                border: 1px solid var(--vscode-input-border);
                border-radius: 4px;
                min-height: 100px;
                max-height: 300px;
                overflow-y: auto;
            }
        </style>
    </head>
    <body>
        <div>
            <button id="connectBtn">Connect Device</button>
            <button id="compileBtn">Compile and Blink</button>
            <button id="resetBtn">Soft Reset</button>
            <button id="disconnectBtn">Disconnect Device</button>
        </div>
        <div id="output"></div>
        <script>
            const vscode = acquireVsCodeApi();
            let device = null;
            let programCharacteristic = null;
            let consoleCharacteristic = null;
            let negotiatedMtuCharacteristic = null;
            let negotiatedMTU = ${DEFAULT_MTU};

            const outputDiv = document.getElementById('output');
            const connectBtn = document.getElementById('connectBtn');
            const compileBtn = document.getElementById('compileBtn');
            const resetBtn = document.getElementById('resetBtn');
            const disconnectBtn = document.getElementById('disconnectBtn');

            function log(message) {
                outputDiv.innerHTML += message + '<br>';
                outputDiv.scrollTop = outputDiv.scrollHeight;
            }

            connectBtn.addEventListener('click', async () => {
                try {
                    log('Starting device connection...');
                    device = await navigator.bluetooth.requestDevice({
                        filters: [{ namePrefix: 'Blink' }],
                        optionalServices: ['${OPENBLINK_SERVICE_UUID}']
                    });

                    if (!device.gatt) {
                        throw new Error('GATT Server not found');
                    }

                    const server = await device.gatt.connect();
                    const service = await server.getPrimaryService('${OPENBLINK_SERVICE_UUID}');

                    consoleCharacteristic = await service.getCharacteristic('${OPENBLINK_CONSOLE_CHARACTERISTIC_UUID}');
                    programCharacteristic = await service.getCharacteristic('${OPENBLINK_PROGRAM_CHARACTERISTIC_UUID}');
                    negotiatedMtuCharacteristic = await service.getCharacteristic('${OPENBLINK_MTU_CHARACTERISTIC_UUID}');

                    await consoleCharacteristic.startNotifications();
                    consoleCharacteristic.addEventListener('characteristicvaluechanged', (event) => {
                        const value = new TextDecoder().decode(event.target.value);
                        log('Device output: ' + value);
                    });

                    log('Successfully connected to device: ' + (device.name || 'Unknown'));
                    vscode.postMessage({ type: 'connected', deviceName: device.name });
                } catch (error) {
                    log('Connection error: ' + error);
                    vscode.postMessage({ type: 'error', message: error.toString() });
                }
            });

            compileBtn.addEventListener('click', async () => {
                try {
                    if (!programCharacteristic) {
                        throw new Error('Device is not connected');
                    }
                    vscode.postMessage({ type: 'compile' });
                } catch (error) {
                    log('Compile error: ' + error);
                    vscode.postMessage({ type: 'error', message: error.toString() });
                }
            });

            resetBtn.addEventListener('click', async () => {
                try {
                    if (!programCharacteristic) {
                        throw new Error('Device is not connected');
                    }
                    const buffer = new ArrayBuffer(2);
                    const view = new DataView(buffer);
                    view.setUint8(0, 0x01);
                    view.setUint8(1, 'R'.charCodeAt(0));
                    await programCharacteristic.writeValue(buffer);
                    log('Soft reset executed');
                    vscode.postMessage({ type: 'reset' });
                } catch (error) {
                    log('Reset error: ' + error);
                    vscode.postMessage({ type: 'error', message: error.toString() });
                }
            });

            disconnectBtn.addEventListener('click', async () => {
                try {
                    if (device?.gatt?.connected) {
                        await device.gatt.disconnect();
                        device = null;
                        programCharacteristic = null;
                        consoleCharacteristic = null;
                        negotiatedMtuCharacteristic = null;
                        negotiatedMTU = ${DEFAULT_MTU};
                        log('Device disconnected');
                        vscode.postMessage({ type: 'disconnected' });
                    }
                } catch (error) {
                    log('Disconnect error: ' + error);
                    vscode.postMessage({ type: 'error', message: error.toString() });
                }
            });

            window.addEventListener('message', event => {
                const message = event.data;
                switch (message.type) {
                    case 'compileResult':
                        log('Compilation completed: ' + message.message);
                        break;
                    case 'error':
                        log('Error: ' + message.message);
                        break;
                }
            });
        </script>
    </body>
    </html>`;
  }
}

// This method is called when your extension is activated
export function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel("Open Blink");
  outputChannel.show();
  outputChannel.appendLine(
    `OpenBlink WebIDE v${OPENBLINK_WEBIDE_VERSION} started.`
  );  

  // ステータスバーアイテムの初期化
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  statusBarItem.text = "$(circle-slash)";
  statusBarItem.tooltip = "Not Connected to Blink Device";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // WebViewプロバイダーの初期化
  const webviewProvider = new OpenBlinkWebviewProvider(context.extensionUri, outputChannel);

  // コマンドの登録
  let showWebview = vscode.commands.registerCommand(
    "open-blink-vscode-extension.showWebview",
    () => {
      vscode.window.showWarningMessage(
        "This extension is no longer supported. Please use the new version available at: [link]",
        "Open Link"
      ).then(selection => {
        if (selection === "Open Link") {
          vscode.env.openExternal(vscode.Uri.parse("https://open-vsx.org/extension/openblink/open-blink-vscode-extension-for-mac"));
        }
      });
      // webviewProvider.show(); // 必要に応じてコメントアウトまたは削除
    }
  );

  context.subscriptions.push(showWebview);
}

// This method is called when your extension is deactivated
export function deactivate() {}
