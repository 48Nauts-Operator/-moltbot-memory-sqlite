/**
 * moltbot-memory-sqlite
 * SQLite-based long-term memory plugin for Moltbot
 * 
 * Privacy-first, local-only memory storage with full-text search support.
 * Uses sql.js (WebAssembly SQLite) - no native compilation required.
 */

import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { randomUUID } from 'crypto';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface Memory {
  id: string;
  text: string;
  category: MemoryCategory;
  importance: number;
  createdAt: string;
  updatedAt: string;
  sessionKey?: string;
  metadata?: Record<string, unknown>;
}

export type MemoryCategory = 
  | 'preference'
  | 'fact'
  | 'decision'
  | 'entity'
  | 'conversation'
  | 'other';

export interface MemoryStoreParams {
  text: string;
  category?: MemoryCategory;
  importance?: number;
  sessionKey?: string;
  metadata?: Record<string, unknown>;
}

export interface MemoryRecallParams {
  query: string;
  limit?: number;
  category?: MemoryCategory;
  dateFrom?: string;
  dateTo?: string;
  filterNoise?: boolean;
}

export interface MemoryForgetParams {
  memoryId?: string;
  query?: string;
}

export interface PluginConfig {
  dbPath?: string;
  maxMemories?: number;
  defaultImportance?: number;
  noisePatterns?: string[];
  autoSaveInterval?: number; // ms, 0 = save after every write
}

// ─────────────────────────────────────────────────────────────────────────────
// Default Configuration
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: Required<PluginConfig> = {
  dbPath: join(homedir(), '.moltbot', 'memory.db'),
  maxMemories: 10000,
  defaultImportance: 0.7,
  noisePatterns: [
    '^(ok|okay|yes|no|thanks|thank you|sure|got it|cool|nice|great)$',
    '^\\s*$',
  ],
  autoSaveInterval: 0,
};

// ─────────────────────────────────────────────────────────────────────────────
// SQLite Memory Plugin
// ─────────────────────────────────────────────────────────────────────────────

export class SqliteMemoryPlugin {
  private db: SqlJsDatabase | null = null;
  private config: Required<PluginConfig>;
  private dirty = false;
  private saveTimer: NodeJS.Timeout | null = null;
  private initialized = false;

  constructor(config: PluginConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    const SQL = await initSqlJs();
    
    // Ensure directory exists
    const dbDir = dirname(this.config.dbPath);
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
    }

    // Load existing database or create new
    if (existsSync(this.config.dbPath)) {
      const buffer = readFileSync(this.config.dbPath);
      this.db = new SQL.Database(buffer);
    } else {
      this.db = new SQL.Database();
    }

    this.initializeSchema();
    this.initialized = true;

