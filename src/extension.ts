// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from "vscode";
import noble, {
  Peripheral,
  Service,
  Characteristic,
  Descriptor,
} from "@abandonware/noble";

// BLE関連の定数
const DEFAULT_MTU = 20;
const REQUESTED_MTU = 512;
const DATA_HEADER_SIZE = 6;
const PROGRAM_HEADER_SIZE = 8;
const OPENBLINK_WEBIDE_VERSION = "0.3.3";

const OPENBLINK_SERVICE_UUID = "227da52ce13a412bbefbba2256bb7fbe";
const OPENBLINK_CONSOLE_CHARACTERISTIC_UUID =
  "a015b3de185a4252aa047a87d38ce148";
const OPENBLINK_PROGRAM_CHARACTERISTIC_UUID =
  "ad9fdd5611354a84923cce5a244385e7";
const OPENBLINK_MTU_CHARACTERISTIC_UUID = "ca1411513113448bb21a6a6203d253ff";

// BLE接続状態
let programCharacteristic: NobleCharacteristic | null = null;
let consoleCharacteristic: NobleCharacteristic | null = null;
let negotiatedMtuCharacteristic: NobleCharacteristic | null = null;
let currentDevice: NoblePeripheral | null = null;
let negotiatedMTU = DEFAULT_MTU;

// ステータスバーアイテム
let statusBarItem: vscode.StatusBarItem;
let lastCompileTime: number | null = null;

// 設定を読み込む関数
function loadKeybindingConfig(): string {
  const config = vscode.workspace.getConfiguration('open-blink-vscode-extension');
  return config.get('keybindings.compileAndBlink') || 'ctrl+s';
}

// 設定変更を監視
function setupConfigChangeListener(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('open-blink-vscode-extension.keybindings.compileAndBlink')) {
        const newKeybinding = loadKeybindingConfig();
        if (newKeybinding === '') {
          // キーバインドを無効化
          vscode.commands.executeCommand('workbench.action.removeKeybinding', 'open-blink-vscode-extension.compileAndBlink');
        } else {
          // 新しいキーバインドを設定
          vscode.commands.executeCommand('workbench.action.addKeybinding', 'open-blink-vscode-extension.compileAndBlink', newKeybinding);
        }
      }
    })
  );
}

// BLE書き込み関数
async function writeCharacteristic(
  characteristic: NobleCharacteristic,
  buffer: ArrayBuffer
) {
  const uint8Array = new Uint8Array(buffer);
  if (characteristic.properties.includes("writeWithoutResponse")) {
    return characteristic.writeAsync(uint8Array, true); // true for withoutResponse
  } else {
    console.log("writeWithoutResponse is not supported.");
    return characteristic.writeAsync(uint8Array);
  }
}

// CRC16計算関数
function crc16_reflect(crc: number, bitnum: number, data: Uint8Array): number {
  let crcout = crc;
  for (let i = 0; i < data.length; i++) {
    let c = data[i];
    for (let j = 0x80; j; j >>= 1) {
      let bit = crcout & 0x8000;
      crcout <<= 1;
      if (c & j) {
        crcout |= 1;
      }
      if (bit) {
        crcout ^= 0x1021;
      }
    }
  }
  return crcout;
}

// nobleの型定義を拡張
type NobleWithState = typeof noble & {
  state: "poweredOn" | "poweredOff" | "unknown";
  initialized: boolean;
  scanning: boolean;
  startScanningAsync: (
    serviceUUIDs?: string[],
    allowDuplicates?: boolean
  ) => Promise<void>;
  stopScanningAsync: () => Promise<void>;
};

type NobleService = Service & {
  uuid: string;
  characteristics: Characteristic[];
  getCharacteristicAsync: (uuid: string) => Promise<Characteristic>;
  discoverIncludedServicesAsync: (serviceUUIDs?: string[]) => Promise<string[]>;
  discoverCharacteristicsAsync: (
    characteristicUUIDs?: string[]
  ) => Promise<Characteristic[]>;
};

type NoblePeripheral = Omit<Peripheral, "discoverServicesAsync"> & {
  discoverServicesAsync: () => Promise<NobleService[]>;
  connectAsync: () => Promise<void>;
  disconnectAsync: () => Promise<void>;
  updateRssiAsync: () => Promise<number>;
  readHandleAsync: (handle: number) => Promise<Buffer>;
  writeHandleAsync: (
    handle: number,
    data: Buffer,
    withoutResponse: boolean
  ) => Promise<void>;
  gatt?: {
    requestMTU: (mtu: number) => Promise<number>;
  };
};

