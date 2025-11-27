#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import { spawn } from 'child_process';
import * as readline from 'readline';
import * as path from 'path';
// Map to store active GDB sessions
const activeSessions = new Map();
class GdbServer {
    constructor() {
        this.server = new Server({
            name: 'mcp-gdb-server',
            version: '0.1.0',
        }, {
            capabilities: {
                tools: {},
            },
        });
        this.setupToolHandlers();
        // Error handling
        this.server.onerror = (error) => console.error('[MCP Error]', error);
        process.on('SIGINT', async () => {
            // Clean up all active GDB sessions
            for (const [id, session] of activeSessions.entries()) {
                await this.terminateGdbSession(id);
            }
            await this.server.close();
            process.exit(0);
        });
    }
    setupToolHandlers() {
        this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: [
                {
                    name: 'gdb_start',
                    description: 'Start a new GDB session',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            gdbPath: {
                                type: 'string',
                                description: 'Path to the GDB executable (optional, defaults to "gdb")'
                            },
                            workingDir: {
                                type: 'string',
                                description: 'Working directory for GDB (optional)'
                            }
                        }
                    }
                },
                {
                    name: 'gdb_load',
                    description: 'Load a program into GDB',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            sessionId: {
                                type: 'string',
                                description: 'GDB session ID'
                            },
                            program: {
                                type: 'string',
                                description: 'Path to the program to debug'
                            },
                            arguments: {
                                type: 'array',
                                items: {
                                    type: 'string'
                                },
                                description: 'Command-line arguments for the program (optional)'
                            }
                        },
                        required: ['sessionId', 'program']
                    }
                },
                {
                    name: 'gdb_command',
                    description: 'Execute a GDB command',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            sessionId: {
                                type: 'string',
                                description: 'GDB session ID'
                            },
                            command: {
                                type: 'string',
                                description: 'GDB command to execute'
                            }
                        },
                        required: ['sessionId', 'command']
                    }
                },
                {
                    name: 'gdb_terminate',
                    description: 'Terminate a GDB session',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            sessionId: {
                                type: 'string',
                                description: 'GDB session ID'
                            }
                        },
                        required: ['sessionId']
                    }
                },
                {
                    name: 'gdb_list_sessions',
                    description: 'List all active GDB sessions',
                    inputSchema: {
                        type: 'object',
                        properties: {}
                    }
                },
                {
                    name: 'gdb_connect_remote',
                    description: 'Connect to a remote GDB server',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            sessionId: {
                                type: 'string',
                                description: 'GDB session ID'
                            },
                            host: {
                                type: 'string',
                                description: 'Hostname or IP address of the remote GDB server'
                            },
                            port: {
                                type: 'number',
                                description: 'Port number of the remote GDB server'
                            }
                        },
                        required: ['sessionId', 'host', 'port']
                    }
                },
                {
                    name: 'gdb_attach',
                    description: 'Attach to a running process',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            sessionId: {
                                type: 'string',
                                description: 'GDB session ID'
                            },
                            pid: {
                                type: 'number',
                                description: 'Process ID to attach to'
                            }
                        },
                        required: ['sessionId', 'pid']
                    }
                },
                {
                    name: 'gdb_load_core',
                    description: 'Load a core dump file',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            sessionId: {
                                type: 'string',
                                description: 'GDB session ID'
                            },
                            program: {
                                type: 'string',
                                description: 'Path to the program executable'
                            },
                            corePath: {
                                type: 'string',
                                description: 'Path to the core dump file'
                            }
                        },
                        required: ['sessionId', 'program', 'corePath']
                    }
                },
                {
                    name: 'gdb_set_breakpoint',
                    description: 'Set a breakpoint',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            sessionId: {
                                type: 'string',
                                description: 'GDB session ID'
                            },
                            location: {
                                type: 'string',
                                description: 'Breakpoint location (e.g., function name, file:line)'
                            },
                            condition: {
                                type: 'string',
                                description: 'Breakpoint condition (optional)'
                            }
                        },
                        required: ['sessionId', 'location']
                    }
                },
                {
                    name: 'gdb_continue',
                    description: 'Continue program execution',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            sessionId: {
                                type: 'string',
                                description: 'GDB session ID'
                            }
                        },
                        required: ['sessionId']
                    }
                },
                {
                    name: 'gdb_step',
                    description: 'Step program execution',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            sessionId: {
                                type: 'string',
                                description: 'GDB session ID'
                            },
                            instructions: {
                                type: 'boolean',
                                description: 'Step by instructions instead of source lines (optional)'
                            }
                        },
                        required: ['sessionId']
                    }
                },
                {
                    name: 'gdb_next',
                    description: 'Step over function calls',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            sessionId: {
                                type: 'string',
                                description: 'GDB session ID'
                            },
                            instructions: {
                                type: 'boolean',
                                description: 'Step by instructions instead of source lines (optional)'
                            }
                        },
                        required: ['sessionId']
                    }
                },
                {
                    name: 'gdb_finish',
                    description: 'Execute until the current function returns',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            sessionId: {
                                type: 'string',
                                description: 'GDB session ID'
                            }
                        },
                        required: ['sessionId']
                    }
                },
                {
                    name: 'gdb_backtrace',
                    description: 'Show call stack',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            sessionId: {
                                type: 'string',
                                description: 'GDB session ID'
                            },
                            full: {
                                type: 'boolean',
                                description: 'Show variables in each frame (optional)'
                            },
                            limit: {
                                type: 'number',
                                description: 'Maximum number of frames to show (optional)'
                            }
                        },
                        required: ['sessionId']
                    }
                },
                {
                    name: 'gdb_print',
                    description: 'Print value of expression',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            sessionId: {
                                type: 'string',
                                description: 'GDB session ID'
                            },
                            expression: {
                                type: 'string',
                                description: 'Expression to evaluate'
                            }
                        },
                        required: ['sessionId', 'expression']
                    }
                },
                {
                    name: 'gdb_examine',
                    description: 'Examine memory',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            sessionId: {
                                type: 'string',
                                description: 'GDB session ID'
                            },
                            expression: {
                                type: 'string',
                                description: 'Memory address or expression'
                            },
                            format: {
                                type: 'string',
                                description: 'Display format (e.g., "x" for hex, "i" for instruction)'
                            },
                            count: {
                                type: 'number',
                                description: 'Number of units to display'
                            }
                        },
                        required: ['sessionId', 'expression']
                    }
                },
                {
                    name: 'gdb_info_registers',
                    description: 'Display registers',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            sessionId: {
                                type: 'string',
                                description: 'GDB session ID'
                            },
                            register: {
                                type: 'string',
                                description: 'Specific register to display (optional)'
                            }
                        },
                        required: ['sessionId']
                    }
                }
            ],
        }));
        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            // Route the tool call to the appropriate handler based on the tool name
            switch (request.params.name) {
                case 'gdb_start':
                    return await this.handleGdbStart(request.params.arguments);
                case 'gdb_load':
                    return await this.handleGdbLoad(request.params.arguments);
                case 'gdb_command':
                    return await this.handleGdbCommand(request.params.arguments);
                case 'gdb_terminate':
                    return await this.handleGdbTerminate(request.params.arguments);
                case 'gdb_list_sessions':
                    return await this.handleGdbListSessions();
                case 'gdb_connect_remote':
                    return await this.handleGdbConnectRemote(request.params.arguments);
                case 'gdb_attach':
                    return await this.handleGdbAttach(request.params.arguments);
                case 'gdb_load_core':
                    return await this.handleGdbLoadCore(request.params.arguments);
                case 'gdb_set_breakpoint':
                    return await this.handleGdbSetBreakpoint(request.params.arguments);
                case 'gdb_continue':
                    return await this.handleGdbContinue(request.params.arguments);
                case 'gdb_step':
                    return await this.handleGdbStep(request.params.arguments);
                case 'gdb_next':
                    return await this.handleGdbNext(request.params.arguments);
                case 'gdb_finish':
                    return await this.handleGdbFinish(request.params.arguments);
                case 'gdb_backtrace':
                    return await this.handleGdbBacktrace(request.params.arguments);
                case 'gdb_print':
                    return await this.handleGdbPrint(request.params.arguments);
                case 'gdb_examine':
                    return await this.handleGdbExamine(request.params.arguments);
                case 'gdb_info_registers':
                    return await this.handleGdbInfoRegisters(request.params.arguments);
                default:
                    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
            }
        });
    }
    async handleGdbStart(args) {
        const gdbPath = args.gdbPath || 'gdb';
        const workingDir = args.workingDir || process.cwd();
        // Create a unique session ID
        const sessionId = Date.now().toString();
        try {
            // Start GDB process with MI mode enabled for machine interface
            const gdbProcess = spawn(gdbPath, ['--interpreter=mi'], {
                cwd: workingDir,
                env: process.env,
                stdio: ['pipe', 'pipe', 'pipe']
            });
            // Create readline interface for reading GDB output
            const rl = readline.createInterface({
                input: gdbProcess.stdout,
                terminal: false
            });
            // Create new GDB session
            const session = {
                process: gdbProcess,
                rl,
                ready: false,
                id: sessionId,
                workingDir
            };
            // Store session in active sessions map
            activeSessions.set(sessionId, session);
            // Collect GDB output until ready
            let outputBuffer = '';
            // Wait for GDB to be ready (when it outputs the initial prompt)
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error('GDB start timeout'));
                }, 10000); // 10 second timeout
                rl.on('line', (line) => {
                    // Append line to output buffer
                    outputBuffer += line + '\n';
                    // Check if GDB is ready (outputs prompt)
                    if (line.includes('(gdb)') || line.includes('^done')) {
                        clearTimeout(timeout);
                        session.ready = true;
                        resolve();
                    }
                });
                gdbProcess.stderr.on('data', (data) => {
                    outputBuffer += `[stderr] ${data.toString()}\n`;
                });
                gdbProcess.on('error', (err) => {
                    clearTimeout(timeout);
                    reject(err);
                });
                gdbProcess.on('exit', (code) => {
                    clearTimeout(timeout);
                    if (!session.ready) {
                        reject(new Error(`GDB process exited with code ${code}`));
                    }
                });
            });
            return {
                content: [
                    {
                        type: 'text',
                        text: `GDB session started with ID: ${sessionId}\n\nOutput:\n${outputBuffer}`
                    }
                ]
            };
        }
        catch (error) {
            // Clean up if an error occurs
            if (activeSessions.has(sessionId)) {
                const session = activeSessions.get(sessionId);
                session.process.kill();
                session.rl.close();
                activeSessions.delete(sessionId);
            }
            const errorMessage = error instanceof Error ? error.message : String(error);
            return {
                content: [
                    {
                        type: 'text',
                        text: `Failed to start GDB: ${errorMessage}`
                    }
                ],
                isError: true
            };
        }
    }
    async handleGdbLoad(args) {
        const { sessionId, program, arguments: programArgs = [] } = args;
        if (!activeSessions.has(sessionId)) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `No active GDB session with ID: ${sessionId}`
                    }
                ],
                isError: true
            };
        }
        const session = activeSessions.get(sessionId);
        try {
            // Normalize path if working directory is set
            const normalizedPath = session.workingDir && !path.isAbsolute(program)
                ? path.resolve(session.workingDir, program)
                : program;
            // Update session target
            session.target = normalizedPath;
            // Execute file command to load program
            const loadCommand = `file "${normalizedPath}"`;
            const loadOutput = await this.executeGdbCommand(session, loadCommand);
            // Set program arguments if provided
            let argsOutput = '';
            if (programArgs.length > 0) {
                const argsCommand = `set args ${programArgs.join(' ')}`;
                argsOutput = await this.executeGdbCommand(session, argsCommand);
            }
            return {
                content: [
                    {
                        type: 'text',
                        text: `Program loaded: ${normalizedPath}\n\nOutput:\n${loadOutput}${argsOutput ? '\n' + argsOutput : ''}`
                    }
                ]
            };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return {
                content: [
                    {
                        type: 'text',
                        text: `Failed to load program: ${errorMessage}`
                    }
                ],
                isError: true
            };
        }
    }
    async handleGdbCommand(args) {
        const { sessionId, command } = args;
        if (!activeSessions.has(sessionId)) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `No active GDB session with ID: ${sessionId}`
                    }
                ],
                isError: true
            };
        }
        const session = activeSessions.get(sessionId);
        try {
            const output = await this.executeGdbCommand(session, command);
            return {
                content: [
                    {
                        type: 'text',
                        text: `Command: ${command}\n\nOutput:\n${output}`
                    }
                ]
            };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return {
                content: [
                    {
                        type: 'text',
                        text: `Failed to execute command: ${errorMessage}`
                    }
                ],
                isError: true
            };
        }
    }
    async handleGdbTerminate(args) {
        const { sessionId } = args;
        if (!activeSessions.has(sessionId)) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `No active GDB session with ID: ${sessionId}`
                    }
                ],
                isError: true
            };
        }
        try {
            await this.terminateGdbSession(sessionId);
            return {
                content: [
                    {
                        type: 'text',
                        text: `GDB session terminated: ${sessionId}`
                    }
                ]
            };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return {
                content: [
                    {
                        type: 'text',
                        text: `Failed to terminate GDB session: ${errorMessage}`
                    }
                ],
                isError: true
            };
        }
    }
    async handleGdbListSessions() {
        const sessions = Array.from(activeSessions.entries()).map(([id, session]) => ({
            id,
            target: session.target || 'No program loaded',
            workingDir: session.workingDir || process.cwd()
        }));
        return {
            content: [
                {
                    type: 'text',
                    text: `Active GDB Sessions (${sessions.length}):\n\n${JSON.stringify(sessions, null, 2)}`
                }
            ]
        };
    }
    async handleGdbConnectRemote(args) {
        const { sessionId, host, port } = args;
        if (!activeSessions.has(sessionId)) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `No active GDB session with ID: ${sessionId}`
                    }
                ],
                isError: true
            };
        }
        const session = activeSessions.get(sessionId);
        try {
            const command = `target extended-remote ${host}:${port}`;
            const output = await this.executeGdbCommand(session, command);
            return {
                content: [
                    {
                        type: 'text',
                        text: `Connected to remote target at ${host}:${port}\n\nOutput:\n${output}`
                    }
                ]
            };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return {
                content: [
                    {
                        type: 'text',
                        text: `Failed to connect to remote target: ${errorMessage}`
                    }
                ],
                isError: true
            };
        }
    }
    async handleGdbAttach(args) {
        const { sessionId, pid } = args;
        if (!activeSessions.has(sessionId)) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `No active GDB session with ID: ${sessionId}`
                    }
                ],
                isError: true
            };
        }
        const session = activeSessions.get(sessionId);
        try {
            const output = await this.executeGdbCommand(session, `attach ${pid}`);
            return {
                content: [
                    {
                        type: 'text',
                        text: `Attached to process ${pid}\n\nOutput:\n${output}`
                    }
                ]
            };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return {
                content: [
                    {
                        type: 'text',
                        text: `Failed to attach to process: ${errorMessage}`
                    }
                ],
                isError: true
            };
        }
    }
    async handleGdbLoadCore(args) {
        const { sessionId, program, corePath } = args;
        if (!activeSessions.has(sessionId)) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `No active GDB session with ID: ${sessionId}`
                    }
                ],
                isError: true
            };
        }
        const session = activeSessions.get(sessionId);
        try {
            // First load the program
            const fileOutput = await this.executeGdbCommand(session, `file "${program}"`);
            // Then load the core file
            const coreOutput = await this.executeGdbCommand(session, `core-file "${corePath}"`);
            // Get backtrace to show initial state
            const backtraceOutput = await this.executeGdbCommand(session, "backtrace");
            return {
                content: [
                    {
                        type: 'text',
                        text: `Core file loaded: ${corePath}\n\nOutput:\n${fileOutput}\n${coreOutput}\n\nBacktrace:\n${backtraceOutput}`
                    }
                ]
            };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return {
                content: [
                    {
                        type: 'text',
                        text: `Failed to load core file: ${errorMessage}`
                    }
                ],
                isError: true
            };
        }
    }
    async handleGdbSetBreakpoint(args) {
        const { sessionId, location, condition } = args;
        if (!activeSessions.has(sessionId)) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `No active GDB session with ID: ${sessionId}`
                    }
                ],
                isError: true
            };
        }
        const session = activeSessions.get(sessionId);
        try {
            // Set breakpoint
            let command = `break ${location}`;
            const output = await this.executeGdbCommand(session, command);
            // Set condition if provided
            let conditionOutput = '';
            if (condition) {
                // Extract breakpoint number from output (assumes format like "Breakpoint 1 at...")
                const match = output.match(/Breakpoint (\d+)/);
                if (match && match[1]) {
                    const bpNum = match[1];
                    const conditionCommand = `condition ${bpNum} ${condition}`;
                    conditionOutput = await this.executeGdbCommand(session, conditionCommand);
                }
            }
            return {
                content: [
                    {
                        type: 'text',
                        text: `Breakpoint set at: ${location}${condition ? ` with condition: ${condition}` : ''}\n\nOutput:\n${output}${conditionOutput ? '\n' + conditionOutput : ''}`
                    }
                ]
            };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return {
                content: [
                    {
                        type: 'text',
                        text: `Failed to set breakpoint: ${errorMessage}`
                    }
                ],
                isError: true
            };
        }
    }
    async handleGdbContinue(args) {
        const { sessionId } = args;
        if (!activeSessions.has(sessionId)) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `No active GDB session with ID: ${sessionId}`
                    }
                ],
                isError: true
            };
        }
        const session = activeSessions.get(sessionId);
        try {
            const output = await this.executeGdbCommand(session, "continue");
            return {
                content: [
                    {
                        type: 'text',
                        text: `Continued execution\n\nOutput:\n${output}`
                    }
                ]
            };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return {
                content: [
                    {
                        type: 'text',
                        text: `Failed to continue execution: ${errorMessage}`
                    }
                ],
                isError: true
            };
        }
    }
    async handleGdbStep(args) {
        const { sessionId, instructions = false } = args;
        if (!activeSessions.has(sessionId)) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `No active GDB session with ID: ${sessionId}`
                    }
                ],
                isError: true
            };
        }
        const session = activeSessions.get(sessionId);
        try {
            // Use stepi for instruction-level stepping, otherwise step
            const command = instructions ? "stepi" : "step";
            const output = await this.executeGdbCommand(session, command);
            return {
                content: [
                    {
                        type: 'text',
                        text: `Stepped ${instructions ? 'instruction' : 'line'}\n\nOutput:\n${output}`
                    }
                ]
            };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return {
                content: [
                    {
                        type: 'text',
                        text: `Failed to step: ${errorMessage}`
                    }
                ],
                isError: true
            };
        }
    }
    async handleGdbNext(args) {
        const { sessionId, instructions = false } = args;
        if (!activeSessions.has(sessionId)) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `No active GDB session with ID: ${sessionId}`
                    }
                ],
                isError: true
            };
        }
        const session = activeSessions.get(sessionId);
        try {
            // Use nexti for instruction-level stepping, otherwise next
            const command = instructions ? "nexti" : "next";
            const output = await this.executeGdbCommand(session, command);
            return {
                content: [
                    {
                        type: 'text',
                        text: `Stepped over ${instructions ? 'instruction' : 'function call'}\n\nOutput:\n${output}`
                    }
                ]
            };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return {
                content: [
                    {
                        type: 'text',
                        text: `Failed to step over: ${errorMessage}`
                    }
                ],
                isError: true
            };
        }
    }
    async handleGdbFinish(args) {
        const { sessionId } = args;
        if (!activeSessions.has(sessionId)) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `No active GDB session with ID: ${sessionId}`
                    }
                ],
                isError: true
            };
        }
        const session = activeSessions.get(sessionId);
        try {
            const output = await this.executeGdbCommand(session, "finish");
            return {
                content: [
                    {
                        type: 'text',
                        text: `Finished current function\n\nOutput:\n${output}`
                    }
                ]
            };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return {
                content: [
                    {
                        type: 'text',
                        text: `Failed to finish function: ${errorMessage}`
                    }
                ],
                isError: true
            };
        }
    }
    async handleGdbBacktrace(args) {
        const { sessionId, full = false, limit } = args;
        if (!activeSessions.has(sessionId)) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `No active GDB session with ID: ${sessionId}`
                    }
                ],
                isError: true
            };
        }
        const session = activeSessions.get(sessionId);
        try {
            // Build backtrace command with options
            let command = full ? "backtrace full" : "backtrace";
            if (typeof limit === 'number') {
                command += ` ${limit}`;
            }
            const output = await this.executeGdbCommand(session, command);
            return {
                content: [
                    {
                        type: 'text',
                        text: `Backtrace${full ? ' (full)' : ''}${limit ? ` (limit: ${limit})` : ''}:\n\n${output}`
                    }
                ]
            };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return {
                content: [
                    {
                        type: 'text',
                        text: `Failed to get backtrace: ${errorMessage}`
                    }
                ],
                isError: true
            };
        }
    }
    async handleGdbPrint(args) {
        const { sessionId, expression } = args;
        if (!activeSessions.has(sessionId)) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `No active GDB session with ID: ${sessionId}`
                    }
                ],
                isError: true
            };
        }
        const session = activeSessions.get(sessionId);
        try {
            const output = await this.executeGdbCommand(session, `print ${expression}`);
            return {
                content: [
                    {
                        type: 'text',
                        text: `Print ${expression}:\n\n${output}`
                    }
                ]
            };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return {
                content: [
                    {
                        type: 'text',
                        text: `Failed to print expression: ${errorMessage}`
                    }
                ],
                isError: true
            };
        }
    }
    async handleGdbExamine(args) {
        const { sessionId, expression, format = 'x', count = 1 } = args;
        if (!activeSessions.has(sessionId)) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `No active GDB session with ID: ${sessionId}`
                    }
                ],
                isError: true
            };
        }
        const session = activeSessions.get(sessionId);
        try {
            // Format examine command: x/[count][format] [expression]
            const command = `x/${count}${format} ${expression}`;
            const output = await this.executeGdbCommand(session, command);
            return {
                content: [
                    {
                        type: 'text',
                        text: `Examine ${expression} (format: ${format}, count: ${count}):\n\n${output}`
                    }
                ]
            };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return {
                content: [
                    {
                        type: 'text',
                        text: `Failed to examine memory: ${errorMessage}`
                    }
                ],
                isError: true
            };
        }
    }
    async handleGdbInfoRegisters(args) {
        const { sessionId, register } = args;
        if (!activeSessions.has(sessionId)) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `No active GDB session with ID: ${sessionId}`
                    }
                ],
                isError: true
            };
        }
        const session = activeSessions.get(sessionId);
        try {
            // Build info registers command, optionally with specific register
            const command = register ? `info registers ${register}` : `info registers`;
            const output = await this.executeGdbCommand(session, command);
            return {
                content: [
                    {
                        type: 'text',
                        text: `Register info${register ? ` for ${register}` : ''}:\n\n${output}`
                    }
                ]
            };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return {
                content: [
                    {
                        type: 'text',
                        text: `Failed to get register info: ${errorMessage}`
                    }
                ],
                isError: true
            };
        }
    }
    /**
     * Execute a GDB command and wait for the response
     */
    executeGdbCommand(session, command) {
        return new Promise((resolve, reject) => {
            if (!session.ready) {
                reject(new Error('GDB session is not ready'));
                return;
            }
            // Write command to GDB's stdin
            if (session.process.stdin) {
                session.process.stdin.write(command + '\n');
            }
            else {
                reject(new Error('GDB stdin is not available'));
                return;
            }
            let output = '';
            let responseComplete = false;
            // Create a one-time event handler for GDB output
            const onLine = (line) => {
                output += line + '\n';
                // Check if this line indicates the end of the GDB response
                if (line.includes('(gdb)') || line.includes('^done') || line.includes('^error')) {
                    responseComplete = true;
                    // If we've received the complete response, resolve the promise
                    if (responseComplete) {
                        // Remove the listener to avoid memory leaks
                        session.rl.removeListener('line', onLine);
                        resolve(output);
                    }
                }
            };
            // Add the line handler to the readline interface
            session.rl.on('line', onLine);
            // Set a timeout to prevent hanging
            const timeout = setTimeout(() => {
                session.rl.removeListener('line', onLine);
                reject(new Error('GDB command timed out'));
            }, 10000); // 10 second timeout
            // Handle GDB errors
            const errorHandler = (data) => {
                const errorText = data.toString();
                output += `[stderr] ${errorText}\n`;
            };
            // Add error handler
            if (session.process.stderr) {
                session.process.stderr.once('data', errorHandler);
            }
            // Clean up event handlers when the timeout expires
            timeout.unref();
        });
    }
    /**
     * Terminate a GDB session
     */
    async terminateGdbSession(sessionId) {
        if (!activeSessions.has(sessionId)) {
            throw new Error(`No active GDB session with ID: ${sessionId}`);
        }
        const session = activeSessions.get(sessionId);
        // Send quit command to GDB
        try {
            await this.executeGdbCommand(session, 'quit');
        }
        catch (error) {
            // Ignore errors from quit command, we'll force kill if needed
        }
        // Force kill the process if it's still running
        if (!session.process.killed) {
            session.process.kill();
        }
        // Close the readline interface
        session.rl.close();
        // Remove from active sessions
        activeSessions.delete(sessionId);
    }
    async run() {
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        console.error('GDB MCP server running on stdio');
    }
}
// Create and run the server
const server = new GdbServer();
server.run().catch((error) => {
    console.error('Failed to start GDB MCP server:', error);
    process.exit(1);
});
//# sourceMappingURL=index.js.map