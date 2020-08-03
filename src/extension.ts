import * as vscode from 'vscode';
import * as queryString from 'query-string';

import * as manifest from './manifest';
import * as ssh from './ssh';
import * as okteto from './okteto';
import * as kubernetes from './kubernetes';
import { Reporter, events } from './telemetry';
import { getCurrentRepo } from './git';

let activeManifest: string;
let reporter: Reporter;

export function activate(context: vscode.ExtensionContext) {
    let version = "0.0.0";
    const ex = vscode.extensions.getExtension('okteto.remote-kubernetes');
    if (ex) {
        version = ex.packageJSON.version;
    }

    console.log(`okteto.remote-kubernetes ${version} activated`);

    const ids = okteto.getOktetoId();
    reporter = new Reporter(version, ids.id, ids.machineId);
    reporter.track(events.activated);

    context.subscriptions.push(vscode.commands.registerCommand('okteto.up', upCommand));
    context.subscriptions.push(vscode.commands.registerCommand('okteto.down', downCommand));
    context.subscriptions.push(vscode.commands.registerCommand('okteto.install', installCmd));
    context.subscriptions.push(vscode.commands.registerCommand('okteto.create', createCmd));

    // Register URI.
    // vscode://okteto.remote-kubernetes/up?repository=localhost&manifest=frontend/okteto.yml
    vscode.window.registerUriHandler({
      async handleUri(uri: vscode.Uri) {
        const { path, query } = uri;
        const [ command ] = path.split('/').filter(Boolean);
        if (command === 'up') {
          const { repository = null, manifest = null } = queryString.parse(query);
          upCommand(
            Array.isArray(repository) ? repository.join() : repository,
            Array.isArray(manifest) ? manifest.join() : manifest
          );
        }
      }
    });
}

async function installCmd(upgrade: boolean, handleErr: boolean) {
    let title = "Installing Okteto";
    let success = `Okteto was successfully installed`;

    if (upgrade) {
        title = "Okteto is out of date, upgrading";
        success = `Okteto was successfully upgraded`;
    }

    console.log('installing okteto');
    reporter.track(events.install);
    await vscode.window.withProgress(
      {location: vscode.ProgressLocation.Notification, title: title},
      async () => {
        try {
            await okteto.install();
        } catch (err) {
            reporter.track(events.oktetoInstallFailed);
            reporter.captureError(`okteto install failed: ${err.message}`, err);
            if (handleErr) {
                vscode.window.showErrorMessage(`Okteto was not installed: ${err.message}`);
            } else {
                throw new Error(`Okteto was not installed: ${err.message}`);
            }

        }
      },
    );

    vscode.window.showInformationMessage(success);
}

async function upCommand(repository: string|null = null, path: string|null = null) {
    // console.log(await getCurrentRepo());

    // 1. Select workspace.
    if (!vscode.workspace.name) {
      console.log(`Select workspace. Repo: `, repository);
      await showWorkspacePicker(repository);
    }

    // 2. Install or upgrade okteto cli.
    const { install, upgrade } = await okteto.needsInstall();
    if (install) {
        try {
            await installCmd(upgrade, false);
        } catch(err) {
            vscode.window.showErrorMessage(err.message);
            return;
        }
    }

    // reporter.track(events.up);

    // 3. Select okteto manifest.
    let manifestUri;
    if (path) {
        const files = await vscode.workspace.findFiles(path);
        if (files.length === 0) {
            manifestUri = await showManifestPicker();
        }
    } else {
        manifestUri = await showManifestPicker();
    }

    if (!manifestUri) {
        reporter.track(events.manifestDismissed);
        return;
    }

    reporter.track(events.manifestSelected);
    const manifestPath = manifestUri.fsPath;
    console.log(`manifest selected: ${manifestPath}`);

    let m: manifest.Manifest;

    try {
        m = await manifest.getManifest(manifestPath);
    } catch (err) {
        reporter.track(events.manifestLoadFailed);
        reporter.captureError(`load manifest failed: ${err.message}`, err);
        return onOktetoFailed(`Okteto: Up failed to load your Okteto manifest: ${err.message}`);
    }

    // 4. Get kubernetes context.
    const kubeconfig = kubernetes.getKubeconfig();

    if (!m.namespace) {
        const ns = kubernetes.getCurrentNamespace(kubeconfig);
        if (!ns) {
            vscode.window.showErrorMessage("Couldn't detect your current Kubernetes context.");
            return;
        }

        m.namespace = ns;
    }

    // 5. Set up developer container.
    okteto.up(manifestPath, m.namespace, m.name, kubeconfig);
    activeManifest = manifestPath;

    try{
        await waitForUp(m.namespace, m.name);
    } catch(err) {
        reporter.captureError(`okteto up failed: ${err.message}`, err);
        return onOktetoFailed(err.message);
    }

    await finalizeUp(m.namespace, m.name);
}