type NobleCharacteristic = Characteristic & {
  subscribeAsync: () => Promise<void>;
  unsubscribeAsync: () => Promise<void>;
  readAsync: () => Promise<DataView>;
  writeAsync: (
    data: Buffer | ArrayBuffer,
    withoutResponse?: boolean
  ) => Promise<void>;
  writeValue: (data: Buffer | ArrayBuffer) => Promise<void>;
  broadcastAsync: (broadcast: boolean) => Promise<void>;
  discoverDescriptorsAsync: () => Promise<Descriptor[]>;
  on: (
    event: string,
    callback: (data: Buffer, isNotification?: boolean) => void
  ) => void;
  service: {
    device: NoblePeripheral;
  };
};

// Emscriptenモジュールの型定義
type EmscriptenModule = {
  ccall: (
    funcName: string,
    returnType: string,
    argTypes: string[],
    args: any[]
  ) => any;
  [key: string]: any;
};

class OpenBlinkActionsViewProvider
  implements vscode.TreeDataProvider<BlinkTreeItem>
{
  public static readonly viewType = "open-blink-actions";
  private _onDidChangeTreeData: vscode.EventEmitter<
    BlinkTreeItem | undefined | null | void
  > = new vscode.EventEmitter<BlinkTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<
    BlinkTreeItem | undefined | null | void
  > = this._onDidChangeTreeData.event;
  private outputChannel: vscode.OutputChannel;
  private foundDevices: noble.Peripheral[] = [];

  constructor(outputChannel: vscode.OutputChannel) {
    this.outputChannel = outputChannel;
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  updateDeviceList(devices: noble.Peripheral[]): void {
    this.foundDevices = devices;
    this.refresh();
  }

  getTreeItem(element: BlinkTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: BlinkTreeItem): Promise<BlinkTreeItem[]> {
    if (!element) {
      // ルートレベルのアイテム
      const items: BlinkTreeItem[] = [];

      // デバイス接続ボタン
      items.push(
        new BlinkTreeItem(
          "Connect Device",
          vscode.TreeItemCollapsibleState.None,
          {
            command: "open-blink-vscode-extension.connectDevice",
            title: "Connect Device",
          }
        )
      );

      // コンパイルと書き込みボタン
      items.push(
        new BlinkTreeItem(
          "Compile and Blink",
          vscode.TreeItemCollapsibleState.None,
          {
            command: "open-blink-vscode-extension.compileAndBlink",
            title: "Compile and Blink",
          }
        )
      );

      // ソフトリセットボタン
      items.push(
        new BlinkTreeItem("Soft Reset", vscode.TreeItemCollapsibleState.None, {
          command: "open-blink-vscode-extension.softReset",
          title: "Soft Reset",
        })
      );

      // デバイス切断ボタン
      items.push(
        new BlinkTreeItem(
          "Disconnect Device",
          vscode.TreeItemCollapsibleState.None,
          {
            command: "open-blink-vscode-extension.disconnectDevice",
            title: "Disconnect Device",
          }
        )
      );

      return items;
    } else if (element.label === "Found Devices") {
      // 検出されたデバイスのリストを表示
      return this.foundDevices.map((device) => {
        const label = device.advertisement.localName || "Unknown Device";
        return new BlinkTreeItem(label, vscode.TreeItemCollapsibleState.None, {
          command: "open-blink-vscode-extension.connectToDevice",
          title: "Connect to Device",
          arguments: [device],
        });
      });
    }
    return [];
  }
}

class BlinkTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly command?: vscode.Command
  ) {
    super(label, collapsibleState);
  }
}

