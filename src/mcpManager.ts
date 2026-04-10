import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

// ── Config types (persisted to mcp.json) ─────────────────────────────────────

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
    private configPath: string;
    private fsWatcher?: fs.FSWatcher;
    private reloadDebounce?: ReturnType<typeof setTimeout>;

    constructor(private readonly context: vscode.ExtensionContext) {
        this.configPath = path.join(context.globalStorageUri.fsPath, 'mcp.json');
    }

    async initialize(): Promise<void> {
        // Ensure storage directory exists
        fs.mkdirSync(path.dirname(this.configPath), { recursive: true });

        // One-time migration from globalState → mcp.json
        const legacy = this.context.globalState.get<McpServerConfig[]>('mcpServers');
        if (legacy && legacy.length > 0 && !fs.existsSync(this.configPath)) {
            this.writeConfigFile(legacy);
            await this.context.globalState.update('mcpServers', undefined);
        }

        // Watch mcp.json for external edits using fs.watch (reliable for globalStorage outside workspace)
        const scheduleReload = () => {
            clearTimeout(this.reloadDebounce);
            this.reloadDebounce = setTimeout(() => this.reloadFromFile(), 400);
        };
        try {
            this.fsWatcher = fs.watch(path.dirname(this.configPath), (event, filename) => {
                if (filename === 'mcp.json') { scheduleReload(); }
            });
        } catch {
            // Directory may not exist yet; watcher will be absent but manual reload still works
        }

        // Connect enabled servers
        const configs = this.readConfigFile();
        await Promise.allSettled(configs.filter(c => c.enabled).map(c => this.connectServer(c)));
    }

    dispose(): void {
        clearTimeout(this.reloadDebounce);
        this.fsWatcher?.close();
        for (const [, client] of this.clients) {
            client.close().catch(() => {/* best-effort */});
        }
        this.clients.clear();
    }

    // ── Config file I/O ───────────────────────────────────────────────────────

    private readConfigFile(): McpServerConfig[] {
        try {
            const raw    = fs.readFileSync(this.configPath, 'utf-8');
            const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
            if (!parsed?.mcpServers || typeof parsed.mcpServers !== 'object') { return []; }

            return Object.entries(parsed.mcpServers).map(([name, entry]) => {
                const e = entry as Record<string, unknown>;
                const cfg: McpStdioConfig | McpSseConfig = e.url
                    ? { transport: 'sse',   url: String(e.url) }
                    : { transport: 'stdio', command: String(e.command ?? ''),
                        args: Array.isArray(e.args) ? e.args.map(String) : [],
                        env:  e.env && typeof e.env === 'object' ? e.env as Record<string,string> : undefined };
                return { name, enabled: true, config: cfg };
            }).filter(c => c.config.transport === 'sse' || (c.config as McpStdioConfig).command);
        } catch {
            return [];
        }
    }

    private writeConfigFile(configs: McpServerConfig[]): void {
        fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
        const mcpServers: Record<string, unknown> = {};
        for (const c of configs) {
            if (c.config.transport === 'sse') {
                mcpServers[c.name] = { url: c.config.url };
            } else {
                const entry: Record<string, unknown> = { command: c.config.command, args: c.config.args ?? [] };
                if (c.config.env) { entry.env = c.config.env; }
                mcpServers[c.name] = entry;
            }
        }
        fs.writeFileSync(this.configPath, JSON.stringify({ mcpServers }, null, 2), 'utf-8');
    }

    getServerConfigs(): McpServerConfig[] {
        return this.readConfigFile();
    }

    async saveServerConfigs(newConfigs: McpServerConfig[]): Promise<void> {
        this.writeConfigFile(newConfigs);
        // Cancel pending watcher-triggered reload; apply immediately instead
        clearTimeout(this.reloadDebounce);
        await this.reloadFromFile();
    }

    getConfigFilePath(): string {
        return this.configPath;
    }

    // ── Reload on file change ─────────────────────────────────────────────────

    private async reloadFromFile(): Promise<void> {
        const newConfigs = this.readConfigFile();
        const oldNames   = new Set(this.states.keys());
        const newNames   = new Set(newConfigs.map(c => c.name));

        // Disconnect removed servers or servers whose config/enabled state changed
        for (const name of oldNames) {
            if (!newNames.has(name)) {
                await this.disconnectServer(name);
            } else {
                const newCfg   = newConfigs.find(c => c.name === name)!;
                const oldState = this.states.get(name)!;
                const configChanged  = JSON.stringify(newCfg.config) !== JSON.stringify(oldState.config.config);
                const enabledChanged = newCfg.enabled !== oldState.config.enabled;
                if (configChanged || enabledChanged) {
                    await this.disconnectServer(name);
                }
            }
        }

        // Connect newly added or newly enabled servers (after above disconnects)
        const currentNames = new Set(this.states.keys());
        for (const cfg of newConfigs) {
            if (cfg.enabled && !currentNames.has(cfg.name)) {
                await this.connectServer(cfg);
            }
        }

        this.notifyChange();
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
                    args:    cfg.config.args ?? [],
                    env:     { ...process.env, ...(cfg.config.env ?? {}) } as Record<string, string>,
                });
            } else {
                transport = new SSEClientTransport(new URL(cfg.config.url));
            }

            const client = new Client(
                { name: 'lm-chat', version: '1.0.0' },
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
                tools:  toolsResult.tools.map(t => ({
                    name:        t.name,
                    description: t.description,
                    inputSchema: (t.inputSchema ?? {}) as object,
                })),
            });
        } catch (err) {
            // Clean up transport that may still be pending a connection
            client.close().catch(() => {/* best-effort */});
            const message = err instanceof Error ? err.message : String(err);
            this.states.set(cfg.name, {
                config: cfg, status: 'error', errorMessage: message, tools: [],
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

    getToolsSystemPromptBlock(
        instructions?: Record<string, string>,
        permissions?: Record<string, string>
    ): string {
        const connected = Array.from(this.states.values()).filter(
            s => s.status === 'connected' && s.tools.length > 0
        );

        const lines: string[] = [
            '',
            'IMPORTANT: Do NOT use <tool_call>, function_call, [TOOL_CALLS], <|tool_call|>, or any other tool-calling format.',
            'Use ONLY the exact XML tag shown below — no exceptions.',
            '',
            'MCP (Model Context Protocol) tools are available. Call them using:',
            '<mcp_call server="SERVER_NAME" tool="TOOL_NAME">{"arg1":"value1"}</mcp_call>',
            'The arguments must be a valid JSON object matching the tool\'s parameters.',
        ];

        if (connected.length === 0) {
            lines.push('No MCP servers are currently connected — the available tools will be listed here once a server is configured and connected.');
            return lines.join('\n');
        }

        lines.push(
            '',
            'Each server below may have custom context and hard permission constraints.',
            'You MUST read both sections for every server before calling any of its tools.',
            '',
            'Available MCP tools:'
        );

        for (const s of connected) {
            lines.push('', `Server: ${s.config.name}`);

            const serverInstructions = instructions?.[s.config.name]?.trim();
            if (serverInstructions) {
                lines.push(
                    '  ── Context (read before using this server) ──────────────',
                    ...serverInstructions.split('\n').map(l => `  ${l}`),
                    '  ─────────────────────────────────────────────────────────'
                );
            }

            const serverPermissions = permissions?.[s.config.name]?.trim();
            if (serverPermissions) {
                lines.push(
                    '  ── Permissions (HARD CONSTRAINTS — never violate) ────────',
                    ...serverPermissions.split('\n').map(l => `  ${l}`),
                    '  ─────────────────────────────────────────────────────────'
                );
            }

            for (const t of s.tools) {
                lines.push('');
                lines.push(`  Tool: ${t.name}`);
                if (t.description) { lines.push(`    Description: ${t.description}`); }
                const schema = t.inputSchema as {
                    properties?: Record<string, { description?: string }>;
                    required?: string[];
                };
                if (schema.properties) {
                    const required = schema.required ?? [];
                    lines.push('    Parameters:');
                    for (const [k, v] of Object.entries(schema.properties)) {
                        const req  = required.includes(k) ? ' (required)' : ' (optional)';
                        const desc = v.description ? `: ${v.description}` : '';
                        lines.push(`      ${k}${req}${desc}`);
                    }
                }
                lines.push(`    Usage: <mcp_call server="${s.config.name}" tool="${t.name}">{"param":"value"}</mcp_call>`);
            }
        }

        return lines.join('\n');
    }

    async callTool(serverName: string, toolName: string, args: object): Promise<string> {
        const client = this.clients.get(serverName);
        if (!client) {
            throw new Error(`MCP server "${serverName}" is not connected`);
        }

        const result = await client.callTool({
            name:      toolName,
            arguments: args as Record<string, unknown>,
        });

        return (result.content as Array<{ type: string; text?: string; [key: string]: unknown }>)
            .map(block => block.type === 'text' ? (block.text ?? '') : JSON.stringify(block))
            .join('\n');
    }
}