async function waitForUp(namespace: string, name: string) {
    await vscode.window.withProgress(
        {location: vscode.ProgressLocation.Notification, cancellable: true },
          async (progress, token) => {
              token.onCancellationRequested(() => {
                  reporter.track(events.upCancelled);
                  vscode.commands.executeCommand('okteto.down');
              });

              const result = await waitForFinalState(namespace, name, progress);
              if (!result.result) {
                  reporter.track(events.oktetoUpFailed);
                  console.error(result.message);
                  throw new Error(`Okteto: Up command failed: ${result.message}`);
              }
          });
}

async function waitForFinalState(namespace: string, name:string, progress: vscode.Progress<{message?: string | undefined; increment?: number | undefined}>): Promise<{result: boolean, message: string}> {
    const seen = new Map<string, boolean>();
    const messages = okteto.getStateMessages();
    progress.report({  message: "Launching your development environment..." });
    var counter = 0;
    var timeout = 5 * 60; // 5 minutes
    while (true) {
        const res = await okteto.getState(namespace, name);
        if (!seen.has(res.state)) {
            progress.report({ message: messages.get(res.state) });
            console.log(`okteto is ${res.state}`);
        }

        seen.set(res.state, true);

        if (okteto.state.ready === res.state) {
            return {result: true, message: ''};
        } else if(okteto.state.failed === res.state) {
            return {result: false, message: res.message};
        }

        counter++;
        if (counter === timeout) {
            return {result: false, message: `task didn't finish in 5 minutes`};
        }

        await sleep(1000);
    }
}

async function sleep(ms: number) {
    return new Promise<void>(resolve => setTimeout(resolve, 1000));
}

async function finalizeUp(namespace: string, name: string) {
    reporter.track(events.upReady);
    reporter.track(events.upFinished);
    okteto.notifyIfFailed(namespace, name, onOktetoFailed);
    vscode.window.showInformationMessage("Your development container is ready!");
}

async function downCommand() {
    const { install, upgrade } = await okteto.needsInstall();
    if (install){
        try {
            await installCmd(upgrade, false);
        } catch (err){
            vscode.window.showErrorMessage(err.message);
            return;
        }
    }

    reporter.track(events.down);
    const manifestPath = await getManifestOrAsk();
    if (!manifestPath) {
        return;
    }

    let m: manifest.Manifest;

    try {
        m = await manifest.getManifest(manifestPath);
    } catch (err) {
        reporter.track(events.manifestLoadFailed);
        reporter.captureError(`load manifest failed: ${err.message}`, err);
        return onOktetoFailed(`Okteto: Down failed to load your Okteto manifest: ${err.message}`);
    }

    const kubeconfig = kubernetes.getKubeconfig();

    if (!m.namespace) {
        const ns = kubernetes.getCurrentNamespace(kubeconfig);
        if (!ns) {
            vscode.window.showErrorMessage("Couldn't detect your current Kubernetes context.");
            return;
        }

        m.namespace = ns;
    }

    try {
        await okteto.down(manifestPath, m.namespace, kubeconfig);
        activeManifest = '';
        vscode.window.showInformationMessage("Okteto environment deactivated");
        reporter.track(events.downFinished);
    } catch (err) {
        reporter.track(events.oktetoDownFailed);
        reporter.captureError(`okteto down failed: ${err.message}`, err);
        vscode.window.showErrorMessage(`Okteto: Down failed: ${err.message}`);
    }
}