    // Setup auto-save if configured
    if (this.config.autoSaveInterval > 0) {
      this.saveTimer = setInterval(() => this.saveIfDirty(), this.config.autoSaveInterval);
    }
  }

  private initializeSchema(): void {
    if (!this.db) throw new Error('Database not initialized');

    this.db.run(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        text_lower TEXT NOT NULL,
        category TEXT DEFAULT 'other',
        importance REAL DEFAULT 0.7,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        session_key TEXT,
        metadata TEXT
      )
    `);

    this.db.run(`CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_memories_text_lower ON memories(text_lower)`);
    
    this.save();
  }

  private save(): void {
    if (!this.db) return;
    const data = this.db.export();
    const buffer = Buffer.from(data);
    writeFileSync(this.config.dbPath, buffer);
    this.dirty = false;
  }

  private saveIfDirty(): void {
    if (this.dirty) this.save();
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.config.autoSaveInterval === 0) {
      this.save();
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Public API
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Store a new memory
   */
  store(params: MemoryStoreParams): Memory {
    if (!this.db) throw new Error('Database not initialized. Call init() first.');

    const now = new Date().toISOString();
    const memory: Memory = {
      id: randomUUID(),
      text: params.text,
      category: params.category || 'other',
      importance: params.importance ?? this.config.defaultImportance,
      createdAt: now,
      updatedAt: now,
      sessionKey: params.sessionKey,
      metadata: params.metadata,
    };

    this.db.run(
      `INSERT INTO memories (id, text, text_lower, category, importance, created_at, updated_at, session_key, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        memory.id,
        memory.text,
        memory.text.toLowerCase(),
        memory.category,
        memory.importance,
        memory.createdAt,
        memory.updatedAt,
        memory.sessionKey || null,
        memory.metadata ? JSON.stringify(memory.metadata) : null,
      ]
    );

    this.markDirty();

    // Enforce max memories limit
    this.pruneOldMemories();

    return memory;
  }

  /**
   * Recall memories matching a query
   */
  recall(params: MemoryRecallParams): Memory[] {
    if (!this.db) throw new Error('Database not initialized. Call init() first.');

    const limit = params.limit || 5;
    const conditions: string[] = [];
    const values: (string | number)[] = [];

    // Text search (simple LIKE-based for sql.js compatibility)
    if (params.query) {
      const words = params.query.toLowerCase().split(/\s+/).filter(w => w.length > 1);
      if (words.length > 0) {
        const likeConditions = words.map(() => 'text_lower LIKE ?');
        conditions.push(`(${likeConditions.join(' OR ')})`);
        words.forEach(word => values.push(`%${word}%`));
      }
    }

    // Category filter
    if (params.category) {
      conditions.push('category = ?');
      values.push(params.category);
    }

    // Date filters
    if (params.dateFrom) {
      conditions.push('created_at >= ?');
      values.push(params.dateFrom);
    }
    if (params.dateTo) {
      conditions.push('created_at <= ?');
      values.push(params.dateTo);
    }

    const whereClause = conditions.length > 0 
      ? `WHERE ${conditions.join(' AND ')}` 
      : '';

    const sql = `
      SELECT id, text, category, importance, created_at, updated_at, session_key, metadata
      FROM memories
      ${whereClause}
      ORDER BY importance DESC, created_at DESC
      LIMIT ?
    `;

    values.push(limit * 2); // Fetch extra for noise filtering

    const stmt = this.db.prepare(sql);
    stmt.bind(values);

    const rows: Memory[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as {
        id: string;
        text: string;
        category: string;
        importance: number;
        created_at: string;
        updated_at: string;
        session_key: string | null;
        metadata: string | null;
      };
      rows.push({
        id: row.id,
        text: row.text,
        category: row.category as MemoryCategory,
        importance: row.importance,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        sessionKey: row.session_key || undefined,
        metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      });
    }
    stmt.free();

    // Apply noise filter
    let memories = rows;
    if (params.filterNoise !== false) {
      const noiseRegexes = this.config.noisePatterns.map(p => new RegExp(p, 'i'));
      memories = memories.filter(m => !noiseRegexes.some(re => re.test(m.text)));
    }

    return memories.slice(0, limit);
  }

  /**
   * Delete a memory (GDPR-compliant)
   */
  forget(params: MemoryForgetParams): { deleted: number } {
    if (!this.db) throw new Error('Database not initialized. Call init() first.');

    let deleted = 0;

    if (params.memoryId) {
      const result = this.db.run('DELETE FROM memories WHERE id = ?', [params.memoryId]);
      deleted = this.db.getRowsModified();
    } else if (params.query) {
      // Find matching memories first
      const memories = this.recall({ query: params.query, limit: 100, filterNoise: false });
      if (memories.length > 0) {
        const placeholders = memories.map(() => '?').join(',');
        this.db.run(`DELETE FROM memories WHERE id IN (${placeholders})`, memories.map(m => m.id));
        deleted = this.db.getRowsModified();
      }
    }

    if (deleted > 0) {
      this.markDirty();
    }

    return { deleted };
  }

  /**
   * Get memory stats
   */
  stats(): { total: number; byCategory: Record<string, number> } {
    if (!this.db) throw new Error('Database not initialized. Call init() first.');

    const totalStmt = this.db.prepare('SELECT COUNT(*) as count FROM memories');
    totalStmt.step();
    const total = (totalStmt.getAsObject() as { count: number }).count;
    totalStmt.free();
    
    const categoryStmt = this.db.prepare(`
      SELECT category, COUNT(*) as count 
      FROM memories 
      GROUP BY category
    `);

    const byCategory: Record<string, number> = {};
    while (categoryStmt.step()) {
      const row = categoryStmt.getAsObject() as { category: string; count: number };
      byCategory[row.category] = row.count;
    }
    categoryStmt.free();

    return { total, byCategory };
  }

  /**
   * Close database connection
   */
  close(): void {
    if (this.saveTimer) {
      clearInterval(this.saveTimer);
      this.saveTimer = null;
    }
    this.saveIfDirty();
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.initialized = false;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Private Methods
  // ───────────────────────────────────────────────────────────────────────────

  private pruneOldMemories(): void {
    const { total } = this.stats();
    if (total > this.config.maxMemories) {
      const toDelete = total - this.config.maxMemories;
      this.db!.run(`
        DELETE FROM memories 
        WHERE id IN (
          SELECT id FROM memories 
          ORDER BY importance ASC, created_at ASC 
          LIMIT ?
        )
      `, [toDelete]);
      this.markDirty();
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Moltbot Plugin Interface
// ─────────────────────────────────────────────────────────────────────────────

export interface MoltbotPlugin {
  id: string;
  name: string;
  version: string;
  slot: 'memory';
  init: (config: PluginConfig) => Promise<void>;
  handlers: {
    memory_store: (params: MemoryStoreParams) => Promise<Memory>;
    memory_recall: (params: MemoryRecallParams) => Promise<Memory[]>;
    memory_forget: (params: MemoryForgetParams) => Promise<{ deleted: number }>;
  };
  shutdown: () => Promise<void>;
}

let pluginInstance: SqliteMemoryPlugin | null = null;

/**
 * Moltbot Plugin Export
 */
export const plugin: MoltbotPlugin = {
  id: 'moltbot-memory-sqlite',
  name: 'SQLite Memory',
  version: '0.1.0',
  slot: 'memory',

  async init(config: PluginConfig = {}): Promise<void> {
    pluginInstance = new SqliteMemoryPlugin(config);
    await pluginInstance.init();
  },

  handlers: {
    async memory_store(params: MemoryStoreParams): Promise<Memory> {
      if (!pluginInstance) throw new Error('Plugin not initialized');
      return pluginInstance.store(params);
    },

    async memory_recall(params: MemoryRecallParams): Promise<Memory[]> {
      if (!pluginInstance) throw new Error('Plugin not initialized');
      return pluginInstance.recall(params);
    },

    async memory_forget(params: MemoryForgetParams): Promise<{ deleted: number }> {
      if (!pluginInstance) throw new Error('Plugin not initialized');
      return pluginInstance.forget(params);
    },
  },

  async shutdown(): Promise<void> {
    if (pluginInstance) {
      pluginInstance.close();
      pluginInstance = null;
    }
  },
};

export default plugin;
