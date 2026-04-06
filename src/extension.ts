import * as vscode from 'vscode';
import { ChatViewProvider } from './chatViewProvider.js';

export function activate(context: vscode.ExtensionContext) {
    const provider = new ChatViewProvider(context.extensionUri, context);

    // Register the webview view provider
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            'lmStudioChat.chatView',
            provider,
            { webviewOptions: { retainContextWhenHidden: true } }
        )
    );

    // Register "New Chat" command
    context.subscriptions.push(
        vscode.commands.registerCommand('lmStudioChat.newChat', () => {
            provider.resetConversation();
        })
    );

    // Register "Set Endpoint" command
    context.subscriptions.push(
        vscode.commands.registerCommand('lmStudioChat.setEndpoint', async () => {
            const config = vscode.workspace.getConfiguration('lmStudioChat');
            const current = config.get<string>('endpoint', 'http://127.0.0.1:1234');
            
            const newEndpoint = await vscode.window.showInputBox({
                prompt: 'Enter LM Studio server URL',
                value: current,
                placeHolder: 'http://127.0.0.1:1234',
                validateInput: (value) => {
                    try {
                        const url = new URL(value);
                        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
                            return 'Only http:// or https:// URLs are allowed';
                        }
                        return null;
                    } catch {
                        return 'Please enter a valid URL (e.g. http://127.0.0.1:1234)';
                    }
                }
            });

            if (newEndpoint && newEndpoint !== current) {
                await config.update('endpoint', newEndpoint, vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage(`LM Studio endpoint set to: ${newEndpoint}`);
                // Refresh the health check so status bar updates
                provider.refreshHealthCheck();
            }
        })
    );

    // Register "Select Model" command
    context.subscriptions.push(
        vscode.commands.registerCommand('lmStudioChat.selectModel', async () => {
            await provider.showModelPicker();
        })
    );

    console.log('LM Studio Chat extension activated');
}

export function deactivate() {}