async function getManifestOrAsk(): Promise<string | undefined> {
    if (activeManifest) {
        return activeManifest;
    } else {
        const manifestUri = await showManifestPicker();
        if (manifestUri) {
            reporter.track(events.manifestSelected);
            return manifestUri.fsPath;
        } else {
            reporter.track(events.manifestDismissed);
        }
    }
}

async function createCmd(){
    reporter.track(events.create);

    const { install, upgrade } = await okteto.needsInstall();
    if (install) {
        try {
            await installCmd(upgrade, false);
        } catch(err) {
            vscode.window.showErrorMessage(err.message);
            return;
        }
    }

    const manifestPath = manifest.getDefaultLocation();
    if (!manifestPath) {
        reporter.track(events.createFailed);
        vscode.window.showErrorMessage(`Okteto: Create failed: Couldn't detect your project's path`);
        return;
    }

    const choice = await vscode.window.showQuickPick(okteto.getLanguages(), {canPickMany: false, placeHolder: 'Select your development runtime'});
    if (!choice) {
        return;
    }

    try {
        await okteto.init(manifestPath, choice.value);
    } catch (err) {
        reporter.track(events.oktetoInitFailed);
        reporter.captureError(`okteto init failed: ${err.message}`, err);
        vscode.window.showErrorMessage(`Okteto: Create failed: ${err}`);
        return;
    }

    try {
        await vscode.commands.executeCommand('vscode.openFolder', manifestPath);
    } catch (err) {
        reporter.track(events.createOpenFailed);
        reporter.captureError(`open folder failed ${err.message}`, err);
        vscode.window.showErrorMessage(`Okteto: Create failed: Couldn't open ${manifestPath}`);
        return;
    }
}

function onOktetoFailed(message: string) {
    vscode.window.showErrorMessage(message);
    okteto.showTerminal();
}

async function showManifestPicker() : Promise<vscode.Uri | undefined> {
    const files = await vscode.workspace.findFiles('**/okteto.{yml,yaml}', '**/node_modules/**');
    if (files.length === 0) {
        await vscode.window.showErrorMessage(`No manifests found in your workspace.\n
Please run the 'Okteto: Create Manifest' command to create it and then try again.`, {
            modal: true
        });
        return;
    }
    const items = files.map(file => {
        return {
            label: vscode.workspace.asRelativePath(file, true),
            uri: file
        };
    });
    const manifestItem = await vscode.window.showQuickPick(items, {
        canPickMany: false,
        placeHolder: 'Select your okteto manifest'
    });
    return manifestItem ? manifestItem.uri : undefined;
}

async function showWorkspacePicker(repository: string|null = null) : Promise<boolean> {
    // Current git repo === repo up? => showpicker
    // List recent workspaces that can be the one we want
    // Show option to Clone repository...
    // Select directory where to clone.
    // open directory that we just cloned.
    //updateWorkspaceFolders
    const items = [];
    if (repository) {
      items.push({
          label: `Clone repository "${repository}" and open folder...`,
          option: 'clone'
      });
    }

    items.push({
        label: `Open existing folder...`,
        option: 'open'
    });

    const selectedItem = await vscode.window.showQuickPick(items, {
        canPickMany: false,
        placeHolder: 'Choose your application\'s workspace'
    });

    if (selectedItem?.option === 'clone') {
      await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: `Cloning repository "${repository}"...`
        },
        async () => {
            return await sleep(3000);
        },
      );
    } else if (selectedItem?.option === 'open') {
        const uri = await vscode.window.showOpenDialog({
            canSelectFolders: true,
            canSelectFiles: false,
            canSelectMany: false
        });
        if (uri && uri.length > 0) {
            const path = uri[0].path.split('/');
            const name = path.length > 0 ? path[path.length - 1] : uri[0].path;
            console.log('Name: ', name);
            const success = vscode.workspace.updateWorkspaceFolders(
              vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders.length : 0,
              null, {
                name,
                uri: uri[0]
              });
              await sleep(1000);
              return success;
        }
    }
    return false;
}
