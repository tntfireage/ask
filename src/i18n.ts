import { loadConfig } from './config/config.js'

export type UiLanguage = 'zh' | 'en'

export function uiLanguage(language: string): UiLanguage {
  return language.trim().toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

export function detectLanguage(): string {
  try {
    return loadConfig().language
  } catch {
    return 'zh'
  }
}

export interface UiMessages {
  welcome: {
    intro: string
    tagline: string
    historyHint: string
    skillsHint: string
    skillHint: string
    mcpHint: string
    expandHint: string
    clearHint: string
    exitHint: string
    unconfiguredModel: string
  }
  status: {
    thinking: string
    running: string
    truncated: string
  }
  labels: {
    error: string
  }
  model: {
    createdTemplate: (path: string) => string
    opening: (path: string) => string
    createFailed: (path: string, message: string) => string
    editorFailed: (editor: string, message: string) => string
    editorExit: (editor: string, code: number) => string
  }
  help: {
    description: string
    model: string
    mcp: string
    query: string
  }
  mcp: {
    createdTemplate: (path: string) => string
    opening: (path: string) => string
    createFailed: (path: string, message: string) => string
    editorFailed: (editor: string, message: string) => string
    editorExit: (editor: string, code: number) => string
  }
  repl: {
    contextCleared: string
    emptyHistory: string
    unknownCommand: (line: string) => string
    aborted: string
    warningPrefix: string
    historyMessage: string
    errorPrefix: string
    skillsEmpty: string
    skillLoaded: (name: string) => string
    skillNotFound: (name: string) => string
    skillUsage: string
    expandUsage: string
    expandNotFound: (id: number) => string
    expandNoCalls: string
    skillTable: {
      name: string
      source: string
      description: string
    }
    mcpTable: {
      name: string
      state: string
      tools: string
      error: string
    }
    mcpNoServers: string
  }
}

const ZH: UiMessages = {
  welcome: {
    intro: '直接输入问题，回车开始',
    tagline: '一个极简的命令行AI工具，自动执行无需确认，加快你的生产效率！！！',
    historyHint: '历史',
    skillsHint: '技能',
    skillHint: '加载',
    mcpHint: 'MCP 状态',
    expandHint: '展开',
    clearHint: '清空',
    exitHint: '退出',
    unconfiguredModel: '未配置',
  },
  status: {
    thinking: '思考中',
    running: '运行中',
    truncated: '输出已截断',
  },
  labels: {
    error: '[错误]',
  },
  model: {
    createdTemplate: (path) => `已创建配置模板: ${path}`,
    opening: (path) => `打开配置文件: ${path}`,
    createFailed: (path, message) => `无法创建配置文件 ${path}: ${message}`,
    editorFailed: (editor, message) =>
      `无法启动编辑器 ${editor}: ${message}`,
    editorExit: (editor, code) => `编辑器 ${editor} 退出码 ${code}`,
  },
  help: {
    description: '用自然语言提问；需要时由 LLM 调用工具取证并回答',
    model: '编辑模型配置 (~/.ask/config.json)',
    mcp: '编辑 MCP 配置 (~/.ask/mcp.json)',
    query: '要提问的内容；执行后进入 REPL',
  },
  mcp: {
    createdTemplate: (path) => `已创建 MCP 配置模板: ${path}`,
    opening: (path) => `打开 MCP 配置: ${path}`,
    createFailed: (path, message) =>
      `无法创建 MCP 配置 ${path}: ${message}`,
    editorFailed: (editor, message) =>
      `无法启动编辑器 ${editor}: ${message}`,
    editorExit: (editor, code) => `编辑器 ${editor} 退出码 ${code}`,
  },
  repl: {
    contextCleared: '上下文已清空',
    emptyHistory: '历史为空',
    unknownCommand: (line) => `未知命令: ${line}`,
    aborted: '[已中止]',
    warningPrefix: '提示: ',
    historyMessage: '历史提问（输入关键词筛选）',
    errorPrefix: '[错误]',
    skillsEmpty: '没有可用技能',
    skillLoaded: (name) => `已加载技能: ${name}`,
    skillNotFound: (name) => `未知技能: ${name}`,
    skillUsage: '用法: /skill <name>',
    expandUsage: '用法: /expand [编号|list]',
    expandNotFound: (id) => `没有编号为 ${id} 的工具调用`,
    expandNoCalls: '还没有工具调用',
    skillTable: {
      name: '名称',
      source: '来源',
      description: '描述',
    },
    mcpTable: {
      name: '名称',
      state: '状态',
      tools: '工具',
      error: '错误',
    },
    mcpNoServers: '未配置 MCP 服务器',
  },
}

const EN: UiMessages = {
  welcome: {
    intro: 'Type a question and press Enter',
    tagline:
      'A minimalist command-line AI tool that executes without confirmation and boosts your productivity!!!',
    historyHint: 'history',
    skillsHint: 'skills',
    skillHint: 'load',
    mcpHint: 'MCP status',
    expandHint: 'expand',
    clearHint: 'clear context',
    exitHint: 'quit',
    unconfiguredModel: 'not configured',
  },
  status: {
    thinking: 'Thinking',
    running: 'Running',
    truncated: 'truncated',
  },
  labels: {
    error: '[Error]',
  },
  model: {
    createdTemplate: (path) => `Created config template: ${path}`,
    opening: (path) => `Opening config: ${path}`,
    createFailed: (path, message) =>
      `Failed to create config ${path}: ${message}`,
    editorFailed: (editor, message) =>
      `Failed to start editor ${editor}: ${message}`,
    editorExit: (editor, code) => `Editor ${editor} exited with code ${code}`,
  },
  help: {
    description:
      'Ask anything in natural language; the LLM uses tools when needed',
    model: 'Edit model config (~/.ask/config.json)',
    mcp: 'Edit MCP config (~/.ask/mcp.json)',
    query: 'Question to ask; then enter the REPL',
  },
  mcp: {
    createdTemplate: (path) => `Created MCP config template: ${path}`,
    opening: (path) => `Opening MCP config: ${path}`,
    createFailed: (path, message) =>
      `Failed to create MCP config ${path}: ${message}`,
    editorFailed: (editor, message) =>
      `Failed to start editor ${editor}: ${message}`,
    editorExit: (editor, code) => `Editor ${editor} exited with code ${code}`,
  },
  repl: {
    contextCleared: 'Context cleared',
    emptyHistory: 'No history yet',
    unknownCommand: (line) => `Unknown command: ${line}`,
    aborted: '[Aborted]',
    warningPrefix: 'Note: ',
    historyMessage: 'History (type to filter)',
    errorPrefix: '[Error]',
    skillsEmpty: 'No skills available',
    skillLoaded: (name) => `Loaded skill: ${name}`,
    skillNotFound: (name) => `Unknown skill: ${name}`,
    skillUsage: 'Usage: /skill <name>',
    expandUsage: 'Usage: /expand [number|list]',
    expandNotFound: (id) => `No tool call #${id}`,
    expandNoCalls: 'No tool calls yet',
    skillTable: {
      name: 'NAME',
      source: 'SOURCE',
      description: 'DESCRIPTION',
    },
    mcpTable: {
      name: 'NAME',
      state: 'STATE',
      tools: 'TOOLS',
      error: 'ERROR',
    },
    mcpNoServers: 'No MCP servers configured',
  },
}

export function messages(language: string): UiMessages {
  return uiLanguage(language) === 'zh' ? ZH : EN
}