// This method is called when your extension is activated
export function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel("Open Blink");
  
  // 設定変更の監視を開始
  setupConfigChangeListener(context);
  
  // 初期設定を読み込む
  const initialKeybinding = loadKeybindingConfig();
  if (initialKeybinding === '') {
    vscode.commands.executeCommand('workbench.action.removeKeybinding', 'open-blink-vscode-extension.compileAndBlink');
  }

  outputChannel.show();
  outputChannel.appendLine(
    `OpenBlink WebIDE v${OPENBLINK_WEBIDE_VERSION} started.`
  );

  // ステータスバーアイテムの初期化
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left
  );
  statusBarItem.text = "$(circle-slash)";
  statusBarItem.tooltip = "Not Connected to Blink Device";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  const actionsProvider = new OpenBlinkActionsViewProvider(outputChannel);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider(
      OpenBlinkActionsViewProvider.viewType,
      actionsProvider
    )
  );

  // デバイスの接続
  let connectDevice = vscode.commands.registerCommand(
    "open-blink-vscode-extension.connectDevice",
    async () => {
      outputChannel.appendLine("=== Starting device connection process ===");

      // 接続中の状態を表示
      statusBarItem.text = "$(sync~spin)";
      statusBarItem.tooltip = "Connecting to Blink Device...";

      vscode.window.showInformationMessage("Starting device connection...");
      outputChannel.appendLine("Starting device connection...");

      try {
        outputChannel.appendLine("Getting noble instance");
        const nobleInstance = noble as NobleWithState;
        outputChannel.appendLine(
          `Current Bluetooth state: ${nobleInstance.state}`
        );
        outputChannel.appendLine(
          `Noble initialization state: ${nobleInstance.initialized}`
        );
        outputChannel.appendLine(
          `Noble scanning state: ${nobleInstance.scanning}`
        );

        // nobleの状態を確認して初期化
        if (nobleInstance.state !== "poweredOn") {
          outputChannel.appendLine("Waiting for Bluetooth initialization...");
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
              reject(new Error("Bluetooth initialization timeout"));
            }, 5000);

            noble.on("stateChange", (state) => {
              outputChannel.appendLine(`Bluetooth state changed: ${state}`);
              if (state === "poweredOn") {
                clearTimeout(timeout);
                resolve();
              } else if (state === "poweredOff") {
                clearTimeout(timeout);
                reject(new Error("Bluetooth is powered off"));
              }
            });
          });
        }
        outputChannel.appendLine("Bluetooth initialization completed");

        let quickPick:
          | vscode.QuickPick<
              vscode.QuickPickItem & { device: noble.Peripheral }
            >
          | undefined;
        let items: (vscode.QuickPickItem & { device: noble.Peripheral })[] = [];

        // デバイスの検出を開始
        nobleInstance.on("discover", async (peripheral) => {
          // outputChannel.appendLine(
          //   "検出されたデバイス名: " + peripheral.advertisement.localName
          // );

          if (peripheral.advertisement.localName?.includes("Blink")) {
            const item = {
              label: peripheral.advertisement.localName,
              description: peripheral.id,
              device: peripheral,
            };

            // 重複チェック
            if (
              !items.some((existing) => existing.description === peripheral.id)
            ) {
              items.push(item);

              // QuickPickが未作成なら作成
              if (!quickPick) {
                quickPick = vscode.window.createQuickPick();
                quickPick.items = items;
                quickPick.placeholder = "Select a Blink device to connect";

                quickPick.onDidAccept(async () => {
                  outputChannel.appendLine("quickPick.onDidAccept");
                  const selected = quickPick?.selectedItems[0];
                  if (selected && "device" in selected) {
                    // await nobleInstance.stopScanningAsync();
                    quickPick?.hide();
                    quickPick?.dispose();

                    try {
                      outputChannel.appendLine("Starting connectAsync");
                      await selected.device.connectAsync();
                      outputChannel.appendLine("connectAsync completed");

                      if (selected.device) {
                        outputChannel.appendLine(
                          "selected.device: " + selected.device
                        );
                        currentDevice = selected.device as NoblePeripheral;
                      }

                      // サービスの検出
                      outputChannel.appendLine("Starting service discovery");

                      // デバイスの状態確認
                      outputChannel.appendLine(
                        `Device state: ${selected.device.state}`
                      );

                      // サービス検出のイベントリスナーを設定
                      const servicesDiscovery = new Promise<Service[]>(
                        (resolve, reject) => {
                          selected.device.once(
                            "servicesDiscover",
                            (services: Service[]) => {
                              outputChannel.appendLine(
                                `Number of services discovered by event: ${services.length}`
                              );
                              resolve(services);
                            }
                          );

                          // タイムアウト設定
                          setTimeout(() => {
                            reject(new Error("Service discovery timeout"));
                          }, 5000); // 5秒でタイムアウト
                        }
                      );

                      // サービス検出を開始
                      selected.device.discoverServices();

                      // サービスの検出を待機
                      const services = await servicesDiscovery;
                      outputChannel.appendLine(
                        `Number of services detected: ${services.length}`
                      );

                      // 検出されたサービスの情報をログ出力
                      services.forEach((service, index) => {
                        outputChannel.appendLine(
                          `Service[${index}]: UUID = ${service.uuid}`
                        );
                      });

                      // OpenBlinkのサービスUUIDを検索
                      const openBlinkService = services.find(
                        (s) =>
                          s.uuid.replace(/-/g, "") === OPENBLINK_SERVICE_UUID
                      ) as NobleService;

                      if (!openBlinkService) {
                        throw new Error("OpenBlink service not found");
                      }
                      outputChannel.appendLine("OpenBlink service detected");

                      // デバッグ情報の追加
                      outputChannel.appendLine(
                        "\n=== OpenBlink Service Details ==="
                      );
                      outputChannel.appendLine(
                        `Service UUID: ${openBlinkService.uuid}`
                      );
                      outputChannel.appendLine(
                        `Service properties: ${Object.keys(
                          openBlinkService
                        ).join(", ")}`
                      );
                      if (openBlinkService.characteristics) {
                        outputChannel.appendLine(
                          `Existing characteristics count: ${openBlinkService.characteristics.length}`
                        );
                      }
                      outputChannel.appendLine(
                        "=== Starting Characteristic Detection ==="
                      );

                      // キャラクタリスティックの検出も同様にイベントベースで実装
                      const characteristicsDiscovery = new Promise<
                        Characteristic[]
                      >((resolve, reject) => {
                        openBlinkService.once(
                          "characteristicsDiscover",
                          (characteristics: Characteristic[]) => {
                            outputChannel.appendLine(
                              `Number of characteristics discovered by event: ${characteristics.length}`
                            );
                            resolve(characteristics);
                          }
                        );

                        setTimeout(() => {
                          reject(new Error("Characteristic detection timeout"));
                        }, 5000);
                      });

                      // キャラクタリスティック検出を開始
                      outputChannel.appendLine(
                        "Starting characteristic detection"
                      );
                      openBlinkService.discoverCharacteristics();
                      outputChannel.appendLine(
                        "Characteristic detection method call completed"
                      );

                      // キャラクタリスティックの検出を待機
                      outputChannel.appendLine(
                        "Waiting for characteristic detection"
                      );
                      const characteristics = await characteristicsDiscovery;
                      outputChannel.appendLine(
                        `Number of characteristics detected: ${characteristics.length}`
                      );

                      // 検出されたキャラクタリスティックの情報をログ出力
                      characteristics.forEach((char, index) => {
                        outputChannel.appendLine(
                          `Characteristic[${index}]: UUID = ${char.uuid}`
                        );
                      });

                      // 必要なキャラクタリスティックを取得
                      outputChannel.appendLine(
                        "\nStarting characteristic search:"
                      );
                      const consoleChar = characteristics.find(
                        (c) =>
                          c.uuid.replace(/-/g, "") ===
                          OPENBLINK_CONSOLE_CHARACTERISTIC_UUID
                      ) as NobleCharacteristic;
                      outputChannel.appendLine(
                        `Console characteristic: ${
                          consoleChar ? "found" : "not found"
                        }`
                      );

                      const programChar = characteristics.find(
                        (c) =>
                          c.uuid.replace(/-/g, "") ===
                          OPENBLINK_PROGRAM_CHARACTERISTIC_UUID
                      ) as NobleCharacteristic;
                      outputChannel.appendLine(
                        `Program characteristic: ${
                          programChar ? "found" : "not found"
                        }`
                      );

                      const mtuChar = characteristics.find(
                        (c) =>
                          c.uuid.replace(/-/g, "") ===
                          OPENBLINK_MTU_CHARACTERISTIC_UUID
                      ) as NobleCharacteristic;
                      outputChannel.appendLine(
                        `MTU characteristic: ${mtuChar ? "found" : "not found"}`
                      );

                      if (!consoleChar || !programChar || !mtuChar) {
                        throw new Error("Required characteristics not found");
                      }
                      outputChannel.appendLine("All characteristics detected");

                      // グローバル変数に保存
                      consoleCharacteristic = consoleChar;
                      programCharacteristic = programChar;
                      negotiatedMtuCharacteristic = mtuChar;

                      // コンソール通知の設定
                      outputChannel.appendLine(
                        "Starting console notification setup"
                      );
                      await consoleChar.subscribeAsync();
                      consoleChar.on("data", (data: Buffer) => {
                        const value = new TextDecoder().decode(data);
                        outputChannel.appendLine(`Device output: ${value}`);
                      });
                      outputChannel.appendLine(
                        "Console notification setup completed"
                      );

                      // MTUネゴシエーション
                      outputChannel.appendLine("Starting MTU negotiation");
                      await negotiateMTU(
                        selected.device as NoblePeripheral,
                        outputChannel
                      );
                      outputChannel.appendLine(
                        `Negotiated MTU: ${negotiatedMTU}`
                      );

                      // 接続成功の通知
                      vscode.window.showInformationMessage(
                        `Successfully connected to device ${selected.label}`
                      );
                      outputChannel.appendLine(
                        `Device ${selected.label} (${selected.description}) connection completed`
                      );

                      // 接続成功時のステータス更新
                      statusBarItem.text = "$(check)";
                      statusBarItem.tooltip = lastCompileTime
                        ? `Connected to ${selected.label} (Last compile: ${lastCompileTime}ms)`
                        : `Connected to ${selected.label}`;
                    } catch (error) {
                      const errorMessage =
                        error instanceof Error
                          ? error.message
                          : "An unknown error occurred";
                      outputChannel.appendLine(
                        `Connection error: ${errorMessage}`
                      );
                      vscode.window.showErrorMessage(
                        `Connection error: ${errorMessage}`
                      );

                      // エラー時のステータス更新
                      statusBarItem.text = "$(circle-slash)";
                      statusBarItem.tooltip = "Not Connected to Blink Device";

                      // エラー発生時のクリーンアップ
                      if (currentDevice) {
                        try {
                          await currentDevice.disconnectAsync();
                        } catch (disconnectError) {
                          outputChannel.appendLine(
                            "Error during disconnection: " + disconnectError
                          );
                        }
                      }

                      // 状態のリセット
                      currentDevice = null;
                      programCharacteristic = null;
                      consoleCharacteristic = null;
                      negotiatedMtuCharacteristic = null;
                      negotiatedMTU = DEFAULT_MTU;
                    }
                  }
                });

                quickPick.onDidHide(() => {
                  nobleInstance.stopScanningAsync();
                  quickPick?.dispose();
                });

                quickPick.show();
              } else {
                // 既存のQuickPickを更新
                quickPick.items = items;
              }
            }
          }
        });

        nobleInstance.on("servicesDiscover", (services: Service[]) => {
          outputChannel.appendLine("servicesDiscover: " + services);
          services.forEach((service) => {
            outputChannel.appendLine("service: " + service);
          });
        });

        let foundDeviceList: Peripheral[] = [];
        let scanTimeout: NodeJS.Timeout;

        outputChannel.appendLine("Starting device search...");

        // デバイスの検出を開始
        nobleInstance.on("discover", (peripheral) => {
          outputChannel.appendLine(
            `Detected device: ${
              peripheral.advertisement.localName || "No name"
            } (${peripheral.id})`
          );
          if (peripheral.advertisement.localName) {
            // 重複を防ぐ
            if (!foundDeviceList.some((d) => d.id === peripheral.id)) {
              foundDeviceList.push(peripheral);
              outputChannel.appendLine(
                `Added to device list: ${peripheral.advertisement.localName} (${peripheral.id})`
              );
              // TreeViewを更新
              actionsProvider.updateDeviceList(foundDeviceList);
            }
          }
        });

        nobleInstance.on("scanStart", () => {
          vscode.window.showInformationMessage("Starting device search...");
        });

        nobleInstance.on("scanStop", () => {
          vscode.window.showInformationMessage("Device search completed");
        });

        nobleInstance.on("error", (error: Error) => {
          vscode.window.showErrorMessage(`BLE Error: ${error.message}`);
        });

        // スキャン開始
        await nobleInstance.startScanningAsync();

        // 10秒後にスキャンを停止
        scanTimeout = setTimeout(async () => {
          await nobleInstance.stopScanningAsync();
        }, 10000);

        // クリーンアップ関数
        const cleanup = async () => {
          clearTimeout(scanTimeout);
          await nobleInstance.stopScanningAsync();
          nobleInstance.removeAllListeners("discover");
          nobleInstance.removeAllListeners("scanStart");
          nobleInstance.removeAllListeners("scanStop");
          nobleInstance.removeAllListeners("error");
        };

        // エラー発生時のクリーンアップ
        process.on("SIGINT", cleanup);
        process.on("SIGTERM", cleanup);
      } catch (error: unknown) {
        const errorMessage =
          error instanceof Error ? error.message : "An unknown error occurred";
        vscode.window.showErrorMessage(`An error occurred: ${errorMessage}`);
      }
    }
  );

  let compileAndBlink = vscode.commands.registerCommand(
    "open-blink-vscode-extension.compileAndBlink",
    async () => {
      const startTime = performance.now();
      try {
        // コンパイル中の状態を表示
        statusBarItem.text = "$(sync~spin)";
        statusBarItem.tooltip = "Compiling and Uploading...";

        // ワークスペースのルートフォルダを取得
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
          throw new Error("No workspace is open");
        }

        const rootPath = workspaceFolders[0].uri.fsPath;
        const appRbPath = vscode.Uri.joinPath(
          workspaceFolders[0].uri,
          "app.rb"
        );
        // Emscripten出力の mrbc.js / mrbc.wasm は resources フォルダに置く想定
        const mrbcJsUri = vscode.Uri.joinPath(
          context.extensionUri,
          "resources",
          "mrbc.js"
        );
        const mrbcWasmUri = vscode.Uri.joinPath(
          context.extensionUri,
          "resources",
          "mrbc.wasm"
        );

        // ファイルの存在確認
        const filePaths = [appRbPath, mrbcJsUri, mrbcWasmUri];
        for (const filePath of filePaths) {
          try {
            await vscode.workspace.fs.stat(filePath);
          } catch {
            if (filePath === appRbPath) {
              throw new Error(
                "app.rb not found. app.rb is required at the root of the workspace."
              );
            } else {
              throw new Error(`Required file (${filePath.fsPath}) not found`);
            }
          }
        }

        // app.rbの内容を読み取り
        const fileContent = await vscode.workspace.fs.readFile(appRbPath);
        const rubyCode = fileContent.toString();

        // 出力チャンネルの作成と表示

        outputChannel.appendLine("=== Starting S1 Compile and Blink ===");
        outputChannel.appendLine("=== Ruby source ===");
        outputChannel.appendLine(rubyCode);
        outputChannel.appendLine("===================");

        // Emscriptenモジュールの読み込み
        const fs = require("fs");
        const mrbcJs = fs.readFileSync(mrbcJsUri.fsPath, "utf8");
        const wasmBinary = fs.readFileSync(mrbcWasmUri.fsPath);

        // モジュールをevalで実行してModuleオブジェクトを取得
        const moduleScript = `
				var Module = {
					wasmBinary: wasmBinary,
					print: (text) => {
						console.log(text);
					},
					printErr: (text) => {
						console.error(text);
					}
				};
				${mrbcJs}
				Module;
			`;

        const mrbcModule = eval(moduleScript);
        outputChannel.appendLine("=== mrbcModule ===");
        outputChannel.appendLine(
          `Module initialized: ${
            typeof mrbcModule === "object" && mrbcModule !== null
          }`
        );
        if (mrbcModule && typeof mrbcModule === "object") {
          outputChannel.appendLine(
            `Available methods: ${Object.keys(mrbcModule).join(", ")}`
          );
        }

        await new Promise((resolve, reject) => {
          const timeoutId = setTimeout(() => {
            reject(new Error("mruby/c compiler initialization timeout"));
          }, 10000); // 10秒でタイムアウト

          mrbcModule.onRuntimeInitialized = () => {
            clearTimeout(timeoutId);
            outputChannel.appendLine(
              "\n=== mruby/c compiler initialization ==="
            );
            outputChannel.appendLine(
              "✓ mruby/c compiler initialization completed"
            );
            resolve(undefined);
          };

          // エラーハンドリングを追加
          mrbcModule.onAbort = (what: string) => {
            clearTimeout(timeoutId);
            reject(
              new Error(`mruby/c compiler initialization failed: ${what}`)
            );
          };
        });

        outputChannel.appendLine("\n=== Starting compilation ===");

        // 一時ファイルの作成
        const inputFileName = "temp_input.rb";
        const outputFileName = "temp_output.mrb";

        outputChannel.appendLine("1. Source code preparation");
        outputChannel.appendLine(`Input file: ${inputFileName}`);
        outputChannel.appendLine(`Output file: ${outputFileName}`);

        // FS.writeFileを使用してRubyコードを一時ファイルに書き込む
        mrbcModule.FS.writeFile(inputFileName, rubyCode);
        outputChannel.appendLine("✓ Temporary file creation completed");

        outputChannel.appendLine("\n2. Running compilation");
        outputChannel.appendLine("Running mruby/c compiler...");

        let result: number;
        try {
          outputChannel.appendLine("Arguments passed to the compiler:");
          outputChannel.appendLine(
            `mrbc -o ${outputFileName} ${inputFileName}`
          );

          // コンパイル前のファイル確認
          outputChannel.appendLine("\nFile system status check:");
          outputChannel.appendLine(
            "Input file exists: " +
              mrbcModule.FS.analyzePath(inputFileName).exists
          );
          outputChannel.appendLine(
            "Input file size: " +
              mrbcModule.FS.stat(inputFileName).size +
              " bytes"
          );

          // 引数を文字列配列として準備
          const args = ["mrbc", "-o", outputFileName, inputFileName];
          const argc = args.length;

          // メモリ割り当てと文字列のコピーを安全に行う
          const argv = mrbcModule._malloc(argc * 4);
          const argPointers = args.map((arg) => {
            const ptr = mrbcModule._malloc(arg.length + 1);
            mrbcModule.stringToUTF8(arg, ptr, arg.length + 1);
            return ptr;
          });

          // 引数ポインタの設定
          for (let i = 0; i < argPointers.length; i++) {
            mrbcModule.setValue(argv + i * 4, argPointers[i], "i32");
          }

          try {
            const start_mrbc = performance.now();
            result = mrbcModule._main(argc, argv);
            const end_mrbc = performance.now();

            outputChannel.appendLine(
              `\nCompilation execution time: ${(end_mrbc - start_mrbc).toFixed(
                2
              )}ms`
            );
            outputChannel.appendLine("Compilation result code: " + result);
          } finally {
            // メモリの解放を確実に行う
            argPointers.forEach((ptr) => {
              if (ptr) {
                mrbcModule._free(ptr);
              }
            });
            if (argv) {
              mrbcModule._free(argv);
            }
          }

          // コンパイル後のファイル確認
          outputChannel.appendLine(
            "Output file exists: " +
              mrbcModule.FS.analyzePath(outputFileName).exists
          );
          if (mrbcModule.FS.analyzePath(outputFileName).exists) {
            outputChannel.appendLine(
              "Output file size: " +
                mrbcModule.FS.stat(outputFileName).size +
                " bytes"
            );
          }
        } catch (compileError) {
          outputChannel.appendLine(
            "Compilation error occurred: " + compileError
          );
          throw compileError;
        }

        if (result !== 0) {
          outputChannel.appendLine("❌ Compilation failed");
          throw new Error("Compilation failed");
        }
        outputChannel.appendLine("✓ Compilation successful");

        outputChannel.appendLine("\n3. Saving compilation result");
        // コンパイル結果を読み取る
        const compiledBinary = mrbcModule.FS.readFile(outputFileName);
        outputChannel.appendLine(`Binary size: ${compiledBinary.length} bytes`);

        // ワークスペースに保存
        const outputPath = vscode.Uri.joinPath(
          workspaceFolders[0].uri,
          "output.mrb"
        );
        await vscode.workspace.fs.writeFile(
          outputPath,
          new Uint8Array(compiledBinary)
        );
        outputChannel.appendLine(
          `✓ Compilation result saved to: ${outputPath.fsPath}`
        );

        outputChannel.appendLine("\n4. Cleanup");
        // 一時ファイルの削除
        mrbcModule.FS.unlink(inputFileName);
        mrbcModule.FS.unlink(outputFileName);
        outputChannel.appendLine("✓ Temporary files deleted");

        outputChannel.appendLine("\n=== Compilation process completed ===");
        vscode.window.showInformationMessage(
          "Compilation completed successfully"
        );

        // デバイス接続チェック
        if (!programCharacteristic) {
          throw new Error(
            "Device is not connected. Please connect a device first."
          );
        }

        // ファームウェア送信処理
        outputChannel.appendLine("\n=== Starting firmware transfer ===");
        const start_send = performance.now();

        try {
          // MTUネゴシエーション
          if (
            currentDevice &&
            currentDevice.gatt &&
            currentDevice.gatt.requestMTU
          ) {
            try {
              negotiatedMTU = await currentDevice.gatt.requestMTU(
                REQUESTED_MTU
              );
              outputChannel.appendLine(
                `MTU negotiation successful: ${negotiatedMTU}`
              );
            } catch (error) {
              outputChannel.appendLine(`Using default MTU: ${DEFAULT_MTU}`);
              negotiatedMTU = DEFAULT_MTU;
            }
          } else if (negotiatedMtuCharacteristic) {
            try {
              const valueDataView =
                await negotiatedMtuCharacteristic.readAsync();
              if (valueDataView instanceof DataView) {
                const devicemtu = valueDataView.getUint16(0, true);
                negotiatedMTU = devicemtu - 3;
                outputChannel.appendLine(
                  `Device negotiation MTU: ${devicemtu}`
                );
              } else {
                throw new Error("Invalid data format received from device");
              }
            } catch (error) {
              outputChannel.appendLine(`Using default MTU: ${DEFAULT_MTU}`);
              negotiatedMTU = DEFAULT_MTU;
            }
          }

          const DATA_PAYLOAD_SIZE = negotiatedMTU - DATA_HEADER_SIZE;
          const contentLength = compiledBinary.length;
          const crc16 = crc16_reflect(0xd175, 0xffff, compiledBinary);
          const slot = 2;

          outputChannel.appendLine(
            `Starting transfer: slot=${slot}, size=${contentLength}bytes, CRC16=${crc16.toString(
              16
            )}, MTU=${negotiatedMTU}`
          );

          // データチャンクの送信
          for (
            let offset = 0;
            offset < contentLength;
            offset += DATA_PAYLOAD_SIZE
          ) {
            const chunkDataSize = Math.min(
              DATA_PAYLOAD_SIZE,
              contentLength - offset
            );
            const buffer = new ArrayBuffer(DATA_HEADER_SIZE + chunkDataSize);
            const view = new DataView(buffer);

            view.setUint8(0, 0x01); // version = 0x01
            view.setUint8(1, "D".charCodeAt(0)); // command = 'D'
            view.setUint16(2, offset, true);
            view.setUint16(4, chunkDataSize, true);

            const payload = new Uint8Array(
              buffer,
              DATA_HEADER_SIZE,
              chunkDataSize
            );
            payload.set(
              compiledBinary.subarray(offset, offset + chunkDataSize)
            );

            await writeCharacteristic(programCharacteristic, buffer);
            outputChannel.appendLine(
              `Data transfer completed: Offset=${offset}, Size=${chunkDataSize}`
            );
          }

          // プログラムヘッダーの送信
          const programBuffer = new ArrayBuffer(PROGRAM_HEADER_SIZE);
          const programView = new DataView(programBuffer);

          programView.setUint8(0, 0x01); // version = 0x01
          programView.setUint8(1, "P".charCodeAt(0)); // command = 'P'
          programView.setUint16(2, contentLength, true); // length
          programView.setUint16(4, crc16, true); // crc: CRC16
          programView.setUint8(6, slot); // slot
          programView.setUint8(7, 0); // reserved

          await writeCharacteristic(programCharacteristic, programBuffer);
          outputChannel.appendLine("Program header transfer completed");

          // リロードコマンドの送信
          const reloadBuffer = new ArrayBuffer(2);
          const reloadView = new DataView(reloadBuffer);
          reloadView.setUint8(0, 0x01); // version = 0x01
          reloadView.setUint8(1, "L".charCodeAt(0)); // command = 'L'
          await writeCharacteristic(programCharacteristic, reloadBuffer);
          outputChannel.appendLine("Reload command transfer completed");

          const end_send = performance.now();
          const compileDuration = Math.round(end_send - startTime);
          lastCompileTime = compileDuration;

          outputChannel.appendLine(
            `Firmware transfer completed! (${compileDuration}ms)`
          );
          vscode.window.showInformationMessage("Firmware transfer completed");

          // 完了時のステータス更新
          statusBarItem.text = `$(check) ${compileDuration}ms`;
          statusBarItem.tooltip = `Connected and Ready (Last compile: ${compileDuration}ms)`;
        } catch (error) {
          const errorMessage =
            error instanceof Error
              ? error.message
              : "An unknown error occurred";
          outputChannel.appendLine(`Firmware transfer error: ${errorMessage}`);
          throw error;
        }
      } catch (error: unknown) {
        const errorMessage =
          error instanceof Error ? error.message : "An unknown error occurred";
        vscode.window.showErrorMessage(`An error occurred: ${errorMessage}`);
        outputChannel.appendLine(`An error occurred: ${errorMessage}`);
      }
    }
  );

  let softReset = vscode.commands.registerCommand(
    "open-blink-vscode-extension.softReset",
    async () => {
      try {
        if (!programCharacteristic) {
          throw new Error(
            "Device is not connected. Please connect a device first."
          );
        }

        const buffer = new ArrayBuffer(2);
        const view = new DataView(buffer);
        view.setUint8(0, 0x01); // version = 0x01
        view.setUint8(1, "R".charCodeAt(0)); // command = 'R'

        await writeCharacteristic(programCharacteristic, buffer);
        vscode.window.showInformationMessage("Soft reset executed");
        outputChannel.appendLine("Soft reset executed");
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "An unknown error occurred";
        vscode.window.showErrorMessage(`Soft reset error: ${errorMessage}`);
        outputChannel.appendLine(`Soft reset error: ${errorMessage}`);
      }
    }
  );

  let disconnectDevice = vscode.commands.registerCommand(
    "open-blink-vscode-extension.disconnectDevice",
    async () => {
      try {
        if (currentDevice) {
          // 切断中の状態を表示
          statusBarItem.text = "$(sync~spin)";
          statusBarItem.tooltip = "Disconnecting...";

          await currentDevice.disconnectAsync();
          currentDevice = null;
          programCharacteristic = null;
          consoleCharacteristic = null;
          negotiatedMtuCharacteristic = null;
          negotiatedMTU = DEFAULT_MTU;
          lastCompileTime = null;

          // 切断完了時のステータス更新
          statusBarItem.text = "$(circle-slash)";
          statusBarItem.tooltip = "Not Connected to Blink Device";

          vscode.window.showInformationMessage("Device disconnected");
          outputChannel.appendLine("Device disconnected");
        } else {
          vscode.window.showInformationMessage(
            "No device is currently connected"
          );
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "An unknown error occurred";
        vscode.window.showErrorMessage(
          `Device disconnection error: ${errorMessage}`
        );
        outputChannel.appendLine(`Device disconnection error: ${errorMessage}`);
      }
    }
  );

  // let helloWorld = vscode.commands.registerCommand(
  //   "open-blink-vscode-extension.helloWorld",
  //   () => {
  //     vscode.window.showInformationMessage(
  //       "Hello World from Open Blink VSCode IDE!"
  //     );
  //     outputChannel.appendLine("Hello World from Open Blink VSCode IDE!");
  //   }
  // );

  context.subscriptions.push(
    connectDevice,
    compileAndBlink,
    softReset,
    disconnectDevice //,
    // helloWorld
  );
}

// This method is called when your extension is deactivated
export function deactivate() {}

async function negotiateMTU(
  device: NoblePeripheral,
  outputChannel: vscode.OutputChannel
) {
  try {
    if (device.gatt?.requestMTU) {
      negotiatedMTU = await device.gatt.requestMTU(REQUESTED_MTU);
      outputChannel.appendLine(`MTU negotiation successful: ${negotiatedMTU}`);
    } else if (negotiatedMtuCharacteristic) {
      try {
        const valueDataView = await negotiatedMtuCharacteristic.readAsync();
        if (valueDataView instanceof DataView) {
          const devicemtu = valueDataView.getUint16(0, true);
          negotiatedMTU = devicemtu - 3;
          outputChannel.appendLine(`Device negotiation MTU: ${devicemtu}`);
        } else {
          throw new Error("Invalid data format received from device");
        }
      } catch (error) {
        outputChannel.appendLine(`Using default MTU: ${DEFAULT_MTU}`);
        negotiatedMTU = DEFAULT_MTU;
      }
    }
  } catch (error) {
    outputChannel.appendLine(`MTU negotiation error: ${error}`);
    negotiatedMTU = DEFAULT_MTU;
  }
}
