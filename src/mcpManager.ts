import * as vscode from 'vscode';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

// ── Config types (persisted to globalState) ───────────────────────────────────

export interface McpStdioConfig {
    transport: 'stdio';
    command: string;
    args?: string[];
    env?: Record<string, string>;
}

export interface McpSseConfig {
    transport: 'sse';
    url: string;
}

export interface McpServerConfig {
    name: string;
    enabled: boolean;
    config: McpStdioConfig | McpSseConfig;
}

// ── Runtime types (not persisted) ────────────────────────────────────────────

export type McpServerStatus = 'connecting' | 'connected' | 'error' | 'disconnected';

export interface McpToolInfo {
    name: string;
    description?: string;
    inputSchema: object;
}

export interface McpServerState {
    config: McpServerConfig;
    status: McpServerStatus;
    errorMessage?: string;
    tools: McpToolInfo[];
}

// ── Manager ───────────────────────────────────────────────────────────────────

export class McpManager {
    private states: Map<string, McpServerState> = new Map();
    private clients: Map<string, Client> = new Map();
    private statusChangeCallback?: () => void;

    constructor(private readonly context: vscode.ExtensionContext) {}

    async initialize(): Promise<void> {
        const configs = this.getServerConfigs();
        await Promise.allSettled(
            configs.filter(c => c.enabled).map(c => this.connectServer(c))
        );
    }

    dispose(): void {
        for (const [, client] of this.clients) {
            client.close().catch(() => {/* best-effort */});
        }
        this.clients.clear();
    }

    // ── Config management ─────────────────────────────────────────────────────

    getServerConfigs(): McpServerConfig[] {
        return this.context.globalState.get<McpServerConfig[]>('mcpServers', []);
    }

    async saveServerConfigs(newConfigs: McpServerConfig[]): Promise<void> {
        await this.context.globalState.update('mcpServers', newConfigs);

        const oldNames = new Set(this.states.keys());
        const newNames = new Set(newConfigs.map(c => c.name));

        // Disconnect removed servers
        for (const name of oldNames) {
            if (!newNames.has(name)) {
                await this.disconnectServer(name);
            }
        }

        // Connect new servers
        for (const cfg of newConfigs) {
            if (!oldNames.has(cfg.name) && cfg.enabled) {
                await this.connectServer(cfg);
            }
        }
    }

    // ── Connection ────────────────────────────────────────────────────────────

    private async connectServer(cfg: McpServerConfig): Promise<void> {
        this.states.set(cfg.name, { config: cfg, status: 'connecting', tools: [] });
        this.notifyChange();

        try {
            let transport;
            if (cfg.config.transport === 'stdio') {
                transport = new StdioClientTransport({
                    command: cfg.config.command,
                    args: cfg.config.args ?? [],
                    env: { ...process.env, ...(cfg.config.env ?? {}) } as Record<string, string>,
                });
            } else {
                transport = new SSEClientTransport(new URL(cfg.config.url));
            }

            const client = new Client(
                { name: 'lm-studio-chat', version: '1.0.0' },
                { capabilities: {} }
            );

            await Promise.race([
                client.connect(transport),
                new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error('Connection timeout after 10s')), 10_000)
                ),
            ]);

            const toolsResult = await client.listTools();
            this.clients.set(cfg.name, client);
            this.states.set(cfg.name, {
                config: cfg,
                status: 'connected',
                tools: toolsResult.tools.map(t => ({
                    name: t.name,
                    description: t.description,
                    inputSchema: (t.inputSchema ?? {}) as object,
                })),
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.states.set(cfg.name, {
                config: cfg,
                status: 'error',
                errorMessage: message,
                tools: [],
            });
        }

        this.notifyChange();
    }

    private async disconnectServer(name: string): Promise<void> {
        const client = this.clients.get(name);
        if (client) {
            client.close().catch(() => {/* best-effort */});
            this.clients.delete(name);
        }
        this.states.delete(name);
        this.notifyChange();
    }

    // ── Status ────────────────────────────────────────────────────────────────

    getServerStatuses(): McpServerState[] {
        return Array.from(this.states.values());
    }

    onStatusChange(cb: () => void): void {
        this.statusChangeCallback = cb;
    }

    private notifyChange(): void {
        this.statusChangeCallback?.();
    }

    // ── Tool access ───────────────────────────────────────────────────────────

    getToolsSystemPromptBlock(): string {
        const connected = Array.from(this.states.values()).filter(
            s => s.status === 'connected' && s.tools.length > 0
        );
        if (connected.length === 0) { return ''; }

        const lines: string[] = [
            '',
            'You also have access to MCP (Model Context Protocol) tools from connected servers.',
            'Call them using:',
            '<mcp_call server="SERVER_NAME" tool="TOOL_NAME">{"arg1":"value1"}</mcp_call>',
            '',
            'Available MCP tools:',
        ];

        for (const s of connected) {
            for (const t of s.tools) {
                lines.push('');
                lines.push(`Server: ${s.config.name}  Tool: ${t.name}`);
                if (t.description) {
                    lines.push(`  Description: ${t.description}`);
                }
                const schema = t.inputSchema as { properties?: Record<string, { description?: string }>; required?: string[] };
                if (schema.properties) {
                    const required = schema.required ?? [];
                    lines.push('  Parameters:');
                    for (const [k, v] of Object.entries(schema.properties)) {
                        const req = required.includes(k) ? ' (required)' : ' (optional)';
                        const desc = v.description ? `: ${v.description}` : '';
                        lines.push(`    ${k}${req}${desc}`);
                    }
                }
                lines.push(`  Usage: <mcp_call server="${s.config.name}" tool="${t.name}">{"param":"value"}</mcp_call>`);
            }
        }

        return lines.join('\n');
    }

    async callTool(serverName: string, toolName: string, args: object): Promise<string> {
        const client = this.clients.get(serverName);
        if (!client) {
            throw new Error(`MCP server "${serverName}" is not connected`);
        }

        const result = await client.callTool({ name: toolName, arguments: args as Record<string, unknown> });

        return (result.content as Array<{ type: string; text?: string; [key: string]: unknown }>)
            .map(block => {
                if (block.type === 'text') { return block.text ?? ''; }
                return JSON.stringify(block);
            })
            .join('\n');
    }
}
